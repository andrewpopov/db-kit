import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DbKitError } from '../errors.js';
import { parseCodecManifest, type CodecManifest } from '../codecs/manifest.js';
import { parseDatabaseUrl } from '../url.js';
import { CloneOutcomeError, CloneRefusal, describeRefusal, refuse, toRefusal } from './errors.js';
import { executeClone } from './execute.js';
import { nonNegativeNumber } from './options.js';
import { reverseClone } from './reverse.js';
import { planClone, type PlanOptions } from './plan.js';
import { planToJson, planToText, resultToJson, resultToText, reverseToText } from './render.js';
import { loadTopology } from './topology.js';

/** The only place the target URL is read from: an argv URL would sit in `ps` and shell history. */
export const TARGET_URL_ENV = 'DB_KIT_TARGET_URL';
/** The reverse clone's source: read from the environment only, for the same reason. */
export const SOURCE_URL_ENV = 'DB_KIT_SOURCE_URL';

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

const CLEANUP_WARNING = 'WARNING: removing the temporary snapshot failed; it holds a full copy of the data, so delete the db-kit-clone-* directory under the temp directory by hand';

const USAGE = `usage: db-kit clone --from-live <sqlite path> --manifest <file> --writers-stopped (--plan-only | --dry-run | --execute)
         [--topology <file>] [--confirm-production host:port/db] [--truncate] [--json] [--commit-poll-seconds n]
  target URL: environment variable ${TARGET_URL_ENV}
       db-kit clone --reverse --to-sqlite <new path> --sqlite-template <empty migrated sqlite file> --manifest <file> --writers-stopped
         [--dry-run] [--topology <file>] [--confirm-production host:port/db] [--json]
  source URL (reverse): environment variable ${SOURCE_URL_ENV}`;

/**
 * Exit codes: 0 plan has no refusals / dry run verified / COMMITTED, 1 refused or failed with the target unchanged,
 * 2 usage error, 3 (reverse only) the SQLite file IS in place but a later step warned (see `warnings`), 4 COMMIT ABORTED (nothing committed), 5 COMMIT outcome UNKNOWN (inspect the target; never re-run blindly).
 */
export async function runCloneCli(argv: readonly string[], env: NodeJS.ProcessEnv, io: CliIo, deps: { reverseClone?: typeof reverseClone } = {}): Promise<number> {
  let values: ReturnType<typeof parseCommand>;
  try {
    values = parseCommand(argv);
  } catch {
    io.err(USAGE);
    return 2;
  }
  if (values.reverse) return runReverse(values, env, io, deps);
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
      ...(values['commit-poll-seconds'] === undefined ? {} : { commitPollMs: pollMilliseconds(values['commit-poll-seconds']) }),
      onProgress: values.json ? undefined : (event) => io.err(`${event.phase} ${event.table}: ${event.rows} rows in ${event.seconds.toFixed(1)}s`),
    });
    io.out(values.json ? resultToJson(result) : resultToText(result));
    if (result.cleanupWarning && !values.json) io.err(CLEANUP_WARNING);
    return 0;
  } catch (error) {
    if (error instanceof CloneOutcomeError) {
      io.err(values.json ? JSON.stringify({ ok: false, outcome: error.outcome, runId: error.runId, transactionId: error.transactionId, cleanupFailed: error.cleanupFailed }) : `COMMIT ${error.outcome.toUpperCase()}: run ${error.runId} transaction ${error.transactionId ?? '?'}${error.outcome === 'unknown' ? ' (inspect db_kit.clone_receipt before doing anything else)' : ' (nothing was committed)'}${error.cleanupFailed ? ` -- ${CLEANUP_WARNING}` : ''}`);
      return error.outcome === 'aborted' ? 4 : 5;
    }
    const refusal = error instanceof CloneRefusal ? error.refusal : toRefusal(error);
    io.err(values.json ? JSON.stringify({ ok: false, refusals: [refusal] }) : `REFUSED: ${describeRefusal(refusal)}`);
    return 1;
  }
}

async function runReverse(values: ReturnType<typeof parseCommand>, env: NodeJS.ProcessEnv, io: CliIo, deps: { reverseClone?: typeof reverseClone }): Promise<number> {
  if (!values['to-sqlite'] || !values['sqlite-template'] || !values.manifest || values['plan-only'] || values.execute) {
    io.err(USAGE);
    return 2;
  }
  try {
    const url = env[SOURCE_URL_ENV];
    if (url === undefined || url === '') return refuseWith({ code: 'source-url-missing' });
    let source;
    try {
      source = parseDatabaseUrl(url);
    } catch {
      return refuseWith({ code: 'source-url-invalid' });
    }
    if (source.dialect !== 'postgres') return refuseWith({ code: 'source-not-postgres' });
    const result = await (deps.reverseClone ?? reverseClone)({
      source,
      manifest: loadManifest(values.manifest),
      toSqlitePath: values['to-sqlite'],
      sqliteTemplatePath: values['sqlite-template'],
      writersStopped: values['writers-stopped'] === true,
      dryRun: values['dry-run'] === true,
      ...(values.topology === undefined ? {} : { topology: loadTopology(values.topology) }),
      ...(values['confirm-production'] === undefined ? {} : { confirmProduction: values['confirm-production'] }),
      onProgress: values.json ? undefined : (event) => io.err(`${event.phase} ${event.table}: ${event.rows} rows in ${event.seconds.toFixed(1)}s`),
    });
    io.out(values.json ? JSON.stringify(result, null, 2) : reverseToText(result));
    if (result.warnings.length > 0) {
      if (!values.json) io.err(`PUBLISHED WITH WARNINGS: ${result.warnings.join(', ')}`);
      return 3;
    }
    return 0;
  } catch (error) {
    const refusal = error instanceof CloneRefusal ? error.refusal : toRefusal(error);
    io.err(values.json ? JSON.stringify({ ok: false, refusals: [refusal] }) : `REFUSED: ${describeRefusal(refusal)}`);
    return 1;
  }
}

/** `--commit-poll-seconds`: a finite number of seconds, never silently NaN (which would skip the wait) or negative. */
function pollMilliseconds(text: string): number {
  const seconds = text.trim() === '' ? Number.NaN : Number(text);
  nonNegativeNumber('commit-poll-seconds', seconds);
  return seconds * 1000;
}

const refuseWith = (refusal: Parameters<typeof refuse>[0]): never => refuse(refusal);

function parseCommand(argv: readonly string[]) {
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
      reverse: { type: 'boolean' },
      'to-sqlite': { type: 'string' },
      'sqlite-template': { type: 'string' },
      'commit-poll-seconds': { type: 'string' },
      json: { type: 'boolean' },
    },
  }).values;
}

function buildOptions(values: ReturnType<typeof parseCommand>, env: NodeJS.ProcessEnv): PlanOptions {
  const url = env[TARGET_URL_ENV];
  if (url === undefined || url === '') return refuse({ code: 'target-url-missing' });
  let target;
  try {
    target = parseDatabaseUrl(url);
  } catch (error) {
    return error instanceof DbKitError ? refuse({ code: 'target-url-invalid' }) : refuse({ code: 'preflight-failed' });
  }
  if (target.dialect !== 'postgres') return refuse({ code: 'target-not-postgres' });
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

function loadManifest(path: string): CodecManifest {
  try {
    return parseCodecManifest(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return refuse({ code: 'manifest-invalid' });
  }
}
