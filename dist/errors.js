/**
 * Typed error for everything db-kit raises itself. Messages are built from
 * structural facts (scheme, field name, pragma name), never from the URL, so
 * a password cannot reach a message by construction.
 */
export class DbKitError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.name = 'DbKitError';
        this.code = code;
    }
}
/**
 * Re-create a driver error with every known secret removed from its message
 * and `code`. The original is deliberately NOT kept as `cause`: driver errors
 * can embed connection details, and anything on the cause chain is reachable
 * by `util.inspect`, loggers and error reporters.
 */
export function scrubError(error, secrets) {
    const known = secrets.filter((s) => typeof s === 'string' && s.length > 0);
    const redact = (text) => known.reduce((acc, secret) => acc.split(secret).join('***'), text);
    const original = error instanceof Error ? error : new Error(String(error));
    const scrubbed = new Error(redact(original.message));
    scrubbed.name = original.name;
    const code = original.code;
    if (typeof code === 'string')
        scrubbed.code = redact(code);
    return scrubbed;
}
