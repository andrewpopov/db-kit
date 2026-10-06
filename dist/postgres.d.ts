import type { ConnectionOptions } from 'node:tls';
import { Pool } from 'pg';
import type { HealthResult } from './health.js';
import { type PostgresConfig, type SslMode } from './url.js';
export interface PostgresOptions {
    /** Required. Shows up in `pg_stat_activity.application_name`. */
    applicationName: string;
    /** Server-side `statement_timeout` applied to every connection, ms. Default 30000. 0 disables. */
    statementTimeoutMs?: number;
    /** Max connections in the pool. Default 10. */
    poolSize?: number;
    /**
     * Pin `TimeZone=UTC` and `DateStyle=ISO, YMD` on every connection (startup options). Required when reading with
     * the codecs' `POSTGRES_CODEC_TYPES`: their timestamp text is whatever the session prints. Default false.
     */
    codecSession?: boolean;
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
 * TLS per sslmode (libpq naming):
 *  - disable: no TLS.
 *  - require: TLS, certificate NOT verified (encryption only; resists passive sniffing, not an active attacker).
 *  - verify-ca: TLS, certificate chain verified against the CA, hostname NOT checked.
 *  - verify-full: TLS, chain AND hostname verified.
 */
export declare function tlsFor(sslmode: SslMode, ca: string | undefined): ConnectionOptions | false;
export interface PostgresConnectionSettings {
    applicationName: string;
    statementTimeoutMs: number;
    codecSession?: boolean | undefined;
    tlsCa?: string | undefined;
}
/**
 * The `pg` connection fields shared by the pool and by a single checked-out `Client` (clone preflight).
 * `statement_timeout` is a startup `options` flag rather than pg's `statement_timeout` field: pg
 * omits a falsy value, so 0 would silently inherit a role/database default instead of disabling.
 */
export declare function postgresConnectionOptions(config: PostgresConfig, settings: PostgresConnectionSettings): {
    host: string;
    port: number;
    database: string;
    user: string | undefined;
    password: string | undefined;
    ssl: false | ConnectionOptions;
    application_name: string;
    options: string;
};
/**
 * Create a `pg.Pool` with fleet settings. Connections are lazy, so a bad
 * host or password surfaces on first use (`health()` or a query), as a
 * password-scrubbed error.
 */
export declare function openPostgres(config: PostgresConfig, opts: PostgresOptions): PostgresHandle;
