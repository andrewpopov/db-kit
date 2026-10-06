import { Client } from 'pg';
import { introspectPostgres, introspectSqlite } from '../codecs/introspect.js';
import { POSTGRES_CODEC_TYPES } from '../codecs/pg-types.js';
import { validateManifest } from '../codecs/validate.js';
import { postgresConnectionOptions } from '../postgres.js';
import { readIdentity, readTargetFacts, TARGET_SCHEMA } from './catalog.js';
import { CloneRefusal, refuse, toRefusal } from './errors.js';
import { DEFAULT_MAX_SLOT_RETENTION_BYTES, evaluateGate } from './rules.js';
import { nonNegativeBigint } from './options.js';
import { openSnapshot, readSequenceSource, restartValue, scanSource, sqliteSkippedKeyRefusals } from './source.js';
import { takeSnapshot } from './snapshot.js';
import { isProduction, productionConfirmation } from './topology.js';
/**
 * Everything clone decides before writing anything: take and verify the snapshot, scan it, read the target in one
 * READ ONLY transaction, and report every refusal found. Throws `CloneRefusal` only when no plan can be built at all
 * (writers not stopped, live file changed, snapshot failed, target unreachable or unreadable). The snapshot is
 * removed on every path.
 */
export async function planClone(options) {
    nonNegativeBigint('maxSlotRetentionBytes', options.maxSlotRetentionBytes);
    const snapshot = await takeSnapshot(options);
    try {
        return await planFromSnapshot(snapshot, options);
    }
    finally {
        snapshot.dispose();
    }
}
/** Plan from an already-verified snapshot. Like `planClone`, nothing but a `CloneRefusal` ever leaves: driver errors are dropped. */
export async function planFromSnapshot(snapshot, options) {
    try {
        return await buildPlan(snapshot, options);
    }
    catch (error) {
        throw error instanceof CloneRefusal ? error : new CloneRefusal(toRefusal(error));
    }
}
async function buildPlan(snapshot, options) {
    const plan = emptyPlan(snapshot);
    const db = openSnapshot(snapshot.path);
    try {
        const context = prepareSource(db, options);
        plan.refusals.push(...context.source.refusals);
        const client = await connectClient(options, 120_000);
        try {
            await client.query('BEGIN READ ONLY');
            await client.query("SELECT pg_catalog.set_config('search_path', '', true)");
            await pinSession(client);
            return (await inspectTarget(client, context, plan)).plan;
        }
        finally {
            await client.query('ROLLBACK').catch(() => undefined);
            await client.end().catch(() => undefined);
        }
    }
    finally {
        db.close();
    }
}
export function emptyPlan(snapshot) {
    return { ok: false, snapshot: { sha256: snapshot.sha256, bytes: snapshot.bytes }, target: null, tables: [], skippedTables: [], foreignKeys: [], incomingReferences: [], sequences: [], refusals: [] };
}
export function prepareSource(db, options) {
    const sqliteSchema = introspectSqlite(db);
    const source = scanSource(db, options.manifest, sqliteSchema);
    source.refusals.push(...sqliteSkippedKeyRefusals(db, options.manifest, sqliteSchema));
    return { db, options, sqliteSchema, source };
}
/**
 * Every target-side check, on a client that already has a transaction open with `search_path = ''`. Planning runs it
 * in a READ ONLY transaction; execution re-runs it under the table locks, where it is authoritative.
 */
export async function inspectTarget(client, context, plan) {
    const { options, db, sqliteSchema, source } = context;
    const { manifest } = options;
    plan.skippedTables = Object.entries(manifest.skipped).map(([table, { reason }]) => ({ table, reason }));
    let identity;
    try {
        identity = await readIdentity(client);
    }
    catch {
        return refuse({ code: 'target-identity-unreadable' });
    }
    const target = { host: options.target.host, port: options.target.port };
    const confirmation = productionConfirmation({ ...target, database: identity.database });
    const production = isProduction({ ...target, database: identity.database, systemIdentifier: identity.systemIdentifier }, options.topology);
    const { serverVersionNum: _versionNum, ...reported } = identity;
    plan.target = { ...reported, ...target, production, confirmation };
    const finish = () => ({ plan: { ...plan, ok: plan.refusals.length === 0 }, identity });
    if (identity.inRecovery)
        plan.refusals.push({ code: 'target-in-recovery' });
    if (production && options.confirmProduction !== confirmation)
        plan.refusals.push({ code: 'production-unconfirmed' });
    if (identity.inRecovery)
        return finish();
    const validation = validateManifest(manifest, { sqlite: sqliteSchema, postgres: await introspectPostgres(client, TARGET_SCHEMA) });
    if (!validation.ok) {
        for (const issue of validation.issues)
            plan.refusals.push({ code: 'manifest-invalid', table: issue.table, ...(issue.column === undefined ? {} : { column: issue.column }), object: `${issue.side}:${issue.code}` });
        return finish();
    }
    const facts = await readTargetFacts(client, Object.keys(manifest.tables), identity.serverVersionNum);
    const truncate = options.truncate === true;
    const gate = evaluateGate(facts, manifest, { truncate, maxSlotRetentionBytes: options.maxSlotRetentionBytes ?? DEFAULT_MAX_SLOT_RETENTION_BYTES });
    plan.refusals.push(...gate.refusals);
    plan.foreignKeys = gate.foreignKeys;
    plan.incomingReferences = gate.incomingReferences;
    plan.tables = source.tables.map((table) => {
        const targetNonEmpty = facts.nonEmptyTables.includes(table.table);
        return { ...table, targetNonEmpty, willTruncate: targetNonEmpty && truncate };
    });
    plan.sequences = gate.sequences.map((sequence) => {
        const { restartWith, inRange } = restartValue(readSequenceSource(db, sequence.table, sequence.column), sequence);
        if (!inRange)
            plan.refusals.push({ code: 'sequence-out-of-range', table: sequence.table, column: sequence.column, object: `${sequence.schema}.${sequence.name}` });
        return { schema: sequence.schema, name: sequence.name, table: sequence.table, column: sequence.column, start: sequence.start, increment: sequence.increment, min: sequence.min, max: sequence.max, restartWith };
    });
    return finish();
}
/**
 * Pin what the codecs read, inside the transaction as well as in the connection's startup options (a pooler may drop
 * the latter): hex bytea, and lossless float text. A role or database default of `bytea_output=escape` or
 * `extra_float_digits=0` would otherwise change what both sides of a verification read.
 */
export async function pinSession(client) {
    await client.query("SET LOCAL bytea_output = 'hex'");
    await client.query('SET LOCAL extra_float_digits = 3');
}
/** Connect one `pg.Client` with a pinned UTC/ISO session (the codecs' read contract). Failure is a typed refusal. */
export async function connectClient(options, statementTimeoutMs) {
    const direct = new Client({
        ...postgresConnectionOptions(options.target, { applicationName: 'db-kit-clone', statementTimeoutMs, tlsCa: options.tlsCa, codecSession: true }),
        types: POSTGRES_CODEC_TYPES,
        connectionTimeoutMillis: 10_000,
    });
    const client = options.wrapClient?.(direct) ?? direct;
    client.on('error', () => undefined);
    try {
        await client.connect();
    }
    catch {
        return refuse({ code: 'target-connect-failed' });
    }
    return client;
}
