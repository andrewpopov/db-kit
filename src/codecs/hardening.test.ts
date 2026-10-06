import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPostgres, type PostgresHandle } from '../postgres.js';
import { startThrowawayPostgres, type ThrowawayPostgres } from '../test-support/embedded-pg.js';
import { buildCodecs, type ColumnCodec } from './bound.js';
import { CodecError } from './errors.js';
import { introspectPostgres, introspectSqlite, type IntrospectedSchema } from './introspect.js';
import { parseCodecManifest, type CodecManifestInput, type TableInput } from './manifest.js';
import { POSTGRES_CODEC_TYPES } from './pg-types.js';
import { validateManifest } from './validate.js';

type Spec = TableInput['columns'][string];

function codecOf(spec: Spec): ColumnCodec {
  const manifest = parseCodecManifest({ version: 1, tables: { main: { columns: { id: { codec: 'integer', nullable: false }, col: spec }, primaryKey: ['id'] } } } satisfies CodecManifestInput);
  return buildCodecs(manifest).column('main', 'col');
}

function errorOf(fn: () => unknown): CodecError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CodecError) return error;
    throw error;
  }
  throw new Error('expected a CodecError');
}

const schemaOf = (tables: Record<string, string[]>): IntrospectedSchema =>
  new Map(Object.entries(tables).map(([table, columns]) => [table, columns.map((name) => ({ name, type: name === 'id' ? 'bigint' : 'text', generated: false }))]));

const idOnly = { id: { codec: 'integer', nullable: false } } as const;
const jsonSpec = { codec: 'json-text', preserveText: true, nullable: false } as const;

let dir: string;
let server: ThrowawayPostgres;
const handles: PostgresHandle[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'db-kit-hardening-'));
  server = await startThrowawayPostgres();
}, 180_000);

