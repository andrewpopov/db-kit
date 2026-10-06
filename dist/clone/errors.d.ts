import { DbKitError } from '../errors.js';
/** Every reason clone refuses. The allowlist is the contract: an error leaving clone is one of these plus an identity, never a driver message. */
export declare const CLONE_REFUSAL_CODES: readonly ["writers-not-stopped", "live-database-missing", "live-changed-during-snapshot", "snapshot-failed", "snapshot-integrity-failed", "snapshot-foreign-key-violation", "snapshot-not-utf8", "source-nul-in-text", "source-read-failed", "codec-null", "codec-invalid", "codec-lossy", "target-url-missing", "target-url-invalid", "target-not-postgres", "target-connect-failed", "target-identity-unreadable", "target-in-recovery", "topology-invalid", "production-unconfirmed", "manifest-invalid", "primary-key-mismatch", "nullability-mismatch", "partitioned-table", "inherited-table", "trigger-present", "rule-present", "row-security-enabled", "foreign-key-not-valid", "constraint-has-comment", "event-trigger-present", "publication-covers-table", "subscription-present", "sequence-unowned", "sequence-shared", "sequence-cycles", "sequence-out-of-range", "incoming-reference-from-uncopied-table", "not-owner", "no-create-privilege", "receipt-table-invalid", "target-not-empty", "archiver-failing", "replication-slot-lag", "preflight-failed"];
export type CloneRefusalCode = (typeof CLONE_REFUSAL_CODES)[number];
/** A refusal as data: a code from the allowlist plus the identity it concerns. Never a value, URL or driver text. */
export interface Refusal {
    code: CloneRefusalCode;
    table?: string;
    column?: string;
    /** A named catalog object (constraint, trigger, sequence, slot, publication). */
    object?: string;
}
export declare function describeRefusal(refusal: Refusal): string;
/** Thrown when clone cannot proceed. The message is `describeRefusal` of the refusal, so it is safe to print. */
export declare class CloneRefusal extends DbKitError {
    readonly refusal: Refusal;
    constructor(refusal: Refusal);
}
/**
 * Map anything that escapes clone onto the allowlist. Driver errors, `cause` chains, SQL text and parameters are
 * dropped on purpose (D12): the fallback names no detail at all.
 */
export declare function toRefusal(error: unknown, fallback?: CloneRefusalCode): Refusal;
export declare function refuse(refusal: Refusal): never;
