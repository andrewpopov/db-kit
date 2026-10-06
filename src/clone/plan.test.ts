import { rmSync } from 'node:fs';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodecManifestInput } from '../codecs/manifest.js';
import { liveSqlite, manifestOf, scratchDir, targetDatabase, type TargetDatabase } from '../test-support/clone-fixture.js';
import { startThrowawayPostgres, type ThrowawayPostgres } from '../test-support/embedded-pg.js';
import { CloneRefusal, type Refusal } from './errors.js';
import { planClone, planFromSnapshot, type ClonePlan, type PlanOptions } from './plan.js';
import { takeSnapshot } from './snapshot.js';
import type { TopologyEntry } from './topology.js';

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

type Columns = CodecManifestInput['tables'][string]['columns'];
const int = { codec: 'integer', nullable: false } as const;
const text = { codec: 'text', nullable: false } as const;
const table = (columns: Columns, primaryKey: string[] = ['id']): CodecManifestInput['tables'][string] => ({ columns, primaryKey });

const ITEMS = manifestOf({ version: 1, tables: { items: table({ id: int, name: text }) } });
const ITEMS_DDL = ['create table items(id bigint primary key, name text not null)'];
const ITEMS_LIVE = liveSqlite(dir, ['create table items(id integer primary key, name text not null)', "insert into items values (1, 'a'), (2, 'b'), (3, 'c')"]);

const PARENT_CHILD = manifestOf({ version: 1, tables: { parent: table({ id: int }), child: table({ id: int, parent_id: int }) } });
const PARENT_CHILD_DDL = ['create table parent(id bigint primary key)', 'create table child(id bigint primary key, parent_id bigint not null)'];
const PARENT_CHILD_LIVE = liveSqlite(dir, ['create table parent(id integer primary key)', 'create table child(id integer primary key, parent_id integer not null)']);
const FK = 'alter table child add constraint child_parent_fk foreign key (parent_id) references parent(id)';

const confirmationOf = (db: TargetDatabase): string => `${db.config.host}:${db.config.port}/${db.config.database}`;

async function create(ddl: readonly string[], target: ThrowawayPostgres = server): Promise<TargetDatabase> {
  const db = await targetDatabase(target, ddl);
  open.push(db);
  return db;
}

function planOf(db: TargetDatabase, overrides: Partial<PlanOptions> = {}): Promise<ClonePlan> {
  return planClone({ livePath: ITEMS_LIVE, writersStopped: true, manifest: ITEMS, target: db.config, confirmProduction: confirmationOf(db), ...overrides });
}

async function refusalOf(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CloneRefusal) return error.refusal;
    throw error;
  }
  throw new Error('expected a CloneRefusal');
}

describe('a clean target', () => {
  it('plans with no refusals, and reads the target without writing anything', async () => {
    const db = await create(ITEMS_DDL);
    const seen: string[] = [];
    const plan = await planOf(db, {
      wrapClient: (client) => {
        const original = client.query.bind(client) as (...args: unknown[]) => unknown;
        client.query = ((text: unknown, ...rest: unknown[]) => {
          seen.push(typeof text === 'string' ? text : '(config)');
          return original(text, ...rest);
        }) as typeof client.query;
        return client;
      },
    });
    expect(plan.refusals).toEqual([]);
    expect(plan.ok).toBe(true);
    expect(plan.tables).toEqual([{ table: 'items', rows: 3, estimatedBytes: expect.any(Number), targetNonEmpty: false, willTruncate: false }]);
    expect(plan.tables[0]?.estimatedBytes).toBeGreaterThan(0);
    expect(seen[0]).toBe('BEGIN READ ONLY');
    expect(seen.filter((sql) => /^\s*(insert|update|delete|create|alter|drop|truncate|grant|comment)\b/i.test(sql))).toEqual([]);
    expect(seen.at(-1)).toBe('ROLLBACK');
    const schemas = await db.admin.query("select 1 from pg_namespace where nspname = 'db_kit'");
    expect(schemas.rowCount).toBe(0);
    expect((await db.admin.query('select count(*)::int as n from items')).rows[0]).toEqual({ n: 0 });
  });
});

