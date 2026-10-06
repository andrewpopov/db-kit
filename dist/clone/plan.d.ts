import type Database from 'better-sqlite3';
import { Client } from 'pg';
import { type IntrospectedSchema } from '../codecs/introspect.js';
import type { CodecManifest } from '../codecs/manifest.js';
import type { PostgresConfig } from '../url.js';
import { type ForeignKeyFact, type TargetIdentityFacts } from './catalog.js';
import { type Refusal } from './errors.js';
import { type SkippedCheck } from './value-limits.js';
import { type SourceFacts, type SourceTableFacts } from './source.js';
import { type Snapshot, type SnapshotOptions } from './snapshot.js';
import { type TopologyEntry } from './topology.js';
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
    snapshot: {
        sha256: string;
        bytes: number;
    };
    target: TargetSummary | null;
    tables: PlannedTable[];
    /** Tables declared `copy: false`: never copied, verified, emptied or truncated. */
    skippedTables: {
        table: string;
        reason: string;
    }[];
    /** Foreign keys owned by copied tables: dropped before the load and re-added (re-validated) before COMMIT. */
    foreignKeys: ForeignKeyFact[];
    /** Foreign keys from tables clone does not copy into copied ones: untouched, listed for the operator. */
    incomingReferences: ForeignKeyFact[];
    sequences: PlannedSequence[];
    refusals: Refusal[];
    /** Checks not run (informational, never a refusal), e.g. an orphan scan of a key SQLite cannot compare the way Postgres does. */
    skippedChecks: SkippedCheck[];
}
/**
 * Everything clone decides before writing anything: take and verify the snapshot, scan it, read the target in one
 * READ ONLY transaction, and report every refusal found. Throws `CloneRefusal` only when no plan can be built at all
 * (writers not stopped, live file changed, snapshot failed, target unreachable or unreadable). The snapshot is
 * removed on every path.
 */
export declare function planClone(options: PlanOptions): Promise<ClonePlan>;
/** Plan from an already-verified snapshot. Like `planClone`, nothing but a `CloneRefusal` ever leaves: driver errors are dropped. */
export declare function planFromSnapshot(snapshot: Snapshot, options: PlanOptions): Promise<ClonePlan>;
export declare function emptyPlan(snapshot: Pick<Snapshot, 'sha256' | 'bytes'>): ClonePlan;
/** The snapshot side of a plan: its schema and the one-scan source facts. Shared by planning and execution. */
export interface SourceContext {
    db: Database.Database;
    options: PlanOptions;
    sqliteSchema: IntrospectedSchema;
    source: SourceFacts;
}
export declare function prepareSource(db: Database.Database, options: PlanOptions): SourceContext;
export interface TargetInspection {
    plan: ClonePlan;
    /** Null only when the identity could not be read as a refusal-free plan (never: unreadable identity throws). */
    identity: TargetIdentityFacts;
}
/**
 * Every target-side check, on a client that already has a transaction open with `search_path = ''`. Planning runs it
 * in a READ ONLY transaction; execution re-runs it under the table locks, where it is authoritative.
 */
export declare function inspectTarget(client: Client, context: SourceContext, plan: ClonePlan): Promise<TargetInspection>;
/**
 * Pin what the codecs read, inside the transaction as well as in the connection's startup options (a pooler may drop
 * the latter): hex bytea, and lossless float text. A role or database default of `bytea_output=escape` or
 * `extra_float_digits=0` would otherwise change what both sides of a verification read.
 */
export declare function pinSession(client: Client): Promise<void>;
/** Connect one `pg.Client` with a pinned UTC/ISO session (the codecs' read contract). Failure is a typed refusal. */
export declare function connectClient(options: Pick<PlanOptions, 'target' | 'tlsCa' | 'wrapClient'>, statementTimeoutMs: number): Promise<Client>;
