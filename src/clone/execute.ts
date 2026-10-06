import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { Client } from 'pg';
import { buildCodecs, type ColumnCodec } from '../codecs/bound.js';
import {
  quoteIdent,
  readForeignKeys,
  readIdentity,
  readReceiptFacts,
  RECEIPT_COLUMNS,
  RECEIPT_SCHEMA,
  RECEIPT_TABLE,
  TARGET_SCHEMA,
  type ForeignKeyFact,
  type TargetIdentityFacts,
} from './catalog.js';
import { CloneOutcomeError, CloneRefusal, refuse, toRefusal, type Refusal } from './errors.js';
import { loadTable } from './load.js';
import { nonNegativeBigint, nonNegativeNumber, positiveInteger } from './options.js';
import { receiptIsSound } from './rules.js';
import { postgresOrderBy, sqliteOrderBy } from './order.js';
import { connectClient, emptyPlan, inspectTarget, pinSession, prepareSource, type ClonePlan, type PlanOptions } from './plan.js';
import { openSnapshot } from './source.js';
import { takeSnapshot, type Snapshot } from './snapshot.js';
import { verifyTable } from './verify.js';

export interface ProgressEvent {
  phase: 'load' | 'verify';
  table: string;
  rows: number;
  seconds: number;
}

export interface ExecuteOptions extends PlanOptions {
  /** Do everything, including verification, then ROLLBACK. Not free: it writes WAL and leaves dead tuples. */
  dryRun?: boolean;
  /** `lock_timeout` for the table locks, ms. Default 10000. */
  lockTimeoutMs?: number;
  /** Approximate COPY chunk size, bytes. Default 1 MiB. */
  batchBytes?: number;
  /** Rows per verification cursor fetch. Default 5000. */
  fetchRows?: number;
  /** After a lost COMMIT acknowledgement, how long to poll `txid_status` before reporting UNKNOWN, ms. Default 30000. */
  commitPollMs?: number;
  onProgress?: (event: ProgressEvent) => void;
  /** Test seams, run inside the clone transaction on its own client. */
  hooks?: {
    afterLoad?: (client: Client) => Promise<void>;
    beforeVerify?: (client: Client) => Promise<void>;
    beforeCommit?: (client: Client) => Promise<void>;
    /** Runs once the transaction's outcome is known, just before the snapshot is removed; receives the snapshot's directory. */
    afterOutcome?: (snapshotDirectory: string) => void;
  };
}

export interface TableResult {
  table: string;
  rows: number;
  /** SHA-256 receipt over the verified row encodings. */
  sha256: string;
  loadSeconds: number;
  verifySeconds: number;
  rowsPerSecond: number;
}

export interface CloneResult {
  outcome: 'committed' | 'dry-run';
  runId: string;
  plan: ClonePlan;
  tables: TableResult[];
  totals: { rows: number; seconds: number };
  /** `acknowledged: false`: the COMMIT reply was lost and the commit was confirmed afterwards through `txid_status`. */
  commit: { transactionId: string; acknowledged: boolean } | null;
  /** Set when the outcome is final but removing the snapshot directory failed (it holds a full copy of the data: remove it). */
  cleanupWarning?: 'snapshot-cleanup-failed';
}

const seconds = (since: number): number => (performance.now() - since) / 1000;

/**
 * Execute a clone in ONE Postgres transaction or leave the target logically unchanged. The sequence is: take the
 * verified snapshot, lock every copied and FK-related table, re-run the whole preflight under the locks (that run is
 * authoritative), optionally TRUNCATE, drop the foreign keys of copied tables, COPY every table, re-add the keys and
 * compare their catalog fields, restart the sequences, verify every table row by row against a second read of the
 * snapshot, write the receipt, COMMIT. Anything but a `CloneRefusal` or `CloneOutcomeError` is mapped onto the
 * allowlist; the snapshot is removed on every path.
 */