afterAll(async () => {
  await Promise.allSettled(handles.map((h) => h.close()));
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

function pg(options: { codecSession?: boolean } = {}): PostgresHandle {
  const handle = openPostgres(server.config, { applicationName: 'db-kit-hardening', ...options });
  handles.push(handle);
  return handle;
}

describe('P1 duplicate JSON keys: kept verbatim where the target keeps them, refused where one object must result', () => {
  const DUPLICATES = ['{"a":1,"a":2}', '{"x":[{"a":1,"a":2}]}', '{"a":1,"\\u0061":2}'];

  for (const pgType of ['text', 'json'] as const) {
    it(`pgType=${pgType}: stored verbatim, both directions, and compared as exact text`, () => {
      const codec = codecOf({ codec: 'json-text', pgType, nullable: false });
      for (const text of DUPLICATES) {
        expect(codec.toPostgres(text), text).toBe(text);
        expect(codec.toSqlite(text), text).toBe(text);
        expect(codec.canonical(text, 'sqlite'), text).toBe(text);
      }
      expect(errorOf(() => codec.toPostgres('{"a":1,')).code).toBe('CODEC_INVALID');
    });
  }

  it('pgType=jsonb: refused at any depth, in both directions and in canonical', () => {
    const codec = codecOf({ codec: 'json-text', pgType: 'jsonb', nullable: false });
    for (const text of DUPLICATES) {
      expect(errorOf(() => codec.toPostgres(text)).code, text).toBe('CODEC_INVALID');
      expect(errorOf(() => codec.toSqlite(text)).message, text).toMatch(/^main\.col: .*duplicate/);
      expect(errorOf(() => codec.canonical(text, 'sqlite')).code, text).toBe('CODEC_INVALID');
    }
    expect(codec.toPostgres('{"a":{"a":1},"b":{"a":1}}')).toBe('{"a":{"a":1},"b":{"a":1}}');
  });

  it('NaN and Infinity stay refused for every pgType', () => {
    for (const pgType of ['text', 'json', 'jsonb'] as const) {
      const codec = codecOf({ codec: 'json-text', pgType, nullable: false });
      for (const text of ['{"a":NaN}', '[Infinity]', '{"a":-Infinity}']) expect(errorOf(() => codec.toPostgres(text)).code, `${pgType} ${text}`).toBe('CODEC_INVALID');
    }
  });
});

describe('P1 names that exist on Object.prototype are ordinary names', () => {
  const NAMES = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];

  it('an undeclared table or column with such a name is reported, not waved through', () => {
    const empty = parseCodecManifest({ version: 1, tables: {} });
    for (const name of NAMES) {
      const result = validateManifest(empty, { sqlite: schemaOf({ [name]: ['id'] }), postgres: schemaOf({}) });
      expect(result.issues.map((i) => i.code), name).toEqual(['undeclared-table']);
    }
    const manifest = parseCodecManifest({ version: 1, tables: { t: { columns: idOnly, primaryKey: ['id'] } } });
    for (const name of NAMES) {
      const result = validateManifest(manifest, { sqlite: schemaOf({ t: ['id', name] }), postgres: schemaOf({ t: ['id'] }) });
      expect(result.issues.map((i) => `${i.code}:${i.column}`), name).toEqual([`undeclared-column:${name}`]);
    }
  });

  it('primaryKey must name an OWN declared column', () => {
    for (const name of NAMES) {
      expect(() => parseCodecManifest({ version: 1, tables: { t: { columns: {}, primaryKey: [name] } } }), name).toThrow(/not declared/);
    }
  });

  it('declared tables and columns with such names validate and bind', () => {
    const tables = Object.fromEntries(NAMES.map((table) => [table, { columns: { ...idOnly, ...Object.fromEntries(NAMES.map((c) => [c, { codec: 'text', nullable: true }])) }, primaryKey: ['id'] }]));
    const manifest = parseCodecManifest({ version: 1, tables: { ...tables, anchor: { columns: idOnly, primaryKey: ['id'] } } });
    expect(Object.keys(manifest.tables).sort()).toEqual([...NAMES, 'anchor'].sort());
    const codecs = buildCodecs(manifest);
    for (const table of NAMES) for (const column of NAMES) expect(codecs.column(table, column).toPostgres('x')).toBe('x');
  });
});

describe('P1 SQLite introspection only skips real internal tables', () => {
  it('keeps sqliteXlost, skips sqlite_sequence', () => {
    const db = new Database(join(dir, 'like.db'));
    db.exec('create table sqliteXlost (id integer); create table seq (id integer primary key autoincrement); insert into seq default values;');
    expect([...introspectSqlite(db).keys()].sort()).toEqual(['seq', 'sqliteXlost']);
    db.close();
  });
});

describe('P2 Postgres timestamptz text is deterministic', () => {
  const kolkata = (): Promise<string> =>
    pg().pool
      .connect()
      .then(async (client) => {
        try {
          await client.query("set time zone 'Asia/Kolkata'");
          const { rows } = await client.query<{ t: string }>({ text: "select '1900-01-01 00:00:00+00'::timestamptz as t", types: POSTGRES_CODEC_TYPES });
          return rows[0]?.t ?? '';
        } finally {
          client.release();
        }
      });

  it('second-resolution historical offsets parse to the same instant as UTC', async () => {
    const text = await kolkata();
    expect(text).toMatch(/[+-]\d\d:\d\d:\d\d$/);
    const codec = codecOf({ codec: 'timestamp-iso', preserveText: false, nullable: false });
    expect(codec.canonical(text, 'postgres')).toBe('1900-01-01T00:00:00.000000Z');
    expect(codec.canonical('1900-01-01 00:09:21+00:09:21', 'postgres')).toBe('1900-01-01T00:00:00.000000Z');
  });

  it('codecSession pins TimeZone=UTC and DateStyle=ISO,YMD on every connection', async () => {
    const { rows } = await pg({ codecSession: true }).pool.query<{ tz: string; ds: string; t: string }>({
      text: "select current_setting('TimeZone') as tz, current_setting('DateStyle') as ds, '1900-01-01 00:00:00+00'::timestamptz as t",
      types: POSTGRES_CODEC_TYPES,
    });
    expect(rows[0]).toEqual({ tz: 'UTC', ds: 'ISO, YMD', t: '1900-01-01 00:00:00+00' });
  });
});

describe('P2 zero-column Postgres tables are enumerated', () => {
  it('a zero-column table appears and fails as undeclared', async () => {
    const handle = pg();
    await handle.pool.query('create table lost ()');
    await handle.pool.query('insert into lost default values');
    try {
      const postgres = await introspectPostgres(handle.pool);
      expect(postgres.get('lost')).toEqual([]);
      const result = validateManifest(parseCodecManifest({ version: 1, tables: {} }), { sqlite: schemaOf({}), postgres });
      expect(result.ok).toBe(false);
      expect(result.issues.map((i) => `${i.code}:${i.table}`)).toContain('undeclared-table:lost');
    } finally {
      await handle.pool.query('drop table lost');
    }
  });
});

describe('P2 real -0 cannot survive SQLite', () => {
  it('rejects -0 bound for SQLite, and SQLite really does lose it', () => {
    const db = new Database(join(dir, 'zero.db'));
    db.exec('create table z (r real)');
    db.prepare('insert into z values (?)').run(-0);
    const back = db.prepare<[], { r: number }>('select r from z').get()?.r;
    expect(Object.is(back, 0)).toBe(true);
    db.close();
    const codec = codecOf({ codec: 'real', nullable: false });
    expect(errorOf(() => codec.toSqlite(-0)).code).toBe('CODEC_LOSSY');
    expect(codec.toSqlite(0)).toBe(0);
    expect(Object.is(codec.toPostgres(-0), -0)).toBe(true);
  });
});

describe('P2 JSON nesting is bounded', () => {
  it('10000-deep input is a typed error everywhere, never a RangeError', () => {
    const deep = `${'['.repeat(10_000)}0${']'.repeat(10_000)}`;
    for (const preserveText of [true, false]) {
      const codec = codecOf({ codec: 'json-text', preserveText, nullable: false });
      expect(errorOf(() => codec.toPostgres(deep)).message).toMatch(/^main\.col: .*deep/);
      expect(errorOf(() => codec.canonical(deep, 'sqlite')).code).toBe('CODEC_INVALID');
    }
  });

  it('512 levels are accepted, 513 are not', () => {
    const nest = (n: number): string => `${'['.repeat(n)}0${']'.repeat(n)}`;
    const codec = codecOf(jsonSpec);
    expect(codec.canonical(nest(512), 'sqlite')).toBe(nest(512));
    expect(errorOf(() => codec.canonical(nest(513), 'sqlite')).code).toBe('CODEC_INVALID');
  });
});

describe('P2 introspection ignores the caller integer mode', () => {
  it('FTS5 hidden columns stay hidden with defaultSafeIntegers(true)', () => {
    const db = new Database(join(dir, 'fts.db'));
    db.defaultSafeIntegers(true);
    db.exec('create virtual table docs using fts5(body); create table g (id integer primary key, d integer generated always as (id * 2) virtual)');
    const schema = introspectSqlite(db);
    expect(schema.get('docs')?.map((c) => c.name)).toEqual(['body']);
    expect(schema.get('g')?.map((c) => [c.name, c.generated])).toEqual([['id', false], ['d', true]]);
    db.close();
  });
});

describe('P3 generated lists only columns checked on both sides', () => {
  it('a generated column on a table missing from Postgres is not reported as verified', () => {
    const manifest = parseCodecManifest({ version: 1, tables: { t: { columns: { id: { codec: 'integer', nullable: false, generated: true } }, primaryKey: ['id'] } } });
    const sqlite: IntrospectedSchema = new Map([['t', [{ name: 'id', type: 'integer', generated: true }]]]);
    const result = validateManifest(manifest, { sqlite, postgres: new Map() });
    expect(result.ok).toBe(false);
    expect(result.generated).toEqual([]);
  });
});
