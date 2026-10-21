import { type PoolRoutingOptions } from './pooling.js';
import { type PostgresHandle, type PostgresOptions } from './postgres.js';
import { type SqliteHandle, type SqliteOptions } from './sqlite.js';
export type DatabaseHandle = SqliteHandle | PostgresHandle;
export interface OpenDatabaseOptions {
    sqlite?: SqliteOptions;
    /** Required when the URL is Postgres: `applicationName` has no default. */
    postgres?: PostgresOptions;
}
/** Parse `url` and open the matching dialect. */
export declare function openDatabase(url: string, opts?: OpenDatabaseOptions): DatabaseHandle;
/** Fleet runtime entrypoint: PostgreSQL uses POOLED_DATABASE_URL by default; direct work is explicit. */
export declare function openDatabaseFromEnvironment(env: Readonly<Record<string, string | undefined>>, opts?: OpenDatabaseOptions & PoolRoutingOptions): DatabaseHandle;
