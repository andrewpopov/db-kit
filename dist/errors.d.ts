export type DbKitErrorCode = 'INVALID_DATABASE_URL' | 'INVALID_OPTIONS' | 'SQLITE_PRAGMA_UNVERIFIED' | 'SQLITE_OPEN_FAILED';
/**
 * Typed error for everything db-kit raises itself. Messages are built from
 * structural facts (scheme, field name, pragma name), never from the URL, so
 * a password cannot reach a message by construction.
 */
export declare class DbKitError extends Error {
    readonly code: DbKitErrorCode;
    constructor(code: DbKitErrorCode, message: string, options?: {
        cause?: unknown;
    });
}
/**
 * Re-create a driver error with every known secret removed from its message
 * and `code`. The original is deliberately NOT kept as `cause`: driver errors
 * can embed connection details, and anything on the cause chain is reachable
 * by `util.inspect`, loggers and error reporters.
 */
export declare function scrubError(error: unknown, secrets: readonly (string | undefined)[]): Error;
