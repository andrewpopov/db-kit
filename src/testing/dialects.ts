import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DbKitError } from '../errors.js';
import { openDatabase, type DatabaseHandle, type OpenDatabaseOptions } from '../open.js';
import { createTestDatabase, startTestPostgres, type StartTestPostgresOptions, type TestDatabase, type TestPostgres } from './postgres.js';

// vitest is an optional peer: loading it lazily keeps `startTestPostgres` and `compareSchemas` usable under any other runner.
const vitest = await import('vitest').catch(() => undefined);

export type TestDialect = 'sqlite' | 'postgres';

export interface DialectContext {
  readonly dialect: TestDialect;
  /** The throwaway database's URL. A function, so destructuring `({ url })` is safe at collection time; call it inside tests (after the describe's `beforeAll`). */
  url(): string;
  /** Open the throwaway database; every handle opened here is closed after the describe. Postgres gets `applicationName: 'db-kit-test'` unless overridden. */
  open(options?: OpenDatabaseOptions): DatabaseHandle;
}

export interface DescribeEachDialectOptions {
  /** Restrict to these dialects (still narrowed by `DB_KIT_TEST_DIALECTS`). Default both. */
  dialects?: readonly TestDialect[];
  /** Options for the shared Postgres server. */
  postgres?: StartTestPostgresOptions;
}

const ALL: readonly TestDialect[] = ['sqlite', 'postgres'];

/** `DB_KIT_TEST_DIALECTS`: `sqlite`, `postgres` or `both` (default). Anything else throws: a typo must not quietly drop a dialect. */
export function dialectsFromEnv(env: NodeJS.ProcessEnv = process.env): readonly TestDialect[] {
  const value = env.DB_KIT_TEST_DIALECTS?.trim() || 'both';
  if (value === 'both') return ALL;
  if (value === 'sqlite' || value === 'postgres') return [value];
  throw new DbKitError('INVALID_OPTIONS', `DB_KIT_TEST_DIALECTS must be sqlite, postgres or both (got "${value.slice(0, 20)}")`);
}

// One Postgres server per test file (vitest gives every file its own module instance), started on first use.
let shared: Promise<TestPostgres> | undefined;
function sharedPostgres(options: StartTestPostgresOptions | undefined): Promise<TestPostgres> {
  shared ??= startTestPostgres(options);
  return shared;
}
async function stopSharedPostgres(): Promise<void> {
  const server = shared;
  shared = undefined;
  if (server) await (await server.catch(() => undefined))?.stop();
}

/**
 * Run `fn` once per requested dialect, each inside its own `describe('<name> [<dialect>]')`: against a throwaway SQLite
 * file and against a fresh database on a Postgres server shared by the whole test file. Call it at the top level of a
 * test file. If Postgres is requested and cannot start (including a missing `embedded-postgres`), its tests FAIL, they
 * are never skipped: a skipped dialect is how parity rots. Narrow with `DB_KIT_TEST_DIALECTS=sqlite|postgres|both`.
 *
 * `fn` runs at collection time, so call `url()` and `open()` inside `it`/`beforeEach`, not at the top of `fn`.
 */
export function describeEachDialect(name: string, fn: (context: DialectContext) => void, options: DescribeEachDialectOptions = {}): void {
  if (!vitest) throw new DbKitError('INVALID_OPTIONS', 'describeEachDialect needs the optional peer "vitest" (npm i -D vitest)');
  const { afterAll, beforeAll, describe } = vitest;
  const requested = dialectsFromEnv();
  const dialects = (options.dialects ?? ALL).filter((dialect) => requested.includes(dialect));
  if (dialects.includes('postgres')) afterAll(stopSharedPostgres, 60_000);
  for (const dialect of dialects) {
    describe(`${name} [${dialect}]`, () => {
      let url: string | undefined;
      let cleanup: () => Promise<void> = async () => undefined;
      const handles: DatabaseHandle[] = [];
      beforeAll(async () => {
        if (dialect === 'sqlite') {
          const dir = mkdtempSync(join(tmpdir(), 'db-kit-sqlite-'));
          url = `file:${join(dir, 'test.db')}`;
          cleanup = async () => rmSync(dir, { recursive: true, force: true });
        } else {
          const database: TestDatabase = await createTestDatabase(await sharedPostgres(options.postgres));
          url = database.url;
          cleanup = () => database.release();
        }
      }, 180_000);
      afterAll(async () => {
        await Promise.allSettled(handles.map((handle) => handle.close()));
        await cleanup();
      }, 60_000);
      fn({
        dialect,
        url() {
          if (url === undefined) throw new DbKitError('INVALID_OPTIONS', 'url() is only available once tests run; call it inside it()/beforeEach()');
          return url;
        },
        open(openOptions = {}) {
          if (url === undefined) throw new DbKitError('INVALID_OPTIONS', 'open() is only available once tests run; call it inside it()/beforeEach()');
          const handle = openDatabase(url, { postgres: { applicationName: 'db-kit-test' }, ...openOptions });
          handles.push(handle);
          return handle;
        },
      });
    });
  }
}
