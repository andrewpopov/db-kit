import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { DbKitError } from './errors.js';
import type { HealthResult } from './health.js';
import type { SqliteConfig } from './url.js';

export interface SqliteOptions {
  /** `busy_timeout` in ms. Default 5000. */
  busyTimeoutMs?: number;
  /** Open read-only. WAL is then not requested (switching journal mode needs write access). Default false. */
  readonly?: boolean;
}

export interface SqliteHandle {
  readonly dialect: 'sqlite';
  readonly db: Database.Database;
  health(): Promise<HealthResult>;
  /** Idempotent. */
  close(): Promise<void>;
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

// PRAGMA synchronous: 0 OFF, 1 NORMAL, 2 FULL, 3 EXTRA
const SYNCHRONOUS_NORMAL = 1;

function verifyPragma(db: Database.Database, name: string, expected: string | number): void {
  const actual = db.pragma(name, { simple: true });
  if (actual !== expected) {
    throw new DbKitError(
      'SQLITE_PRAGMA_UNVERIFIED',
      `SQLite pragma ${name} did not take effect: expected ${String(expected)}, read back ${String(actual)}`,
    );
  }
}

/**
 * Open a SQLite database with fleet settings, each applied and read back:
 * `journal_mode=WAL` (in-memory databases cannot WAL and are exempt),
 * `busy_timeout`, `foreign_keys=ON`, `synchronous=NORMAL`.
 * A pragma that does not verify closes the handle and throws `SQLITE_PRAGMA_UNVERIFIED`.
 */
export function openSqlite(config: SqliteConfig, opts: SqliteOptions = {}): SqliteHandle {
  const busyTimeoutMs = opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new DbKitError('INVALID_OPTIONS', 'busyTimeoutMs must be a non-negative integer');
  }
  const readonly = opts.readonly ?? false;

  let db: Database.Database;
  try {
    db = new Database(config.inMemory ? ':memory:' : resolve(config.path), { readonly });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new DbKitError('SQLITE_OPEN_FAILED', `Could not open SQLite database ${config.path}: ${reason}`);
  }

  try {
    if (!readonly) {
      db.pragma('journal_mode = WAL');
      verifyPragma(db, 'journal_mode', config.inMemory ? 'memory' : 'wal');
    }
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    verifyPragma(db, 'busy_timeout', busyTimeoutMs);
    db.pragma('foreign_keys = ON');
    verifyPragma(db, 'foreign_keys', 1);
    db.pragma('synchronous = NORMAL');
    verifyPragma(db, 'synchronous', SYNCHRONOUS_NORMAL);
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    dialect: 'sqlite',
    db,
    async health() {
      const started = performance.now();
      try {
        db.prepare('select 1').get();
        return { ok: true, latencyMs: performance.now() - started };
      } catch (error) {
        return { ok: false, latencyMs: performance.now() - started, error: error instanceof Error ? error.message : String(error) };
      }
    },
    async close() {
      if (db.open) db.close();
    },
  };
}
