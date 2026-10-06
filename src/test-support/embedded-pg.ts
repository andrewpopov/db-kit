import { startTestPostgres } from '../testing/postgres.js';
import type { PostgresConfig } from '../url.js';

export interface ThrowawayPostgres {
  /** Config for the superuser `postgres` with the real password. */
  config: PostgresConfig;
  /** PEM of the self-signed server certificate (SAN per `san`). */
  caPem: string;
  startupMs: number;
  stop(): Promise<void>;
}

/**
 * The repo's own tests use the public `startTestPostgres` through this wrapper, which adds the TLS certificate
 * (`san` is its subjectAltName; the default only matches `localhost`, not 127.0.0.1) and `extraFlags` for the server.
 */
export async function startThrowawayPostgres(san = 'DNS:localhost', extraFlags: readonly string[] = []): Promise<ThrowawayPostgres> {
  const server = await startTestPostgres({ tls: { san }, extraFlags });
  return { config: server.config, caPem: server.caPem ?? '', startupMs: server.startupMs, stop: () => server.stop() };
}
