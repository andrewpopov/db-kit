import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { CodecManifest } from './codecs/manifest.js';
import type { SqliteExportApp } from './clone/export-sqlite.js';
import type { DatabaseHandle } from './open.js';
import type { PostgresHandle } from './postgres.js';
import type { SqliteHandle } from './sqlite.js';
/**
 * Wrap an open handle in the matching Drizzle instance. Lives on the
 * `@andrewpopov/db-kit/drizzle` subpath so that apps not using Drizzle never
 * need `drizzle-orm` installed (it is an optional peer dependency).
 */
export declare function drizzleFor(handle: SqliteHandle): BetterSQLite3Database;
export declare function drizzleFor(handle: PostgresHandle): NodePgDatabase;
export declare function drizzleFor(handle: DatabaseHandle): BetterSQLite3Database | NodePgDatabase;
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
/** A `SqliteExportApp` for a Drizzle app: the template is the SQLite migrations applied to an empty file, the ledger is the Postgres `created_at` of each migration. */
export declare function drizzleExportApp(options: DrizzleExportOptions): SqliteExportApp;
