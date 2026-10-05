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
        'CodecError',
        'CodecManifestSchema',
        'DEFAULT_BUSY_TIMEOUT_MS',
        'DEFAULT_STATEMENT_TIMEOUT_MS',
        'DatabaseConfigSchema',
        'DbKitError',
        'POSTGRES_CODEC_TYPES',
        'SSL_MODES',
        'buildCodecs',
        'describe',
        'introspectPostgres',
        'introspectSqlite',
        'openDatabase',
        'openPostgres',
        'openSqlite',
        'parseCodecManifest',
        'parseDatabaseUrl',
        'validateManifest',
      ].sort(),
    );
  });

  it('keeps drizzle-orm an optional peer so non-Drizzle apps need not install it', () => {
    expect(pkg.peerDependenciesMeta['drizzle-orm']?.optional).toBe(true);
  });
});
