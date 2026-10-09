import type { CliIo } from './cli.js';
import { type SqliteExportApp } from './export-sqlite.js';
export interface ExportCliOptions {
    /** The environment variable holding the Postgres source URL. Default `DATABASE_URL`. */
    sourceUrlEnv?: string;
}
/** The URL and its password (raw and decoded) replaced outright, then any other `scheme://user:password@` userinfo masked. */
export declare function scrubMessage(text: string, url: string | undefined): string;
/**
 * `export-sqlite <out.db>` and `sqlite-template <path>` for an app that supplied a `SqliteExportApp`.
 * Exit codes: 0 written (or dry run verified), 1 refused or failed (one JSON line on `io.err`), 2 usage,
 * 3 the file IS in place but a later step warned (`warnings` in the JSON line on `io.out`).
 */
export declare function runExportSqliteCli(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv, app: SqliteExportApp, opts?: ExportCliOptions): Promise<number>;
