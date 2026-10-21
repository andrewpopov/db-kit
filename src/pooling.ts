import path from 'node:path';
import { DbKitError } from './errors.js';
import { parseDatabaseUrl, type PostgresConfig } from './url.js';

export interface PoolRoutingOptions {
  /** Runtime connections require a pool by default. Session-affine work must opt out explicitly. */
  purpose?: 'runtime' | 'migration' | 'backup' | 'session';
  pooling?: 'required' | 'preferred' | 'off';
}

function invalid(message: string): never { throw new DbKitError('INVALID_OPTIONS', message); }

/** ORM-independent routing. Never changes the direct URL or consults global process state. */
export function runtimeDatabaseUrl(env: Readonly<Record<string, string | undefined>>, options: PoolRoutingOptions = {}): string {
  if (!['runtime', 'migration', 'backup', 'session'].includes(options.purpose ?? 'runtime') ||
      !['required', 'preferred', 'off'].includes(options.pooling ?? 'required')) return invalid('Unsupported connection purpose or pooling policy');
  const direct = env.DATABASE_URL;
  if (!direct) return invalid('DATABASE_URL is required');
  if (/^(file|sqlite):/i.test(direct)) return direct;
  const upstream = postgresUrl(direct);
  if ((options.purpose ?? 'runtime') !== 'runtime' || options.pooling === 'off') return direct;
  const pooled = env.POOLED_DATABASE_URL;
  if (!pooled) {
    if (options.pooling === 'preferred') return direct;
    return invalid('POOLED_DATABASE_URL is required for PostgreSQL runtime connections');
  }
  const runtime = postgresUrl(pooled);
  if (runtime.database !== upstream.database || runtime.user !== upstream.user || runtime.password !== upstream.password ||
      (new URL(direct).searchParams.get('schema') ?? 'public') !== (new URL(pooled).searchParams.get('schema') ?? 'public')) {
    return invalid('Pooled connection must preserve the direct database, credentials and schema');
  }
  return pooled;
}

// These settings belong to the client driver, not PgBouncer's upstream DSN.
const DRIVER_KEYS = ['connection_limit', 'pool_timeout', 'schema', 'pgbouncer', 'connect_timeout', 'statement_cache_size', 'application_name'];
function postgresUrl(value: string): PostgresConfig {
  let url: URL;
  try { url = new URL(value); } catch { return invalid('A PostgreSQL URL is required'); }
  for (const key of DRIVER_KEYS) url.searchParams.delete(key);
  const config = parseDatabaseUrl(url.toString());
  if (config.dialect !== 'postgres') return invalid('A PostgreSQL URL is required');
  return config;
}

export interface PgBouncerDatabase {
  /** Must equal the upstream database name; aliases cannot multiply its server budget. */
  name: string;
  url: string;
  poolSize?: number;
  reservePoolSize?: number;
  maxServerConnections?: number;
  mode?: 'transaction' | 'session';
}
export interface PgBouncerOptions {
  databases: readonly PgBouncerDatabase[];
  /** Sum of all per-database caps must fit this operator-assigned budget. */
  serverConnectionBudget: number;
  listenPort?: number;
  maxClientConnections?: number;
  authFile?: string;
  socketDirectory?: string;
  /** Required for verify-ca/verify-full; never downgrade upstream TLS. */
  serverTlsCaFile?: string;
}
export interface PgBouncerFiles {
  /** Sensitive: install config and authentication files with mode 0600. */
  config: string;
  auth: string;
  runtimeUrls: Readonly<Record<string, string>>;
  serverConnectionCap: number;
}

