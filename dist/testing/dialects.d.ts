import { type DatabaseHandle, type OpenDatabaseOptions } from '../open.js';
import { type StartTestPostgresOptions } from './postgres.js';
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
/** `DB_KIT_TEST_DIALECTS`: `sqlite`, `postgres` or `both` (default). Anything else throws: a typo must not quietly drop a dialect. */
export declare function dialectsFromEnv(env?: NodeJS.ProcessEnv): readonly TestDialect[];
/**
 * Run `fn` once per requested dialect, each inside its own `describe('<name> [<dialect>]')`: against a throwaway SQLite
 * file and against a fresh database on a Postgres server shared by the whole test file. Call it at the top level of a
 * test file. If Postgres is requested and cannot start (including a missing `embedded-postgres`), its tests FAIL, they
 * are never skipped: a skipped dialect is how parity rots. Narrow with `DB_KIT_TEST_DIALECTS=sqlite|postgres|both`.
 *
 * `fn` runs at collection time, so call `url()` and `open()` inside `it`/`beforeEach`, not at the top of `fn`.
 */
export declare function describeEachDialect(name: string, fn: (context: DialectContext) => void, options?: DescribeEachDialectOptions): void;
