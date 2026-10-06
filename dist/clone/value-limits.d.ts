import type Database from 'better-sqlite3';
import type { IntrospectedSchema } from '../codecs/introspect.js';
import type { CodecManifest } from '../codecs/manifest.js';
import { type ForeignKeyFact } from './catalog.js';
import { type Refusal } from './errors.js';
/**
 * What the target's own column limits and constraints would reject mid-load, found on the snapshot instead: a value
 * longer than a `character varying(n)`, an integer outside the target's int2/int4/int8 range, and a child row with no
 * parent for a foreign key clone drops and re-adds (SQLite never enforced it if `PRAGMA foreign_keys` was off).
 * One aggregate scan per table and one anti-join per key. Counts and bounds are reported, never a value.
 * `db` must read integers as bigint (`openSnapshot`).
 */
export declare function sourceLimitRefusals(db: Database.Database, manifest: CodecManifest, postgres: IntrospectedSchema, foreignKeys: readonly ForeignKeyFact[]): SourceLimitResult;
/** A check that was not run, and why. Informational: the re-`ADD CONSTRAINT` before COMMIT still refuses a real orphan. */
export interface SkippedCheck {
    code: 'orphan-check-skipped';
    table: string;
    object: string;
}
export interface SourceLimitResult {
    refusals: Refusal[];
    skipped: SkippedCheck[];
}
type CompareKind = 'integer' | 'text';
/** A LEFT JOIN, not a correlated `NOT EXISTS`: SQLite builds an automatic index on the parent side, so the scan is linear even when the parent key has no index. */
export declare function orphanCountSql(fk: Pick<ForeignKeyFact, 'table' | 'refTable' | 'columns' | 'refColumns'>, kinds: readonly CompareKind[]): string;
export {};
