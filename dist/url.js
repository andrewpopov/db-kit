import { z } from 'zod';
import { DbKitError } from './errors.js';
export const SSL_MODES = ['disable', 'require', 'verify-ca', 'verify-full'];
const SqliteConfigSchema = z.object({
    dialect: z.literal('sqlite'),
    /** Path exactly as written in the URL (percent-decoded), or `:memory:`. Relative paths resolve against the process cwd when opened. */
    path: z.string().min(1, 'sqlite path is empty'),
    inMemory: z.boolean(),
});
const PostgresConfigSchema = z.object({
    dialect: z.literal('postgres'),
    host: z.string().min(1, 'postgres host is required'),
    port: z.number().int().min(1).max(65535),
    database: z.string().min(1, 'postgres database name is required'),
    user: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    sslmode: z.enum(SSL_MODES),
});
export const DatabaseConfigSchema = z.discriminatedUnion('dialect', [SqliteConfigSchema, PostgresConfigSchema]);
const SQLITE_SCHEMES = ['file', 'sqlite'];
const POSTGRES_SCHEMES = ['postgres', 'postgresql'];
const POSTGRES_QUERY_KEYS = ['sslmode', 'user', 'password'];
function invalid(message) {
    throw new DbKitError('INVALID_DATABASE_URL', `Invalid DATABASE_URL: ${message}`);
}
/** Only echo a query key when it is plainly an identifier; anything else could be data. */
function describeKey(key) {
    return /^[A-Za-z0-9_]{1,40}$/.test(key) ? `"${key}"` : '(unprintable key)';
}
function decode(part, what) {
    try {
        return decodeURIComponent(part);
    }
    catch {
        return invalid(`${what} is not valid percent-encoding`);
    }
}
function parseSqlite(rest) {
    if (rest.includes('?') || rest.includes('#'))
        invalid('sqlite URLs take no query string or fragment');
    let path = rest;
    if (path.startsWith('//')) {
        // `file:///abs/path.db`: empty authority, absolute path. A non-empty authority is ambiguous, so refuse it.
        if (!path.startsWith('///'))
            invalid('sqlite URL has an authority; use file:///absolute/path or file:relative/path');
        path = path.slice(2);
    }
    path = decode(path, 'sqlite path');
    const result = SqliteConfigSchema.safeParse({ dialect: 'sqlite', path, inMemory: path === ':memory:' });
    if (!result.success)
        return invalid('sqlite path is empty');
    return result.data;
}
function parsePostgres(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return invalid('postgres URL could not be parsed (percent-encode special characters in the password)');
    }
    if (parsed.hash)
        invalid('postgres URLs take no fragment');
    const query = new Map();
    for (const [key, value] of parsed.searchParams) {
        if (!POSTGRES_QUERY_KEYS.includes(key))
            invalid(`unsupported query parameter ${describeKey(key)}`);
        if (query.has(key))
            invalid(`duplicate query parameter ${describeKey(key)}`);
        query.set(key, value);
    }
    const database = decode(parsed.pathname.replace(/^\//, ''), 'database name');
    if (database.includes('/'))
        invalid('postgres database name contains "/"');
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    const userInfoUser = parsed.username ? decode(parsed.username, 'user') : undefined;
    const userInfoPassword = parsed.password ? decode(parsed.password, 'password') : undefined;
    if (userInfoUser && query.has('user'))
        invalid('user given both in the URL and as a query parameter');
    if (userInfoPassword && query.has('password'))
        invalid('password given both in the URL and as a query parameter');
    const sslmode = query.get('sslmode') ?? 'disable';
    const result = PostgresConfigSchema.safeParse({
        dialect: 'postgres',
        host,
        port: parsed.port ? Number(parsed.port) : 5432,
        database,
        user: userInfoUser ?? query.get('user') ?? undefined,
        password: userInfoPassword ?? query.get('password') ?? undefined,
        sslmode,
    });
    if (!result.success) {
        // Name the failing fields only: zod's own messages may quote the offending value.
        const fields = [...new Set(result.error.issues.map((i) => i.path.join('.') || 'url'))];
        return invalid(`postgres URL has invalid ${fields.join(', ')}`);
    }
    return result.data;
}
/**
 * Parse a `DATABASE_URL` into a validated config.
 *
 * SQLite (`file:` and `sqlite:` are equivalent):
 *   - `file:relative/app.db`, `file:./app.db`: relative to the process cwd.
 *   - `file:/abs/app.db` and `file:///abs/app.db`: absolute.
 *   - `file::memory:`: private in-memory database.
 *   - No query string, fragment or authority (`file://host/x` is refused).
 *
 * Postgres (`postgres:` and `postgresql:`):
 *   `postgres://[user[:password]@]host[:port]/database[?sslmode=...]`, port defaults to 5432.
 *   Percent-encode special characters in user/password. Accepted query keys:
 *   `sslmode` (disable | require | verify-ca | verify-full, default disable), `user`, `password`.
 *
 * Every failure is a `DbKitError('INVALID_DATABASE_URL')` whose message never contains the URL.
 */
export function parseDatabaseUrl(url) {
    if (typeof url !== 'string' || url.trim() === '')
        invalid('value is empty');
    const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url.trim());
    if (!match)
        invalid('no URL scheme (expected file:, sqlite:, postgres: or postgresql:)');
    const scheme = match[1].toLowerCase();
    const trimmed = url.trim();
    if (SQLITE_SCHEMES.includes(scheme))
        return parseSqlite(trimmed.slice(match[0].length));
    if (POSTGRES_SCHEMES.includes(scheme))
        return parsePostgres(trimmed);
    return invalid(`unsupported scheme "${/^[A-Za-z0-9+.-]{1,20}$/.test(scheme) ? scheme : '?'}" (expected file, sqlite, postgres or postgresql)`);
}
function describePostgres(config) {
    const host = config.host.includes(':') ? `[${config.host}]` : config.host;
    const auth = config.user ? `${encodeURIComponent(config.user)}${config.password ? ':***' : ''}@` : config.password ? ':***@' : '';
    return `postgres://${auth}${host}:${config.port}/${encodeURIComponent(config.database)}?sslmode=${config.sslmode}`;
}
/** Last-resort scrubbing for a raw URL string that did not parse. */
function redactRawUrl(url) {
    return url
        .replace(/(:\/\/[^:/?#@\s]*:)[^@\s]*@/g, '$1***@')
        .replace(/([?&;]password=)[^&#\s]*/gi, '$1***');
}
/**
 * Human-readable, log-safe description of a config. The password is always
 * `***`. A raw URL string is also accepted (e.g. to log a `DATABASE_URL` that
 * failed to parse): it is parsed when possible, otherwise regex-redacted
 * (userinfo password and any `password=` query parameter).
 */
export function describe(config) {
    if (typeof config === 'string') {
        try {
            return describe(parseDatabaseUrl(config));
        }
        catch {
            return redactRawUrl(config);
        }
    }
    return config.dialect === 'sqlite' ? `sqlite:${config.path}` : describePostgres(config);
}
