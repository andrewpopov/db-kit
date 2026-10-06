import { rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TableInput } from '../codecs/manifest.js';
import { liveSqlite, manifestOf, scratchDir, targetDatabase, type TargetDatabase } from '../test-support/clone-fixture.js';
import { startThrowawayPostgres, type ThrowawayPostgres } from '../test-support/embedded-pg.js';
import { CloneRefusal, type Refusal } from './errors.js';
import { executeClone } from './execute.js';
import { planToText } from './render.js';
import { planClone, type PlanOptions } from './plan.js';
import { orphanCountSql } from './value-limits.js';

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

const int = { codec: 'integer', nullable: false } as const;
const nullableInt = { codec: 'integer', nullable: true } as const;
const text = { codec: 'text', nullable: false } as const;
const table = (columns: TableInput['columns'], primaryKey: string[] = ['id']): TableInput => ({ columns, primaryKey });

async function optionsFor(ddl: string[], manifestTables: Record<string, TableInput>, live: string[]): Promise<{ db: TargetDatabase; options: PlanOptions }> {
  const db = await targetDatabase(server, ddl);
  open.push(db);
  const options: PlanOptions = { livePath: liveSqlite(dir, live), writersStopped: true, manifest: manifestOf({ version: 1, tables: manifestTables }), target: db.config, confirmProduction: `${db.config.host}:${db.config.port}/${db.config.database}` };
  return { db, options };
}

const planRefusals = async (options: PlanOptions): Promise<Refusal[]> => (await planClone(options)).refusals;

describe('varchar-overflow', () => {
  const run = (pgType: string, values: string[]) =>
    optionsFor([`create table items(id bigint primary key, name ${pgType} not null)`], { items: table({ id: int, name: text }) }, [
      'create table items(id integer primary key, name text not null)',
      ...values.map((value, index) => `insert into items values (${index + 1}, '${value}')`),
    ]);

  it('passes at exactly n characters, counting characters and not bytes', async () => {
    const { options } = await run('varchar(5)', ['abcde', 'ééééé', 'a']);
    expect(await planRefusals(options)).toEqual([]);
  });

  it('refuses n+1 characters naming table.column, the limit, the count and the longest length', async () => {
    const { options } = await run('varchar(5)', ['abcde', 'abcdef', 'ééééééé']);
    expect(await planRefusals(options)).toEqual([{ code: 'varchar-overflow', table: 'items', column: 'name', object: 'max 5 chars, 2 rows over, longest 7' }]);
  });

  it('is re-checked under the locks by executeClone, leaving the target empty', async () => {
    const { db, options } = await run('varchar(5)', ['abcdef']);
    await expect(executeClone(options)).rejects.toMatchObject({ refusal: { code: 'varchar-overflow', table: 'items', column: 'name' } });
    expect((await db.admin.query('select count(*)::int as n from items')).rows[0]).toEqual({ n: 0 });
  });
});

