import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteSnapshot } from '@andrewpopov/db-backup';
import Database from 'better-sqlite3';
import { refuse } from './errors.js';

/** Size and modification time (ns) of one file; `null` when it does not exist. */
export type FileStamp = { size: bigint; mtimeNs: bigint } | null;

export interface LiveStamp {
  main: FileStamp;
  wal: FileStamp;
  shm: FileStamp;
}

export interface Snapshot {
  /** The snapshot file, inside a private 0700 directory removed by `dispose()`. */
  path: string;
  sha256: string;
  bytes: number;
  liveBefore: LiveStamp;
  liveAfter: LiveStamp;
  /** Idempotent. Removes the temp directory and everything in it. */
  dispose(): void;
}

export interface SnapshotOptions {
  livePath: string;
  /** Operator attestation that every writer to `livePath` is stopped. Without it nothing is read. */
  writersStopped: boolean;
  /** Test seam: the snapshot primitive. Defaults to db-backup's `createSqliteSnapshot`. */
  createSnapshotFile?: (source: string, destination: string) => void;
}

function stamp(path: string): FileStamp {
  try {
    const stats = statSync(path, { bigint: true });
    return { size: stats.size, mtimeNs: stats.mtimeNs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return refuse({ code: 'snapshot-failed' });
  }
}

export function stampLive(livePath: string): LiveStamp {
  return { main: stamp(livePath), wal: stamp(`${livePath}-wal`), shm: stamp(`${livePath}-shm`) };
}

const sameStamp = (a: FileStamp, b: FileStamp): boolean => (a === null || b === null ? a === b : a.size === b.size && a.mtimeNs === b.mtimeNs);

export function liveUnchanged(before: LiveStamp, after: LiveStamp): boolean {
  return sameStamp(before.main, after.main) && sameStamp(before.wal, after.wal) && sameStamp(before.shm, after.shm);
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** `PRAGMA integrity_check`, `foreign_key_check` and `encoding` on the snapshot, read-only. Refuses on the first failure. */
function checkSnapshot(path: string): void {
  let db: Database.Database;
  try {
    db = new Database(path, { readonly: true });
  } catch {
    return refuse({ code: 'snapshot-integrity-failed' });
  }
  try {
    let integrity: { integrity_check: string }[];
    let violations: { table: string }[];
    try {
      integrity = db.pragma('integrity_check') as { integrity_check: string }[];
      violations = db.pragma('foreign_key_check') as { table: string }[];
    } catch {
      return refuse({ code: 'snapshot-integrity-failed' });
    }
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') refuse({ code: 'snapshot-integrity-failed' });
    if (violations.length > 0) refuse({ code: 'snapshot-foreign-key-violation', table: violations[0]?.table });
    if (db.pragma('encoding', { simple: true }) !== 'UTF-8') refuse({ code: 'snapshot-not-utf8' });
  } finally {
    db.close();
  }
}

const defaultSnapshotFile = (source: string, destination: string): void => {
  createSqliteSnapshot({ sourcePath: source, destPath: destination });
};

/**
 * Snapshot a stopped live SQLite database into a private temp directory and verify the copy. Refuses (typed
 * `CloneRefusal`) without `writersStopped`, if the live file or its `-wal`/`-shm` changed size or mtime while the
 * snapshot ran, or if the copy fails integrity, foreign-key or encoding checks. The temp directory is removed on
 * every failing path; on success the caller owns `dispose()`.
 */
export async function takeSnapshot(options: SnapshotOptions): Promise<Snapshot> {
  if (options.writersStopped !== true) refuse({ code: 'writers-not-stopped' });
  const liveBefore = stampLive(options.livePath);
  if (liveBefore.main === null) refuse({ code: 'live-database-missing' });

  const dir = mkdtempSync(join(tmpdir(), 'db-kit-clone-'));
  const dispose = (): void => rmSync(dir, { recursive: true, force: true });
  try {
    chmodSync(dir, 0o700);
    const path = join(dir, 'snapshot.db');
    try {
      (options.createSnapshotFile ?? defaultSnapshotFile)(options.livePath, path);
    } catch {
      return refuse({ code: 'snapshot-failed' });
    }
    const liveAfter = stampLive(options.livePath);
    if (!liveUnchanged(liveBefore, liveAfter)) refuse({ code: 'live-changed-during-snapshot' });
    const sha256 = await sha256Of(path);
    checkSnapshot(path);
    return { path, sha256, bytes: statSync(path).size, liveBefore, liveAfter, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
