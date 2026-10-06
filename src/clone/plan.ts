import type Database from 'better-sqlite3';
import { Client } from 'pg';
import { introspectPostgres, introspectSqlite, type IntrospectedSchema } from '../codecs/introspect.js';
import type { CodecManifest } from '../codecs/manifest.js';
import { POSTGRES_CODEC_TYPES } from '../codecs/pg-types.js';
import { validateManifest } from '../codecs/validate.js';
import { postgresConnectionOptions } from '../postgres.js';
import type { PostgresConfig } from '../url.js';
import { readIdentity, readTargetFacts, TARGET_SCHEMA, type ForeignKeyFact, type TargetIdentityFacts } from './catalog.js';
import { CloneRefusal, refuse, toRefusal, type Refusal } from './errors.js';
import { DEFAULT_MAX_SLOT_RETENTION_BYTES, evaluateGate } from './rules.js';
import { nonNegativeBigint } from './options.js';
import { openSnapshot, readSequenceSource, restartValue, scanSource, sqliteSkippedKeyRefusals, type SourceFacts, type SourceTableFacts } from './source.js';
import { takeSnapshot, type Snapshot, type SnapshotOptions } from './snapshot.js';
import { isProduction, productionConfirmation, type TopologyEntry } from './topology.js';

export interface PlanOptions extends SnapshotOptions {
  manifest: CodecManifest;
  target: PostgresConfig;
  /** Parsed `--topology` file. Absent means every target is production. */
  topology?: readonly TopologyEntry[];
  /** `--confirm-production`: must equal `host:port/database`. */
  confirmProduction?: string;
  truncate?: boolean;
  /** Refuse when a replication slot retains more WAL than this. Default 5 GiB. */
  maxSlotRetentionBytes?: bigint;
  tlsCa?: string;
  /** Test seam: wrap the target client (e.g. to fake `pg_is_in_recovery`). */
  wrapClient?: (client: Client) => Client;
}

export interface PlannedTable extends SourceTableFacts {
  targetNonEmpty: boolean;
  willTruncate: boolean;
}

export interface PlannedSequence {
  schema: string;
  name: string;
  table: string;
  column: string;
  start: bigint;
  increment: bigint;
  min: bigint;
  max: bigint;
  /** The `RESTART WITH` value; `null` restarts at `start` (empty table). */
  restartWith: bigint | null;
}

export interface TargetSummary extends Omit<TargetIdentityFacts, 'serverVersionNum'> {
  host: string;
  port: number;
  production: boolean;
  /** What `--confirm-production` must equal for this target. */
  confirmation: string;
}

export interface ClonePlan {
  /** True only when `refusals` is empty. */
  ok: boolean;
  snapshot: { sha256: string; bytes: number };
  target: TargetSummary | null;
  tables: PlannedTable[];
  /** Tables declared `copy: false`: never copied, verified, emptied or truncated. */
  skippedTables: { table: string; reason: string }[];
  /** Foreign keys owned by copied tables: dropped before the load and re-added (re-validated) before COMMIT. */
  foreignKeys: ForeignKeyFact[];
  /** Foreign keys from tables clone does not copy into copied ones: untouched, listed for the operator. */
  incomingReferences: ForeignKeyFact[];
  sequences: PlannedSequence[];
  refusals: Refusal[];
}

/**
 * Everything clone decides before writing anything: take and verify the snapshot, scan it, read the target in one
 * READ ONLY transaction, and report every refusal found. Throws `CloneRefusal` only when no plan can be built at all
 * (writers not stopped, live file changed, snapshot failed, target unreachable or unreadable). The snapshot is
 * removed on every path.
 */
export async function planClone(options: PlanOptions): Promise<ClonePlan> {
  nonNegativeBigint('maxSlotRetentionBytes', options.maxSlotRetentionBytes);
  const snapshot = await takeSnapshot(options);
  try {
    return await planFromSnapshot(snapshot, options);
  } finally {
    snapshot.dispose();
  }
}

/** Plan from an already-verified snapshot. Like `planClone`, nothing but a `CloneRefusal` ever leaves: driver errors are dropped. */
export async function planFromSnapshot(snapshot: Snapshot, options: PlanOptions): Promise<ClonePlan> {
  try {
    return await buildPlan(snapshot, options);
  } catch (error) {
    throw error instanceof CloneRefusal ? error : new CloneRefusal(toRefusal(error));
  }
}

async function buildPlan(snapshot: Snapshot, options: PlanOptions): Promise<ClonePlan> {
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
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  } finally {
    db.close();
  }
}

