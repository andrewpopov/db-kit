import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as root from './index.js';

const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
};

describe('testing entry', () => {
  it('exports the documented testing API on its own subpath, not on the root', async () => {
    const testing = await import('./testing.js');
    expect(Object.keys(testing).sort()).toEqual(['compareSchemas', 'createTestDatabase', 'describeEachDialect', 'dialectsFromEnv', 'normalizeExpression', 'postgresUrl', 'startTestPostgres']);
    expect(Object.keys(root)).not.toContain('startTestPostgres');
    expect(Object.keys(root)).not.toContain('describeEachDialect');
  });
});

describe('clone entry', () => {
  it('exports the SQLite export API next to reverseClone', async () => {
    const clone = await import('./clone.js');
    expect(Object.keys(clone)).toEqual(expect.arrayContaining(['reverseClone', 'exportToSqlite', 'buildExportTemplate', 'reverseManifestFor', 'runExportSqliteCli']));
    expect(clone.CLONE_REFUSAL_CODES).toContain('ledger-mismatch');
  });
});

describe('builder entries', () => {
  it('exports prismaExportApp on the prisma subpath and drizzleExportApp on the drizzle subpath, neither on the root', async () => {
    expect(Object.keys(await import('./prisma.js'))).toEqual(['prismaExportApp']);
    expect(Object.keys(await import('./drizzle.js'))).toEqual(expect.arrayContaining(['drizzleFor', 'drizzleExportApp']));
    expect(Object.keys(root)).not.toContain('prismaExportApp');
    expect(Object.keys(root)).not.toContain('drizzleExportApp');
  });

  it('maps the prisma subpath in package.json exports', () => {
    expect((pkg as unknown as { exports: Record<string, unknown> }).exports['./prisma']).toEqual({ types: './dist/prisma.d.ts', default: './dist/prisma.js' });
  });
});

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
