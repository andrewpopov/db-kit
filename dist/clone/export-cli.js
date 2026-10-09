import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseDatabaseUrl } from '../url.js';
import { CloneRefusal, refuse, toRefusal } from './errors.js';
import { buildExportTemplate, exportToSqlite } from './export-sqlite.js';
const DEFAULT_SOURCE_URL_ENV = 'DATABASE_URL';
const USAGE = `usage: <cmd> export-sqlite <out.db> [--writers-stopped] [--dry-run] [--confirm-production host:port/db]
       <cmd> sqlite-template <path>`;
/** The URL and its password (raw and decoded) replaced outright, then any other `scheme://user:password@` userinfo masked. */
export function scrubMessage(text, url) {
    let scrubbed = text;
    if (url) {
        const password = (() => {
            try {
                return new URL(url).password;
            }
            catch {
                return '';
            }
        })();
        const decoded = (() => {
            try {
                return decodeURIComponent(password);
            }
            catch {
                return password;
            }
        })();
        for (const secret of [url, decoded, password])
            if (secret)
                scrubbed = scrubbed.split(secret).join('[redacted]');
    }
    return scrubbed.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1[redacted]@');
}
/**
 * `export-sqlite <out.db>` and `sqlite-template <path>` for an app that supplied a `SqliteExportApp`.
 * Exit codes: 0 written (or dry run verified), 1 refused or failed (one JSON line on `io.err`), 2 usage,
 * 3 the file IS in place but a later step warned (`warnings` in the JSON line on `io.out`).
 */
export async function runExportSqliteCli(argv, io, env, app, opts = {}) {
    const [command, ...rest] = argv;
    let parsed;
    try {
        parsed = parseCommand(rest);
    }
    catch {
        io.err(USAGE);
        return 2;
    }
    const { values, positionals } = parsed;
    if ((command !== 'export-sqlite' && command !== 'sqlite-template') || positionals.length !== 1 || positionals[0] === '') {
        io.err(USAGE);
        return 2;
    }
    const output = positionals[0];
    const url = env[opts.sourceUrlEnv ?? DEFAULT_SOURCE_URL_ENV];
    try {
        if (command === 'sqlite-template') {
            if (existsSync(output))
                refuse({ code: 'sqlite-target-exists' });
            io.out(JSON.stringify({ ok: true, command, templateRowsCleared: await buildExportTemplate(app, output) }));
            return 0;
        }
        if (url === undefined || url === '')
            return refuse({ code: 'source-url-missing' });
        let source;
        try {
            source = parseDatabaseUrl(url);
        }
        catch {
            return refuse({ code: 'source-url-invalid' });
        }
        if (source.dialect !== 'postgres')
            return refuse({ code: 'source-not-postgres' });
        const result = await exportToSqlite({
            app,
            source,
            toSqlitePath: output,
            writersStopped: values['writers-stopped'] === true,
            dryRun: values['dry-run'] === true,
            ...(values['confirm-production'] === undefined ? {} : { confirmProduction: values['confirm-production'] }),
        });
        io.out(JSON.stringify({
            ok: true,
            command,
            outcome: result.outcome,
            path: result.path,
            receiptPath: result.receiptPath,
            tables: result.tables.length,
            rows: result.totals.rows,
            sequences: result.sequences,
            warnings: result.warnings.map((warning) => scrubMessage(warning, url)),
            templateRowsCleared: result.templateRowsCleared,
        }));
        return result.warnings.length > 0 ? 3 : 0;
    }
    catch (error) {
        const refusal = toRefusal(error);
        const message = error instanceof Error ? error.message : String(error);
        io.err(JSON.stringify({ ok: false, command, error: scrubMessage(message, url), ...(error instanceof CloneRefusal && { refusal }) }));
        return 1;
    }
}
const parseCommand = (args) => parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: {
        'dry-run': { type: 'boolean' },
        'writers-stopped': { type: 'boolean' },
        'confirm-production': { type: 'string' },
    },
});
