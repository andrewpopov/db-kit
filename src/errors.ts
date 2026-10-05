export type DbKitErrorCode =
  | 'INVALID_DATABASE_URL'
  | 'INVALID_OPTIONS'
  | 'SQLITE_PRAGMA_UNVERIFIED'
  | 'SQLITE_OPEN_FAILED';

/**
 * Typed error for everything db-kit raises itself. Messages are built from
 * structural facts (scheme, field name, pragma name), never from the URL, so
 * a password cannot reach a message by construction.
 */
export class DbKitError extends Error {
  readonly code: DbKitErrorCode;

  constructor(code: DbKitErrorCode, message: string, options?: { cause?: unknown }) {
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
export function scrubError(error: unknown, secrets: readonly (string | undefined)[]): Error {
  const known = secrets.filter((s): s is string => typeof s === 'string' && s.length > 0);
  const redact = (text: string): string => known.reduce((acc, secret) => acc.split(secret).join('***'), text);
  const original = error instanceof Error ? error : new Error(String(error));
  const scrubbed = new Error(redact(original.message));
  scrubbed.name = original.name;
  const code = (original as { code?: unknown }).code;
  if (typeof code === 'string') (scrubbed as { code?: string }).code = redact(code);
  return scrubbed;
}
