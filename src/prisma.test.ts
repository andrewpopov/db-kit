import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runExportSqliteCli } from './clone/export-cli.js';
import { manifestOf, targetDatabase, type TargetDatabase } from './test-support/clone-fixture.js';
import { startThrowawayPostgres, type ThrowawayPostgres } from './test-support/embedded-pg.js';
import { prismaExportApp } from './prisma.js';
import { postgresUrl } from './testing/postgres.js';

const run = promisify(execFile);
const PRISMA_JS = join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js');

const SQLITE_MIGRATION = '20260102000000_init_sqlite';
const PG_MIGRATION = '20260101000000_init';
const MANIFEST = manifestOf({ version: 1, tables: { Item: { primaryKey: ['id'], columns: { id: { codec: 'integer', nullable: false }, label: { codec: 'text', nullable: false } } } } });

let server: ThrowawayPostgres;
const root = mkdtempSync(join(tmpdir(), 'db-kit-prisma-test-'));
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

/** A fixture app: a SQLite Prisma schema + migration, a Postgres Prisma schema + migration, and a `node_modules/.bin/prisma` above both. */
function writeFixture(name: string): string {
  const base = join(root, name);
  mkdirSync(join(base, 'node_modules', '.bin'), { recursive: true });
  symlinkSync(PRISMA_JS, join(base, 'node_modules', '.bin', 'prisma'));
  writeFileSync(join(base, 'package.json'), '{"name":"fixture","private":true}');
  const sqlite = join(base, 'prisma');
  mkdirSync(join(sqlite, 'migrations', SQLITE_MIGRATION), { recursive: true });
  writeFileSync(join(sqlite, 'schema.prisma'), 'datasource db {\n  provider = "sqlite"\n  url      = env("DATABASE_URL")\n}\n\nmodel Item {\n  id    Int    @id @default(autoincrement())\n  label String\n}\n');
  writeFileSync(join(sqlite, 'migrations', 'migration_lock.toml'), 'provider = "sqlite"\n');
  writeFileSync(join(sqlite, 'migrations', SQLITE_MIGRATION, 'migration.sql'), 'CREATE TABLE "Item" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "label" TEXT NOT NULL);\n');
  const pg = join(sqlite, 'postgres');
  mkdirSync(join(pg, 'migrations', PG_MIGRATION), { recursive: true });
  writeFileSync(join(pg, 'schema.prisma'), 'datasource db {\n  provider = "postgresql"\n  url      = env("PG_URL")\n}\n\nmodel Item {\n  id    Int    @id @default(autoincrement())\n  label String\n}\n');
  writeFileSync(join(pg, 'migrations', 'migration_lock.toml'), 'provider = "postgresql"\n');
  writeFileSync(join(pg, 'migrations', PG_MIGRATION, 'migration.sql'), 'CREATE TABLE "Item" ("id" SERIAL NOT NULL, "label" TEXT NOT NULL, CONSTRAINT "Item_pkey" PRIMARY KEY ("id"));\n');
  return base;
}

/** A database migrated by the real `prisma migrate deploy` from `fixture`'s Postgres migrations, holding three rows. */
async function migratedDatabase(fixture: string): Promise<TargetDatabase> {
  const db = await targetDatabase(server, []);
  open.push(db);
  await run(PRISMA_JS, ['migrate', 'deploy', '--schema', join(fixture, 'prisma', 'postgres', 'schema.prisma')], { env: { ...process.env, PG_URL: postgresUrl(db.config), CI: '1' } });
  await db.admin.query("insert into \"Item\"(label) values ('a'), ('b'), ('c')");
  return db;
}

const appFor = (fixture: string, extra: Partial<Parameters<typeof prismaExportApp>[0]> = {}) =>
  prismaExportApp({ manifest: MANIFEST, sqliteSchemaPath: join(fixture, 'prisma', 'schema.prisma'), postgresMigrationsDir: join(fixture, 'prisma', 'postgres', 'migrations'), ...extra });