export async function executeClone(options: ExecuteOptions): Promise<CloneResult> {
  positiveInteger('fetchRows', options.fetchRows);
  positiveInteger('batchBytes', options.batchBytes);
  positiveInteger('lockTimeoutMs', options.lockTimeoutMs);
  nonNegativeNumber('commitPollMs', options.commitPollMs);
  nonNegativeBigint('maxSlotRetentionBytes', options.maxSlotRetentionBytes);
  const snapshot = await takeSnapshot(options);
  let result: CloneResult | undefined;
  let failure: unknown;
  try {
    result = await executeFromSnapshot(snapshot, options);
  } catch (error) {
    failure = error;
  }
  // The outcome is settled before cleanup starts, and nothing cleanup does can replace it.
  let cleanupFailed = false;
  try {
    options.hooks?.afterOutcome?.(dirname(snapshot.path));
    snapshot.dispose();
  } catch {
    cleanupFailed = true;
  }
  if (result) return cleanupFailed ? { ...result, cleanupWarning: 'snapshot-cleanup-failed' } : result;
  if (failure instanceof CloneOutcomeError) {
    failure.cleanupFailed = cleanupFailed;
    throw failure;
  }
  if (failure instanceof CloneRefusal) throw failure;
  throw new CloneRefusal(isLockTimeout(failure) ? { code: 'lock-timeout' } : toRefusal(failure, 'execute-failed'));
}

const isLockTimeout = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '55P03';

async function executeFromSnapshot(snapshot: Snapshot, options: ExecuteOptions): Promise<CloneResult> {
  const started = performance.now();
  const startedAt = new Date();
  const { manifest } = options;
  const codecs = buildCodecs(manifest);
  const db = openSnapshot(snapshot.path);
  let client: Client | undefined;
  let open = false;
  try {
    const context = prepareSource(db, options);
    const plan0 = emptyPlan(snapshot);
    plan0.refusals.push(...context.source.refusals);
    client = await connectClient(options, 0);
    await client.query('BEGIN');
    open = true;
    await client.query(`SET LOCAL lock_timeout = '${Math.trunc(options.lockTimeoutMs ?? 10_000)}ms'`);
    await client.query('SET LOCAL statement_timeout = 0');
    await client.query("SELECT pg_catalog.set_config('search_path', '', true)");
    await client.query('SET LOCAL row_security = off');
    await pinSession(client);

    const copiedOids = await lockTables(client, Object.keys(manifest.tables));
    const { plan, identity } = await inspectTarget(client, context, plan0);
    if (!plan.ok) return refuse(plan.refusals[0] as Refusal);

    if (plan.tables.some((table) => table.targetNonEmpty)) {
      await client.query(`TRUNCATE ${Object.keys(manifest.tables).map(qualified).join(', ')} RESTRICT`);
    }
    for (const fk of plan.foreignKeys) await client.query(`ALTER TABLE ${qualify(fk.tableSchema, fk.table)} DROP CONSTRAINT ${quoteIdent(fk.name)}`);

    const results: TableResult[] = [];
    for (const [table, spec] of Object.entries(manifest.tables)) {
      const loadStarted = performance.now();
      const columns = Object.keys(spec.columns).map((name) => codecs.column(table, name));
      let rows: number;
      try {
        rows = await loadTable({ client, db, table, columns: columns.filter((column) => !column.generated), orderBy: sqliteOrderBy(spec), batchBytes: options.batchBytes ?? 1 << 20 });
      } catch (error) {
        if (error instanceof CloneRefusal || (error as { name?: string }).name === 'CodecError') throw error;
        return refuse({ code: 'load-failed', table });
      }
      const loadSeconds = seconds(loadStarted);
      options.onProgress?.({ phase: 'load', table, rows, seconds: loadSeconds });
      results.push({ table, rows, sha256: '', loadSeconds, verifySeconds: 0, rowsPerSecond: loadSeconds > 0 ? rows / loadSeconds : rows });
    }
    await options.hooks?.afterLoad?.(client);

    for (const fk of plan.foreignKeys) await client.query(`ALTER TABLE ${qualify(fk.tableSchema, fk.table)} ADD CONSTRAINT ${quoteIdent(fk.name)} ${fk.definition}`);
    await assertForeignKeysRestored(client, copiedOids, identity, plan.foreignKeys);

    for (const sequence of plan.sequences) {
      const restart = sequence.restartWith === null ? 'RESTART' : `RESTART WITH ${sequence.restartWith}`;
      await client.query(`ALTER SEQUENCE ${qualify(sequence.schema, sequence.name)} ${restart}`);
    }

    await options.hooks?.beforeVerify?.(client);
    for (const result of results) {
      const spec = manifest.tables[result.table];
      if (!spec) continue;
      const verifyStarted = performance.now();
      const digest = await verifyTable({
        client,
        db,
        table: result.table,
        columns: Object.keys(spec.columns).map((name) => codecs.column(result.table, name)) as ColumnCodec[],
        primaryKey: spec.primaryKey,
        sqliteOrderBy: sqliteOrderBy(spec),
        postgresOrderBy: postgresOrderBy(spec),
        fetchRows: options.fetchRows ?? 5000,
      });
      result.verifySeconds = seconds(verifyStarted);
      options.onProgress?.({ phase: 'verify', table: result.table, rows: digest.rows, seconds: result.verifySeconds });
      result.sha256 = digest.sha256;
    }

    const runId = randomUUID();
    await writeReceipt(client, identity.serverVersionNum, runId, startedAt, manifest, results);
    await options.hooks?.beforeCommit?.(client);
    const finish = (outcome: CloneResult['outcome'], commit: CloneResult['commit']): CloneResult => ({
      outcome,
      runId,
      plan,
      tables: results,
      totals: { rows: results.reduce((sum, result) => sum + result.rows, 0), seconds: seconds(started) },
      commit,
    });

    if (options.dryRun === true) {
      await client.query('ROLLBACK');
      open = false;
      return finish('dry-run', null);
    }
    const [{ xid } = { xid: '' }] = (await client.query<{ xid: string }>('select pg_catalog.txid_current()::text as xid')).rows;
    const acknowledged = await commit(client, options, identity, runId, xid);
    open = false;
    return finish('committed', { transactionId: xid, acknowledged });
  } finally {
    if (client) {
      if (open) await client.query('ROLLBACK').catch(() => undefined);
      await client.end().catch(() => undefined);
    }
    try {
      db.close();
    } catch {
      // a failing close must not replace the outcome
    }
  }
}

