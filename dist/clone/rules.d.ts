import type { CodecManifest } from '../codecs/manifest.js';
import { type ForeignKeyFact, type ReceiptFacts, type SequenceRef, type TargetFacts } from './catalog.js';
import type { Refusal } from './errors.js';
export declare const DEFAULT_MAX_SLOT_RETENTION_BYTES: bigint;
export interface RuleOptions {
    truncate: boolean;
    maxSlotRetentionBytes: bigint;
}
/** One sequence clone will restart: owned by (or identity of) exactly one column of a copied table. */
export interface OwnedSequence extends Omit<SequenceRef, 'kind' | 'tableOid'> {
    table: string;
}
export interface GateResult {
    refusals: Refusal[];
    /** Foreign keys owned by a copied table: the set clone will drop and re-add. */
    foreignKeys: ForeignKeyFact[];
    /** Foreign keys from a table clone does not copy into a copied one: left alone, listed for the operator. */
    incomingReferences: ForeignKeyFact[];
    sequences: OwnedSequence[];
}
/** Turn catalog facts into refusals: the schema gate, capabilities, emptiness and operational checks of PKG-177 D5-D10 and A1/A3-A5/A7. */
export declare function evaluateGate(facts: TargetFacts, manifest: CodecManifest, options: RuleOptions): GateResult;
/** The receipt table is safe to insert into: a plain owned table of exactly the expected shape that nothing else hooks into. */
export declare function receiptIsSound(table: NonNullable<ReceiptFacts['table']>): boolean;
