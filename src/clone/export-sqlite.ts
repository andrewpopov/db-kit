import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { CodecManifest } from '../codecs/manifest.js';
import { openPostgres } from '../postgres.js';
import type { PostgresConfig } from '../url.js';
import { quoteIdent } from './catalog.js';
import { CloneRefusal, refuse, toRefusal } from './errors.js';
import type { ProgressEvent } from './execute.js';
import { reverseClone, type ReverseResult } from './reverse.js';
import type { TopologyEntry } from './topology.js';

/**
 * Postgres to SQLite export, the swap-back path every app shares. `reverseClone` does the copy and the row-by-row
 * verification; the app supplies what only it knows: its forward manifest, how to build its empty SQLite schema, and
 * which migration ids Postgres must hold.
 */
export interface SqliteExportApp {
  /** The app's FORWARD codec manifest (already parsed). */
  manifest: CodecManifest;
  /** Extra tables the reverse direction must not copy: name -> reason. Merged into the manifest as `{ copy: false, reason }`. */
  skipTables?: Readonly<Record<string, string>>;
  /** Write an EMPTY file at `path` carrying the app's own SQLite schema (run its migrations, any app-specific rebuilds). */
  buildTemplate(path: string): void | Promise<void>;
  /** The source's migration ledger must equal `expected` exactly. `query` is SQL run on the Postgres source returning a text column `id`. */
  ledger: { query: string; expected: () => Iterable<string> | Promise<Iterable<string>> };
  /** Open a COPY of the published file the way the app would. Throw to report a problem; it becomes a warning, never a refusal. */
  smoke?(copyPath: string): void | Promise<void>;
}

export interface ExportToSqliteOptions {
  app: SqliteExportApp;
  source: PostgresConfig;
  /** The new SQLite file; must not exist. Put it outside the live location. */
  toSqlitePath: string;
  /** Operator attestation that every writer to the source is stopped and drained. */
  writersStopped: boolean;
  dryRun?: boolean;
  confirmProduction?: string;
  topology?: readonly TopologyEntry[];
  tlsCa?: string;
  fetchRows?: number;
  onProgress?: (event: ProgressEvent) => void;
}

export interface ExportToSqliteResult extends ReverseResult {
  /** Copied tables in which the template held rows (seeded by a migration), emptied in the template only. */
  templateRowsCleared: string[];
}

/** The forward manifest with `app.skipTables` declared `copy: false`, so the template's own rows in them (such as its ledger) are kept. */
export function reverseManifestFor(app: SqliteExportApp): CodecManifest {
  const skip = app.skipTables ?? {};
  const tables = Object.fromEntries(Object.entries(app.manifest.tables).filter(([name]) => !Object.hasOwn(skip, name)));
  const skipped = { ...app.manifest.skipped, ...Object.fromEntries(Object.entries(skip).map(([name, reason]) => [name, { reason }])) };
  return { version: app.manifest.version, tables, skipped };
}

/**
 * Writes the app's empty SQLite file at `path`. A migration may seed a row into a table the clone copies (`reverseClone`
 * refuses a template with rows there); those rows are deleted here, in the template only, because Postgres's own copy of
 * them is what the export carries. Returns the tables emptied.
 */
export async function buildExportTemplate(app: SqliteExportApp, path: string): Promise<string[]> {
  await app.buildTemplate(path);
  const db = new Database(path);
  try {
    const emptied: string[] = [];
    for (const table of Object.keys(reverseManifestFor(app).tables)) {
      const { changes } = db.prepare(`DELETE FROM ${quoteIdent(table)}`).run();
      if (changes === 0) continue;
      emptied.push(table);
      db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(table);
    }
    return emptied;
  } finally {
    db.close();
  }
}

