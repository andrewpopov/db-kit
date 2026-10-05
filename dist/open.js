import { DbKitError } from './errors.js';
import { openPostgres } from './postgres.js';
import { openSqlite } from './sqlite.js';
import { parseDatabaseUrl } from './url.js';
/** Parse `url` and open the matching dialect. */
export function openDatabase(url, opts = {}) {
    const config = parseDatabaseUrl(url);
    switch (config.dialect) {
        case 'sqlite':
            return openSqlite(config, opts.sqlite);
        case 'postgres':
            if (!opts.postgres)
                throw new DbKitError('INVALID_OPTIONS', 'postgres options (with applicationName) are required for a Postgres URL');
            return openPostgres(config, opts.postgres);
    }
}
