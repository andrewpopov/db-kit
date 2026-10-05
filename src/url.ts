import { z } from 'zod';
import { DbKitError } from './errors.js';

export const SSL_MODES = ['disable', 'require', 'verify-ca', 'verify-full'] as const;
export type SslMode = (typeof SSL_MODES)[number];

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

export type SqliteConfig = z.infer<typeof SqliteConfigSchema>;
export type PostgresConfig = z.infer<typeof PostgresConfigSchema>;
export const DatabaseConfigSchema = z.discriminatedUnion('dialect', [SqliteConfigSchema, PostgresConfigSchema]);
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

const SQLITE_SCHEMES = ['file', 'sqlite'];
const POSTGRES_SCHEMES = ['postgres', 'postgresql'];
const POSTGRES_QUERY_KEYS = ['sslmode', 'user', 'password'];

function invalid(message: string): never {
  throw new DbKitError('INVALID_DATABASE_URL', `Invalid DATABASE_URL: ${message}`);
}

function decode(part: string, what: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return invalid(`${what} is not valid percent-encoding`);
  }
}

function parseSqlite(rest: string): SqliteConfig {
  if (rest.includes('?') || rest.includes('#')) invalid('sqlite URLs take no query string or fragment');
  let path = rest;
  if (path.startsWith('//')) {
    // `file:///abs/path.db`: empty authority, absolute path. A non-empty authority is ambiguous, so refuse it.
    if (!path.startsWith('///')) invalid('sqlite URL has an authority; use file:///absolute/path or file:relative/path');
    path = path.slice(2);
  }
  path = decode(path, 'sqlite path');
  const result = SqliteConfigSchema.safeParse({ dialect: 'sqlite', path, inMemory: path === ':memory:' });
  if (!result.success) return invalid('sqlite path is empty');
  return result.data;
}

function parsePostgres(url: string): PostgresConfig {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return invalid('postgres URL could not be parsed (percent-encode special characters in the password)');
  }
  if (parsed.hash) invalid('postgres URLs take no fragment');

  const query = new Map<string, string>();
  for (const [key, value] of parsed.searchParams) {
    if (!POSTGRES_QUERY_KEYS.includes(key)) invalid('unsupported query parameter (allowed: sslmode, user, password)');
    if (query.has(key)) invalid('duplicate query parameter');
    query.set(key, value);
  }

  const database = decode(parsed.pathname.replace(/^\//, ''), 'database name');
  if (database.includes('/')) invalid('postgres database name contains "/"');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const userInfoUser = parsed.username ? decode(parsed.username, 'user') : undefined;
  const userInfoPassword = parsed.password ? decode(parsed.password, 'password') : undefined;
  if (userInfoUser && query.has('user')) invalid('user given both in the URL and as a query parameter');
  if (userInfoPassword && query.has('password')) invalid('password given both in the URL and as a query parameter');

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
export function parseDatabaseUrl(url: string): DatabaseConfig {
  if (typeof url !== 'string' || url.trim() === '') invalid('value is empty');
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url.trim());
  if (!match) invalid('no URL scheme (expected file:, sqlite:, postgres: or postgresql:)');
  const scheme = match[1].toLowerCase();
  const trimmed = url.trim();
  if (SQLITE_SCHEMES.includes(scheme)) return parseSqlite(trimmed.slice(match[0].length));
  if (POSTGRES_SCHEMES.includes(scheme)) return parsePostgres(trimmed);
  return invalid(`unsupported scheme "${/^[A-Za-z0-9+.-]{1,20}$/.test(scheme) ? scheme : '?'}" (expected file, sqlite, postgres or postgresql)`);
}

function describePostgres(config: PostgresConfig): string {
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  const auth = config.user ? `${encodeURIComponent(config.user)}${config.password ? ':***' : ''}@` : config.password ? ':***@' : '';
  return `postgres://${auth}${host}:${config.port}/${encodeURIComponent(config.database)}?sslmode=${config.sslmode}`;
}

/**
 * Fallback for a string that does not parse. It cannot pattern-match its way
 * to safety (percent-encoded names, literal `@`/`/`/`#` in a password), so it
 * keeps only what is provably not a secret: the scheme and the host. Everything
 * up to the LAST `@` is treated as userinfo, and the path and query are dropped.
 */
function redactRawUrl(url: string): string {
  const schemeEnd = url.indexOf('://');
  if (schemeEnd < 1 || !/^[A-Za-z][A-Za-z0-9+.-]*$/.test(url.slice(0, schemeEnd))) return '<unparseable DATABASE_URL>';
  const scheme = url.slice(0, schemeEnd);
  const afterScheme = url.slice(schemeEnd + 3);
  const lastAt = afterScheme.lastIndexOf('@');
  const hostPart = afterScheme.slice(lastAt + 1).split(/[/?#;\s]/, 1)[0];
  return `${scheme}://${lastAt >= 0 ? '***@' : ''}${hostPart}`;
}

/**
 * Human-readable, log-safe description of a config. The password is always
 * `***`. A raw URL string is also accepted (e.g. to log a `DATABASE_URL` that
 * failed to parse): it is parsed when possible, otherwise regex-redacted
 * (userinfo password and any `password=` query parameter).
 */
export function describe(config: DatabaseConfig | string): string {
  if (typeof config === 'string') {
    try {
      return describe(parseDatabaseUrl(config));
    } catch {
      return redactRawUrl(config);
    }
  }
  return config.dialect === 'sqlite' ? `sqlite:${config.path}` : describePostgres(config);
}
