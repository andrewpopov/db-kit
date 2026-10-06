import Database from 'better-sqlite3';
import type { CodecManifest } from '../codecs/manifest.js';
import type { PostgresConfig } from '../url.js';
import type { ProgressEvent } from './execute.js';
import { type PlanOptions } from './plan.js';
import { type TopologyEntry } from './topology.js';
export interface ReverseOptions {
    /** The Postgres database to read. */
    source: PostgresConfig;
    manifest: CodecManifest;
    /** The new SQLite file. Must not exist; it appears only once everything has been verified. */
    toSqlitePath: string;
    /** An already-migrated, EMPTY SQLite file carrying the app's own SQLite schema. Copied, never modified. */
    sqliteTemplatePath: string;
    /** Operator attestation that every writer to the source is stopped and drained. */
    writersStopped: boolean;
    topology?: readonly TopologyEntry[];
    confirmProduction?: string;
    /** Do everything, verification included, then discard the file: nothing appears at `toSqlitePath`. */
    dryRun?: boolean;
    tlsCa?: string;
    /** Rows fetched from Postgres per round trip, load and verify. Default 5000. */
    fetchRows?: number;
    onProgress?: (event: ProgressEvent) => void;
    /** Test seams. */
    wrapClient?: PlanOptions['wrapClient'];
    hooks?: {
        afterLoad?: (db: Database.Database) => void;
        /** Runs on the finished temp file just before it is verified. */
        beforeVerify?: (tempPath: string) => void;
        beforeRename?: (tempPath: string, targetPath: string) => void;
    };
}
export interface ReverseTableResult {
    table: string;
    rows: number;
    sha256: string;
    loadSeconds: number;
    verifySeconds: number;
}
export interface ReverseResult {
    outcome: 'written' | 'dry-run';
    runId: string;
    /** The new database, or null for a dry run. */
    path: string | null;
    receiptPath: string | null;
    source: {
        host: string;
        port: number;
        database: string;
        systemIdentifier: string;
        serverVersion: string;
    };
    tables: ReverseTableResult[];
    /** `sqlite_sequence` values set for AUTOINCREMENT tables. */
    sequences: {
        table: string;
        seq: string;
    }[];
    totals: {
        rows: number;
        seconds: number;
    };
}
/**
 * Clone Postgres into a FRESH SQLite file, the rollback-window path: writers stopped and drained, one REPEATABLE READ
 * READ ONLY snapshot of the source, the app's own empty SQLite schema (a template file, copied) filled inside one
 * SQLite transaction with foreign keys off, then `foreign_key_check` and `integrity_check` clean, committed, and
 * verified row by row against a second read of the same Postgres snapshot. Only then is the file fsynced and linked
 * into place without clobbering anything, with a receipt beside it. Everything before that happens in a hidden temp
 * file next to the target, so a crash at any point leaves nothing at the target path. Only a `CloneRefusal` ever leaves.
 */
export declare function reverseClone(options: ReverseOptions): Promise<ReverseResult>;
