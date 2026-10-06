import { Client } from 'pg';
import type { CodecManifest } from '../codecs/manifest.js';
import type { PostgresConfig } from '../url.js';
import { type ForeignKeyFact, type TargetIdentityFacts } from './catalog.js';
import { type Refusal } from './errors.js';
import { type SourceTableFacts } from './source.js';
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
export declare function planClone(options: PlanOptions): Promise<ClonePlan>;
export declare function planFromSnapshot(snapshot: Snapshot, options: PlanOptions): Promise<ClonePlan>;
