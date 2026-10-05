import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
export function drizzleFor(handle) {
    switch (handle.dialect) {
        case 'sqlite':
            return drizzleSqlite(handle.db);
        case 'postgres':
            return drizzlePg(handle.pool);
    }
}
