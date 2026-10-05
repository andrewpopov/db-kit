import Database from 'better-sqlite3';
import type { HealthResult } from './health.js';
import type { SqliteConfig } from './url.js';
export interface SqliteOptions {
    /** `busy_timeout` in ms. Default 5000. */
    busyTimeoutMs?: number;
    /** Open read-only. WAL is then not requested (switching journal mode needs write access). Default false. */
    readonly?: boolean;
}
export interface SqliteHandle {
    readonly dialect: 'sqlite';
    readonly db: Database.Database;
    health(): Promise<HealthResult>;
    /** Idempotent. */
    close(): Promise<void>;
}
export declare const DEFAULT_BUSY_TIMEOUT_MS = 5000;
/**
 * Open a SQLite database with fleet settings, each applied and read back:
 * `journal_mode=WAL` (in-memory databases cannot WAL and are exempt),
 * `busy_timeout`, `foreign_keys=ON`, `synchronous=NORMAL`.
 * A pragma that does not verify closes the handle and throws `SQLITE_PRAGMA_UNVERIFIED`.
 */
export declare function openSqlite(config: SqliteConfig, opts?: SqliteOptions): SqliteHandle;
