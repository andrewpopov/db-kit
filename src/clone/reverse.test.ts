import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCodecs } from '../codecs/bound.js';
import type { CodecManifest, TableInput } from '../codecs/manifest.js';
import { BIG_DDL, BIG_LIVE, BIG_MANIFEST, BIG_SCHEMA, NASTY } from '../test-support/big-fixture.js';
import { liveSqlite, manifestOf, scratchDir, targetDatabase, type TargetDatabase } from '../test-support/clone-fixture.js';
import { startThrowawayPostgres, type ThrowawayPostgres } from '../test-support/embedded-pg.js';
import { postgresUrl } from '../testing/postgres.js';
import { runCloneCli, SOURCE_URL_ENV } from './cli.js';
import { CloneRefusal, type Refusal } from './errors.js';
import { executeClone } from './execute.js';
import { sqliteOrderBy } from './order.js';
import { reverseClone, type ReverseOptions, type ReverseResult } from './reverse.js';
import { openSnapshot } from './source.js';
import { encodeRow } from './verify.js';

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

async function create(ddl: readonly string[]): Promise<TargetDatabase> {
  const db = await targetDatabase(server, ddl);
  open.push(db);
  return db;
}

const confirmationOf = (db: TargetDatabase): string => `${db.config.host}:${db.config.port}/${db.config.database}`;
let counter = 0;
const outputPath = (): string => {
  const folder = join(dir, `out-${++counter}`);
  mkdirSync(folder);
  return join(folder, 'app.db');
};

