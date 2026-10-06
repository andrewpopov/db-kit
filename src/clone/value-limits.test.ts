import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TableInput } from '../codecs/manifest.js';
import { liveSqlite, manifestOf, scratchDir, targetDatabase, type TargetDatabase } from '../test-support/clone-fixture.js';
import { startThrowawayPostgres, type ThrowawayPostgres } from '../test-support/embedded-pg.js';
import { CloneRefusal, type Refusal } from './errors.js';
import { executeClone } from './execute.js';
import { planClone, type PlanOptions } from './plan.js';

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
