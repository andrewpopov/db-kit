import type { CodecManifest } from './codecs/manifest.js';
import type { SqliteExportApp } from './clone/export-sqlite.js';
/**
 * Options for `prismaExportApp`. Lives on the `@andrewpopov/db-kit/prisma` subpath; db-kit itself never imports
 * Prisma, it only runs the app's own `prisma` binary.
 */
export interface PrismaExportOptions {
    /** The app's FORWARD codec manifest (already parsed). */
    manifest: CodecManifest;
    /** The SQLite Prisma schema (`provider = "sqlite"`, `url = env("DATABASE_URL")`); its sibling `migrations/` is the SQLite history. */
    sqliteSchemaPath: string;
    /** The Postgres migrations directory: one subdirectory per migration, each holding `migration.sql`. */
    postgresMigrationsDir: string;
    /** Default: `node_modules/.bin/prisma`, found by walking up from the schema's directory. */
    prismaBin?: string;
    /** The environment variable the SQLite schema's `url` reads. Default `DATABASE_URL`. */
    databaseUrlEnv?: string;
    /** Extra tables the reverse direction must not copy: name -> reason. Merged with the Prisma ledger table. */
    skipTables?: Readonly<Record<string, string>>;
    smoke?: SqliteExportApp['smoke'];
}
/** A `SqliteExportApp` for a Prisma app: the template is `prisma migrate deploy` on an empty SQLite file, the ledger is `_prisma_migrations`. */
export declare function prismaExportApp(options: PrismaExportOptions): SqliteExportApp;
