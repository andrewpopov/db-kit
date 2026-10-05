import { Pool } from 'pg';
import type { HealthResult } from './health.js';
import { type PostgresConfig } from './url.js';
export interface PostgresOptions {
    /** Required. Shows up in `pg_stat_activity.application_name`. */
    applicationName: string;
    /** Server-side `statement_timeout` applied to every connection, ms. Default 30000. 0 disables. */
    statementTimeoutMs?: number;
    /** Max connections in the pool. Default 10. */
    poolSize?: number;
    /** Close idle connections after this many ms. Default 30000. */
    idleTimeoutMs?: number;
    /** Fail a connection attempt (and pool checkout) after this many ms. Default 10000. */
    connectionTimeoutMs?: number;
    /** Upper bound for the whole `health()` call, ms. Default 5000. */
    healthTimeoutMs?: number;
    /** PEM CA bundle for `verify-ca`/`verify-full` against a private CA. Defaults to Node's trust store. */
    tlsCa?: string;
    /** Called with a password-scrubbed error when an idle pooled connection errors. Default: ignore. */
    onPoolError?: (error: Error) => void;
}
export interface PostgresHandle {
    readonly dialect: 'postgres';
    readonly pool: Pool;
    health(): Promise<HealthResult>;
    /** Idempotent: concurrent and repeated calls share one shutdown. */
    close(): Promise<void>;
}
export declare const DEFAULT_STATEMENT_TIMEOUT_MS = 30000;
/**
 * Create a `pg.Pool` with fleet settings. Connections are lazy, so a bad
 * host or password surfaces on first use (`health()` or a query), as a
 * password-scrubbed error.
 */
export declare function openPostgres(config: PostgresConfig, opts: PostgresOptions): PostgresHandle;
