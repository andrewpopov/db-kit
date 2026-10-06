import Database from 'better-sqlite3';
import type { CodecManifest } from '../codecs/manifest.js';
import type { IntrospectedSchema } from '../codecs/introspect.js';
import { type Refusal } from './errors.js';
export interface SourceTableFacts {
    table: string;
    rows: number;
    /** Sum of stored byte lengths of the copied columns: what the load will carry, before any codec or COPY framing. */
    estimatedBytes: number;
}
export interface SourceFacts {
    tables: SourceTableFacts[];
    refusals: Refusal[];
}
/** Open the verified snapshot read-only. Every statement reads 64-bit values as bigint. */
export declare function openSnapshot(path: string): Database.Database;
/**
 * One scan per table: row count, byte estimate, and a NUL check on every copied non-blob column. Postgres TEXT cannot
 * store U+0000, so a NUL byte in a stored string is refused here, naming table.column, instead of failing mid-load.
 * Tables or columns missing from the snapshot are left to manifest validation.
 */
export declare function scanSource(db: Database.Database, manifest: CodecManifest, schema: IntrospectedSchema): SourceFacts;
/**
 * Foreign keys the SQLite schema itself declares between a copied table and a `copy: false` one, in either direction:
 * Postgres may not have that key, but the relationship would still dangle once one side is never copied.
 */
export declare function sqliteSkippedKeyRefusals(db: Database.Database, manifest: CodecManifest, schema: IntrospectedSchema): Refusal[];
export interface SequenceSourceFacts {
    /** max and min of the column over the snapshot; null for an empty table. */
    highest: bigint | null;
    lowest: bigint | null;
    /** `sqlite_sequence.seq` for an AUTOINCREMENT table; null otherwise. */
    autoincrementHighWater: bigint | null;
}
export declare function readSequenceSource(db: Database.Database, table: string, column: string): SequenceSourceFacts;
/**
 * The value `ALTER SEQUENCE ... RESTART WITH` must use (A4): the extreme in the sequence's own direction (max for
 * ascending, min for descending; AUTOINCREMENT's high-water counts for ascending) plus the increment. `null` means the
 * table is empty, so the sequence is restarted at its own start value. A result outside min/max is a refusal.
 */
export declare function restartValue(source: SequenceSourceFacts, sequence: {
    increment: bigint;
    min: bigint;
    max: bigint;
}): {
    restartWith: bigint | null;
    inRange: boolean;
};
