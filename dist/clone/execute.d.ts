import type { Client } from 'pg';
import { type ForeignKeyFact, type TargetIdentityFacts } from './catalog.js';
import { type ClonePlan, type PlanOptions } from './plan.js';
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
    totals: {
        rows: number;
        seconds: number;
    };
    /** `acknowledged: false`: the COMMIT reply was lost and the commit was confirmed afterwards through `txid_status`. */
    commit: {
        transactionId: string;
        acknowledged: boolean;
    } | null;
    /** Set when the outcome is final but removing the snapshot directory failed (it holds a full copy of the data: remove it). */
    cleanupWarning?: 'snapshot-cleanup-failed';
}
/**
 * Execute a clone in ONE Postgres transaction or leave the target logically unchanged. The sequence is: take the
 * verified snapshot, lock every copied and FK-related table, re-run the whole preflight under the locks (that run is
 * authoritative), optionally TRUNCATE, drop the foreign keys of copied tables, COPY every table, re-add the keys and
 * compare their catalog fields, restart the sequences, verify every table row by row against a second read of the
 * snapshot, write the receipt, COMMIT. Anything but a `CloneRefusal` or `CloneOutcomeError` is mapped onto the
 * allowlist; the snapshot is removed on every path.
 */
export declare function executeClone(options: ExecuteOptions): Promise<CloneResult>;
/** A1: the re-created constraints must match the captured ones field for field (the constraint's own oid is new by design). */
export declare function assertForeignKeysRestored(client: Client, copiedOids: readonly number[], identity: TargetIdentityFacts, captured: readonly ForeignKeyFact[]): Promise<void>;