describe('integer-width', () => {
  const run = (pgType: string, values: (string | number)[]) =>
    optionsFor([`create table items(id bigint primary key, n ${pgType} not null)`], { items: table({ id: int, n: int }) }, [
      'create table items(id integer primary key, n integer not null)',
      ...values.map((value, index) => `insert into items values (${index + 1}, ${value})`),
    ]);

  it('passes the int4 extremes and refuses max+1 naming the type and the bound', async () => {
    expect(await planRefusals((await run('integer', [2147483647, -2147483648])).options)).toEqual([]);
    expect(await planRefusals((await run('integer', [2147483648])).options)).toEqual([{ code: 'integer-width', table: 'items', column: 'n', object: 'integer, max 2147483648' }]);
    expect(await planRefusals((await run('integer', [-2147483649])).options)).toEqual([{ code: 'integer-width', table: 'items', column: 'n', object: 'integer, min -2147483649' }]);
  });

  it('checks smallint, and passes a bigint column holding the int64 extremes', async () => {
    expect(await planRefusals((await run('smallint', [32767])).options)).toEqual([]);
    expect(await planRefusals((await run('smallint', [32768])).options)).toEqual([{ code: 'integer-width', table: 'items', column: 'n', object: 'smallint, max 32768' }]);
    expect(await planRefusals((await run('bigint', ['9223372036854775807', '-9223372036854775808'])).options)).toEqual([]);
  });

  it('counts decimal-integer TEXT the integer codec accepts, but not a REAL it refuses', async () => {
    const text = async (value: string, declared = 'text') =>
      optionsFor([`create table items(id bigint primary key, n integer not null)`], { items: table({ id: int, n: int }) }, [`create table items(id integer primary key, n ${declared} not null)`, `insert into items values (1, ${value})`]);
    expect(await planRefusals((await text("'2147483648'")).options)).toEqual([{ code: 'integer-width', table: 'items', column: 'n', object: 'integer, max 2147483648' }]);
    expect(await planRefusals((await text("'-2147483649'")).options)).toEqual([{ code: 'integer-width', table: 'items', column: 'n', object: 'integer, min -2147483649' }]);
    expect(await planRefusals((await text("'0002147483647'")).options)).toEqual([]);
    expect(await planRefusals((await text("'12abc'")).options)).toEqual([]);
    expect(await planRefusals((await text("'-'")).options)).toEqual([]);
    expect(await planRefusals((await text('2147483648.5', 'integer')).options)).toEqual([]);
  });

  it('is re-checked under the locks by executeClone', async () => {
    const { db, options } = await run('integer', [2147483648]);
    await expect(executeClone(options)).rejects.toMatchObject({ refusal: { code: 'integer-width', table: 'items', column: 'n' } });
    expect((await db.admin.query('select count(*)::int as n from items')).rows[0]).toEqual({ n: 0 });
  });
});

describe('orphan-foreign-keys', () => {
  const single = (rows: string[]) =>
    optionsFor(
      ['create table parent(id bigint primary key)', 'create table child(id bigint primary key, parent_id bigint)', 'alter table child add constraint child_parent_fk foreign key (parent_id) references parent(id)'],
      { parent: table({ id: int }), child: table({ id: int, parent_id: nullableInt }) },
      ['create table parent(id integer primary key)', 'create table child(id integer primary key, parent_id integer)', 'insert into parent values (1), (2)', ...rows],
    );

  it('passes when every child has a parent, and ignores NULL key columns', async () => {
    const { options } = await single(['insert into child values (1, 1), (2, 2), (3, null)']);
    expect(await planRefusals(options)).toEqual([]);
  });

  it('refuses an orphan naming the constraint, child, parent and count', async () => {
    const { options } = await single(['insert into child values (1, 1), (2, 99), (3, 98), (4, null)']);
    expect(await planRefusals(options)).toEqual([{ code: 'orphan-foreign-keys', table: 'child', object: 'child_parent_fk -> parent, 2 rows' }]);
  });

  const composite = (rows: string[]) =>
    optionsFor(
      ['create table parent(a bigint, b bigint, primary key (a, b))', 'create table child(id bigint primary key, pa bigint, pb bigint)', 'alter table child add constraint child_parent_fk foreign key (pa, pb) references parent(a, b)'],
      { parent: table({ a: int, b: int }, ['a', 'b']), child: table({ id: int, pa: nullableInt, pb: nullableInt }) },
      ['create table parent(a integer, b integer, primary key (a, b))', 'create table child(id integer primary key, pa integer, pb integer)', 'insert into parent values (1, 1), (1, 2)', ...rows],
    );

  it('detects a composite orphan whose columns each exist in the parent, and skips a row with any NULL column', async () => {
    const { options } = await composite(['insert into child values (1, 1, 2), (2, 2, 1), (3, 1, null), (4, null, 7)']);
    expect(await planRefusals(options)).toEqual([{ code: 'orphan-foreign-keys', table: 'child', object: 'child_parent_fk -> parent, 1 rows' }]);
  });

  it('passes a clean composite key', async () => {
    const { options } = await composite(['insert into child values (1, 1, 2), (2, 1, 1), (3, 1, null)']);
    expect(await planRefusals(options)).toEqual([]);
  });

  it('is re-checked under the locks by executeClone', async () => {
    const { db, options } = await single(['insert into child values (1, 99)']);
    const error = await executeClone(options).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CloneRefusal);
    expect((error as CloneRefusal).refusal.code).toBe('orphan-foreign-keys');
    expect((await db.admin.query('select count(*)::int as n from parent')).rows[0]).toEqual({ n: 0 });
  });
});

