import type { CliIo } from './cli.js';
import { type SqliteExportApp } from './export-sqlite.js';
export interface ExportCliOptions {
    /** The environment variable holding the Postgres source URL. Default `DATABASE_URL`. */
    sourceUrlEnv?: string;
    /**
     * The environment variable holding the path of a PEM CA file for the source connection (a private CA behind
     * `sslmode=verify-ca`/`verify-full`). Read from the same place as the URL: `--env-file` when given (and then ONLY the file, so a
     * file without it means unset even if the environment has it), else the environment.
     */
    tlsCaFileEnv?: string;
}
/**
 * The app's `DATABASE_URL` as `parseDatabaseUrl` can read it: a Postgres URL loses the Prisma client params and `schema=public`.
 * Any other `schema` is refused (the export reads `public`); every other param stays so `parseDatabaseUrl` still refuses it.
 * A URL that is not Postgres, or that has nothing to drop, is returned byte for byte.
 */
export declare function exportSourceUrl(raw: string): string;
/** The URL and its password (raw and decoded) replaced outright, then any other `scheme://user:password@` userinfo masked. */
export declare function scrubMessage(text: string, url: string | undefined): string;
/**
 * `export-sqlite <out.db>` and `sqlite-template <path>` for an app that supplied a `SqliteExportApp`.
 * Exit codes: 0 written (or dry run verified), 1 refused or failed (one JSON line on `io.err`), 2 usage,
 * 3 the file IS in place but a later step warned (`warnings` in the JSON line on `io.out`).
 */
export declare function runExportSqliteCli(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv, app: SqliteExportApp, opts?: ExportCliOptions): Promise<number>;
