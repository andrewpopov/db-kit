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
