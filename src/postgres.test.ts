import { createServer, type AddressInfo, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbKitError } from './errors.js';
import { openDatabase } from './open.js';
import { openPostgres, type PostgresHandle } from './postgres.js';
import { startThrowawayPostgres, type ThrowawayPostgres } from './test-support/embedded-pg.js';
import type { PostgresConfig } from './url.js';

let server: ThrowawayPostgres;
const handles: PostgresHandle[] = [];

function open(opts: Partial<Parameters<typeof openPostgres>[1]> = {}, config: Partial<PostgresConfig> = {}): PostgresHandle {
  const handle = openPostgres({ ...server.config, ...config }, { applicationName: 'db-kit-test', ...opts });
  handles.push(handle);
  return handle;
}

beforeAll(async () => {
  server = await startThrowawayPostgres();
  console.log(`embedded-postgres started in ${server.startupMs} ms on port ${server.config.port}`);
}, 180_000);

afterAll(async () => {
  await Promise.allSettled(handles.map((h) => h.close()));
  await server?.stop();
});

describe('openPostgres', () => {
  it('requires applicationName', () => {
    // @ts-expect-error applicationName is mandatory in the type as well
    expect(() => openPostgres(server.config, {})).toThrow(DbKitError);
    expect(() => openPostgres(server.config, { applicationName: ' ' })).toThrow(/applicationName/);
  });

  it('rejects invalid numeric options', () => {
    expect(() => openPostgres(server.config, { applicationName: 'x', poolSize: 0 })).toThrow(/poolSize/);
    expect(() => openPostgres(server.config, { applicationName: 'x', statementTimeoutMs: -5 })).toThrow(/statementTimeoutMs/);
  });

  it('health() succeeds against the live server', async () => {
    const result = await open().health();
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('exposes applicationName in pg_stat_activity', async () => {
    const handle = open({ applicationName: 'db-kit-visible-name' });
    await handle.pool.query('select 1');
    const { rows } = await handle.pool.query<{ n: string }>(
      "select count(*)::text as n from pg_stat_activity where application_name = 'db-kit-visible-name'",
    );
    expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(1);
  });

  it('applies statement_timeout per connection: pg_sleep is cancelled by the server', async () => {
    const handle = open({ statementTimeoutMs: 250 });
    const started = performance.now();
    await expect(handle.pool.query('select pg_sleep(5)')).rejects.toMatchObject({ code: '57014' });
    expect(performance.now() - started).toBeLessThan(3000);
    const { rows } = await handle.pool.query<{ statement_timeout: string }>('show statement_timeout');
    expect(rows[0]?.statement_timeout).toBe('250ms');
  });

  it('defaults statement_timeout to 30s', async () => {
    const { rows } = await open().pool.query<{ statement_timeout: string }>('show statement_timeout');
    expect(rows[0]?.statement_timeout).toBe('30s');
  });

  it('close() is idempotent, including concurrent calls', async () => {
    const handle = open();
    await handle.health();
    await Promise.all([handle.close(), handle.close()]);
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('health() after close reports not ok instead of throwing', async () => {
    const handle = open();
    await handle.close();
    expect((await handle.health()).ok).toBe(false);
  });

  it('health() has its own timeout', async () => {
    // A listener that accepts and never speaks: the connect hangs deterministically, so only the health budget can end it.
    const sockets: Socket[] = [];
    const silent = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as AddressInfo;
    try {
      const handle = open({ healthTimeoutMs: 300, connectionTimeoutMs: 10_000 }, { host: '127.0.0.1', port });
      const started = performance.now();
      const result = await handle.health();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/timed out after 300ms/);
      expect(performance.now() - started).toBeLessThan(2000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it('connect failure with a wrong password carries no password anywhere', async () => {
    const wrong = 'wrong-pw-Zx9!probe';
    const handle = open({}, { password: wrong });
    const result = await handle.health();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/password authentication failed/i);
    expect(result.error).not.toContain(wrong);

    // Direct pool use throws the raw driver error: it must carry neither password either.
    const error = await handle.pool.query('select 1').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(wrong);
    expect(String(error)).not.toContain(server.config.password ?? 'unreachable');
  });

  it('unreachable host: scrubbed health error and nothing leaks into the cause chain', async () => {
    const secret = 'unreach-pw-Q7#probe';
    const handle = open({ connectionTimeoutMs: 1000 }, { host: '127.0.0.1', port: 1, password: secret });
    const result = await handle.health();
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain(secret);
    const error = await handle.pool.query('select 1').then(
      () => undefined,
      (e: unknown) => e,
    );
    for (let e: unknown = error; e instanceof Error; e = e.cause) {
      expect(String(e)).not.toContain(secret);
      expect(JSON.stringify(e, Object.getOwnPropertyNames(e))).not.toContain(secret);
    }
  });

  it('close() failure is scrubbed too', async () => {
    const secret = 'close-pw-L3$probe';
    const handle = open({}, { password: secret });
    const closeError = await handle.close().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(String(closeError ?? '')).not.toContain(secret);
  });

  it('openDatabase dispatches to postgres and demands postgres options', async () => {
    const url = `postgres://postgres:${server.config.password}@127.0.0.1:${server.config.port}/postgres`;
    expect(() => openDatabase(url)).toThrow(/applicationName/);
    const handle = openDatabase(url, { postgres: { applicationName: 'db-kit-dispatch' } });
    expect(handle.dialect).toBe('postgres');
    expect((await handle.health()).ok).toBe(true);
    await handle.close();
  });

  it('tls: require encrypts without verifying; verify-ca checks the chain only; verify-full also checks the hostname', async () => {
    const tls = { connectionTimeoutMs: 3000, tlsCa: server.caPem };
    const sslOn = async (handle: PostgresHandle): Promise<boolean | undefined> => {
      const { rows } = await handle.pool.query<{ ssl: boolean }>('select ssl from pg_stat_ssl where pid = pg_backend_pid()');
      return rows[0]?.ssl;
    };

    // disable: plaintext.
    expect(await sslOn(open({}, { sslmode: 'disable' }))).toBe(false);
    // require: encrypted even though the cert is untrusted by default and 127.0.0.1 is not in its SAN.
    expect(await sslOn(open({}, { sslmode: 'require' }))).toBe(true);
    // verify-ca with the right CA: chain verified, hostname ignored (127.0.0.1 is not in the SAN).
    expect(await sslOn(open(tls, { sslmode: 'verify-ca' }))).toBe(true);
    // verify-ca without the CA: untrusted self-signed chain is refused.
    expect((await open({ connectionTimeoutMs: 3000 }, { sslmode: 'verify-ca' }).health()).ok).toBe(false);
    // verify-full: hostname must match. 'localhost' is in the SAN ...
    expect(await sslOn(open(tls, { sslmode: 'verify-full', host: 'localhost' }))).toBe(true);
    // ... 127.0.0.1 is not, so the same CA and server now fail.
    const mismatch = await open(tls, { sslmode: 'verify-full', host: '127.0.0.1' }).health();
    expect(mismatch.ok).toBe(false);
    expect(mismatch.error).toMatch(/altnames|hostname|IP/i);
  });
});
