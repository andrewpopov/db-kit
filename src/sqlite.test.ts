import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbKitError } from './errors.js';
import { openDatabase } from './open.js';
import { openSqlite, type SqliteHandle } from './sqlite.js';
import { parseDatabaseUrl, type SqliteConfig } from './url.js';

let dir: string;
let handle: SqliteHandle | undefined;

function configFor(path: string): SqliteConfig {
  const config = parseDatabaseUrl(`file:${path}`);
  if (config.dialect !== 'sqlite') throw new Error('expected sqlite');
  return config;
}

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'db-kit-sqlite-'));
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('openSqlite', () => {
  it('applies fleet pragmas that read back on the live connection', () => {
    handle = openSqlite(configFor(join(dir, 'a.db')));
    expect(handle.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(handle.db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(handle.db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(handle.db.pragma('synchronous', { simple: true })).toBe(1);
  });

  it('honours a custom busy timeout', () => {
    handle = openSqlite(configFor(join(dir, 'a.db')), { busyTimeoutMs: 1234 });
    expect(handle.db.pragma('busy_timeout', { simple: true })).toBe(1234);
  });

  it('rejects a foreign-key violation (foreign_keys really is ON)', () => {
    handle = openSqlite(configFor(join(dir, 'a.db')));
    handle.db.exec('create table parent (id integer primary key); create table child (pid integer references parent(id));');
    expect(() => handle?.db.exec('insert into child (pid) values (42)')).toThrow(/FOREIGN KEY/);
  });

  it('resolves a relative path against the cwd', () => {
    const original = process.cwd();
    process.chdir(dir);
    try {
      handle = openSqlite(configFor('rel.db'));
      handle.db.exec('create table t (x)');
    } finally {
      process.chdir(original);
    }
    expect(handle.db.name).toBe(join(realpathSync(dir), 'rel.db'));
  });

  it('opens in-memory databases (WAL exempt)', async () => {
    handle = openDatabase('file::memory:') as SqliteHandle;
    expect(handle.db.memory).toBe(true);
    expect((await handle.health()).ok).toBe(true);
  });

  it('opens read-only: writes fail, pragmas still verified', () => {
    const path = join(dir, 'ro.db');
    openSqlite(configFor(path)).db.exec('create table t (x)');
    handle = openSqlite(configFor(path), { readonly: true });
    expect(handle.db.readonly).toBe(true);
    expect(handle.db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() => handle?.db.exec('insert into t values (1)')).toThrow(/readonly/i);
  });

  // Replacement is what the spy runs instead, so the pragma ends up different from the requested value
  // (better-sqlite3 defaults foreign_keys=ON and busy_timeout=5000, so ignoring those alone would still verify).
  it.each([
    ['foreign_keys = ON', 'foreign_keys = OFF', 'foreign_keys', undefined],
    ['journal_mode = WAL', 'journal_mode = DELETE', 'journal_mode', undefined],
    ['busy_timeout = 1234', 'busy_timeout = 1', 'busy_timeout', 1234],
    ['synchronous = NORMAL', 'synchronous = FULL', 'synchronous', undefined],
  ])('throws SQLITE_PRAGMA_UNVERIFIED when "%s" does not take effect', (requested, actual, name, busyTimeoutMs) => {
    const realPragma = Database.prototype.pragma;
    const spy = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (this: Database.Database, source, options) {
      return realPragma.call(this, source === requested ? actual : source, options);
    });
    try {
      const error = errorOf(() => openSqlite(configFor(join(dir, 'a.db')), { busyTimeoutMs }));
      expect(error).toBeInstanceOf(DbKitError);
      expect((error as DbKitError).code).toBe('SQLITE_PRAGMA_UNVERIFIED');
      expect((error as DbKitError).message).toContain(name);
    } finally {
      spy.mockRestore();
    }
  });

  it('health() reports ok, and failure after close', async () => {
    handle = openSqlite(configFor(join(dir, 'a.db')));
    expect((await handle.health()).ok).toBe(true);
    await handle.close();
    const after = await handle.health();
    expect(after.ok).toBe(false);
    expect(after.error).toBeTruthy();
  });

  it('close() is idempotent', async () => {
    handle = openSqlite(configFor(join(dir, 'a.db')));
    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('rejects invalid busyTimeoutMs and an unopenable path with typed errors', () => {
    expect(() => openSqlite(configFor(join(dir, 'a.db')), { busyTimeoutMs: -1 })).toThrow(DbKitError);
    expect(() => openSqlite(configFor(join(dir, 'missing-dir', 'a.db')))).toThrow(/Could not open SQLite database/);
  });
});
