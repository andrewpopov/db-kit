import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { DbKitError } from '../errors.js';
import { startTestPostgres, startTestPostgresWith } from './postgres.js';

function holdPort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

describe('startTestPostgres start failures', () => {
  it('retries on a fresh port when the first one is taken before postgres binds', async () => {
    const { server: holder, port: held } = await holdPort();
    const handedOut: number[] = [];
    let first = true;
    const pickPort = async (): Promise<number> => {
      if (first) {
        first = false;
        handedOut.push(held);
        return held;
      }
      const { server, port } = await holdPort();
      await new Promise((resolve) => server.close(resolve));
      handedOut.push(port);
      return port;
    };
    try {
      const pg = await startTestPostgresWith({}, pickPort);
      try {
        expect(pg.config.port).not.toBe(held);
        expect(handedOut.length).toBe(2);
        const client = new Client({ ...pg.config, ssl: false });
        await client.connect();
        try {
          expect((await client.query('select 1 as one')).rows[0]).toEqual({ one: 1 });
        } finally {
          await client.end();
        }
      } finally {
        await pg.stop();
      }
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  }, 180_000);

  it('throws a typed error carrying postgres own complaint, once, and cleans up', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'db-kit-start-failure-'));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = scratch;
    try {
      const error = await startTestPostgres({ extraFlags: ['-c', 'max_connections=notanumber'] }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(DbKitError);
      const failure = error as DbKitError;
      expect(failure.code).toBe('TEST_POSTGRES_START_FAILED');
      expect(failure.message).toContain('invalid value for parameter');
      expect(failure.message).toContain('after 1 attempt(s)');
      expect(failure.message).not.toContain('correct-horse-battery');
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});