async function postgresLedgerIds(app: SqliteExportApp, options: ExportToSqliteOptions): Promise<Set<string>> {
  const handle = openPostgres(options.source, { applicationName: 'db-kit-export', poolSize: 1, statementTimeoutMs: 0, ...(options.tlsCa === undefined ? {} : { tlsCa: options.tlsCa }) });
  try {
    const { rows } = await handle.pool.query<{ id: string }>(app.ledger.query);
    return new Set(rows.map((row) => row.id));
  } catch {
    return refuse({ code: 'source-read-failed' });
  } finally {
    await handle.close();
  }
}

/** Refuses unless Postgres holds exactly the migrations the code defines, naming every missing and extra id. */
function assertLedgersMatch(postgres: ReadonlySet<string>, expected: ReadonlySet<string>): void {
  const missing = [...expected].filter((id) => !postgres.has(id)).sort();
  const extra = [...postgres].filter((id) => !expected.has(id)).sort();
  if (missing.length === 0 && extra.length === 0) return;
  throw new CloneRefusal(
    { code: 'ledger-mismatch' },
    `the Postgres migration ledger differs from this code's: missing from Postgres [${missing.join(', ')}]; unknown to this code [${extra.join(', ')}]`,
  );
}

/** Runs the app's smoke open on a COPY: a production open may switch the journal mode or seed, which would stale the receipt's sha256 of the file. */
async function smokeWarning(app: SqliteExportApp, published: string, workDir: string): Promise<string[]> {
  if (!app.smoke) return [];
  try {
    const copy = join(workDir, 'smoke.db');
    copyFileSync(published, copy);
    await app.smoke(copy);
    return [];
  } catch (error) {
    return [`smoke-open-failed: ${error instanceof Error ? error.message : String(error)}`];
  }
}

/**
 * The whole export: refuse unless writers are stopped, build the template, check the Postgres ledger against the code,
 * `reverseClone`, then smoke-open a copy. Only a `CloneRefusal` ever leaves. The work directory is always removed.
 */
export async function exportToSqlite(options: ExportToSqliteOptions): Promise<ExportToSqliteResult> {
  const { app } = options;
  if (options.writersStopped !== true) refuse({ code: 'writers-not-stopped' });
  const workDir = mkdtempSync(join(tmpdir(), 'db-kit-export-'));
  try {
    const templatePath = join(workDir, 'template.db');
    // The app's own message (such as which setting it needs) reaches the operator; the CLI scrubs any URL in it.
    const templateRowsCleared = await buildExportTemplate(app, templatePath).catch((error: unknown) => {
      if (error instanceof CloneRefusal) throw error;
      throw new CloneRefusal({ code: 'sqlite-template-invalid' }, `the app's SQLite template could not be built: ${error instanceof Error ? error.message : String(error)}`);
    });
    const expected = new Set(await Promise.resolve(app.ledger.expected()).catch((error: unknown) => refuse(toRefusal(error))));
    assertLedgersMatch(await postgresLedgerIds(app, options), expected);
    const result = await reverseClone({
      source: options.source,
      manifest: reverseManifestFor(app),
      toSqlitePath: options.toSqlitePath,
      sqliteTemplatePath: templatePath,
      writersStopped: options.writersStopped,
      ...(options.dryRun && { dryRun: true }),
      ...(options.confirmProduction !== undefined && { confirmProduction: options.confirmProduction }),
      ...(options.topology !== undefined && { topology: options.topology }),
      ...(options.tlsCa !== undefined && { tlsCa: options.tlsCa }),
      ...(options.fetchRows !== undefined && { fetchRows: options.fetchRows }),
      ...(options.onProgress !== undefined && { onProgress: options.onProgress }),
    });
    // The file is already published and verified, so a failed smoke open is a warning (exit 3), never a refusal.
    const warnings = [...result.warnings, ...(result.path === null ? [] : await smokeWarning(app, result.path, workDir))];
    return { ...result, warnings, templateRowsCleared };
  } catch (error) {
    throw error instanceof CloneRefusal ? error : new CloneRefusal(toRefusal(error, 'execute-failed'));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
