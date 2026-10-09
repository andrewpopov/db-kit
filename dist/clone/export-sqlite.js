import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openPostgres } from '../postgres.js';
import { quoteIdent } from './catalog.js';
import { CloneRefusal, refuse, toRefusal } from './errors.js';
import { reverseClone } from './reverse.js';
/** The forward manifest with `app.skipTables` declared `copy: false`, so the template's own rows in them (such as its ledger) are kept. */
export function reverseManifestFor(app) {
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
export async function buildExportTemplate(app, path) {
    await app.buildTemplate(path);
    const db = new Database(path);
    try {
        const emptied = [];
        for (const table of Object.keys(reverseManifestFor(app).tables)) {
            const { changes } = db.prepare(`DELETE FROM ${quoteIdent(table)}`).run();
            if (changes === 0)
                continue;
            emptied.push(table);
            db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(table);
        }
        return emptied;
    }
    finally {
        db.close();
    }
}
async function postgresLedgerIds(app, options) {
    const handle = openPostgres(options.source, { applicationName: 'db-kit-export', poolSize: 1, statementTimeoutMs: 0, ...(options.tlsCa === undefined ? {} : { tlsCa: options.tlsCa }) });
    try {
        const { rows } = await handle.pool.query(app.ledger.query);
        return new Set(rows.map((row) => row.id));
    }
    catch {
        return refuse({ code: 'source-read-failed' });
    }
    finally {
        await handle.close();
    }
}
/** Refuses unless Postgres holds exactly the migrations the code defines, naming every missing and extra id. */
function assertLedgersMatch(postgres, expected) {
    const missing = [...expected].filter((id) => !postgres.has(id)).sort();
    const extra = [...postgres].filter((id) => !expected.has(id)).sort();
    if (missing.length === 0 && extra.length === 0)
        return;
    throw new CloneRefusal({ code: 'ledger-mismatch' }, `the Postgres migration ledger differs from this code's: missing from Postgres [${missing.join(', ')}]; unknown to this code [${extra.join(', ')}]`);
}
/** Runs the app's smoke open on a COPY: a production open may switch the journal mode or seed, which would stale the receipt's sha256 of the file. */
async function smokeWarning(app, published, workDir) {
    if (!app.smoke)
        return [];
    try {
        const copy = join(workDir, 'smoke.db');
        copyFileSync(published, copy);
        await app.smoke(copy);
        return [];
    }
    catch (error) {
        return [`smoke-open-failed: ${error instanceof Error ? error.message : String(error)}`];
    }
}
/**
 * The whole export: refuse unless writers are stopped, build the template, check the Postgres ledger against the code,
 * `reverseClone`, then smoke-open a copy. Only a `CloneRefusal` ever leaves. The work directory is always removed.
 */
export async function exportToSqlite(options) {
    const { app } = options;
    if (options.writersStopped !== true)
        refuse({ code: 'writers-not-stopped' });
    const workDir = mkdtempSync(join(tmpdir(), 'db-kit-export-'));
    try {
        const templatePath = join(workDir, 'template.db');
        const templateRowsCleared = await buildExportTemplate(app, templatePath).catch((error) => refuse(toRefusal(error, 'sqlite-template-invalid')));
        const expected = new Set(await Promise.resolve(app.ledger.expected()).catch((error) => refuse(toRefusal(error))));
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
    }
    catch (error) {
        throw error instanceof CloneRefusal ? error : new CloneRefusal(toRefusal(error, 'execute-failed'));
    }
    finally {
        rmSync(workDir, { recursive: true, force: true });
    }
}
