export type DbKitErrorCode =
  | 'INVALID_DATABASE_URL'
  | 'INVALID_OPTIONS'
  | 'SQLITE_PRAGMA_UNVERIFIED'
  | 'SQLITE_OPEN_FAILED'
  | 'INVALID_MANIFEST'
  | 'CODEC_NULL'
  | 'CODEC_INVALID'
  | 'CODEC_LOSSY'
  | 'CLONE_REFUSED';

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
 * Re-create a driver error with every known secret removed from its name,
 * message, stack and every own string property (`code`, pg's `detail`, ...). The original is deliberately NOT kept as `cause`: driver errors
 * can embed connection details, and anything on the cause chain is reachable
 * by `util.inspect`, loggers and error reporters.
 */
export function scrubError(error: unknown, secrets: readonly (string | undefined)[]): Error {
  const known = secrets.filter((s): s is string => typeof s === 'string' && s.length > 0);
  const redact = (text: string): string => known.reduce((acc, secret) => acc.split(secret).join('***'), text);
  const original = error instanceof Error ? error : new Error(String(error));
  const scrubbed = new Error(redact(original.message));
  scrubbed.name = redact(original.name);
  if (original.stack) scrubbed.stack = redact(original.stack);
  for (const key of Object.getOwnPropertyNames(original)) {
    if (key === 'message' || key === 'stack' || key === 'name' || key === 'cause') continue;
    const value: unknown = Object.getOwnPropertyDescriptor(original, key)?.value;
    if (typeof value === 'string') Object.defineProperty(scrubbed, key, { value: redact(value), enumerable: true, writable: true, configurable: true });
  }
  return scrubbed;
}
