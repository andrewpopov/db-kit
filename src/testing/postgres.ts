import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
   * Database locale. `'C'` (or any libc locale name) or `'icu:<name>'` (for example `'icu:en-US'`, needs a server
   * built with ICU). Default: the host's initdb default.
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
  if (locale.startsWith('icu:')) return ['--encoding=UTF8', '--locale-provider=icu', `--icu-locale=${locale.slice(4)}`];
  return ['--encoding=UTF8', `--locale=${locale}`];
}

export function postgresUrl(config: PostgresConfig, database = config.database): string {
  const auth = `${encodeURIComponent(config.user ?? 'postgres')}:${encodeURIComponent(config.password ?? '')}`;
  return `postgres://${auth}@${config.host}:${config.port}/${encodeURIComponent(database)}?sslmode=${config.sslmode}`;
}

async function loadEmbeddedPostgres() {
  try {
    return (await import('embedded-postgres')).default;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (package|module)/.test(String((error as Error).message))) {
      throw new DbKitError('INVALID_OPTIONS', 'Testing against Postgres needs the optional peer "embedded-postgres": install it as a devDependency (npm i -D embedded-postgres)');
    }
    throw error;
  }
}

/**
 * Start a real, throwaway Postgres in a temp directory on a random free port with password auth. Needs the optional
 * peer `embedded-postgres` (a devDependency of the app, never of production). Torn down by `stop()`.
 */
export async function startTestPostgres(options: StartTestPostgresOptions = {}): Promise<TestPostgres> {
  const EmbeddedPostgres = await loadEmbeddedPostgres();
  const started = performance.now();
  const dir = mkdtempSync(join(tmpdir(), 'db-kit-pg-'));
  const port = await freePort();
  const password = 'correct-horse-battery';
  const tlsFlags: string[] = [];
  let caPem: string | undefined;
  try {
    if (options.tls) {
      const cert = join(dir, 'server.crt');
      const key = join(dir, 'server.key');
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=db-kit-test', '-addext', `subjectAltName=${options.tls.san ?? 'DNS:localhost'}`, '-keyout', key, '-out', cert], { stdio: 'ignore' });
      tlsFlags.push('-c', 'ssl=on', '-c', `ssl_cert_file=${cert}`, '-c', `ssl_key_file=${key}`);
      caPem = readFileSync(cert, 'utf8');
    }
    const server = new EmbeddedPostgres({
      initdbFlags: localeFlags(options.locale),
      postgresFlags: [...tlsFlags, ...(options.extraFlags ?? [])],
      databaseDir: join(dir, 'data'),
      user: 'postgres',
      password,
      port,
      persistent: true,
      onLog: () => undefined,
      onError: () => undefined,
    });
    await server.initialise();
    await server.start();
    const config: PostgresConfig = { dialect: 'postgres', host: '127.0.0.1', port, database: 'postgres', user: 'postgres', password, sslmode: 'disable' };
    return {
      url: postgresUrl(config),
      config,
      caPem,
      startupMs: Math.round(performance.now() - started),
      async stop() {
        try {
          await server.stop();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
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
