import { execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { DbKitError } from '../errors.js';
import type { PostgresConfig } from '../url.js';

export interface StartTestPostgresOptions {
  /** Appended to the server's command line, as `-c name=value` pairs. */
  extraFlags?: readonly string[];
  /**
   * Database locale. `'C'` (or any libc locale name), `'icu:<name>'` (for example `'icu:en-US'`, needs a server
   * built with ICU) or `'builtin:<name>'` (for example `'builtin:C.UTF-8'`, the PG 17 builtin provider production
   * uses; needs a PG 17+ server). Default: the host's initdb default (an explicit option, not the default, so an
   * existing suite's collation does not change under it).
   */
  locale?: string;
  /** Serve TLS with a self-signed certificate (needs `openssl`); `san` is its subjectAltName. Default: no TLS. */
  tls?: { san?: string };
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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function localeFlags(locale: string | undefined): string[] {
  if (locale === undefined) return [];
  if (locale.startsWith('builtin:')) return ['--encoding=UTF8', '--locale-provider=builtin', `--builtin-locale=${locale.slice(8)}`];
  if (locale.startsWith('icu:')) return ['--encoding=UTF8', '--locale-provider=icu', `--icu-locale=${locale.slice(4)}`];
  return ['--encoding=UTF8', `--locale=${locale}`];
}

export function postgresUrl(config: PostgresConfig, database = config.database): string {
  const auth = `${encodeURIComponent(config.user ?? 'postgres')}:${encodeURIComponent(config.password ?? '')}`;
  return `postgres://${auth}@${config.host}:${config.port}/${encodeURIComponent(database)}?sslmode=${config.sslmode}`;
}

/**
 * Importing `embedded-postgres` calls `async-exit-hook` at module top level, which listens on these process events.
 * Its `beforeExit` listener runs `process.exit(0)`, overriding a test runner's `process.exitCode = 1`: a failing run
 * then reports success. Its `exit` listener stops servers by a callback only the other events supply.
 */
const HOOKED_EVENTS = ['exit', 'beforeExit', 'SIGHUP', 'SIGINT', 'SIGTERM', 'SIGBREAK', 'message'] as const;

type Listener = (...args: unknown[]) => void;

function snapshotListeners(): Map<string, Listener[]> {
  const emitter = process as NodeJS.EventEmitter;
  return new Map(HOOKED_EVENTS.map((event) => [event, emitter.listeners(event) as Listener[]]));
}

let embeddedPostgresLoad: Promise<typeof import('embedded-postgres').default> | undefined;

/**
 * Imports `embedded-postgres` and removes exactly the process listeners that import added, right away, so the
 * library's hook can never fire, even when `stop()` is never called. The module is cached, so only the first import
 * adds listeners; the load is memoized and the removal happens once. (An import of the library elsewhere in the
 * process before this one is outside our reach: its listeners were not added by us.) db-kit's own `reapOnExit`
 * takes over the cleanup the library's hook used to do.
 */
function loadEmbeddedPostgres(): Promise<typeof import('embedded-postgres').default> {
  embeddedPostgresLoad ??= (async () => {
    const before = snapshotListeners();
    let module: typeof import('embedded-postgres');
    try {
      module = await import('embedded-postgres');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (package|module)/.test(String((error as Error).message))) {
        throw new DbKitError('INVALID_OPTIONS', 'Testing against Postgres needs the optional peer "embedded-postgres": install it as a devDependency (npm i -D embedded-postgres)');
      }
      throw error;
    } finally {
      const after = snapshotListeners();
      for (const event of HOOKED_EVENTS) {
        const previous = new Set(before.get(event));
        for (const listener of after.get(event) ?? []) {
          if (!previous.has(listener)) (process as NodeJS.EventEmitter).removeListener(event, listener);
        }
      }
    }
    return module.default;
  })();
  embeddedPostgresLoad.catch(() => {
    embeddedPostgresLoad = undefined;
  });
  return embeddedPostgresLoad;
}

const REAP_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;
const REAP_WAIT_MS = 5000;

interface LiveServer {
  dir: string;
  child: ChildProcess | undefined;
}

const liveServers = new Set<LiveServer>();

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Synchronous (usable in an `exit` handler): stop the postgres child, wait for its clean shutdown, remove the directory. */
function reapSync(live: LiveServer): void {
  const pid = live.child?.pid;
  if (pid !== undefined && live.child?.exitCode === null && live.child.signalCode === null) {
    try {
      process.kill(pid, 'SIGINT');
    } catch {
      // already gone
    }
    // A clean shutdown removes postmaster.pid; the child cannot be reaped here (the event loop is not running).
    const deadline = Date.now() + REAP_WAIT_MS;
    while (existsSync(join(live.dir, 'data', 'postmaster.pid')) && Date.now() < deadline) sleepSync(25);
    if (existsSync(join(live.dir, 'data', 'postmaster.pid'))) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  rmSync(live.dir, { recursive: true, force: true });
}

function reapAllSync(): void {
  for (const live of liveServers) reapSync(live);
  liveServers.clear();
}

function onReapSignal(signal: NodeJS.Signals): void {
  reapAllSync();
  uninstallReapHandlers();
  // Another listener owns the exit decision; otherwise keep default semantics: die from this very signal, never exit 0.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

const signalHandlers = new Map<NodeJS.Signals, () => void>(REAP_SIGNALS.map((signal) => [signal, () => onReapSignal(signal)]));

function installReapHandlers(): void {
  process.on('exit', reapAllSync);
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
}

function uninstallReapHandlers(): void {
  process.removeListener('exit', reapAllSync);
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
}

/**
 * Registers `server` for cleanup if the process ends without `stop()` being called: on `exit` and on SIGHUP/SIGINT/SIGTERM
 * the child is stopped and the directory removed, and a signal is then re-raised so the exit status stays the signal's.
 * Never touches `process.exitCode`. The child is unref'd so an unstopped server cannot keep the process alive.
 */
function reapOnExit(live: LiveServer): () => void {
  live.child?.unref();
  for (const stream of [live.child?.stdin, live.child?.stdout, live.child?.stderr]) (stream as { unref?: () => void } | null | undefined)?.unref?.();
  if (liveServers.size === 0) installReapHandlers();
  liveServers.add(live);
  return () => {
    liveServers.delete(live);
    if (liveServers.size === 0) uninstallReapHandlers();
  };
}

/**
 * Start a real, throwaway Postgres in a temp directory on a random free port with password auth. Needs the optional
 * peer `embedded-postgres` (a devDependency of the app, never of production). Torn down by `stop()`.
 */
export async function startTestPostgres(options: StartTestPostgresOptions = {}): Promise<TestPostgres> {
  return startTestPostgresWith(options, freePort);
}

const MAX_START_ATTEMPTS = 3;
const LOG_TAIL_LINES = 40;
const BIND_CONFLICT = /could not bind|Address already in use|could not create any TCP\/IP sockets/i;

/** Internal seam (not re-exported from `./testing`): `pickPort` is injectable so a test can force a port collision. */
export async function startTestPostgresWith(options: StartTestPostgresOptions, pickPort: () => Promise<number>): Promise<TestPostgres> {
  const EmbeddedPostgres = await loadEmbeddedPostgres();
  const started = performance.now();
  const dir = mkdtempSync(join(tmpdir(), 'db-kit-pg-'));
  const password = 'correct-horse-battery';
  const tlsFlags: string[] = [];
  let caPem: string | undefined;
  const logLines: string[] = [];
  const capture = (chunk: unknown): void => {
    logLines.push(...String(chunk).split('\n').filter((line) => line.trim() !== ''));
    if (logLines.length > LOG_TAIL_LINES) logLines.splice(0, logLines.length - LOG_TAIL_LINES);
  };
  const build = (port: number) =>
    new EmbeddedPostgres({
      initdbFlags: localeFlags(options.locale),
      // listen_addresses first so a caller's extraFlags can still override it; 127.0.0.1 only, because the client connects there
      postgresFlags: ['-c', 'listen_addresses=127.0.0.1', ...tlsFlags, ...(options.extraFlags ?? [])],
      databaseDir: join(dir, 'data'),
      user: 'postgres',
      password,
      port,
      persistent: true,
      onLog: capture,
      onError: capture,
    });
  try {
    if (options.tls) {
      const cert = join(dir, 'server.crt');
      const key = join(dir, 'server.key');
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=db-kit-test', '-addext', `subjectAltName=${options.tls.san ?? 'DNS:localhost'}`, '-keyout', key, '-out', cert], { stdio: 'ignore' });
      tlsFlags.push('-c', 'ssl=on', '-c', `ssl_cert_file=${cert}`, '-c', `ssl_key_file=${key}`);
      caPem = readFileSync(cert, 'utf8');
    }
    await build(0).initialise();
    // The port is chosen after initdb (seconds under load), then start() is retried on a fresh port if something took it meanwhile.
    for (let attempt = 1; ; attempt++) {
      const port = await pickPort();
      logLines.length = 0;
      const server = build(port);
      try {
        await server.start();
      } catch {
        const child = (server as unknown as { process?: ChildProcess }).process;
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        if (attempt < MAX_START_ATTEMPTS && BIND_CONFLICT.test(logLines.join('\n'))) continue;
        throw new DbKitError('TEST_POSTGRES_START_FAILED', `Test Postgres failed to start on port ${port} after ${attempt} attempt(s); postgres log tail:\n${logLines.join('\n')}`);
      }
      const live: LiveServer = { dir, child: (server as unknown as { process?: ChildProcess }).process };
      const unregister = reapOnExit(live);
      const config: PostgresConfig = { dialect: 'postgres', host: '127.0.0.1', port, database: 'postgres', user: 'postgres', password, sslmode: 'disable' };
      return {
        url: postgresUrl(config),
        config,
        caPem,
        startupMs: Math.round(performance.now() - started),
        async stop() {
          live.child?.ref(); // stop() awaits the child's exit, which an unref'd child cannot wake the loop for
          try {
            await server.stop();
          } finally {
            unregister();
            rmSync(dir, { recursive: true, force: true });
          }
        },
      };
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** A fresh `test_<random>` database on `server`; `release()` drops it. */
export async function createTestDatabase(server: TestPostgres): Promise<TestDatabase> {
  const name = `test_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ host: server.config.host, port: server.config.port, user: server.config.user, password: server.config.password, database: 'postgres', ssl: false });
  admin.on('error', () => undefined);
  await admin.connect();
  try {
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const config: PostgresConfig = { ...server.config, database: name };
  let released = false;
  return {
    name,
    url: postgresUrl(config),
    config,
    async release() {
      if (released) return;
      released = true;
      const dropper = new Client({ host: config.host, port: config.port, user: config.user, password: config.password, database: 'postgres', ssl: false });
      dropper.on('error', () => undefined);
      await dropper.connect();
      try {
        await dropper.query(`drop database if exists ${name} with (force)`);
      } finally {
        await dropper.end();
      }
    },
  };
}
