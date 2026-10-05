import { Client, Pool } from 'pg';
import { DbKitError, scrubError } from './errors.js';
import { describe } from './url.js';
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
function requireNonNegativeInt(name, value) {
    if (!Number.isInteger(value) || value < 0)
        throw new DbKitError('INVALID_OPTIONS', `${name} must be a non-negative integer`);
}
/**
 * TLS per sslmode (libpq naming):
 *  - disable: no TLS.
 *  - require: TLS, certificate NOT verified (encryption only; resists passive sniffing, not an active attacker).
 *  - verify-ca: TLS, certificate chain verified against the CA, hostname NOT checked.
 *  - verify-full: TLS, chain AND hostname verified.
 */
export function tlsFor(sslmode, ca) {
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
/**
 * Create a `pg.Pool` with fleet settings. Connections are lazy, so a bad
 * host or password surfaces on first use (`health()` or a query), as a
 * password-scrubbed error.
 */
export function openPostgres(config, opts) {
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
    if (!Number.isInteger(poolSize) || poolSize < 1)
        throw new DbKitError('INVALID_OPTIONS', 'poolSize must be a positive integer');
    const scrub = (error) => scrubError(error, [config.password]);
    // `statement_timeout` as a startup `options` flag rather than pg's `statement_timeout` field: pg
    // omits a falsy value, so 0 would silently inherit a role/database default instead of disabling.
    const connection = {
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
        ssl: tlsFor(config.sslmode, opts.tlsCa),
        application_name: opts.applicationName,
        options: `-c statement_timeout=${statementTimeoutMs}`,
    };
    const pool = new Pool({
        ...connection,
        max: poolSize,
        idleTimeoutMillis: idleTimeoutMs,
        connectionTimeoutMillis: connectionTimeoutMs,
    });
    // An idle client erroring is emitted on the pool; with no listener Node would crash the process.
    pool.on('error', (error) => opts.onPoolError?.(scrub(error)));
    let closing;
    return {
        dialect: 'postgres',
        pool,
        async health() {
            const started = performance.now();
            const elapsed = () => performance.now() - started;
            if (closing)
                return { ok: false, latencyMs: elapsed(), error: 'handle is closed' };
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
            }
            catch (error) {
                const reason = timedOut ? `health check timed out after ${healthTimeoutMs}ms` : scrub(error).message;
                return { ok: false, latencyMs: elapsed(), error: `${describe(config)}: ${reason}` };
            }
            finally {
                clearTimeout(timer);
                client.connection.stream.destroy();
            }
        },
        close() {
            closing ??= pool.end().catch((error) => {
                throw scrub(error);
            });
            return closing;
        },
    };
}
