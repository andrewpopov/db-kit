import type { ConnectionOptions } from 'node:tls';
import { Client, Pool } from 'pg';
import { DbKitError, scrubError } from './errors.js';
import type { HealthResult } from './health.js';
import { describe, type PostgresConfig, type SslMode } from './url.js';

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

export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

function requireNonNegativeInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new DbKitError('INVALID_OPTIONS', `${name} must be a non-negative integer`);
}

/**
 * TLS per sslmode (libpq naming):
 *  - disable: no TLS.
 *  - require: TLS, certificate NOT verified (encryption only; resists passive sniffing, not an active attacker).
 *  - verify-ca: TLS, certificate chain verified against the CA, hostname NOT checked.
 *  - verify-full: TLS, chain AND hostname verified.
 */
export function tlsFor(sslmode: SslMode, ca: string | undefined): ConnectionOptions | false {
  switch (sslmode) {
    case 'disable':
      return false;
    case 'require':
      return { rejectUnauthorized: false };
    case 'verify-ca':
      return { rejectUnauthorized: true, ca, checkServerIdentity: () => undefined };
    case 'verify-full':
      return { rejectUnauthorized: true, ca };
  }
}

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
export function postgresConnectionOptions(config: PostgresConfig, settings: PostgresConnectionSettings) {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: tlsFor(config.sslmode, settings.tlsCa),
    application_name: settings.applicationName,
    options: `-c statement_timeout=${settings.statementTimeoutMs}${settings.codecSession ? ' -c TimeZone=UTC -c DateStyle=ISO,YMD' : ''}`,
  };
}

/**
 * Create a `pg.Pool` with fleet settings. Connections are lazy, so a bad
 * host or password surfaces on first use (`health()` or a query), as a
 * password-scrubbed error.
 */
export function openPostgres(config: PostgresConfig, opts: PostgresOptions): PostgresHandle {
  if (typeof opts?.applicationName !== 'string' || opts.applicationName.trim() === '') {
    throw new DbKitError('INVALID_OPTIONS', 'applicationName is required for Postgres connections');
  }
  const statementTimeoutMs = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const poolSize = opts.poolSize ?? 10;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;
  const connectionTimeoutMs = opts.connectionTimeoutMs ?? 10_000;
  const healthTimeoutMs = opts.healthTimeoutMs ?? 5000;
  requireNonNegativeInt('statementTimeoutMs', statementTimeoutMs);
  requireNonNegativeInt('idleTimeoutMs', idleTimeoutMs);
  requireNonNegativeInt('connectionTimeoutMs', connectionTimeoutMs);
  requireNonNegativeInt('healthTimeoutMs', healthTimeoutMs);
  if (!Number.isInteger(poolSize) || poolSize < 1) throw new DbKitError('INVALID_OPTIONS', 'poolSize must be a positive integer');

  const scrub = (error: unknown): Error => scrubError(error, [config.password]);

  const connection = postgresConnectionOptions(config, { applicationName: opts.applicationName, statementTimeoutMs, codecSession: opts.codecSession, tlsCa: opts.tlsCa });
  const pool = new Pool({
    ...connection,
    max: poolSize,
    idleTimeoutMillis: idleTimeoutMs,
    connectionTimeoutMillis: connectionTimeoutMs,
  });
  // An idle client erroring is emitted on the pool; with no listener Node would crash the process.
  pool.on('error', (error) => opts.onPoolError?.(scrub(error)));

  let closing: Promise<void> | undefined;

  return {
    dialect: 'postgres',
    pool,
    async health() {
      const started = performance.now();
      const elapsed = (): number => performance.now() - started;
      if (closing) return { ok: false, latencyMs: elapsed(), error: 'handle is closed' };
      // A throwaway client, not a pool checkout: a hung probe is destroyed outright, so it can
      // never hold a pool slot or delay close().
      const client = new Client({ ...connection, connectionTimeoutMillis: healthTimeoutMs, query_timeout: healthTimeoutMs });
      client.on('error', () => undefined);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        client.connection.stream.destroy();
      }, healthTimeoutMs);
      try {
        await client.connect();
        await client.query('select 1');
        return { ok: true, latencyMs: elapsed() };
      } catch (error) {
        const reason = timedOut ? `health check timed out after ${healthTimeoutMs}ms` : scrub(error).message;
        return { ok: false, latencyMs: elapsed(), error: `${describe(config)}: ${reason}` };
      } finally {
        clearTimeout(timer);
        client.connection.stream.destroy();
      }
    },
    close() {
      closing ??= pool.end().catch((error: unknown) => {
        throw scrub(error);
      });
      return closing;
    },
  };
}
