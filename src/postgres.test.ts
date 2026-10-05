import { createServer, type AddressInfo, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DbKitError } from './errors.js';
import { openDatabase } from './open.js';
import { openPostgres, type PostgresHandle } from './postgres.js';
import { startThrowawayPostgres, type ThrowawayPostgres } from './test-support/embedded-pg.js';
import type { PostgresConfig } from './url.js';

let server: ThrowawayPostgres;
// Certificate with IP SANs only (no DNS name): the configured host, not 'localhost', must be what is verified.
let ipServer: ThrowawayPostgres;
const handles: PostgresHandle[] = [];

function open(opts: Partial<Parameters<typeof openPostgres>[1]> = {}, config: Partial<PostgresConfig> = {}): PostgresHandle {
  const handle = openPostgres({ ...server.config, ...config }, { applicationName: 'db-kit-test', ...opts });
  handles.push(handle);
  return handle;
}

beforeAll(async () => {
  [server, ipServer] = await Promise.all([startThrowawayPostgres(), startThrowawayPostgres('IP:127.0.0.1,IP:::1')]);
  console.log(`embedded-postgres started in ${server.startupMs} ms on port ${server.config.port}`);
}, 180_000);

afterAll(async () => {
  await Promise.allSettled(handles.map((h) => h.close()));
  await Promise.allSettled([server?.stop(), ipServer?.stop()]);
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

  describe('verify-full identity is the configured host', () => {
    const ipConfig = (host: string): Partial<PostgresConfig> => ({ ...ipServer.config, host, sslmode: 'verify-full' });
    const openIp = (host: string): PostgresHandle =>
      open({ connectionTimeoutMs: 3000, tlsCa: ipServer.caPem }, ipConfig(host));

    it('IP literal in the certificate SAN passes', async () => {
      expect((await openIp('127.0.0.1').health()).ok).toBe(true);
    });

    it('a cert with no DNS SAN is refused for host "localhost" (identity is not hard-wired to localhost)', async () => {
      const result = await openIp('localhost').health();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/altnames|hostname|does not match/i);
    });

    it('cert for localhost only is refused for 127.0.0.1', async () => {
      const result = await open({ connectionTimeoutMs: 3000, tlsCa: server.caPem }, { sslmode: 'verify-full', host: '127.0.0.1' }).health();
      expect(result.ok).toBe(false);
    });

    it('IPv6 literal in the SAN passes when the server listens on ::1', async () => {
      const result = await openIp('::1').health();
      expect(result.ok, result.error).toBe(true);
    });
  });

  it('statementTimeoutMs: 0 really disables, overriding a role-level default, on every pooled connection', async () => {
    const admin = open();
    await admin.pool.query("create role t3 login password 'pw3'");
    await admin.pool.query("alter role t3 set statement_timeout = '7s'");
    const asRole = (statementTimeoutMs: number): PostgresHandle => open({ statementTimeoutMs, poolSize: 3 }, { user: 't3', password: 'pw3' });

    const baseline = await asRole(30_000).pool.query<{ statement_timeout: string }>('show statement_timeout');
    expect(baseline.rows[0]?.statement_timeout).toBe('30s');

    const disabled = asRole(0);
    // Hold three connections at once so the pool really opens three distinct ones.
    const clients = await Promise.all([disabled.pool.connect(), disabled.pool.connect(), disabled.pool.connect()]);
    try {
      for (const client of clients) {
        const { rows } = await client.query<{ statement_timeout: string }>('show statement_timeout');
        expect(rows[0]?.statement_timeout).toBe('0');
      }
    } finally {
      for (const client of clients) client.release();
    }
  });

  it('timed-out health probes do not occupy the pool or hang close()', async () => {
    const sockets: Socket[] = [];
    const silent = createServer((socket) => {
      socket.resume(); // consume, so a client-side close is observed
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as AddressInfo;
    try {
      const handle = open({ healthTimeoutMs: 150, poolSize: 1, connectionTimeoutMs: 10_000 }, { host: '127.0.0.1', port });
      for (let i = 0; i < 4; i++) expect((await handle.health()).ok).toBe(false);
      // Probes must not have taken the pool's only slot: nothing is checked out or waiting.
      expect(handle.pool.totalCount).toBe(0);
      expect(handle.pool.waitingCount).toBe(0);
      // Every probe's socket must have been torn down by the client, not left for the server to close.
      await vi.waitFor(() => expect(sockets.filter((socket) => !socket.destroyed && socket.readable)).toHaveLength(0), { timeout: 1000 });
      expect(sockets).toHaveLength(4);
      // close() must finish on its own, while the silent server's sockets are still open.
      const closed = await Promise.race([handle.close().then(() => 'closed'), new Promise((r) => setTimeout(() => r('hung'), 2000))]);
      expect(closed).toBe('closed');
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it('a probe that connects but whose query hangs is destroyed, not left open', async () => {
    const sockets: Socket[] = [];
    // Speaks just enough protocol to finish startup (AuthenticationOk + ReadyForQuery), then ignores every query.
    const stalled = createServer((socket) => {
      sockets.push(socket);
      let answered = false;
      socket.on('data', () => {
        if (answered) return;
        answered = true;
        socket.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]));
      });
    });
    await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', resolve));
    const { port } = stalled.address() as AddressInfo;
    try {
      const result = await open({ healthTimeoutMs: 200 }, { host: '127.0.0.1', port }).health();
      expect(result.ok).toBe(false);
      expect(sockets).toHaveLength(1);
      await vi.waitFor(() => expect(sockets[0]?.destroyed).toBe(true), { timeout: 1000 });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => stalled.close(() => resolve()));
    }
  });
});