function integer(value: number, minimum: number, maximum = 1_000_000): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) return invalid('Invalid pool size, port, or connection budget');
  return value;
}
function clean(value: string): string {
  if (/[\r\n\0]/.test(value)) return invalid('Configuration values cannot contain line breaks or NUL');
  return value;
}
function configPath(value: string): string {
  if (!path.posix.isAbsolute(value) || /[\s'"#;]/.test(value)) return invalid('Configuration paths must be absolute POSIX paths without whitespace or delimiters');
  return clean(value);
}
function conninfo(value: string): string { return `'${clean(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`; }
function authValue(value: string): string { return `"${clean(value).replaceAll('"', '""')}"`; }

/** Pure renderer: never installs packages, writes files, restarts services, or prints secrets. */
export function renderPgBouncer(options: PgBouncerOptions): PgBouncerFiles {
  if (!options.databases.length) return invalid('At least one database is required');
  const budget = integer(options.serverConnectionBudget, 1);
  const port = integer(options.listenPort ?? 6432, 1, 65535);
  const authFile = configPath(options.authFile ?? '/etc/db-kit-pool/users.txt');
  const socketDirectory = configPath(options.socketDirectory ?? '/run/db-kit-pool');
  const maxClients = integer(options.maxClientConnections ?? 200, 1);
  const users = new Map<string, string>();
  const names = new Set<string>();
  const tlsModes = new Set<string>();
  const runtimeUrls: Record<string, string> = Object.create(null) as Record<string, string>;
  let cap = 0;
  const databases = options.databases.map(database => {
    const upstream = postgresUrl(database.url);
    if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(database.name) || names.has(database.name) || database.name !== upstream.database) {
      return invalid('Database names must be unique safe identifiers matching their upstream database');
    }
    names.add(database.name);
    if (!upstream.user || !upstream.password) return invalid('Each pooled database requires an explicit user and password');
    if (users.has(upstream.user) && users.get(upstream.user) !== upstream.password) return invalid('Conflicting credentials for a shared database role');
    users.set(upstream.user, upstream.password);
    tlsModes.add(upstream.sslmode);
    const size = integer(database.poolSize ?? 5, 1);
    const reserve = integer(database.reservePoolSize ?? 2, 0);
    const maximum = integer(database.maxServerConnections ?? size + reserve, 1);
    if (size + reserve > maximum || maximum > maxClients) return invalid('Database capacity must contain its normal and reserve pools and fit the client limit');
    if (database.mode !== undefined && !['transaction', 'session'].includes(database.mode)) return invalid('Unsupported pool mode');
    cap += maximum;
    const runtime = new URL(database.url);
    // Normalize query-string credentials into userinfo before replacing the endpoint.
    runtime.username = encodeURIComponent(upstream.user);
    runtime.password = encodeURIComponent(upstream.password);
    runtime.searchParams.delete('user');
    runtime.searchParams.delete('password');
    runtime.hostname = '127.0.0.1';
    runtime.port = String(port);
    runtime.searchParams.set('sslmode', 'disable');
    runtimeUrls[database.name] = runtime.toString();
    return `${database.name} = host=${conninfo(upstream.host)} port=${upstream.port} dbname=${conninfo(upstream.database)} pool_size=${size} reserve_pool_size=${reserve} max_db_connections=${maximum} pool_mode=${database.mode ?? 'session'}`;
  });
  if (cap > budget) return invalid('Per-database connection caps exceed the assigned server budget');
  if (tlsModes.size !== 1) return invalid('Different upstream TLS modes require separate PgBouncer instances');
  const tlsMode = [...tlsModes][0];
  if (tlsMode.startsWith('verify-') && !options.serverTlsCaFile) return invalid('Verified upstream TLS requires an explicit CA file');
  const config = [
    '[databases]', ...databases, '', '[pgbouncer]',
    'listen_addr = 127.0.0.1', `listen_port = ${port}`, `unix_socket_dir = ${socketDirectory}`,
    'unix_socket_mode = 0700', 'auth_type = scram-sha-256', `auth_file = ${authFile}`,
    'pool_mode = session', `max_client_conn = ${maxClients}`, 'max_prepared_statements = 100',
    // Accept db-kit's startup settings without ignoring them. Session pooling is
    // required for non-reported settings: transaction mode cannot isolate them.
    'track_extra_parameters = statement_timeout,bytea_output,extra_float_digits',
    `server_tls_sslmode = ${tlsMode}`,
    ...(options.serverTlsCaFile ? [`server_tls_ca_file = ${configPath(options.serverTlsCaFile)}`] : []),
    'dns_max_ttl = 15', 'query_wait_timeout = 120', '',
  ].join('\n');
  const auth = [...users].map(([user, password]) => `${authValue(user)} ${authValue(password)}`).join('\n') + '\n';
  return { config, auth, runtimeUrls, serverConnectionCap: cap };
}
