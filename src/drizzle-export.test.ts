import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runExportSqliteCli } from './clone/export-cli.js';
import { drizzleExportApp } from './drizzle.js';
import { manifestOf, targetDatabase, type TargetDatabase } from './test-support/clone-fixture.js';
import { startThrowawayPostgres, type ThrowawayPostgres } from './test-support/embedded-pg.js';
import { postgresUrl } from './testing/postgres.js';

const SQLITE_WHEN = 1_700_000_000_000;
const PG_WHEN = 1_700_000_000_123;
const MANIFEST = manifestOf({ version: 1, tables: { items: { primaryKey: ['id'], columns: { id: { codec: 'integer', nullable: false }, label: { codec: 'text', nullable: false } } } } });

let server: ThrowawayPostgres;
const root = mkdtempSync(join(tmpdir(), 'db-kit-drizzle-test-'));
// exportToSqlite's work directories go under os.tmpdir(); keep them out of the shared one, which export-sqlite.test.ts counts when it runs in parallel.
process.env.TMPDIR = root;
const open: TargetDatabase[] = [];
beforeAll(async () => {
  server = await startThrowawayPostgres();
}, 180_000);
afterAll(async () => {
  await Promise.allSettled(open.map((db) => db.close()));
  await server?.stop();
  rmSync(root, { recursive: true, force: true });
}, 60_000);

function writeFolder(name: string, when: number, tag: string, ddl: string): string {
  const folder = join(root, name);
  mkdirSync(join(folder, 'meta'), { recursive: true });
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ version: '7', dialect: 'x', entries: [{ idx: 0, version: '1', when, tag, breakpoints: true }] }));
  writeFileSync(join(folder, `${tag}.sql`), ddl);
  return folder;
}

const sqliteFolder = writeFolder('sqlite', SQLITE_WHEN, '0000_init', 'CREATE TABLE `items` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `label` text NOT NULL);\n');
const pgFolder = writeFolder('pg', PG_WHEN, '0000_init_pg', 'CREATE TABLE "items" ("id" serial PRIMARY KEY NOT NULL, "label" text NOT NULL);\n');

/** A database migrated by drizzle's real Postgres migrator from `folder`, holding three rows. */
async function migratedDatabase(folder: string): Promise<TargetDatabase> {
  const db = await targetDatabase(server, []);
  open.push(db);
  const pool = new Pool({ host: db.config.host, port: db.config.port, user: db.config.user, password: db.config.password, database: db.config.database, ssl: false });
  try {
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally {
    await pool.end();
  }
  await db.admin.query("insert into items(label) values ('a'), ('b'), ('c')");
  return db;
}

let counter = 0;
async function exportCli(db: TargetDatabase, app: ReturnType<typeof drizzleExportApp>): Promise<{ code: number; out: string; err: string; target: string }> {
  const target = join(root, `out-${++counter}.db`);
  let out = '';
  let err = '';
  const confirm = `${db.config.host}:${db.config.port}/${db.config.database}`;
  const code = await runExportSqliteCli(['export-sqlite', target, '--writers-stopped', '--confirm-production', confirm], { out: (t) => void (out += t), err: (t) => void (err += t) }, { DATABASE_URL: postgresUrl(db.config) }, app);
  return { code, out, err, target };
}

const app = (postgresMigrationsFolder = pgFolder) => drizzleExportApp({ manifest: MANIFEST, sqliteMigrationsFolder: sqliteFolder, postgresMigrationsFolder });

describe('drizzleExportApp', () => {
  it('round trips: rows arrive and the ledger holds the SQLite journal, not Postgres', async () => {
    const db = await migratedDatabase(pgFolder);
    const result = await exportCli(db, app());
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    const exported = new Database(result.target, { readonly: true });
    expect(exported.prepare('select id, label from items order by id').all()).toEqual([
      { id: 1, label: 'a' },
      { id: 2, label: 'b' },
      { id: 3, label: 'c' },
    ]);
    expect(exported.prepare('select created_at from __drizzle_migrations').all()).toEqual([{ created_at: SQLITE_WHEN }]);
    exported.close();
  }, 180_000);

  it('expected ids are the journal `when` of every entry, the same digits Postgres stores as created_at', async () => {
    const db = await migratedDatabase(pgFolder);
    const { rows } = await db.admin.query<{ id: string }>(app().ledger.query);
    expect(rows).toEqual([{ id: String(PG_WHEN) }]);
    expect([...(await app().ledger.expected())]).toEqual([String(PG_WHEN)]);
  }, 180_000);

  it('refuses a ledger mismatch naming both ids', async () => {
    const db = await migratedDatabase(pgFolder);
    const ahead = join(root, 'pg-ahead');
    cpSync(pgFolder, ahead, { recursive: true });
    const journalPath = join(ahead, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: unknown[] };
    journal.entries.push({ idx: 1, version: '1', when: PG_WHEN + 1000, tag: '0001_next', breakpoints: true });
    writeFileSync(journalPath, JSON.stringify(journal));
    writeFileSync(join(ahead, '0001_next.sql'), 'SELECT 1;\n');
    await db.admin.query(`insert into drizzle.__drizzle_migrations(hash, created_at) values ('h', ${PG_WHEN + 5000})`);
    const result = await exportCli(db, app(ahead));
    expect(result.code).toBe(1);
    const error = JSON.parse(result.err) as { refusal: unknown; error: string };
    expect(error.refusal).toEqual({ code: 'ledger-mismatch' });
    expect(error.error).toContain(`missing from Postgres [${PG_WHEN + 1000}]`);
    expect(error.error).toContain(`unknown to this code [${PG_WHEN + 5000}]`);
  }, 180_000);
});