interface RefusalCase {
  name: string;
  ddl: string[];
  expected: Refusal[];
  manifest?: typeof ITEMS;
  live?: string;
  truncate?: boolean;
}

const NOOP_TRIGGER = ['create function noop() returns trigger language plpgsql as $$ begin return new; end $$', 'create trigger t before insert on items for each row execute function noop()'];
const RECEIPT = 'create table db_kit.clone_receipt(run_id uuid primary key, started_at timestamptz not null, manifest_sha text not null, per_table jsonb not null)';
const RECEIPT_REFUSAL: Refusal = { code: 'receipt-table-invalid', table: 'db_kit.clone_receipt' };
const SEQ_ITEMS = (identity: string): string[] => [`create table items(id bigint generated by default as identity ${identity} primary key, name text not null)`];

const CASES: RefusalCase[] = [
  // schema gate: shape
  { name: 'an extra undeclared Postgres column', ddl: [...ITEMS_DDL, 'alter table items add column extra int'], expected: [{ code: 'manifest-invalid', table: 'items', column: 'extra', object: 'postgres:undeclared-column' }] },
  { name: 'a primary key wider than the manifest', ddl: ['create table items(id bigint, name text not null, primary key (id, name))'], expected: [{ code: 'primary-key-mismatch', table: 'items' }] },
  { name: 'a table with no primary key', ddl: ['create table items(id bigint not null, name text not null)'], expected: [{ code: 'primary-key-mismatch', table: 'items' }] },
  { name: 'a column nullable in Postgres but declared non-nullable', ddl: ['create table items(id bigint primary key, name text)'], expected: [{ code: 'nullability-mismatch', table: 'items', column: 'name' }] },
  {
    name: 'a column NOT NULL in Postgres but declared nullable',
    ddl: ITEMS_DDL,
    manifest: manifestOf({ version: 1, tables: { items: table({ id: int, name: { codec: 'text', nullable: true } }) } }),
    expected: [{ code: 'nullability-mismatch', table: 'items', column: 'name' }],
  },
  { name: 'a partitioned table', ddl: ['create table items(id bigint primary key, name text not null) partition by range (id)'], expected: [{ code: 'partitioned-table', table: 'items' }] },
  {
    name: 'inheritance (parent and child both declared)',
    ddl: [...ITEMS_DDL, 'create table items_child (primary key (id)) inherits (items)'],
    manifest: manifestOf({ version: 1, tables: { items: table({ id: int, name: text }), items_child: table({ id: int, name: text }) } }),
    live: liveSqlite(dir, ['create table items(id integer primary key, name text not null)', 'create table items_child(id integer primary key, name text not null)']),
    expected: [
      { code: 'inherited-table', table: 'items' },
      { code: 'inherited-table', table: 'items_child' },
    ],
  },
  {
    name: 'a declared foreign table (invisible to the table catalog, so the manifest check refuses it)',
    ddl: [...ITEMS_DDL, 'create foreign data wrapper w', 'create server s foreign data wrapper w', 'create foreign table ft(id int) server s'],
    manifest: manifestOf({ version: 1, tables: { items: table({ id: int, name: text }), ft: table({ id: int }) } }),
    live: liveSqlite(dir, ['create table items(id integer primary key, name text not null)', 'create table ft(id integer primary key)']),
    expected: [{ code: 'manifest-invalid', table: 'ft', object: 'postgres:missing-table' }],
  },
  // triggers, rules, row security
  ...(['enable', 'enable always', 'enable replica', 'disable'] as const).map(
    (mode): RefusalCase => ({ name: `a user trigger (${mode})`, ddl: [...ITEMS_DDL, ...NOOP_TRIGGER, `alter table items ${mode} trigger t`], expected: [{ code: 'trigger-present', table: 'items', object: 't' }] }),
  ),
  { name: 'a rule', ddl: [...ITEMS_DDL, 'create rule r as on insert to items do also notify chan'], expected: [{ code: 'rule-present', table: 'items', object: 'r' }] },
  { name: 'row level security', ddl: [...ITEMS_DDL, 'alter table items enable row level security'], expected: [{ code: 'row-security-enabled', table: 'items' }] },
  // foreign keys
  { name: 'a NOT VALID foreign key', ddl: [...PARENT_CHILD_DDL, `${FK} not valid`], manifest: PARENT_CHILD, live: PARENT_CHILD_LIVE, expected: [{ code: 'foreign-key-not-valid', table: 'child', object: 'child_parent_fk' }] },
  { name: 'a comment on a foreign key constraint', ddl: [...PARENT_CHILD_DDL, FK, "comment on constraint child_parent_fk on child is 'keep me'"], manifest: PARENT_CHILD, live: PARENT_CHILD_LIVE, expected: [{ code: 'constraint-has-comment', table: 'child', object: 'child_parent_fk' }] },
  {
    name: 'an incoming reference from a table that is not copied, when truncate is requested',
    ddl: [...ITEMS_DDL, 'create schema other', 'create table other.ref(item_id bigint references public.items(id))'],
    truncate: true,
    expected: [{ code: 'incoming-reference-from-uncopied-table', table: 'items', object: 'other.ref.ref_item_id_fkey' }],
  },
  // replication and DDL hooks
  { name: 'an event trigger', ddl: [...ITEMS_DDL, 'create function evt() returns event_trigger language plpgsql as $$ begin end $$', 'create event trigger e on ddl_command_start execute function evt()'], expected: [{ code: 'event-trigger-present', object: 'e' }] },
  { name: 'a publication naming the table', ddl: [...ITEMS_DDL, 'create publication pub for table items'], expected: [{ code: 'publication-covers-table', table: 'items', object: 'pub' }] },
  { name: 'a subscription', ddl: [...ITEMS_DDL, "create subscription sub connection 'host=127.0.0.1 port=1 dbname=none' publication p with (connect = false)"], expected: [{ code: 'subscription-present' }] },
  // sequences
  { name: 'a sequence nobody owns', ddl: ['create sequence s1', "create table items(id bigint primary key default nextval('s1'), name text not null)"], expected: [{ code: 'sequence-unowned', table: 'items', column: 'id', object: 'public.s1' }] },
  {
    name: 'a sequence shared by two tables',
    ddl: ['create table a(id bigserial primary key)', "create table b(id bigint primary key default nextval('a_id_seq'))"],
    manifest: manifestOf({ version: 1, tables: { a: table({ id: int }), b: table({ id: int }) } }),
    live: liveSqlite(dir, ['create table a(id integer primary key)', 'create table b(id integer primary key)']),
    expected: [{ code: 'sequence-shared', table: 'a', column: 'id', object: 'public.a_id_seq' }],
  },
  { name: 'a cycling sequence', ddl: SEQ_ITEMS('(cycle)'), expected: [{ code: 'sequence-cycles', table: 'items', column: 'id', object: 'public.items_id_seq' }] },
  {
    name: 'a late-bound nextval default in another schema on a copied sequence',
    ddl: ['create table items(id bigserial primary key, name text not null)', 'create schema other', "create table other.orders(id bigint primary key default nextval('public.items_id_seq'::text))"],
    expected: [{ code: 'sequence-dynamic-default', table: 'other.orders', column: 'id' }],
  },
  {
    name: 'a regclass nextval default in another schema on a copied sequence',
    ddl: ['create table items(id bigserial primary key, name text not null)', 'create schema other', "create table other.orders(id bigint primary key default nextval('public.items_id_seq'::regclass))"],
    expected: [{ code: 'sequence-shared', table: 'items', column: 'id', object: 'public.items_id_seq' }],
  },
  { name: 'a schema publication that would adopt a future receipt table', ddl: [...ITEMS_DDL, 'create schema db_kit', 'create publication p_schema for tables in schema db_kit'], expected: [{ code: 'receipt-table-invalid', table: 'db_kit.clone_receipt', object: 'p_schema' }] },
  { name: 'a FOR ALL TABLES publication also adopts a future receipt table', ddl: [...ITEMS_DDL, 'create publication p_all for all tables'], expected: [{ code: 'publication-covers-table', table: 'items', object: 'p_all' }, { code: 'receipt-table-invalid', table: 'db_kit.clone_receipt', object: 'p_all' }] },
  {
    name: 'an incoming NOT VALID foreign key from an uncopied table',
    ddl: [...ITEMS_DDL, 'create schema other', 'create table other.child(item_id bigint)', 'insert into other.child values (5)', 'alter table other.child add constraint child_fk foreign key (item_id) references public.items(id) not valid'],
    expected: [{ code: 'foreign-key-not-valid', table: 'other.child', object: 'child_fk' }],
  },
  ...(['decimal-as-string', 'timestamp-iso'] as const).map(
    (codec): RefusalCase => ({
      name: `a ${codec} primary key that reorders on conversion (row-by-row verification could not line the sides up)`,
      ddl: [`create table k(id ${codec === 'decimal-as-string' ? 'numeric' : 'timestamptz'} primary key)`],
      manifest: manifestOf({ version: 1, tables: { k: table({ id: codec === 'decimal-as-string' ? { codec, nullable: false } : { codec, preserveText: false, nullable: false } }) } }),
      live: liveSqlite(dir, ['create table k(id text primary key)']),
      expected: [{ code: 'primary-key-order-unsupported', table: 'k', column: 'id' }],
    }),
  ),
  // emptiness
  { name: 'a non-empty table', ddl: [...ITEMS_DDL, "insert into items values (9, 'x')"], expected: [{ code: 'target-not-empty', table: 'items' }] },
  // the receipt table
  { name: 'a receipt table of the right shape is accepted', ddl: ['create schema db_kit', RECEIPT, ...ITEMS_DDL], expected: [] },
  { name: 'an existing db_kit schema without the table is accepted', ddl: ['create schema db_kit', ...ITEMS_DDL], expected: [] },
  { name: 'a receipt table with a wrong column type', ddl: ['create schema db_kit', 'create table db_kit.clone_receipt(run_id text primary key, started_at timestamptz not null, manifest_sha text not null, per_table jsonb not null)', ...ITEMS_DDL], expected: [RECEIPT_REFUSAL] },
  { name: 'a receipt table with an extra column', ddl: ['create schema db_kit', RECEIPT, 'alter table db_kit.clone_receipt add column extra int', ...ITEMS_DDL], expected: [RECEIPT_REFUSAL] },
  { name: 'a receipt table without its primary key', ddl: ['create schema db_kit', 'create table db_kit.clone_receipt(run_id uuid, started_at timestamptz not null, manifest_sha text not null, per_table jsonb not null)', ...ITEMS_DDL], expected: [RECEIPT_REFUSAL] },
  { name: 'a receipt table with row level security', ddl: ['create schema db_kit', RECEIPT, 'alter table db_kit.clone_receipt enable row level security', ...ITEMS_DDL], expected: [RECEIPT_REFUSAL] },
  {
    name: 'a receipt table with a trigger',
    ddl: ['create schema db_kit', RECEIPT, 'create function db_kit.noop() returns trigger language plpgsql as $$ begin return new; end $$', 'create trigger t before insert on db_kit.clone_receipt for each row execute function db_kit.noop()', ...ITEMS_DDL],
    expected: [RECEIPT_REFUSAL],
  },
  { name: 'a receipt table in a publication', ddl: ['create schema db_kit', RECEIPT, 'create publication pub_receipt for table db_kit.clone_receipt', ...ITEMS_DDL], expected: [RECEIPT_REFUSAL] },
  { name: 'db_kit.clone_receipt that is a view', ddl: ['create schema db_kit', 'create view db_kit.clone_receipt as select 1 as run_id', ...ITEMS_DDL], expected: [RECEIPT_REFUSAL] },
];