function options(db: TargetDatabase, manifest: CodecManifest, template: string, extra: Partial<ReverseOptions> = {}): ReverseOptions {
  return { source: db.config, manifest, toSqlitePath: outputPath(), sqliteTemplatePath: template, writersStopped: true, confirmProduction: confirmationOf(db), ...extra };
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

const files = (path: string): string[] => readdirSync(dirname(path)).sort();

// A tiny fixture for refusals.
const ITEMS = manifestOf({ version: 1, tables: { items: { primaryKey: ['id'], columns: { id: { codec: 'integer', nullable: false }, name: { codec: 'text', nullable: false } } } } });
const ITEMS_PG = ['create table items(id bigint primary key, name text not null)', "insert into items values (1, 'a'), (2, 'b')"];
const itemsTemplate = (extra: string[] = []): string => liveSqlite(dir, ['create table items(id integer primary key, name text not null)', ...extra]);

describe('reverseClone: Postgres -> SQLite, the round trip', () => {
  it('forward then reverse equals the original under the codecs, with the sequence high-water, a receipt, and nothing else left behind', async () => {
    const original = BIG_LIVE(dir);
    const db = await create(BIG_DDL);
    await executeClone({ livePath: original, writersStopped: true, manifest: BIG_MANIFEST, target: db.config, confirmProduction: confirmationOf(db) });

    const template = liveSqlite(dir, [...BIG_SCHEMA]);
    const templateBefore = readFileSync(template);
    const opts = options(db, BIG_MANIFEST, template);
    const result = await reverseClone(opts);
    expect(result.outcome).toBe('written');
    expect(result.path).toBe(opts.toSqlitePath);
    expect(files(opts.toSqlitePath)).toEqual(['app.db', 'app.db.receipt.json']);
    expect(readFileSync(template).equals(templateBefore)).toBe(true);
    expect(Object.fromEntries(result.tables.map((t) => [t.table, t.rows]))).toEqual({ a: 2, b: 2, node: 3, events: 3, ticket: 3, people: 10, tokens: 3, labels: 4 });

    // every table, every column (generated ones too), in primary-key order, compared on the codecs' canonical encoding
    const codecs = buildCodecs(BIG_MANIFEST);
    const before = openSnapshot(original);
    const after = openSnapshot(opts.toSqlitePath);
    try {
      for (const [table, spec] of Object.entries(BIG_MANIFEST.tables)) {
        const columns = Object.keys(spec.columns).map((name) => codecs.column(table, name));
        const sql = `select ${columns.map((c) => `"${c.column}"`).join(', ')} from "${table}" order by ${sqliteOrderBy(spec)}`;
        const left = (before.prepare(sql).raw(true).all() as unknown[][]).map((row) => encodeRow(columns, row, 'sqlite').toString('hex'));
        const right = (after.prepare(sql).raw(true).all() as unknown[][]).map((row) => encodeRow(columns, row, 'sqlite').toString('hex'));
        expect(right, table).toEqual(left);
      }
      // and the raw values a canonical form could hide
      const events = after.prepare('select id, label, at_ms, iso, flag, big, dbig, doc, raw, note from events order by id').all() as Record<string, unknown>[];
      expect(events[1]?.label).toBe(NASTY);
      expect(events[0]).toMatchObject({ at_ms: 1709280000124n, iso: '2026-01-01T00:00:00Z', flag: 1n, big: 9007199254740993n, dbig: 18014398509481986n, note: null });
      expect(events[1]?.note).toBe('');
      expect(events.map((e) => e.flag)).toEqual([1n, 0n, 1n]);
      expect(Buffer.isBuffer(events[0]?.raw) && (events[0]?.raw as Buffer).toString('hex')).toBe('00ff5c09');
      expect(JSON.parse(events[0]?.doc as string)).toEqual({ a: [1.0], b: 1 });
      expect(after.prepare("select seq from sqlite_sequence where name = 'events'").get()).toEqual({ seq: 5n }); // original high-water 5, rows only reach 3
      expect(after.prepare('select count(*) as n from pragma_foreign_key_check').get()).toEqual({ n: 0n });
    } finally {
      before.close();
      after.close();
    }

    const receipt = JSON.parse(readFileSync(`${opts.toSqlitePath}.receipt.json`, 'utf8')) as { runId: string; direction: string; source: { database: string; systemIdentifier: string }; tables: { table: string; rows: number; sha256: string }[] };
    expect(receipt).toMatchObject({ runId: result.runId, direction: 'postgres-to-sqlite', source: { database: db.config.database } });
    expect(receipt.tables.find((t) => t.table === 'events')).toEqual({ table: 'events', rows: 3, sha256: result.tables.find((t) => t.table === 'events')?.sha256 });
    // the source was only read
    expect(((await db.admin.query("select count(*)::int as n from pg_namespace where nspname = 'db_kit'")).rows[0] as { n: number }).n).toBe(1); // from the FORWARD run's receipt, not ours
    expect(((await db.admin.query('select count(*)::int as n from db_kit.clone_receipt')).rows[0] as { n: number }).n).toBe(1);
  }, 120_000);

  it('--dry-run does everything including verification, and writes nothing at all', async () => {
    const db = await create(ITEMS_PG);
    const opts = options(db, ITEMS, itemsTemplate(), { dryRun: true });
    const result = await reverseClone(opts);
    expect(result.outcome).toBe('dry-run');
    expect(result.path).toBeNull();
    expect(result.tables).toMatchObject([{ table: 'items', rows: 2 }]);
    expect(files(opts.toSqlitePath)).toEqual([]);
  });

  it('keeps the template journal mode: a WAL template gives a WAL file, with no sidecars left', async () => {
    const db = await create(ITEMS_PG);
    const template = liveSqlite(dir, ['create table items(id integer primary key, name text not null)'], ['journal_mode = wal']);
    const opts = options(db, ITEMS, template);
    await reverseClone(opts);
    expect(files(opts.toSqlitePath)).toEqual(['app.db', 'app.db.receipt.json']);
    const check = new Database(opts.toSqlitePath, { readonly: true });
    expect(check.pragma('journal_mode', { simple: true })).toBe('wal');
    check.close();
  });
});

describe('reverseClone: refusals leave nothing at the target path', () => {
  it('a target path that already exists (a file, or a dangling symlink) is refused untouched', async () => {
    const db = await create(ITEMS_PG);
    const template = itemsTemplate();
    const existing = options(db, ITEMS, template);
    writeFileSync(existing.toSqlitePath, 'precious');
    expect(await refusalOf(() => reverseClone(existing))).toEqual({ code: 'sqlite-target-exists' });
    expect(readFileSync(existing.toSqlitePath, 'utf8')).toBe('precious');
    const dangling = options(db, ITEMS, template);
    symlinkSync(join(dir, 'nowhere'), dangling.toSqlitePath);
    expect(await refusalOf(() => reverseClone(dangling))).toEqual({ code: 'sqlite-target-exists' });
  });

  it('a file appearing at the target path while the clone runs is never overwritten', async () => {
    const db = await create(ITEMS_PG);
    const opts = options(db, ITEMS, itemsTemplate(), { hooks: { beforeRename: (_temp, target) => writeFileSync(target, 'created meanwhile') } });
    expect(await refusalOf(() => reverseClone(opts))).toEqual({ code: 'sqlite-target-exists' });
    expect(readFileSync(opts.toSqlitePath, 'utf8')).toBe('created meanwhile');
    expect(files(opts.toSqlitePath)).toEqual(['app.db']);
  });

  it('template problems: missing, not SQLite, not empty, wrong schema', async () => {
    const db = await create(ITEMS_PG);
    const notSqlite = join(dir, 'notsqlite.db');
    writeFileSync(notSqlite, 'this is not a database'.repeat(100));
    const wrongSchema = liveSqlite(dir, ['create table items(id integer primary key)']);
    // reports a problem without throwing: an index page nobody owns any more
    const damaged = liveSqlite(dir, ['create table items(id integer primary key, name text not null)', 'create index by_name on items(name)', "insert into items values (1, 'a')"]);
    execFileSync('sqlite3', [damaged, '.dbconfig defensive off', "pragma writable_schema = on; delete from sqlite_master where type = 'index' and name = 'by_name';"]);
    const cases: [string, Refusal][] = [
      [join(dir, 'missing.db'), { code: 'sqlite-template-missing' }],
      [notSqlite, { code: 'sqlite-template-invalid' }],
      [damaged, { code: 'sqlite-template-invalid' }],
      [itemsTemplate(["insert into items values (7, 'x')"]), { code: 'sqlite-template-not-empty', table: 'items' }],
      [wrongSchema, { code: 'manifest-invalid', table: 'items', column: 'name', object: 'postgres:undeclared-column' }],
    ];
    for (const [template, expected] of cases) {
      const opts = options(db, ITEMS, template);
      const refusal = await refusalOf(() => reverseClone(opts));
      expect(refusal.code, template).toBe(expected.code);
      if (expected.code !== 'manifest-invalid') expect(refusal).toEqual(expected);
      expect(files(opts.toSqlitePath), template).toEqual([]);
    }
  });

  it('writers not stopped, an unconfirmed production source and a source in recovery are refused', async () => {
    const db = await create(ITEMS_PG);
    const template = itemsTemplate();
    expect(await refusalOf(() => reverseClone(options(db, ITEMS, template, { writersStopped: false })))).toEqual({ code: 'writers-not-stopped' });
    expect(await refusalOf(() => reverseClone(options(db, ITEMS, template, { confirmProduction: undefined })))).toEqual({ code: 'production-unconfirmed' });
    const stubbed = options(db, ITEMS, template, {
      wrapClient: (client) => {
        const original = client.query.bind(client) as (...args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
        client.query = (async (text: unknown, ...rest: unknown[]) => {
          const result = await original(text, ...rest);
          return typeof text === 'string' && text.includes('pg_control_system') ? { ...result, rows: result.rows.map((row) => ({ ...row, recovery: true })) } : result;
        }) as typeof client.query;
        return client;
      },
    });
    expect(await refusalOf(() => reverseClone(stubbed))).toEqual({ code: 'source-in-recovery' });
    expect(files(stubbed.toSqlitePath)).toEqual([]);
  });

  it('lossy values refuse by table.column: -0, and a timestamp finer than epoch milliseconds', async () => {
    const manifest = manifestOf({ version: 1, tables: { m: { primaryKey: ['id'], columns: { id: { codec: 'integer', nullable: false }, r: { codec: 'real', nullable: false }, t: { codec: 'timestamp-epoch-ms', preserveInteger: false, nullable: false } } } } });
    const template = liveSqlite(dir, ['create table m(id integer primary key, r real not null, t integer not null)']);
    const ddl = ['create table m(id bigint primary key, r double precision not null, t timestamptz not null)'];
    const negativeZero = await create([...ddl, "insert into m values (1, '-0'::float8, '2024-03-01 08:00:00.123+00')"]);
    expect(await refusalOf(() => reverseClone(options(negativeZero, manifest, template)))).toEqual({ code: 'codec-lossy', table: 'm', column: 'r' });
    const micros = await create([...ddl, "insert into m values (1, 1.5, '2024-03-01 08:00:00.123456+00')"]);
    const opts = options(micros, manifest, template);
    expect(await refusalOf(() => reverseClone(opts))).toEqual({ code: 'codec-lossy', table: 'm', column: 't' });
    expect(files(opts.toSqlitePath)).toEqual([]);
  });

  it('a foreign key the SQLite schema has but the data violates is refused after the load, before anything is written', async () => {
    const manifest = manifestOf({ version: 1, tables: { parent: { primaryKey: ['id'], columns: { id: { codec: 'integer', nullable: false } } }, child: { primaryKey: ['id'], columns: { id: { codec: 'integer', nullable: false }, parent_id: { codec: 'integer', nullable: false } } } } });
    const db = await create(['create table parent(id bigint primary key)', 'create table child(id bigint primary key, parent_id bigint not null)', 'insert into parent values (1)', 'insert into child values (5, 99)']);
    const template = liveSqlite(dir, ['create table parent(id integer primary key)', 'create table child(id integer primary key, parent_id integer not null references parent(id))']);
    const opts = options(db, manifest, template);
    expect(await refusalOf(() => reverseClone(opts))).toEqual({ code: 'sqlite-foreign-key-violation', table: 'child' });
    expect(files(opts.toSqlitePath)).toEqual([]);
  });

  it('a constraint of the SQLite schema that rejects a row is a load-failed refusal naming the table', async () => {
    const db = await create(ITEMS_PG);
    const template = liveSqlite(dir, ['create table items(id integer primary key, name text not null check (length(name) > 5))']);
    expect(await refusalOf(() => reverseClone(options(db, ITEMS, template)))).toEqual({ code: 'load-failed', table: 'items' });
  });

  it('a file that fails integrity_check (a row that slipped past a CHECK) is refused before COMMIT', async () => {
    const db = await create(ITEMS_PG);
    const template = liveSqlite(dir, ['create table items(id integer primary key, name text not null check (length(name) > 0))']);
    const opts = options(db, ITEMS, template, {
      hooks: {
        afterLoad: (sqlite) => {
          sqlite.pragma('ignore_check_constraints = ON');
          sqlite.exec("insert into items values (99, '')");
          sqlite.pragma('ignore_check_constraints = OFF');
        },
      },
    });
    expect(await refusalOf(() => reverseClone(opts))).toEqual({ code: 'sqlite-integrity-failed' });
    expect(files(opts.toSqlitePath)).toEqual([]);
  });

  it('a verification mismatch injected into the finished file is refused naming table and column, and no file appears', async () => {
    const db = await create(ITEMS_PG);
    const opts = options(db, ITEMS, itemsTemplate(), {
      hooks: {
        beforeVerify: (temp) => {
          const tamper = new Database(temp);
          tamper.exec("update items set name = 'tampered' where id = 2");
          tamper.close();
        },
      },
    });
    expect(await refusalOf(() => reverseClone(opts))).toEqual({ code: 'verification-mismatch', table: 'items', column: 'name' });
    expect(files(opts.toSqlitePath)).toEqual([]);
    expect(((await db.admin.query('select count(*)::int as n from items')).rows[0] as { n: number }).n).toBe(2);
  });

  it('a source that is not valid for the manifest (a primary key it does not have) is refused', async () => {
    const db = await create(['create table items(id bigint, name text not null)', "insert into items values (1, 'a')"]);
    expect(await refusalOf(() => reverseClone(options(db, ITEMS, itemsTemplate())))).toEqual({ code: 'primary-key-mismatch', table: 'items' });
  });
});

describe('reverseClone: review follow-ups', () => {
  it('database defaults of bytea_output=escape and extra_float_digits=0 cannot corrupt a blob or round a float (the session pins both)', async () => {
    const manifest = manifestOf({ version: 1, tables: { m: { primaryKey: ['id'], columns: { id: { codec: 'integer', nullable: false }, raw: { codec: 'blob', nullable: false }, r: { codec: 'real', nullable: false } } } } });
    const db = await create([
      'create table m(id bigint primary key, raw bytea not null, r double precision not null)',
      "insert into m values (1, decode('68656c6c6f', 'hex'), 0.30000000000000004), (2, decode('00ff5c', 'hex'), 1.2345678901234567)",
      "alter database {db} set bytea_output = 'escape'",
      'alter database {db} set extra_float_digits = 0',
    ]);
    const opts = options(db, manifest, liveSqlite(dir, ['create table m(id integer primary key, raw blob not null, r real not null)']));
    await reverseClone(opts);
    const check = new Database(opts.toSqlitePath, { readonly: true });
    expect(check.prepare('select hex(raw) as h, r from m order by id').all()).toEqual([
      { h: '68656C6C6F', r: 0.30000000000000004 },
      { h: '00FF5C', r: 1.2345678901234567 },
    ]);
    check.close();
  });

  it('the verification bytea parser accepts only hex output: an escape-format value is an error, never an empty blob', async () => {
    const { VERIFY_TYPES } = await import('./verify.js');
    const parse = VERIFY_TYPES.getTypeParser(17, 'text') as (text: string) => unknown;
    expect(parse('\\x00ff')).toEqual(Buffer.from([0, 255]));
    expect(parse('\\x')).toEqual(Buffer.alloc(0));
    expect(() => parse('hello')).toThrow(CloneRefusal);
    expect(() => parse('\\000\\377')).toThrow(CloneRefusal);
  });

  it('refuses a non-positive or non-integer fetchRows (FETCH FORWARD 0 would "verify" empty tables) and other bad options', async () => {
    const db = await create(ITEMS_PG);
    const template = itemsTemplate();
    for (const fetchRows of [0, -5, 1.5, Number.NaN]) {
      const opts = options(db, ITEMS, template, { fetchRows });
      expect(await refusalOf(() => reverseClone(opts)), String(fetchRows)).toEqual({ code: 'invalid-option', object: 'fetchRows' });
      expect(files(opts.toSqlitePath)).toEqual([]);
    }
  });

  it('refuses a target whose sidecars exist (a hot journal would be replayed over the verified file), before the load and again at link time', async () => {
    const db = await create(ITEMS_PG);
    const template = itemsTemplate();
    for (const suffix of ['-journal', '-wal', '-shm']) {
      let loaded = false;
      const opts = options(db, ITEMS, template, { hooks: { afterLoad: () => void (loaded = true) } });
      writeFileSync(`${opts.toSqlitePath}${suffix}`, 'stale');
      expect(await refusalOf(() => reverseClone(opts)), suffix).toEqual({ code: 'sqlite-target-exists', object: suffix });
      expect(loaded, `${suffix}: refused before any row was loaded`).toBe(false);
      expect(files(opts.toSqlitePath)).toEqual([`app.db${suffix}`]);
    }
    for (const suffix of ['-journal', '-wal', '-shm']) {
      const opts = options(db, ITEMS, template, { hooks: { beforeRename: (_temp, target) => writeFileSync(`${target}${suffix}`, 'appeared meanwhile') } });
      expect(await refusalOf(() => reverseClone(opts)), suffix).toEqual({ code: 'sqlite-target-exists', object: suffix });
      expect(existsSync(opts.toSqlitePath)).toBe(false);
    }
  });

  it('never replaces an existing receipt file: refused up front, and again just before publishing', async () => {
    const db = await create(ITEMS_PG);
    const template = itemsTemplate();
    const early = options(db, ITEMS, template);
    writeFileSync(`${early.toSqlitePath}.receipt.json`, 'old receipt');
    expect(await refusalOf(() => reverseClone(early))).toEqual({ code: 'sqlite-target-exists', object: '.receipt.json' });
    expect(readFileSync(`${early.toSqlitePath}.receipt.json`, 'utf8')).toBe('old receipt');
    expect(existsSync(early.toSqlitePath)).toBe(false);
    const late = options(db, ITEMS, template, { hooks: { beforeRename: (_temp, target) => writeFileSync(`${target}.receipt.json`, 'appeared meanwhile') } });
    expect(await refusalOf(() => reverseClone(late))).toEqual({ code: 'sqlite-target-exists', object: '.receipt.json' });
    expect(existsSync(late.toSqlitePath)).toBe(false);
    expect(readFileSync(`${late.toSqlitePath}.receipt.json`, 'utf8')).toBe('appeared meanwhile');
  });

  it('a receipt that appears after the database was published is not replaced either: the database stays, with a warning', async () => {
    const db = await create(ITEMS_PG);
    const opts = options(db, ITEMS, itemsTemplate(), { hooks: { afterPublish: (target) => writeFileSync(`${target}.receipt.json`, 'appeared after publish') } });
    const result = await reverseClone(opts);
    expect(result.outcome).toBe('written');
    expect(result.warnings).toEqual(['receipt-not-written']);
    expect(readFileSync(`${opts.toSqlitePath}.receipt.json`, 'utf8')).toBe('appeared after publish');
    expect(existsSync(opts.toSqlitePath)).toBe(true);
  });

  it('a failure after the file is in place is PUBLISHED with warnings, not a refusal: the database is there', async () => {
    const db = await create(ITEMS_PG);
    const opts = options(db, ITEMS, itemsTemplate(), { hooks: { afterPublish: (target) => chmodSync(dirname(target), 0o500) } });
    try {
      const result = await reverseClone(opts);
      expect(result.outcome).toBe('written');
      expect(result.path).toBe(opts.toSqlitePath);
      expect(result.receiptPath).toBeNull();
      expect(result.warnings).toEqual(expect.arrayContaining(['receipt-not-written']));
      expect(existsSync(opts.toSqlitePath)).toBe(true);
    } finally {
      chmodSync(dirname(opts.toSqlitePath), 0o700);
    }
  });

  it('a SQLite foreign key to a copy:false table, in either direction, is refused', async () => {
    const manifest = manifestOf({ version: 1, tables: { items: { primaryKey: ['id'], columns: { id: { codec: 'integer', nullable: false }, name: { codec: 'text', nullable: false }, l: { codec: 'integer', nullable: true } } }, ledger: { copy: false, reason: 'ledger' } } });
    const db = await create(['create table items(id bigint primary key, name text not null, l bigint)', 'create table ledger(id bigint primary key)']);
    const toLedger = liveSqlite(dir, ['create table ledger(id integer primary key)', 'create table items(id integer primary key, name text not null, l integer references ledger(id))']);
    expect(await refusalOf(() => reverseClone(options(db, manifest, toLedger)))).toMatchObject({ code: 'foreign-key-to-skipped-table', table: 'items' });
    const fromLedger = liveSqlite(dir, ['create table items(id integer primary key, name text not null, l integer)', 'create table ledger(id integer primary key, item integer references items(id))']);
    expect(await refusalOf(() => reverseClone(options(db, manifest, fromLedger)))).toMatchObject({ code: 'foreign-key-to-skipped-table', table: 'items' });
  });

  it('a Postgres skipped table referencing a copied table is exported; a copied table referencing a skipped one is refused', async () => {
    const manifest = manifestOf({ version: 1, tables: { items: { primaryKey: ['id'], columns: { id: { codec: 'integer', nullable: false }, name: { codec: 'text', nullable: false }, l: { codec: 'integer', nullable: true } } }, ledger: { copy: false, reason: 'derived' } } });
    const template = liveSqlite(dir, ['create table items(id integer primary key, name text not null, l integer)', 'create table ledger(id integer primary key)']);
    const skippedToCopied = await create(['create table items(id bigint primary key, name text not null, l bigint)', 'create table ledger(id bigint primary key, item bigint references items(id))', "insert into items values (1, 'a', null), (2, 'b', null)"]);
    const result = await reverseClone(options(skippedToCopied, manifest, template));
    expect(result.outcome).toBe('written');
    expect(result.tables.map((t) => [t.table, t.rows])).toEqual([['items', 2]]);
    const copiedToSkipped = await create(['create table ledger(id bigint primary key)', 'create table items(id bigint primary key, name text not null, l bigint constraint items_l_fkey references ledger(id))']);
    expect(await refusalOf(() => reverseClone(options(copiedToSkipped, manifest, template)))).toMatchObject({ code: 'foreign-key-to-skipped-table', table: 'items', object: 'items_l_fkey' });
  });
});

describe('reverseClone: a column that mixed epoch integers and SQLite datetime() text', () => {
  it('forward then reverse normalises every row to an INTEGER and verification passes', async () => {
    const manifest = manifestOf({ version: 1, tables: { bindings: { primaryKey: ['id'], columns: { id: { codec: 'integer', nullable: false }, created_at: { codec: 'timestamp-epoch-ms', preserveInteger: false, acceptSqliteDatetimeText: true, nullable: false } } } } });
    const db = await create(['create table bindings(id bigint primary key, created_at timestamptz not null)']);
    const mixed = liveSqlite(dir, ['create table bindings(id integer primary key, created_at)', "insert into bindings values (1, 1709280000123), (2, '2024-03-01 08:00:00'), (3, '2024-03-01 08:00:00.123')"]);
    await executeClone({ livePath: mixed, writersStopped: true, manifest, target: db.config, confirmProduction: confirmationOf(db) });
    const opts = options(db, manifest, liveSqlite(dir, ['create table bindings(id integer primary key, created_at)']));
    await reverseClone(opts);
    const check = new Database(opts.toSqlitePath, { readonly: true });
    expect(check.prepare('select id, created_at, typeof(created_at) as t from bindings order by id').all()).toEqual([
      { id: 1, created_at: 1709280000123, t: 'integer' },
      { id: 2, created_at: 1709280000000, t: 'integer' },
      { id: 3, created_at: 1709280000123, t: 'integer' },
    ]);
    check.close();
  });
});

describe('reverseClone: a killed process', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  it('SIGKILLed mid-clone leaves no file at the target path (only a hidden temp), and the next run still works', async () => {
    const db = await create(ITEMS_PG);
    const template = itemsTemplate();
    const target = outputPath();
    const work = mkdtempSync(join(tmpdir(), 'db-kit-kill-'));
    try {
      const config = join(work, 'vitest.config.mjs');
      writeFileSync(config, `export default { root: ${JSON.stringify(root)}, test: { pool: 'forks', include: [${JSON.stringify(join(root, 'src/clone/fixtures/reverse-kill.fixture.ts'))}] } };\n`);
      const env: NodeJS.ProcessEnv = { ...process.env, REVERSE_SOURCE_URL: postgresUrl(db.config), REVERSE_TARGET: target, REVERSE_TEMPLATE: template, REVERSE_CONFIRM: confirmationOf(db), NO_COLOR: '1' };
      for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key];
      let status = 0;
      try {
        execFileSync(process.execPath, [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', config], { cwd: root, env, stdio: 'pipe', timeout: 150_000 });
      } catch (error) {
        status = (error as { status?: number }).status ?? -1;
      }
      expect(status).not.toBe(0);
      expect(existsSync(target)).toBe(false);
      expect(existsSync(`${target}.receipt.json`)).toBe(false);
      const left = files(target);
      expect(left.length).toBeGreaterThan(0);
      expect(left.every((name) => name.startsWith('.app.db.db-kit-tmp-'))).toBe(true); // debris is hidden and named, never the target
      expect((await reverseClone({ ...options(db, ITEMS, template), toSqlitePath: target })).outcome).toBe('written');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 240_000);
});

describe('db-kit clone --reverse', () => {
  async function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> {
    let out = '';
    let err = '';
    const code = await runCloneCli(['--reverse', ...args], env, { out: (t) => void (out += `${t}\n`), err: (t) => void (err += `${t}\n`) });
    return { code, out, err };
  }
  const manifestFile = (): string => {
    const path = join(dir, 'reverse-manifest.json');
    writeFileSync(path, JSON.stringify({ version: 1, tables: { items: { primaryKey: ['id'], columns: { id: { codec: 'integer', nullable: false }, name: { codec: 'text', nullable: false } } } } }));
    return path;
  };

  it('exits 3 and says PUBLISHED when the file is in place but a later step warned (the engine is stubbed: the CLI has no failure hook)', async () => {
    let out = '';
    let err = '';
    const result: ReverseResult = { outcome: 'written', runId: 'r', path: '/x/app.db', receiptPath: null, source: { host: 'h', port: 1, database: 'd', systemIdentifier: '1', serverVersion: '17' }, tables: [], sequences: [], totals: { rows: 0, seconds: 0 }, warnings: ['receipt-not-written'] };
    const db = await create(ITEMS_PG);
    const args = ['--reverse', '--to-sqlite', '/x/app.db', '--sqlite-template', 'ignored', '--manifest', manifestFile(), '--writers-stopped'];
    const code = await runCloneCli(args, { [SOURCE_URL_ENV]: postgresUrl(db.config) }, { out: (t) => void (out += t), err: (t) => void (err += t) }, { reverseClone: async () => result });
    expect(code).toBe(3);
    expect(out).toContain('WRITTEN /x/app.db');
    expect(err).toContain('PUBLISHED WITH WARNINGS: receipt-not-written');
    const clean = await runCloneCli(args, { [SOURCE_URL_ENV]: postgresUrl(db.config) }, { out: () => undefined, err: () => undefined }, { reverseClone: async () => ({ ...result, warnings: [] }) });
    expect(clean).toBe(0);
  });

  it('refuses a non-numeric --commit-poll-seconds instead of treating it as zero', async () => {
    const db = await create(['create table items(id bigint primary key, name text not null)']);
    let err = '';
    const result = await runCloneCli(['--from-live', itemsTemplate(), '--manifest', manifestFile(), '--writers-stopped', '--dry-run', '--commit-poll-seconds', 'abc', '--confirm-production', confirmationOf(db)], { DB_KIT_TARGET_URL: postgresUrl(db.config) }, { out: () => undefined, err: (t) => void (err += t) });
    expect(result).toBe(1);
    expect(err).toContain('invalid-option (commit-poll-seconds)');
  });

  it('writes the file and exits 0; --dry-run exits 0 writing nothing; refusals exit 1; usage errors exit 2; the URL comes from DB_KIT_SOURCE_URL only', async () => {
    const db = await create(ITEMS_PG);
    const env = { [SOURCE_URL_ENV]: postgresUrl(db.config) };
    const template = itemsTemplate();
    const target = outputPath();
    const base = ['--to-sqlite', target, '--sqlite-template', template, '--manifest', manifestFile(), '--writers-stopped', '--confirm-production', confirmationOf(db)];
    const dry = await run([...base, '--dry-run'], env);
    expect({ code: dry.code, text: dry.out.includes('DRY RUN') }).toEqual({ code: 0, text: true });
    expect(existsSync(target)).toBe(false);
    const done = await run(base, env);
    expect(done.code).toBe(0);
    expect(done.out).toContain(`WRITTEN ${target}`);
    expect(existsSync(target)).toBe(true);
    expect((await run(base, env)).err.trim()).toBe('REFUSED: sqlite-target-exists');
    expect((await run(base, {})).err.trim()).toBe('REFUSED: source-url-missing');
    expect((await run(base, { [SOURCE_URL_ENV]: 'file:/tmp/x.db' })).err.trim()).toBe('REFUSED: source-not-postgres');
    expect((await run(['--manifest', manifestFile()], env)).code).toBe(2);
    expect((await run([...base, '--plan-only'], env)).code).toBe(2);
    expect(done.out + done.err).not.toContain(db.config.password ?? 'x');
  });
});