let counter = 0;
async function exportCli(db: TargetDatabase, app: ReturnType<typeof prismaExportApp>): Promise<{ code: number; out: string; err: string; target: string }> {
  const target = join(root, `out-${++counter}.db`);
  let out = '';
  let err = '';
  const confirm = `${db.config.host}:${db.config.port}/${db.config.database}`;
  const code = await runExportSqliteCli(['export-sqlite', target, '--writers-stopped', '--confirm-production', confirm], { out: (t) => void (out += t), err: (t) => void (err += t) }, { DATABASE_URL: postgresUrl(db.config) }, app);
  return { code, out, err, target };
}

describe('prismaExportApp', () => {
  it('round trips: rows arrive and _prisma_migrations holds the SQLite migration names, not Postgres', async () => {
    const fixture = writeFixture('round-trip');
    const db = await migratedDatabase(fixture);
    const result = await exportCli(db, appFor(fixture));
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    const exported = new Database(result.target, { readonly: true });
    expect(exported.prepare('select id, label from "Item" order by id').all()).toEqual([
      { id: 1, label: 'a' },
      { id: 2, label: 'b' },
      { id: 3, label: 'c' },
    ]);
    expect(exported.prepare('select migration_name from _prisma_migrations').all()).toEqual([{ migration_name: SQLITE_MIGRATION }]);
    exported.close();
  }, 180_000);

  it('refuses a ledger mismatch naming both ids, ignoring migration_lock.toml', async () => {
    const fixture = writeFixture('mismatch');
    const db = await migratedDatabase(fixture);
    const extra = join(fixture, 'prisma', 'postgres', 'migrations', '20260103000000_extra');
    mkdirSync(extra);
    writeFileSync(join(extra, 'migration.sql'), 'SELECT 1;\n');
    await db.admin.query("insert into _prisma_migrations(id, checksum, migration_name, finished_at, applied_steps_count) values ('x', 'x', '20260104000000_from_the_future', now(), 1)");
    const result = await exportCli(db, appFor(fixture));
    expect(result.code).toBe(1);
    const error = JSON.parse(result.err) as { refusal: unknown; error: string };
    expect(error.refusal).toEqual({ code: 'ledger-mismatch' });
    expect(error.error).toContain('missing from Postgres [20260103000000_extra]');
    expect(error.error).toContain('unknown to this code [20260104000000_from_the_future]');
  }, 180_000);

  it('does not count a rolled-back ledger row as applied', async () => {
    const fixture = writeFixture('rolled-back');
    const db = await migratedDatabase(fixture);
    await db.admin.query(`update _prisma_migrations set rolled_back_at = now() where migration_name = '${PG_MIGRATION}'`);
    const result = await exportCli(db, appFor(fixture));
    expect(result.code).toBe(1);
    expect((JSON.parse(result.err) as { error: string }).error).toContain(`missing from Postgres [${PG_MIGRATION}]`);
  }, 180_000);

  it('expected ids are exactly the migration directories holding migration.sql', async () => {
    const fixture = writeFixture('expected');
    const migrations = join(fixture, 'prisma', 'postgres', 'migrations');
    mkdirSync(join(migrations, '20260105000000_no_sql'));
    cpSync(join(migrations, PG_MIGRATION), join(migrations, '20260100000000_first'), { recursive: true });
    expect([...(await appFor(fixture).ledger.expected())]).toEqual(['20260100000000_first', PG_MIGRATION]);
    expect(readdirSync(migrations)).toContain('migration_lock.toml');
  });

  it('refuses clearly when no prisma binary can be found', async () => {
    const fixture = writeFixture('no-bin');
    rmSync(join(fixture, 'node_modules'), { recursive: true });
    let err = '';
    const code = await runExportSqliteCli(['sqlite-template', join(root, 'no-bin.db')], { out: () => undefined, err: (t) => void (err += t) }, {}, appFor(fixture));
    expect(code).toBe(1);
    expect(err).toContain('prisma binary not found');
  });
});