describe('refusals, each triggered by a real offending object', () => {
  for (const c of CASES) {
    it(`${c.expected.length === 0 ? 'accepts' : 'refuses'}: ${c.name}`, async () => {
      const db = await create(c.ddl);
      const plan = await planOf(db, { manifest: c.manifest ?? ITEMS, livePath: c.live ?? ITEMS_LIVE, truncate: c.truncate === true });
      expect(plan.refusals).toEqual(c.expected);
      expect(plan.ok).toBe(c.expected.length === 0);
    }, 30_000);
  }

  it('lists incoming references from uncopied tables without refusing when not truncating', async () => {
    const db = await create([...ITEMS_DDL, 'create schema other', 'create table other.ref(item_id bigint references public.items(id))']);
    const plan = await planOf(db);
    expect(plan.refusals).toEqual([]);
    expect(plan.incomingReferences.map((fk) => `${fk.tableSchema}.${fk.table}.${fk.name}`)).toEqual(['other.ref.ref_item_id_fkey']);
    expect(plan.foreignKeys).toEqual([]);
  });

  it('allows a non-empty table when truncate is requested, and says it will truncate', async () => {
    const db = await create([...ITEMS_DDL, "insert into items values (9, 'x')"]);
    const plan = await planOf(db, { truncate: true });
    expect(plan.refusals).toEqual([]);
    expect(plan.tables[0]).toMatchObject({ table: 'items', targetNonEmpty: true, willTruncate: true });
  });

  it('refuses a sequence whose restart value would leave its max', async () => {
    const db = await create(SEQ_ITEMS('(maxvalue 10)'));
    const live = liveSqlite(dir, ['create table items(id integer primary key, name text not null)', "insert into items values (10, 'last')"]);
    const plan = await planOf(db, { livePath: live });
    expect(plan.refusals).toEqual([{ code: 'sequence-out-of-range', table: 'items', column: 'id', object: 'public.items_id_seq' }]);
  });
});

