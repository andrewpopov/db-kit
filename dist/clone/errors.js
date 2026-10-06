import { DbKitError } from '../errors.js';
import { CodecError } from '../codecs/errors.js';
/** Every reason clone refuses. The allowlist is the contract: an error leaving clone is one of these plus an identity, never a driver message. */
export const CLONE_REFUSAL_CODES = [
    // snapshot
    'writers-not-stopped',
    'live-database-missing',
    'live-checkpoint-blocked',
    'live-writer-active',
    'live-changed-during-snapshot',
    'snapshot-failed',
    'snapshot-integrity-failed',
    'snapshot-foreign-key-violation',
    'snapshot-not-utf8',
    // source data
    'source-nul-in-text',
    'source-invalid-utf8',
    'source-read-failed',
    'codec-null',
    'codec-invalid',
    'codec-lossy',
    // target connection and identity
    'target-url-missing',
    'target-url-invalid',
    'target-not-postgres',
    'target-connect-failed',
    'target-identity-unreadable',
    'target-in-recovery',
    'topology-invalid',
    'production-unconfirmed',
    // schema gate
    'manifest-invalid',
    'primary-key-mismatch',
    'primary-key-order-unsupported',
    'nullability-mismatch',
    'partitioned-table',
    'inherited-table',
    'trigger-present',
    'rule-present',
    'row-security-enabled',
    'foreign-key-not-valid',
    'constraint-has-comment',
    'event-trigger-present',
    'publication-covers-table',
    'subscription-present',
    'sequence-unowned',
    'sequence-shared',
    'sequence-dynamic-default',
    'volatile-expression',
    'sequence-cycles',
    'sequence-out-of-range',
    'incoming-reference-from-uncopied-table',
    // capabilities
    'not-owner',
    'no-create-privilege',
    'receipt-table-invalid',
    // state and operations
    'target-not-empty',
    'archiver-failing',
    'replication-slot-lag',
    'preflight-failed',
    // execution
    'lock-timeout',
    'load-failed',
    'verification-mismatch',
    'foreign-keys-changed',
    'commit-failed',
    'execute-failed',
];
export function describeRefusal(refusal) {
    const identity = [refusal.table, refusal.column].filter((part) => part !== undefined).join('.');
    return [refusal.code, identity, refusal.object === undefined ? '' : `(${refusal.object})`].filter((part) => part !== '').join(' ');
}
/** Thrown when clone cannot proceed. The message is `describeRefusal` of the refusal, so it is safe to print. */
export class CloneRefusal extends DbKitError {
    refusal;
    constructor(refusal) {
        super('CLONE_REFUSED', describeRefusal(refusal));
        this.name = 'CloneRefusal';
        this.refusal = refusal;
    }
}
const CODEC_REFUSALS = { CODEC_NULL: 'codec-null', CODEC_INVALID: 'codec-invalid', CODEC_LOSSY: 'codec-lossy' };
/**
 * Map anything that escapes clone onto the allowlist. Driver errors, `cause` chains, SQL text and parameters are
 * dropped on purpose (D12): the fallback names no detail at all.
 */
export function toRefusal(error, fallback = 'preflight-failed') {
    if (error instanceof CloneRefusal)
        return error.refusal;
    if (error instanceof CodecError)
        return { code: CODEC_REFUSALS[error.code], table: error.table, column: error.column };
    return { code: fallback };
}
export function refuse(refusal) {
    throw new CloneRefusal(refusal);
}
/**
 * The COMMIT's fate when its acknowledgement was lost or it failed: `aborted` (nothing was committed, the target is
 * unchanged) or `unknown` (could not be established: inspect the target, never retry blindly).
 */
export class CloneOutcomeError extends DbKitError {
    outcome;
    runId;
    transactionId;
    /** Set when removing the snapshot failed after the outcome was known; the outcome itself is unchanged. */
    cleanupFailed = false;
    constructor(outcome, runId, transactionId) {
        super('CLONE_OUTCOME', `commit ${outcome} (run ${runId})`);
        this.name = 'CloneOutcomeError';
        this.outcome = outcome;
        this.runId = runId;
        this.transactionId = transactionId;
    }
}
