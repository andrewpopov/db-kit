import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DbKitError } from '../errors.js';
import { parseCodecManifest } from '../codecs/manifest.js';
import { parseDatabaseUrl } from '../url.js';
import { CloneRefusal, describeRefusal, refuse, toRefusal } from './errors.js';
import { planClone } from './plan.js';
import { planToJson, planToText } from './render.js';
import { loadTopology } from './topology.js';
/** The only place the target URL is read from: an argv URL would sit in `ps` and shell history. */
export const TARGET_URL_ENV = 'DB_KIT_TARGET_URL';
const USAGE = `usage: db-kit clone --from-live <sqlite path> --manifest <file> --writers-stopped --plan-only
         [--topology <file>] [--confirm-production host:port/db] [--truncate] [--json]
  target URL: environment variable ${TARGET_URL_ENV}`;
/** Exit codes: 0 plan has no refusals, 1 refused, 2 usage error or an operation this build does not do yet. */
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
    if (!values['plan-only']) {
        io.err('clone: only --plan-only is available; the transactional load is not implemented in this build');
        return 2;
    }
    try {
        const plan = await planClone(buildOptions(values, env));
        io.out(values.json ? planToJson(plan) : planToText(plan));
        return plan.ok ? 0 : 1;
    }
    catch (error) {
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