export function emptyPlan(snapshot: Pick<Snapshot, 'sha256' | 'bytes'>): ClonePlan {
  return { ok: false, snapshot: { sha256: snapshot.sha256, bytes: snapshot.bytes }, target: null, tables: [], skippedTables: [], foreignKeys: [], incomingReferences: [], sequences: [], refusals: [] };
}

/** The snapshot side of a plan: its schema and the one-scan source facts. Shared by planning and execution. */
export interface SourceContext {
  db: Database.Database;
  options: PlanOptions;
  sqliteSchema: IntrospectedSchema;
  source: SourceFacts;
}

export function prepareSource(db: Database.Database, options: PlanOptions): SourceContext {
  const sqliteSchema = introspectSqlite(db);
  const source = scanSource(db, options.manifest, sqliteSchema);
  source.refusals.push(...sqliteSkippedKeyRefusals(db, options.manifest, sqliteSchema));
  return { db, options, sqliteSchema, source };
}

export interface TargetInspection {
  plan: ClonePlan;
  /** Null only when the identity could not be read as a refusal-free plan (never: unreadable identity throws). */
  identity: TargetIdentityFacts;
}

/**
 * Every target-side check, on a client that already has a transaction open with `search_path = ''`. Planning runs it
 * in a READ ONLY transaction; execution re-runs it under the table locks, where it is authoritative.
 */
export async function inspectTarget(client: Client, context: SourceContext, plan: ClonePlan): Promise<TargetInspection> {
  const { options, db, sqliteSchema, source } = context;
  const { manifest } = options;
  plan.skippedTables = Object.entries(manifest.skipped).map(([table, { reason }]) => ({ table, reason }));
  let identity: TargetIdentityFacts;
  try {
    identity = await readIdentity(client);
  } catch {
    return refuse({ code: 'target-identity-unreadable' });
  }
  const target = { host: options.target.host, port: options.target.port };
  const confirmation = productionConfirmation({ ...target, database: identity.database });
  const production = isProduction({ ...target, database: identity.database, systemIdentifier: identity.systemIdentifier }, options.topology);
  const { serverVersionNum: _versionNum, ...reported } = identity;
  plan.target = { ...reported, ...target, production, confirmation };
  const finish = (): TargetInspection => ({ plan: { ...plan, ok: plan.refusals.length === 0 }, identity });
  if (identity.inRecovery) plan.refusals.push({ code: 'target-in-recovery' });
  if (production && options.confirmProduction !== confirmation) plan.refusals.push({ code: 'production-unconfirmed' });
  if (identity.inRecovery) return finish();

  const validation = validateManifest(manifest, { sqlite: sqliteSchema, postgres: await introspectPostgres(client, TARGET_SCHEMA) });
  if (!validation.ok) {
    for (const issue of validation.issues) plan.refusals.push({ code: 'manifest-invalid', table: issue.table, ...(issue.column === undefined ? {} : { column: issue.column }), object: `${issue.side}:${issue.code}` });
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
    if (!inRange) plan.refusals.push({ code: 'sequence-out-of-range', table: sequence.table, column: sequence.column, object: `${sequence.schema}.${sequence.name}` });
    return { schema: sequence.schema, name: sequence.name, table: sequence.table, column: sequence.column, start: sequence.start, increment: sequence.increment, min: sequence.min, max: sequence.max, restartWith };
  });
  return finish();
}

/**
 * Pin what the codecs read, inside the transaction as well as in the connection's startup options (a pooler may drop
 * the latter): hex bytea, and lossless float text. A role or database default of `bytea_output=escape` or
 * `extra_float_digits=0` would otherwise change what both sides of a verification read.
 */
export async function pinSession(client: Client): Promise<void> {
  await client.query("SET LOCAL bytea_output = 'hex'");
  await client.query('SET LOCAL extra_float_digits = 3');
}

/** Connect one `pg.Client` with a pinned UTC/ISO session (the codecs' read contract). Failure is a typed refusal. */
export async function connectClient(options: Pick<PlanOptions, 'target' | 'tlsCa' | 'wrapClient'>, statementTimeoutMs: number): Promise<Client> {
  const direct = new Client({
    ...postgresConnectionOptions(options.target, { applicationName: 'db-kit-clone', statementTimeoutMs, tlsCa: options.tlsCa, codecSession: true }),
    types: POSTGRES_CODEC_TYPES,
    connectionTimeoutMillis: 10_000,
  });
  const client = options.wrapClient?.(direct) ?? direct;
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch {
    return refuse({ code: 'target-connect-failed' });
  }
  return client;
}
