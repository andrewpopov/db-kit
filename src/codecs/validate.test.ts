import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPostgres, type PostgresHandle } from '../postgres.js';
import { startThrowawayPostgres, type ThrowawayPostgres } from '../test-support/embedded-pg.js';
import { introspectPostgres, introspectSqlite } from './introspect.js';
import { parseCodecManifest, type CodecManifestInput } from './manifest.js';
import { validateManifest, type IntrospectedDatabases, type ManifestIssue } from './validate.js';

type Columns = CodecManifestInput['tables'][string]['columns'];

const GOOD_COLUMNS = {
  id: { codec: 'integer', nullable: false },
  name: { codec: 'text', nullable: false },
  flag: { codec: 'integer', nullable: true },
  qty: { codec: 'integer', nullable: false },
  total: { codec: 'integer', nullable: false, generated: true },
} satisfies Columns;

function manifestOf(columns: Columns, extraTables: CodecManifestInput['tables'] = {}) {
  return parseCodecManifest({ version: 1, tables: { items: { columns, primaryKey: ['id'] }, ...extraTables } } satisfies CodecManifestInput);
}

let server: ThrowawayPostgres;
let pg: PostgresHandle;
let dir: string;
let sqlite: Database.Database;
let databases: IntrospectedDatabases;

beforeAll(async () => {
  server = await startThrowawayPostgres();
  pg = openPostgres(server.config, { applicationName: 'db-kit-validate-test' });
  // flag is int4 in Postgres on purpose: a `boolean` codec must be refused there.
  await pg.pool.query(`create table items (id bigint primary key, name text not null, flag integer, qty bigint not null,
    total bigint generated always as (qty * 2) stored)`);
  dir = mkdtempSync(join(tmpdir(), 'db-kit-validate-'));
  sqlite = new Database(join(dir, 'app.db'));
  sqlite.exec(`create table items (id integer primary key, name text not null, flag integer, qty integer not null,
    total integer generated always as (qty * 2) stored, note text generated always as (name || '!') virtual)`);
  databases = { sqlite: introspectSqlite(sqlite), postgres: await introspectPostgres(pg.pool) };
}, 180_000);

afterAll(async () => {
  sqlite?.close();
  await pg?.close();
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

function codesOf(issues: readonly ManifestIssue[]): string[] {
  return issues.map((i) => `${i.code}:${i.side}:${i.table}${i.column ? `.${i.column}` : ''}`).sort();
}

describe('introspection', () => {
  it('detects stored and virtual generated columns in SQLite and generated columns in Postgres', () => {
    const sqliteColumns = databases.sqlite.get('items') ?? [];
    expect(sqliteColumns.map((c) => [c.name, c.generated])).toEqual([
      ['id', false], ['name', false], ['flag', false], ['qty', false], ['total', true], ['note', true],
    ]);
    const pgColumns = databases.postgres.get('items') ?? [];
    expect(pgColumns.map((c) => [c.name, c.type, c.generated])).toEqual([
      ['id', 'bigint', false], ['name', 'text', false], ['flag', 'integer', false], ['qty', 'bigint', false], ['total', 'bigint', true],
    ]);
  });
});

describe('validateManifest', () => {
  it('passes when every column is declared and agrees; generated columns are verified, not copied', async () => {
    const db: IntrospectedDatabases = {
      sqlite: new Map([['items', (databases.sqlite.get('items') ?? []).filter((c) => c.name !== 'note')]]),
      postgres: databases.postgres,
    };
    const result = validateManifest(manifestOf(GOOD_COLUMNS), db);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.generated).toEqual([{ table: 'items', column: 'total' }]);
    expect(result.report).toBe('manifest OK: 1 tables, 5 columns, 1 generated (verified, not copied)');
  });

  it('fails an undeclared column by name, on the side that has it', () => {
    const result = validateManifest(manifestOf(GOOD_COLUMNS), databases);
    expect(result.ok).toBe(false);
    expect(codesOf(result.issues)).toEqual(['undeclared-column:sqlite:items.note']);
    expect(result.report).toContain('FAIL [undeclared-column] sqlite column items.note is not declared in the manifest');
  });

  it('fails a declared column that is missing from a side', () => {
    const result = validateManifest(manifestOf({ ...GOOD_COLUMNS, ghost: { codec: 'text', nullable: true } }), databases);
    expect(codesOf(result.issues)).toEqual([
      'missing-column:postgres:items.ghost',
      'missing-column:sqlite:items.ghost',
      'undeclared-column:sqlite:items.note',
    ]);
  });

  it('fails a declared table that is missing and an undeclared table by name', async () => {
    const missing = validateManifest(manifestOf(GOOD_COLUMNS, { nope: { columns: { id: { codec: 'integer', nullable: false } }, primaryKey: ['id'] } }), databases);
    expect(codesOf(missing.issues)).toContain('missing-table:postgres:nope');
    expect(codesOf(missing.issues)).toContain('missing-table:sqlite:nope');
    await pg.pool.query('create table orphan (id bigint primary key)');
    try {
      const withOrphan = { sqlite: databases.sqlite, postgres: await introspectPostgres(pg.pool) };
      expect(codesOf(validateManifest(manifestOf(GOOD_COLUMNS), withOrphan).issues)).toContain('undeclared-table:postgres:orphan');
    } finally {
      await pg.pool.query('drop table orphan');
    }
  });

  it('fails a codec whose expected Postgres type is not the real column type', () => {
    const result = validateManifest(manifestOf({ ...GOOD_COLUMNS, flag: { codec: 'boolean', nullable: true } }), databases);
    expect(codesOf(result.issues)).toContain('pg-type-mismatch:postgres:items.flag');
    expect(result.report).toContain('items.flag uses codec boolean (expects boolean) but the Postgres column is integer');
  });

  it('requires generated columns to be declared, and declared ones to be generated', () => {
    const undeclared = validateManifest(manifestOf({ ...GOOD_COLUMNS, total: { codec: 'integer', nullable: false } }), databases);
    expect(codesOf(undeclared.issues)).toContain('generated-undeclared:sqlite:items.total');
    expect(codesOf(undeclared.issues)).toContain('generated-undeclared:postgres:items.total');
    const plainDeclaredGenerated = validateManifest(manifestOf({ ...GOOD_COLUMNS, qty: { codec: 'integer', nullable: false, generated: true } }), databases);
    expect(codesOf(plainDeclaredGenerated.issues)).toContain('generated-mismatch:sqlite:items.qty');
    expect(codesOf(plainDeclaredGenerated.issues)).toContain('generated-mismatch:postgres:items.qty');
  });
});
