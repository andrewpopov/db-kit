import { drizzle as drizzleSqlite, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { DatabaseHandle } from './open.js';
import type { PostgresHandle } from './postgres.js';
import type { SqliteHandle } from './sqlite.js';

/**
 * Wrap an open handle in the matching Drizzle instance. Lives on the
 * `@andrewpopov/db-kit/drizzle` subpath so that apps not using Drizzle never
 * need `drizzle-orm` installed (it is an optional peer dependency).
 */
export function drizzleFor(handle: SqliteHandle): BetterSQLite3Database;
export function drizzleFor(handle: PostgresHandle): NodePgDatabase;
export function drizzleFor(handle: DatabaseHandle): BetterSQLite3Database | NodePgDatabase;
export function drizzleFor(handle: DatabaseHandle): BetterSQLite3Database | NodePgDatabase {
  switch (handle.dialect) {
    case 'sqlite':
      return drizzleSqlite(handle.db);
    case 'postgres':
      return drizzlePg(handle.pool);
  }
}
