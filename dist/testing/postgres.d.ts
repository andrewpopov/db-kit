import type { PostgresConfig } from '../url.js';
export interface StartTestPostgresOptions {
    /** Appended to the server's command line, as `-c name=value` pairs. */
    extraFlags?: readonly string[];
    /**
     * Database locale. `'C'` (or any libc locale name) or `'icu:<name>'` (for example `'icu:en-US'`, needs a server
     * built with ICU). Default: the host's initdb default.
     */
    locale?: string;
    /** Serve TLS with a self-signed certificate (needs `openssl`); `san` is its subjectAltName. Default: no TLS. */
    tls?: {
        san?: string;
    };
}
export interface TestPostgres {
    /** URL of the `postgres` maintenance database as the superuser. Prefer `createTestDatabase` for a test's own database. */
    url: string;
    /** The same as a parsed config. */
    config: PostgresConfig;
    /** PEM of the server certificate when `tls` was requested. */
    caPem: string | undefined;
    startupMs: number;
    /** Stops the server and removes its data directory. */
    stop(): Promise<void>;
}
export interface TestDatabase {
    name: string;
    /** URL of this database, as accepted by `openDatabase`. */
    url: string;
    config: PostgresConfig;
    /** Drops the database (connections still open to it are terminated). Idempotent. */
    release(): Promise<void>;
}
export declare function postgresUrl(config: PostgresConfig, database?: string): string;
/**
 * Start a real, throwaway Postgres in a temp directory on a random free port with password auth. Needs the optional
 * peer `embedded-postgres` (a devDependency of the app, never of production). Torn down by `stop()`.
 */
export declare function startTestPostgres(options?: StartTestPostgresOptions): Promise<TestPostgres>;
/** A fresh `test_<random>` database on `server`; `release()` drops it. */
export declare function createTestDatabase(server: TestPostgres): Promise<TestDatabase>;
