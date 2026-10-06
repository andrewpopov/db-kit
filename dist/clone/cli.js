import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DbKitError } from '../errors.js';
import { parseCodecManifest } from '../codecs/manifest.js';
import { parseDatabaseUrl } from '../url.js';
import { CloneOutcomeError, CloneRefusal, describeRefusal, refuse, toRefusal } from './errors.js';
import { executeClone } from './execute.js';
import { planClone } from './plan.js';
import { planToJson, planToText, resultToJson, resultToText } from './render.js';
import { loadTopology } from './topology.js';
/** The only place the target URL is read from: an argv URL would sit in `ps` and shell history. */
export const TARGET_URL_ENV = 'DB_KIT_TARGET_URL';
const USAGE = `usage: db-kit clone --from-live <sqlite path> --manifest <file> --writers-stopped (--plan-only | --dry-run | --execute)
         [--topology <file>] [--confirm-production host:port/db] [--truncate] [--json] [--commit-poll-seconds n]
  target URL: environment variable ${TARGET_URL_ENV}`;
/**
 * Exit codes: 0 plan has no refusals / dry run verified / COMMITTED, 1 refused or failed with the target unchanged,
 * 2 usage error, 4 COMMIT ABORTED (nothing committed), 5 COMMIT outcome UNKNOWN (inspect the target; never re-run blindly).
 */
export async function runCloneCli(argv, env, io) {
    let values;
    try {
        values = parseCommand(argv);
    }
    catch {
        io.err(USAGE);
        return 2;
    }
    if (!values['from-live'] || !values.manifest) {
        io.err(USAGE);
        return 2;
    }
    const modes = [values['plan-only'], values['dry-run'], values.execute].filter((mode) => mode === true).length;
    if (modes !== 1) {
        io.err(USAGE);
        return 2;
    }
    try {
        const options = buildOptions(values, env);
        if (values['plan-only']) {
            const plan = await planClone(options);
            io.out(values.json ? planToJson(plan) : planToText(plan));
            return plan.ok ? 0 : 1;
        }
        const result = await executeClone({
            ...options,
            dryRun: values['dry-run'] === true,
            ...(values['commit-poll-seconds'] === undefined ? {} : { commitPollMs: Math.max(0, Number(values['commit-poll-seconds'])) * 1000 }),
            onProgress: values.json ? undefined : (event) => io.err(`${event.phase} ${event.table}: ${event.rows} rows in ${event.seconds.toFixed(1)}s`),
        });
        io.out(values.json ? resultToJson(result) : resultToText(result));
        return 0;
    }
    catch (error) {
        if (error instanceof CloneOutcomeError) {
            io.err(values.json ? JSON.stringify({ ok: false, outcome: error.outcome, runId: error.runId, transactionId: error.transactionId }) : `COMMIT ${error.outcome.toUpperCase()}: run ${error.runId} transaction ${error.transactionId ?? '?'}${error.outcome === 'unknown' ? ' (inspect db_kit.clone_receipt before doing anything else)' : ' (nothing was committed)'}`);
            return error.outcome === 'aborted' ? 4 : 5;
        }
        const refusal = error instanceof CloneRefusal ? error.refusal : toRefusal(error);
        io.err(values.json ? JSON.stringify({ ok: false, refusals: [refusal] }) : `REFUSED: ${describeRefusal(refusal)}`);
        return 1;
    }
}
function parseCommand(argv) {
    return parseArgs({
        args: [...argv],
        strict: true,
        allowPositionals: false,
        options: {
            'from-live': { type: 'string' },
            manifest: { type: 'string' },
            'writers-stopped': { type: 'boolean' },
            topology: { type: 'string' },
            'confirm-production': { type: 'string' },
            truncate: { type: 'boolean' },
            'plan-only': { type: 'boolean' },
            'dry-run': { type: 'boolean' },
            execute: { type: 'boolean' },
            'commit-poll-seconds': { type: 'string' },
            json: { type: 'boolean' },
        },
    }).values;
}
function buildOptions(values, env) {
    const url = env[TARGET_URL_ENV];
    if (url === undefined || url === '')
        return refuse({ code: 'target-url-missing' });
    let target;
    try {
        target = parseDatabaseUrl(url);
    }
    catch (error) {
        return error instanceof DbKitError ? refuse({ code: 'target-url-invalid' }) : refuse({ code: 'preflight-failed' });
    }
    if (target.dialect !== 'postgres')
        return refuse({ code: 'target-not-postgres' });
    return {
        livePath: values['from-live'] ?? '',
        writersStopped: values['writers-stopped'] === true,
        manifest: loadManifest(values.manifest ?? ''),
        target,
        ...(values.topology === undefined ? {} : { topology: loadTopology(values.topology) }),
        ...(values['confirm-production'] === undefined ? {} : { confirmProduction: values['confirm-production'] }),
        truncate: values.truncate === true,
    };
}
function loadManifest(path) {
    try {
        return parseCodecManifest(JSON.parse(readFileSync(path, 'utf8')));
    }
    catch {
        return refuse({ code: 'manifest-invalid' });
    }
}
