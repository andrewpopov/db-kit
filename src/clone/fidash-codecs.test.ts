import { rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveSqlite, manifestOf, scratchDir, targetDatabase, type TargetDatabase } from '../test-support/clone-fixture.js';
import { startThrowawayPostgres, type ThrowawayPostgres } from '../test-support/embedded-pg.js';
import { CloneRefusal, type Refusal } from './errors.js';
import { executeClone } from './execute.js';
import { reverseClone } from './reverse.js';

let server: ThrowawayPostgres;
const dir = scratchDir();
const open: TargetDatabase[] = [];
beforeAll(async () => {
  server = await startThrowawayPostgres();
}, 180_000);
afterAll(async () => {
  await Promise.allSettled(open.map((db) => db.close()));
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
}, 60_000);

const confirmationOf = (db: TargetDatabase): string => `${db.config.host}:${db.config.port}/${db.config.database}`;
let counter = 0;
const outputPath = (): string => {
  const folder = join(dir, `out-${++counter}`);
  mkdirSync(folder);
  return join(folder, 'app.db');
};

const manifest = manifestOf({
  version: 1,
  tables: {
    reading: {
      primaryKey: ['id'],
      columns: {
        id: { codec: 'integer', nullable: false },
        at: { codec: 'timestamp-naive', nullable: false },
        day: { codec: 'date-text', nullable: true },
        payload: { codec: 'json-text', pgType: 'json', nullable: true },
      },
    },
  },
});
const PG_DDL = ['create table reading(id bigint primary key, at timestamp not null, day date, payload json)'];
const SQLITE_SCHEMA = 'create table reading(id integer primary key, at text not null, day text, payload text)';
const seeded = (extra: string[] = []): string =>
  liveSqlite(dir, [
    SQLITE_SCHEMA,
    `insert into reading values (1, '2026-03-01 10:11:12', '2026-03-01', '{ "ok": true,  "n": 1.50 }')`,
    `insert into reading values (2, '2026-03-01 10:11:12.123456', null, null)`,
    `insert into reading values (3, '2026-03-01 10:11:12.5', '2024-02-29', '[1,  2]')`,
    ...extra,
  ]);

async function refusalOf(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CloneRefusal) return error.refusal;
    throw error;
  }
  throw new Error('expected a CloneRefusal');
}

describe('clone with timestamp-naive, date-text and json-text pgType: json', () => {
  it('forward lands native Postgres types with microseconds and verbatim json; reverse restores SQLite text and verifies', async () => {
    const db = await targetDatabase(server, PG_DDL);
    open.push(db);
    const result = await executeClone({ livePath: seeded(), writersStopped: true, manifest, target: db.config, confirmProduction: confirmationOf(db) });
    expect(result.outcome).toBe('committed');
    const rows = (await db.admin.query<{ id: string; at: string; day: string | null; payload: string | null }>("select id::text, to_char(at, 'YYYY-MM-DD HH24:MI:SS.US') as at, day::text, payload::text from reading order by id")).rows;
    expect(rows).toEqual([
      { id: '1', at: '2026-03-01 10:11:12.000000', day: '2026-03-01', payload: '{ "ok": true,  "n": 1.50 }' },
      { id: '2', at: '2026-03-01 10:11:12.123456', day: null, payload: null },
      { id: '3', at: '2026-03-01 10:11:12.500000', day: '2024-02-29', payload: '[1,  2]' },
    ]);

    const out = outputPath();
    const reverse = await reverseClone({ source: db.config, manifest, toSqlitePath: out, sqliteTemplatePath: liveSqlite(dir, [SQLITE_SCHEMA]), writersStopped: true, confirmProduction: confirmationOf(db) });
    expect(reverse.outcome).toBe('written');
    const check = new Database(out, { readonly: true });
    expect(check.prepare('select id, at, day, payload from reading order by id').all()).toEqual([
      { id: 1, at: '2026-03-01 10:11:12.000000', day: '2026-03-01', payload: '{ "ok": true,  "n": 1.50 }' },
      { id: 2, at: '2026-03-01 10:11:12.123456', day: null, payload: null },
      { id: 3, at: '2026-03-01 10:11:12.500000', day: '2024-02-29', payload: '[1,  2]' },
    ]);
    check.close();
  });

  it('forward refuses a T-separated timestamp, an impossible date and NaN JSON by table.column, writing nothing', async () => {
    for (const [row, column] of [
      [`(1, '2026-03-01T10:11:12', null, null)`, 'at'],
      [`(1, '2026-03-01 10:11:12', '2026-02-30', null)`, 'day'],
      [`(1, '2026-03-01 10:11:12', null, '{"a": NaN}')`, 'payload'],
    ] as const) {
      const db = await targetDatabase(server, PG_DDL);
      open.push(db);
      const live = liveSqlite(dir, [SQLITE_SCHEMA, `insert into reading values ${row}`]);
      expect(await refusalOf(() => executeClone({ livePath: live, writersStopped: true, manifest, target: db.config, confirmProduction: confirmationOf(db) }))).toEqual({ code: 'codec-invalid', table: 'reading', column });
      expect(((await db.admin.query('select count(*)::int as n from reading')).rows[0] as { n: number }).n).toBe(0);
    }
  });

  it('forward refuses a Postgres column of the wrong type (timestamptz for timestamp-naive)', async () => {
    const db = await targetDatabase(server, ['create table reading(id bigint primary key, at timestamptz not null, day date, payload json)']);
    open.push(db);
    expect((await refusalOf(() => executeClone({ livePath: seeded(), writersStopped: true, manifest, target: db.config, confirmProduction: confirmationOf(db) }))).code).toBe('manifest-invalid');
  });

  it('a timestamp-naive primary key is refused up front: text order and timestamp order can differ for one instant', async () => {
    const db = await targetDatabase(server, ['create table reading(at timestamp primary key)']);
    open.push(db);
    const keyed = manifestOf({ version: 1, tables: { reading: { primaryKey: ['at'], columns: { at: { codec: 'timestamp-naive', nullable: false } } } } });
    const live = liveSqlite(dir, ['create table reading(at text primary key)', "insert into reading values ('2026-03-01 10:11:12')"]);
    expect(await refusalOf(() => executeClone({ livePath: live, writersStopped: true, manifest: keyed, target: db.config, confirmProduction: confirmationOf(db) }))).toEqual({ code: 'primary-key-order-unsupported', table: 'reading', column: 'at' });
  });
});