describe('orphan-foreign-keys: only where raw SQLite equality is Postgres equality', () => {
  const keyed = (pgType: string, codec: string, parentDdl: string, childDdl: string, parentValue: string, childValue: string) =>
    optionsFor(
      [
        `create table parent(id bigint primary key, k ${pgType} not null unique)`,
        `create table child(id bigint primary key, k ${pgType})`,
        'alter table child add constraint child_parent_fk foreign key (k) references parent(k)',
      ],
      { parent: table({ id: int, k: { codec, nullable: false } as TableInput['columns'][string] }), child: table({ id: int, k: { codec, nullable: true } as TableInput['columns'][string] }) },
      [`create table parent(id integer primary key, k ${parentDdl} not null)`, `create table child(id integer primary key, k ${childDdl})`, `insert into parent values (1, ${parentValue})`, `insert into child values (1, ${childValue})`],
    );
  const planOf = async (options: PlanOptions) => planClone(options);

  it('does not refuse timestamps that spell differently and are the same Postgres timestamp, and says it skipped the check', async () => {
    const { options } = await keyed('timestamp', 'timestamp-naive', 'text', 'text', "'2026-03-01 10:11:12.1'", "'2026-03-01 10:11:12.100000'");
    const plan = await planOf(options);
    expect(plan.refusals).toEqual([]);
    expect(plan.skippedChecks).toEqual([{ code: 'orphan-check-skipped', table: 'child', object: 'child_parent_fk -> parent: codecs timestamp-naive / timestamp-naive are not compared by raw equality' }]);
    expect(planToText(plan)).toContain('orphan-check-skipped: child child_parent_fk -> parent');
  });

  it('does not refuse TEXT-stored integers that spell differently', async () => {
    const { options } = await keyed('bigint', 'integer', 'text', 'text', "'1'", "'01'");
    const plan = await planOf(options);
    expect(plan.refusals).toEqual([]);
    expect(plan.skippedChecks.map((skipped) => skipped.code)).toEqual(['orphan-check-skipped']);
  });

  it('does not refuse UUIDs that differ only in case', async () => {
    const { options } = await keyed('uuid', 'uuid-text', 'text', 'text', "'AAAAAAAA-0000-0000-0000-000000000001'", "'aaaaaaaa-0000-0000-0000-000000000001'");
    expect((await planOf(options)).refusals).toEqual([]);
  });

  it('refuses a key SQLite NOCASE or RTRIM would match but Postgres text equality does not', async () => {
    for (const [collation, child] of [['nocase', "'ABC'"], ['rtrim', "'abc  '"]] as const) {
      const { options } = await keyed('text', 'text', `text collate ${collation}`, `text collate ${collation}`, "'abc'", child);
      expect((await planOf(options)).refusals, collation).toEqual([{ code: 'orphan-foreign-keys', table: 'child', object: 'child_parent_fk -> parent, 1 rows' }]);
    }
  });

  it('still passes a text key that really matches, and checks it', async () => {
    const { options } = await keyed('text', 'text', 'text collate nocase', 'text', "'abc'", "'abc'");
    const plan = await planOf(options);
    expect(plan.refusals).toEqual([]);
    expect(plan.skippedChecks).toEqual([]);
  });

  it('skips (does not guess) an integer key column holding a TEXT value, even a real orphan', async () => {
    const { options } = await keyed('bigint', 'integer', 'integer', 'text', '1', "'99'");
    const plan = await planOf(options);
    expect(plan.refusals).toEqual([]);
    expect(plan.skippedChecks).toHaveLength(1);
  });

  it('is linear: SQLite plans an automatic index on an unindexed parent key instead of scanning it per child', () => {
    const db = new Database(':memory:');
    db.exec('create table parent(id integer primary key, k integer not null); create table child(id integer primary key, k integer)');
    const fk = { table: 'child', refTable: 'parent', columns: ['k'], refColumns: ['k'] };
    for (const kind of ['integer', 'text'] as const) {
      const details = (db.prepare(`explain query plan ${orphanCountSql(fk, [kind])}`).all() as { detail: string }[]).map((row) => row.detail);
      expect(details.some((detail) => /^SCAN p\b/.test(detail)), details.join(' | ')).toBe(false);
      expect(details.join(' | ')).toMatch(/AUTOMATIC (COVERING )?INDEX/);
    }
    db.close();
  });
});