const qualify = (schema: string, name: string): string => `${quoteIdent(schema)}.${quoteIdent(name)}`;
const qualified = (table: string): string => qualify(TARGET_SCHEMA, table);

/** ACCESS EXCLUSIVE on every copied table, every table joined to one by a foreign key, and the receipt table when it exists, in name order. Returns the copied tables' oids. */
async function lockTables(client: Client, tables: readonly string[]): Promise<number[]> {
  const copied = (
    await client.query<{ oid: number }>(
      `select c.oid::int as oid from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = $1::text and c.relname = any($2::text[])`,
      [TARGET_SCHEMA, [...tables]],
    )
  ).rows.map((row) => row.oid);
  const { rows } = await client.query<{ name: string }>(
    `select distinct pg_catalog.format('%I.%I', n.nspname, c.relname) as name
       from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where c.oid = any($1::oid[])
         or c.oid in (select k.conrelid from pg_catalog.pg_constraint k where k.contype = 'f' and k.confrelid = any($1::oid[]))
         or c.oid in (select k.confrelid from pg_catalog.pg_constraint k where k.contype = 'f' and k.conrelid = any($1::oid[]))
      order by 1`,
    [copied],
  );
  const receipt = (await client.query<{ name: string | null }>("select pg_catalog.to_regclass($1::text)::text as name", [`${quoteIdent(RECEIPT_SCHEMA)}.${quoteIdent(RECEIPT_TABLE)}`])).rows[0]?.name;
  const names = [...new Set([...rows.map((row) => row.name), ...(receipt ? [receipt] : [])])].sort();
  if (names.length > 0) await client.query(`LOCK TABLE ${names.join(', ')} IN ACCESS EXCLUSIVE MODE`);
  return copied;
}

const FK_FIELDS = ['tableOid', 'refOid', 'definition', 'validated', 'enforced', 'conkey', 'confkey', 'conpfeqop', 'confdelsetcols', 'confupdtype', 'confdeltype', 'confmatchtype', 'deferrable', 'deferred', 'indexName'] as const;

/** A1: the re-created constraints must match the captured ones field for field (the constraint's own oid is new by design). */
export async function assertForeignKeysRestored(client: Client, copiedOids: readonly number[], identity: TargetIdentityFacts, captured: readonly ForeignKeyFact[]): Promise<void> {
  const now = (await readForeignKeys(client, copiedOids, identity.serverVersionNum)).filter((fk) => copiedOids.includes(fk.tableOid));
  const key = (fk: ForeignKeyFact): string => `${fk.tableSchema}.${fk.table}.${fk.name}`;
  const byKey = new Map(now.map((fk) => [key(fk), fk]));
  if (byKey.size !== captured.length || now.length !== captured.length) return refuse({ code: 'foreign-keys-changed' });
  for (const before of captured) {
    const after = byKey.get(key(before));
    if (!after || FK_FIELDS.some((field) => before[field] !== after[field])) return refuse({ code: 'foreign-keys-changed', table: before.table, object: before.name });
  }
}

