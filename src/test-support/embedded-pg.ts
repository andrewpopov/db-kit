import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { PostgresConfig } from '../url.js';

export interface ThrowawayPostgres {
  /** Config for the superuser `postgres` with the real password. */
  config: PostgresConfig;
  /** PEM of the self-signed server certificate (SAN per `san`). */
  caPem: string;
  startupMs: number;
  stop(): Promise<void>;
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

/** Start a real Postgres in a temp dir on a random free port with password auth. Torn down by `stop()`. */
/** `san` is the certificate's subjectAltName (default only `DNS:localhost`, so 127.0.0.1 does not match). */
/** `extraFlags` are appended to the server's command line (`-c name=value` pairs). */
export async function startThrowawayPostgres(san = 'DNS:localhost', extraFlags: readonly string[] = []): Promise<ThrowawayPostgres> {
  const started = performance.now();
  const dir = mkdtempSync(join(tmpdir(), 'db-kit-pg-'));
  const port = await freePort();
  const password = 'correct-horse-battery';
  const cert = join(dir, 'server.crt');
  const key = join(dir, 'server.key');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=db-kit-test', '-addext', `subjectAltName=${san}`, '-keyout', key, '-out', cert],
    { stdio: 'ignore' },
  );
  const server = new EmbeddedPostgres({
    postgresFlags: ['-c', 'ssl=on', '-c', `ssl_cert_file=${cert}`, '-c', `ssl_key_file=${key}`, ...extraFlags],
    databaseDir: join(dir, 'data'),
    user: 'postgres',
    password,
    port,
    persistent: true,
    onLog: () => undefined,
    onError: () => undefined,
  });
  try {
    await server.initialise();
    await server.start();
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    config: { dialect: 'postgres', host: '127.0.0.1', port, database: 'postgres', user: 'postgres', password, sslmode: 'disable' },
    caPem: readFileSync(cert, 'utf8'),
    startupMs: Math.round(performance.now() - started),
    async stop() {
      try {
        await server.stop();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
