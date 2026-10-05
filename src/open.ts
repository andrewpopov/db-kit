import { DbKitError } from './errors.js';
import { openPostgres, type PostgresHandle, type PostgresOptions } from './postgres.js';
import { openSqlite, type SqliteHandle, type SqliteOptions } from './sqlite.js';
import { parseDatabaseUrl } from './url.js';

export type DatabaseHandle = SqliteHandle | PostgresHandle;

export interface OpenDatabaseOptions {
  sqlite?: SqliteOptions;
  /** Required when the URL is Postgres: `applicationName` has no default. */
  postgres?: PostgresOptions;
}

/** Parse `url` and open the matching dialect. */
export function openDatabase(url: string, opts: OpenDatabaseOptions = {}): DatabaseHandle {
  const config = parseDatabaseUrl(url);
  switch (config.dialect) {
    case 'sqlite':
      return openSqlite(config, opts.sqlite);
    case 'postgres':
      if (!opts.postgres) throw new DbKitError('INVALID_OPTIONS', 'postgres options (with applicationName) are required for a Postgres URL');
      return openPostgres(config, opts.postgres);
  }
}