describe('ownership and capabilities (a non-superuser role)', () => {
  async function asRole(role: string, ddl: string[]): Promise<TargetDatabase> {
    const db = await create([`create role ${role} login password 'pw-${role}'`, ...ITEMS_DDL, ...ddl]);
    return { ...db, config: { ...db.config, user: role, password: `pw-${role}` } };
  }

  it('refuses tables the role does not own, and a database it cannot CREATE in', async () => {
    const db = await asRole('cloner_a', ['grant usage on schema public to cloner_a', 'grant select on items to cloner_a']);
    const plan = await planOf(db);
    expect(plan.refusals).toEqual([{ code: 'not-owner', table: 'items' }, { code: 'no-create-privilege', object: 'db_kit' }]);
  });

  it('accepts an owner with CREATE on the database', async () => {
    const db = await asRole('cloner_b', ['alter table items owner to cloner_b', 'grant create on database {db} to cloner_b']);
    expect((await planOf(db)).refusals).toEqual([]);
  });

  it('refuses an owner without CREATE on the database', async () => {
    const db = await asRole('cloner_c', ['alter table items owner to cloner_c']);
    expect((await planOf(db)).refusals).toEqual([{ code: 'no-create-privilege', object: 'db_kit' }]);
  });
});

describe('target identity and production gating', () => {
  const systemIdentifier = async (db: TargetDatabase): Promise<string> => ((await db.admin.query<{ id: string }>('select system_identifier::text as id from pg_control_system()')).rows[0]?.id ?? '');
  const entry = async (db: TargetDatabase, over: Partial<TopologyEntry>): Promise<TopologyEntry> => ({
    host: db.config.host,
    port: db.config.port,
    systemIdentifier: await systemIdentifier(db),
    database: db.config.database,
    production: false,
    ...over,
  });

  it('treats a target as production without a topology and demands the exact confirmation', async () => {
    const db = await create(ITEMS_DDL);
    const unconfirmed = await planOf(db, { confirmProduction: undefined });
    expect(unconfirmed.refusals).toEqual([{ code: 'production-unconfirmed' }]);
    expect(unconfirmed.target).toMatchObject({ production: true, confirmation: confirmationOf(db), database: db.config.database, host: db.config.host, port: db.config.port, inRecovery: false });
    expect(unconfirmed.target?.systemIdentifier).toBe(await systemIdentifier(db));
    expect(unconfirmed.target?.serverVersion).toMatch(/^17/);
    expect((await planOf(db, { confirmProduction: db.config.database })).refusals).toEqual([{ code: 'production-unconfirmed' }]);
    expect((await planOf(db)).refusals).toEqual([]);
  });

  it('is non-production only when every field matches a production:false entry', async () => {
    const db = await create(ITEMS_DDL);
    const none = { confirmProduction: undefined };
    const exact = await planOf(db, { ...none, topology: [await entry(db, {})] });
    expect(exact.refusals).toEqual([]);
    expect(exact.target?.production).toBe(false);
    const wrong: Partial<TopologyEntry>[] = [{ systemIdentifier: '1' }, { database: 'other' }, { port: db.config.port + 1 }, { host: 'localhost' }, { production: true }];
    for (const over of wrong) {
      const plan = await planOf(db, { ...none, topology: [await entry(db, over)] });
      expect(plan.refusals, JSON.stringify(over)).toEqual([{ code: 'production-unconfirmed' }]);
    }
  });

  it('stays production when one entry says production:false and another matching entry says true', async () => {
    const db = await create(ITEMS_DDL);
    const plan = await planOf(db, { confirmProduction: undefined, topology: [await entry(db, {}), await entry(db, { production: true })] });
    expect(plan.refusals).toEqual([{ code: 'production-unconfirmed' }]);
  });

  it('refuses a target in recovery (the identity answer is stubbed: a real standby is impractical here)', async () => {
    const db = await create(ITEMS_DDL);
    const plan = await planOf(db, {
      wrapClient: (client) => {
        const original = client.query.bind(client) as (...args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
        client.query = (async (text: unknown, ...rest: unknown[]) => {
          const result = await original(text, ...rest);
          return typeof text === 'string' && text.includes('pg_control_system') ? { ...result, rows: result.rows.map((row) => ({ ...row, recovery: true })) } : result;
        }) as typeof client.query;
        return client;
      },
    });
    expect(plan.refusals).toEqual([{ code: 'target-in-recovery' }]);
    expect(plan.target?.inRecovery).toBe(true);
    expect(plan.tables).toEqual([]);
  });

  it('reports a connection failure as a typed refusal that never contains the password', async () => {
    const db = await create(ITEMS_DDL);
    const refusal = await refusalOf(() => planOf(db, { target: { ...db.config, password: 'hunter2-secret' } }));
    expect(refusal).toEqual({ code: 'target-connect-failed' });
    expect(JSON.stringify(refusal)).not.toContain('hunter2');
  });

  it('refuses before anything else when writers are not stopped', async () => {
    const db = await create(ITEMS_DDL);
    expect(await refusalOf(() => planOf(db, { writersStopped: false }))).toEqual({ code: 'writers-not-stopped' });
  });
});

describe('source-side refusals', () => {
  it('refuses a TEXT value containing NUL, naming table.column, but allows NUL inside a blob column', async () => {
    const db = await create(['create table items(id bigint primary key, name text not null, payload bytea not null)']);
    const manifest = manifestOf({ version: 1, tables: { items: table({ id: int, name: text, payload: { codec: 'blob', nullable: false } }) } });
    const clean = liveSqlite(dir, ['create table items(id integer primary key, name text not null, payload blob not null)', "insert into items values (1, 'ok', x'00ff00')"]);
    expect((await planOf(db, { manifest, livePath: clean })).refusals).toEqual([]);
    const nul = liveSqlite(dir, ['create table items(id integer primary key, name text not null, payload blob not null)', "insert into items values (1, 'ok', x'00'), (2, 'a' || char(0) || 'b', x'01')"]);
    expect((await planOf(db, { manifest, livePath: nul })).refusals).toEqual([{ code: 'source-nul-in-text', table: 'items', column: 'name' }]);
  });
});

describe('the plan itself', () => {
  it('captures FK cycles, a self-reference, a descending sequence and the sqlite_sequence high-water', async () => {
    const db = await create([
      'create table a(id bigint primary key, b_id bigint)',
      'create table b(id bigint primary key, a_id bigint)',
      'alter table a add constraint a_b_fk foreign key (b_id) references b(id) on delete cascade deferrable initially deferred',
      'alter table b add constraint b_a_fk foreign key (a_id) references a(id) on update set null',
      'create table node(id bigint primary key, parent_id bigint)',
      'alter table node add constraint node_parent_fk foreign key (parent_id) references node(id)',
      'create table ticket(id bigint generated by default as identity (start with -1 increment by -1 minvalue -1000 maxvalue -1) primary key)',
      'create table events(id bigint generated by default as identity primary key, label text not null)',
      'create table empty_seq(id bigint generated always as identity (start with 7 increment by 3) primary key)',
    ]);
    const nullableInt = { codec: 'integer', nullable: true } as const;
    const manifest = manifestOf({
      version: 1,
      tables: {
        a: table({ id: int, b_id: nullableInt }),
        b: table({ id: int, a_id: nullableInt }),
        node: table({ id: int, parent_id: nullableInt }),
        ticket: table({ id: int }),
        events: table({ id: int, label: text }),
        empty_seq: table({ id: int }),
      },
    });
    const live = liveSqlite(dir, [
      'create table a(id integer primary key, b_id integer)',
      'create table b(id integer primary key, a_id integer)',
      'create table node(id integer primary key, parent_id integer)',
      'create table ticket(id integer primary key)',
      'create table events(id integer primary key autoincrement, label text not null)',
      'create table empty_seq(id integer primary key)',
      'insert into a values (1, null), (2, null)',
      'insert into b values (10, 1)',
      'update a set b_id = 10 where id = 1',
      'insert into node values (1, null), (2, 1), (3, 2)',
      'insert into ticket values (-1), (-5), (-3)',
      "insert into events(label) values ('1'), ('2'), ('3'), ('4'), ('5')",
      'delete from events where id > 3',
    ]);
    const plan = await planOf(db, { manifest, livePath: live });
    expect(plan.refusals).toEqual([]);

    expect(Object.fromEntries(plan.tables.map((t) => [t.table, t.rows]))).toEqual({ a: 2, b: 1, node: 3, ticket: 3, events: 3, empty_seq: 0 });
    expect(plan.foreignKeys.map((fk) => `${fk.table}.${fk.name}->${fk.refTable}`)).toEqual(['a.a_b_fk->b', 'b.b_a_fk->a', 'node.node_parent_fk->node']);
    const cascade = plan.foreignKeys.find((fk) => fk.name === 'a_b_fk');
    expect(cascade).toMatchObject({ confdeltype: 'c', confupdtype: 'a', confmatchtype: 's', deferrable: true, deferred: true, validated: true, enforced: true, tableSchema: 'public', refSchema: 'public', indexName: 'b_pkey' });
    expect(cascade?.definition).toContain('ON DELETE CASCADE');
    expect(plan.foreignKeys.find((fk) => fk.name === 'b_a_fk')).toMatchObject({ confupdtype: 'n', confdeltype: 'a', deferrable: false, indexName: 'a_pkey' });
    expect(plan.foreignKeys.every((fk) => /^\{\d+\}$/.test(fk.conkey) && /^\{\d+\}$/.test(fk.confkey) && /^\{\d+\}$/.test(fk.conpfeqop))).toBe(true);

    const sequences = Object.fromEntries(plan.sequences.map((s) => [s.table, s]));
    expect(sequences.ticket).toMatchObject({ schema: 'public', name: 'ticket_id_seq', increment: -1n, min: -1000n, max: -1n, start: -1n, restartWith: -6n });
    expect(sequences.events).toMatchObject({ increment: 1n, restartWith: 6n }); // max(id) is 3, the AUTOINCREMENT high-water is 5
    expect(sequences.empty_seq).toMatchObject({ start: 7n, increment: 3n, restartWith: null });
    expect(plan.sequences).toHaveLength(3);
  });
});

describe('the exported planning API never leaks a driver error', () => {
  it('planFromSnapshot maps a raising RLS policy function to preflight-failed without its value', async () => {
    const db = await create([
      'create role rls_owner login password \'pw-rls\'',
      ...ITEMS_DDL,
      "insert into items values (1, 'x')",
      "create function boom(i bigint) returns boolean language plpgsql as $$ begin raise exception 'leaked-value-%', i; end $$",
      'alter table items owner to rls_owner',
      'alter table items enable row level security',
      'alter table items force row level security',
      'create policy p on items using (boom(id))',
      'grant create on database {db} to rls_owner',
    ]);
    const snapshot = await takeSnapshot({ livePath: ITEMS_LIVE, writersStopped: true });
    try {
      const error: unknown = await planFromSnapshot(snapshot, { livePath: ITEMS_LIVE, writersStopped: true, manifest: ITEMS, target: { ...db.config, user: 'rls_owner', password: 'pw-rls' }, confirmProduction: confirmationOf(db) }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CloneRefusal);
      expect((error as CloneRefusal).refusal).toEqual({ code: 'preflight-failed' });
      expect(JSON.stringify(error) + (error as Error).message + (error as Error).stack).not.toContain('leaked-value');
    } finally {
      snapshot.dispose();
    }
  });
});

describe('server-side operational refusals', () => {
  it('refuses a replication slot that retains more WAL than the limit (the 5 GiB default is injectable here)', async () => {
    const db = await create(ITEMS_DDL);
    await db.admin.query("select pg_create_physical_replication_slot('lagslot', true)");
    try {
      await db.admin.query('create schema junk');
      await db.admin.query('create table junk.waste as select generate_series(1, 2000) as n');
      await db.admin.query('select pg_switch_wal()');
      expect((await planOf(db)).refusals).toEqual([]);
      expect((await planOf(db, { maxSlotRetentionBytes: 0n })).refusals).toEqual([{ code: 'replication-slot-lag', object: 'lagslot' }]);
    } finally {
      await db.admin.query("select pg_drop_replication_slot('lagslot')");
    }
  });

  describe('a failing WAL archiver', () => {
    let archiving: ThrowawayPostgres;
    beforeAll(async () => {
      archiving = await startThrowawayPostgres('DNS:localhost', ['-c', 'archive_mode=on', '-c', "archive_command=false"]);
    }, 180_000);
    afterAll(async () => {
      await archiving?.stop();
    }, 60_000);

    it('is refused once the last failure is within 15 minutes', async () => {
      const db = await create(ITEMS_DDL, archiving);
      expect((await planOf(db)).refusals).toEqual([]);
      await db.admin.query('select pg_switch_wal()');
      const deadline = Date.now() + 60_000;
      for (;;) {
        const { rows } = await (db.admin as Client).query<{ failed: boolean }>('select last_failed_time is not null as failed from pg_stat_archiver');
        if (rows[0]?.failed) break;
        if (Date.now() > deadline) throw new Error('the archiver never reported a failure');
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect((await planOf(db)).refusals).toEqual([{ code: 'archiver-failing' }]);
    }, 120_000);
  });
});
