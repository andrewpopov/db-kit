import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { DatabaseHandle } from './open.js';
import type { PostgresHandle } from './postgres.js';
import type { SqliteHandle } from './sqlite.js';
/**
 * Wrap an open handle in the matching Drizzle instance. Lives on the
 * `@andrewpopov/db-kit/drizzle` subpath so that apps not using Drizzle never
 * need `drizzle-orm` installed (it is an optional peer dependency).
 */
export declare function drizzleFor(handle: SqliteHandle): BetterSQLite3Database;
export declare function drizzleFor(handle: PostgresHandle): NodePgDatabase;
export declare function drizzleFor(handle: DatabaseHandle): BetterSQLite3Database | NodePgDatabase;
