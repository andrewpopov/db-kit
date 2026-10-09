import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { CodecManifest } from './codecs/manifest.js';
import { quoteIdent } from './clone/catalog.js';
import type { SqliteExportApp } from './clone/export-sqlite.js';
import type { DatabaseHandle } from './open.js';
import type { PostgresHandle } from './postgres.js';
import type { SqliteHandle } from './sqlite.js';

/**
 * Wrap an open handle in the matching Drizzle instance. Lives on the
 * `@andrewpopov/db-kit/drizzle` subpath so that apps not using Drizzle never
 * need `drizzle-orm` installed (it is an optional peer dependency).
 */
export function drizzleFor(handle: SqliteHandle): BetterSQLite3Database;
export function drizzleFor(handle: PostgresHandle): NodePgDatabase;
export function drizzleFor(handle: DatabaseHandle): BetterSQLite3Database | NodePgDatabase;
export function drizzleFor(handle: DatabaseHandle): BetterSQLite3Database | NodePgDatabase {
  switch (handle.dialect) {
    case 'sqlite':
      return drizzleSqlite(handle.db);
    case 'postgres':
      return drizzlePg(handle.pool);
  }
}

export interface DrizzleExportOptions {
  /** The app's FORWARD codec manifest (already parsed). */
  manifest: CodecManifest;
  /** Drizzle SQLite migrations folder (with `meta/_journal.json`). */
  sqliteMigrationsFolder: string;
  /** Drizzle Postgres migrations folder (with `meta/_journal.json`). */
  postgresMigrationsFolder: string;
  /** Default `__drizzle_migrations`. */
  migrationsTable?: string;
  /** Postgres schema holding the ledger. Default `drizzle`. */
  migrationsSchema?: string;
  /** Extra tables the reverse direction must not copy: name -> reason. Merged with the Drizzle ledger table. */
  skipTables?: Readonly<Record<string, string>>;
  smoke?: SqliteExportApp['smoke'];
}

/** The `when` of each journal entry: drizzle's migrators write it as the ledger's `created_at` (`folderMillis`). */
function journalMillis(migrationsFolder: string): string[] {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: { when: number }[] };
  return journal.entries.map((entry) => String(entry.when));
}

/** A `SqliteExportApp` for a Drizzle app: the template is the SQLite migrations applied to an empty file, the ledger is the Postgres `created_at` of each migration. */
export function drizzleExportApp(options: DrizzleExportOptions): SqliteExportApp {
  const table = options.migrationsTable ?? '__drizzle_migrations';
  const schema = options.migrationsSchema ?? 'drizzle';
  return {
    manifest: options.manifest,
    skipTables: { [table]: 'Drizzle migration ledger, per-dialect', ...options.skipTables },
    smoke: options.smoke,
    buildTemplate(path) {
      const sqlite = new Database(path);
      try {
        migrate(drizzleSqlite(sqlite), { migrationsFolder: options.sqliteMigrationsFolder, migrationsTable: table });
      } finally {
        sqlite.close();
      }
    },
    ledger: {
      query: `SELECT created_at::text AS id FROM ${quoteIdent(schema)}.${quoteIdent(table)}`,
      expected: () => journalMillis(options.postgresMigrationsFolder),
    },
  };
}