async function writeReceipt(client: Client, versionNum: number, runId: string, startedAt: Date, manifest: unknown, results: readonly TableResult[]): Promise<void> {
  const columns = Object.entries(RECEIPT_COLUMNS)
    .map(([name, type]) => `${quoteIdent(name)} ${type}${name === 'run_id' ? ' primary key' : ' not null'}`)
    .join(', ');
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(RECEIPT_SCHEMA)}`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${qualify(RECEIPT_SCHEMA, RECEIPT_TABLE)} (${columns})`);
  // Locked (a table created here is locked by its creator) and re-validated before anything is inserted: a trigger, rule,
  // RLS policy or publication that appeared since the preflight would run inside this transaction, after verification.
  await client.query(`LOCK TABLE ${qualify(RECEIPT_SCHEMA, RECEIPT_TABLE)} IN ACCESS EXCLUSIVE MODE`);
  const { table: facts } = await readReceiptFacts(client, versionNum);
  if (!facts || !receiptIsSound(facts)) return refuse({ code: 'receipt-table-invalid', table: `${RECEIPT_SCHEMA}.${RECEIPT_TABLE}` });
  const perTable = Object.fromEntries(results.map((result) => [result.table, { rows: result.rows, sha256: result.sha256 }]));
  const manifestSha = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  await client.query(`INSERT INTO ${qualify(RECEIPT_SCHEMA, RECEIPT_TABLE)} (run_id, started_at, manifest_sha, per_table) VALUES ($1, $2, $3, $4::jsonb)`, [runId, startedAt.toISOString(), manifestSha, JSON.stringify(perTable)]);
}

/**
 * COMMIT. No error is proof of anything: a SQLSTATE can come from a pooler or proxy that gave up after the server
 * committed. Whatever happened, the transaction's own status decides. It is asked on the same connection first (a
 * server that rejected the COMMIT, a deferred constraint for one, answers 'aborted' there), then, if that
 * connection is gone, through a reconnect with the identity re-verified and a bounded poll ('in progress' keeps
 * waiting). Never retries the COMMIT. Returns whether the acknowledgement arrived.
 */
async function commit(client: Client, options: ExecuteOptions, identity: TargetIdentityFacts, runId: string, xid: string): Promise<boolean> {
  try {
    await client.query('COMMIT');
    return true;
  } catch {
    // fall through: the status decides
  }
  const live = await statusOnLiveConnection(client, xid);
  if (live === 'committed') return false;
  if (live === 'aborted') throw new CloneOutcomeError('aborted', runId, xid);
  client.connection.stream.destroy();
  const status = await pollTransactionStatus(options, identity, xid);
  if (status === 'committed') return false;
  throw new CloneOutcomeError(status === 'aborted' ? 'aborted' : 'unknown', runId, xid);
}

async function statusOnLiveConnection(client: Client, xid: string): Promise<string | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000).unref());
  const ask = client.query<{ status: string | null }>('select pg_catalog.txid_status($1::bigint) as status', [xid]).then(
    (result) => result.rows[0]?.status ?? null,
    () => null,
  );
  return Promise.race([ask, timeout]);
}

async function pollTransactionStatus(options: ExecuteOptions, identity: TargetIdentityFacts, xid: string): Promise<'committed' | 'aborted' | 'unknown'> {
  const deadline = performance.now() + (options.commitPollMs ?? 30_000);
  let verifier: Client | undefined;
  try {
    while (performance.now() < deadline) {
      try {
        verifier ??= await connectClient({ ...options, wrapClient: undefined }, 10_000);
        const seen = await readIdentity(verifier);
        if (seen.systemIdentifier !== identity.systemIdentifier || seen.database !== identity.database) return 'unknown';
        const { rows } = await verifier.query<{ status: string | null }>('select pg_catalog.txid_status($1::bigint) as status', [xid]);
        const status = rows[0]?.status ?? null;
        if (status === 'committed') return 'committed';
        if (status === 'aborted') return 'aborted';
        if (status === null) return 'unknown';
      } catch {
        await verifier?.end().catch(() => undefined);
        verifier = undefined;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return 'unknown';
  } finally {
    await verifier?.end().catch(() => undefined);
  }
}
