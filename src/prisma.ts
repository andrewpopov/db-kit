import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { CodecManifest } from './codecs/manifest.js';
import type { SqliteExportApp } from './clone/export-sqlite.js';

const run = promisify(execFile);
const STDERR_TAIL_LINES = 20;

/**
 * Options for `prismaExportApp`. Lives on the `@andrewpopov/db-kit/prisma` subpath; db-kit itself never imports
 * Prisma, it only runs the app's own `prisma` binary.
 */
export interface PrismaExportOptions {
  /** The app's FORWARD codec manifest (already parsed). */
  manifest: CodecManifest;
  /** The SQLite Prisma schema (`provider = "sqlite"`, `url = env("DATABASE_URL")`); its sibling `migrations/` is the SQLite history. */
  sqliteSchemaPath: string;
  /** The Postgres migrations directory: one subdirectory per migration, each holding `migration.sql`. */
  postgresMigrationsDir: string;
  /** Default: `node_modules/.bin/prisma`, found by walking up from the schema's directory. */
  prismaBin?: string;
  /** The environment variable the SQLite schema's `url` reads. Default `DATABASE_URL`. */
  databaseUrlEnv?: string;
  /** Extra tables the reverse direction must not copy: name -> reason. Merged with the Prisma ledger table. */
  skipTables?: Readonly<Record<string, string>>;
  smoke?: SqliteExportApp['smoke'];
}

const LEDGER_TABLE = '_prisma_migrations';

function findUp(start: string, relative: string): string | undefined {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

function resolvePrismaBin(schemaDir: string): string {
  const found = findUp(schemaDir, join('node_modules', '.bin', 'prisma'));
  if (found === undefined) throw new Error(`prisma binary not found: no node_modules/.bin/prisma above ${schemaDir}; pass prismaBin`);
  return found;
}

const stderrTail = (error: unknown): string => {
  const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String((error as { stderr: unknown }).stderr) : '';
  return stderr.trimEnd().split('\n').slice(-STDERR_TAIL_LINES).join('\n');
};

/** A `SqliteExportApp` for a Prisma app: the template is `prisma migrate deploy` on an empty SQLite file, the ledger is `_prisma_migrations`. */
export function prismaExportApp(options: PrismaExportOptions): SqliteExportApp {
  const schemaPath = resolve(options.sqliteSchemaPath);
  const schemaDir = dirname(schemaPath);
  const urlEnv = options.databaseUrlEnv ?? 'DATABASE_URL';
  const migrationsDir = resolve(options.postgresMigrationsDir);
  return {
    manifest: options.manifest,
    skipTables: { [LEDGER_TABLE]: 'Prisma migration ledger, per-dialect', ...options.skipTables },
    smoke: options.smoke,
    async buildTemplate(path) {
      const bin = options.prismaBin ?? resolvePrismaBin(schemaDir);
      const packageJson = findUp(schemaDir, 'package.json');
      const cwd = packageJson === undefined ? schemaDir : dirname(packageJson);
      try {
        await run(bin, ['migrate', 'deploy', '--schema', schemaPath], {
          cwd,
          env: { ...process.env, [urlEnv]: `file:${resolve(path)}`, PRISMA_HIDE_UPDATE_MESSAGE: '1', CI: '1' },
        });
      } catch (error) {
        throw new Error(`prisma migrate deploy failed for the SQLite template:\n${stderrTail(error)}`);
      }
    },
    ledger: {
      query: `SELECT migration_name AS id FROM ${LEDGER_TABLE} WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
      expected: () =>
        readdirSync(migrationsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && existsSync(join(migrationsDir, entry.name, 'migration.sql')))
          .map((entry) => entry.name)
          .sort(),
    },
  };
}
