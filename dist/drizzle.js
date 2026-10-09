import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { quoteIdent } from './clone/catalog.js';
export function drizzleFor(handle) {
    switch (handle.dialect) {
        case 'sqlite':
            return drizzleSqlite(handle.db);
        case 'postgres':
            return drizzlePg(handle.pool);
    }
}
/** The `when` of each journal entry: drizzle's migrators write it as the ledger's `created_at` (`folderMillis`). */
function journalMillis(migrationsFolder) {
    const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'));
    return journal.entries.map((entry) => String(entry.when));
}
/** A `SqliteExportApp` for a Drizzle app: the template is the SQLite migrations applied to an empty file, the ledger is the Postgres `created_at` of each migration. */
export function drizzleExportApp(options) {
    const table = options.migrationsTable ?? '__drizzle_migrations';
    const schema = options.migrationsSchema ?? 'drizzle';
    return {
        manifest: options.manifest,
        skipTables: { [table]: 'Drizzle migration ledger, per-dialect', ...options.skipTables },
        smoke: options.smoke,
        buildTemplate(path) {
            const sqlite = new Database(path);
            try {
                migrate(drizzleSqlite(sqlite), { migrationsFolder: options.sqliteMigrationsFolder, migrationsTable: table });
            }
            finally {
                sqlite.close();
            }
        },
        ledger: {
            query: `SELECT created_at::text AS id FROM ${quoteIdent(schema)}.${quoteIdent(table)}`,
            expected: () => journalMillis(options.postgresMigrationsFolder),
        },
    };
}
