import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as root from './index.js';

const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
};

describe('package surface', () => {
  it('root entry exports the documented API and does not pull in drizzle', () => {
    expect(Object.keys(root).sort()).toEqual(
      [
        'DEFAULT_BUSY_TIMEOUT_MS',
        'DEFAULT_STATEMENT_TIMEOUT_MS',
        'DatabaseConfigSchema',
        'DbKitError',
        'SSL_MODES',
        'describe',
        'openDatabase',
        'openPostgres',
        'openSqlite',
        'parseDatabaseUrl',
      ].sort(),
    );
  });

  it('keeps drizzle-orm an optional peer so non-Drizzle apps need not install it', () => {
    expect(pkg.peerDependenciesMeta['drizzle-orm']?.optional).toBe(true);
  });
});
