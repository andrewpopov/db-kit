import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { platform, arch, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../open.js';
import { parseDatabaseUrl } from '../url.js';
import { dialectsFromEnv, describeEachDialect } from './dialects.js';
import { createTestDatabase, startTestPostgres, type TestPostgres } from './postgres.js';

describe('startTestPostgres / createTestDatabase', () => {
  let server: TestPostgres;
  beforeAll(async () => {
    server = await startTestPostgres();
    console.log(`embedded-postgres: ${platform()}/${arch()} node ${process.version} started in ${server.startupMs} ms`);
  }, 180_000);
  afterAll(async () => {
    await server?.stop();
  }, 60_000);

  const databaseExists = async (name: string): Promise<boolean> => {
    const admin = new Client({ ...server.config, ssl: false });
    admin.on('error', () => undefined);
    await admin.connect();
    try {
      return ((await admin.query('select 1 from pg_database where datname = $1', [name])).rowCount ?? 0) > 0;
    } finally {
      await admin.end();
    }
  };

  it('returns a URL and config that open a healthy handle as the superuser', async () => {
    expect(parseDatabaseUrl(server.url)).toMatchObject({ dialect: 'postgres', host: '127.0.0.1', port: server.config.port, database: 'postgres', user: 'postgres' });
    const handle = openDatabase(server.url, { postgres: { applicationName: 'db-kit-test' } });
    try {
      expect((await handle.health()).ok).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('creates fresh test_<random> databases and drops them on release, even with a connection still open', async () => {
    const a = await createTestDatabase(server);
    const b = await createTestDatabase(server);
    expect(a.name).toMatch(/^test_[0-9a-f]{12}$/);
    expect(a.name).not.toBe(b.name);
    const handle = openDatabase(a.url, { postgres: { applicationName: 'db-kit-test' } });
    if (handle.dialect !== 'postgres') throw new Error('expected postgres');
    await handle.pool.query('create table only_in_a(id int)');
    expect((await openDatabase(b.url, { postgres: { applicationName: 'db-kit-test' } }).health()).ok).toBe(true);
    expect(await databaseExists(a.name)).toBe(true);
    await a.release();
    await a.release(); // idempotent
    await handle.close().catch(() => undefined);
    expect(await databaseExists(a.name)).toBe(false);
    expect(await databaseExists(b.name)).toBe(true);
    await b.release();
  });

  it('passes extra server flags and a locale through to the server', async () => {
    const custom = await startTestPostgres({ extraFlags: ['-c', 'max_connections=23'], locale: 'C' });
    try {
      const client = new Client({ ...custom.config, ssl: false });
      await client.connect();
      try {
        expect((await client.query('show max_connections')).rows[0]).toEqual({ max_connections: '23' });
        expect((await client.query('select datcollate from pg_database where datname = current_database()')).rows[0]).toEqual({ datcollate: 'C' });
        expect((await client.query('show server_encoding')).rows[0]).toEqual({ server_encoding: 'UTF8' });
      } finally {
        await client.end();
      }
    } finally {
      await custom.stop();
    }
  }, 180_000);

  it('initialises with the builtin locale provider when asked (PG 17)', async () => {
    const custom = await startTestPostgres({ locale: 'builtin:C.UTF-8' });
    try {
      const client = new Client({ ...custom.config, ssl: false });
      await client.connect();
      try {
        expect((await client.query('select datlocprovider, datlocale from pg_database where datname = current_database()')).rows[0]).toEqual({ datlocprovider: 'b', datlocale: 'C.UTF-8' });
      } finally {
        await client.end();
      }
    } finally {
      await custom.stop();
    }
  }, 180_000);

  it('a start that cannot succeed rejects (and leaves no server behind)', async () => {
    await expect(startTestPostgres({ locale: 'no_such_locale_xyz' })).rejects.toThrow();
  }, 120_000);
});

const ran = new Map<string, { url: string; port: string }>();

describeEachDialect('describeEachDialect, first block', ({ dialect, url, open }) => {
  it('hands each dialect its own handle, URL and fresh database', async () => {
    const handle = open();
    expect(handle.dialect).toBe(dialect);
    expect(parseDatabaseUrl(url()).dialect).toBe(dialect);
    if (handle.dialect === 'sqlite') {
      handle.db.exec('create table kv(k text primary key, v text)');
      handle.db.prepare('insert into kv values (?, ?)').run('a', 'b');
      expect(handle.db.prepare('select v from kv').get()).toEqual({ v: 'b' });
    } else {
      await handle.pool.query('create table kv(k text primary key, v text)');
      await handle.pool.query("insert into kv values ('a', 'b')");
      expect((await handle.pool.query('select v from kv')).rows).toEqual([{ v: 'b' }]);
    }
    const config = parseDatabaseUrl(url());
    ran.set(`first ${dialect}`, { url: url(), port: config.dialect === 'postgres' ? String(config.port) : '' });
  });
});

describeEachDialect('describeEachDialect, second block', ({ dialect, url, open }) => {
  it('gets a different database than the first block, on the same shared server for Postgres', async () => {
    const handle = open();
    // the first block's table is not here: this is a fresh database / file
    if (handle.dialect === 'sqlite') expect(handle.db.prepare("select count(*) as n from sqlite_master where name = 'kv'").get()).toEqual({ n: 0 });
    else expect((await handle.pool.query("select count(*)::int as n from pg_tables where tablename = 'kv'")).rows).toEqual([{ n: 0 }]);
    const first = ran.get(`first ${dialect}`);
    expect(first).toBeDefined();
    expect(first?.url).not.toBe(url());
    const config = parseDatabaseUrl(url());
    if (config.dialect === 'postgres') expect(config.port).toBe(Number(first?.port));
    ran.set(`second ${dialect}`, { url: url(), port: '' });
  });
});

describe('describeEachDialect covered every requested dialect', () => {
  it('ran once per dialect named by DB_KIT_TEST_DIALECTS (default both)', () => {
    const expected = dialectsFromEnv();
    expect([...ran.keys()].sort()).toEqual(expected.flatMap((d) => [`first ${d}`, `second ${d}`]).sort());
  });
});

describe('DB_KIT_TEST_DIALECTS', () => {
  it('accepts sqlite, postgres and both (the default) and rejects anything else', () => {
    expect(dialectsFromEnv({})).toEqual(['sqlite', 'postgres']);
    expect(dialectsFromEnv({ DB_KIT_TEST_DIALECTS: 'both' })).toEqual(['sqlite', 'postgres']);
    expect(dialectsFromEnv({ DB_KIT_TEST_DIALECTS: 'sqlite' })).toEqual(['sqlite']);
    expect(dialectsFromEnv({ DB_KIT_TEST_DIALECTS: 'postgres' })).toEqual(['postgres']);
    expect(() => dialectsFromEnv({ DB_KIT_TEST_DIALECTS: 'postgress' })).toThrow(/sqlite, postgres or both/);
  });
});

describe('when Postgres cannot start, describeEachDialect fails: it never skips', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const work = mkdtempSync(join(tmpdir(), 'db-kit-fixture-'));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  /** Run the fixture file in a child vitest and return its exit status and output. */
  function runFixture(dialects: string): { status: number; output: string } {
    const config = join(work, `vitest.${dialects}.config.mjs`);
    writeFileSync(config, `export default { root: ${JSON.stringify(root)}, test: { include: [${JSON.stringify(join(root, 'src/testing/fixtures/*.fixture.ts'))}] } };\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, DB_KIT_TEST_DIALECTS: dialects, NO_COLOR: '1' };
    delete env.FORCE_COLOR;
    const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');
    for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key];
    try {
      const output = execFileSync(process.execPath, [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', config, '--reporter=verbose'], { cwd: root, env, encoding: 'utf8', stdio: 'pipe', timeout: 150_000 });
      return { status: 0, output: plain(output) };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { status: failure.status ?? -1, output: plain(`${failure.stdout ?? ''}${failure.stderr ?? ''}`) };
    }
  }

  it('both requested: the sqlite test passes and the postgres test FAILS by name', () => {
    const { status, output } = runFixture('both');
    expect(status).not.toBe(0);
    expect(output).toMatch(/✓.*fixture \[sqlite\] > opens its dialect/);
    // vitest lists a suite whose beforeAll threw as skipped tests under a FAILED suite; the run itself fails, by suite name
    expect(output).toMatch(/FAIL.*fixture \[postgres\]/);
    expect(output).toMatch(/invalid locale name/);
  }, 180_000);

  it('postgres only: fails too', () => {
    const { status, output } = runFixture('postgres');
    expect(status).not.toBe(0);
    expect(output).toMatch(/fixture \[postgres\]/);
    expect(output).not.toMatch(/fixture \[sqlite\]/);
  }, 180_000);

  it('sqlite only: passes without ever starting Postgres', () => {
    const { status, output } = runFixture('sqlite');
    expect(status).toBe(0);
    expect(output).toMatch(/fixture \[sqlite\] > opens its dialect/);
    expect(output).not.toMatch(/fixture \[postgres\]/);
  }, 180_000);

  it('a mistyped value fails loudly instead of dropping a dialect', () => {
    const { status, output } = runFixture('postgress');
    expect(status).not.toBe(0);
    expect(output).toMatch(/DB_KIT_TEST_DIALECTS must be sqlite, postgres or both/);
  }, 180_000);
});
