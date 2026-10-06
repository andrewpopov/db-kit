import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteSnapshot } from '@andrewpopov/db-backup';
import Database from 'better-sqlite3';
import { CloneRefusal, refuse } from './errors.js';

/**
 * What our own reads cannot disturb: the main file's size, mtime and sha256, and the `-wal` size (absent and empty
 * are the same, `0n`). `-shm` is ignored on purpose: every reader of a WAL database touches it.
 */
export interface LiveStamp {
  main: { size: bigint; mtimeNs: bigint; sha256: string };
  walBytes: bigint;
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

function sizeOf(path: string): bigint | null {
  try {
    return statSync(path, { bigint: true }).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return refuse({ code: 'snapshot-failed' });
  }
}

export async function stampLive(livePath: string): Promise<LiveStamp> {
  let stats;
  try {
    stats = statSync(livePath, { bigint: true });
  } catch {
    return refuse({ code: 'live-database-missing' });
  }
  return { main: { size: stats.size, mtimeNs: stats.mtimeNs, sha256: await sha256Of(livePath) }, walBytes: sizeOf(`${livePath}-wal`) ?? 0n };
}

export function liveUnchanged(before: LiveStamp, after: LiveStamp): boolean {
  return (
    before.main.size === after.main.size && before.main.mtimeNs === after.main.mtimeNs && before.main.sha256 === after.main.sha256 && before.walBytes === after.walBytes
  );
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * With writers stopped, fold the live `-wal` into the main file and empty it, so the change evidence is stable
 * against our own reads. A reader or writer still holding the database (`busy`) or a `-wal` that is not empty
 * afterwards means somebody is not stopped: refuse. A database that is not in WAL mode reports busy=0, log=-1.
 */
function checkpointLive(livePath: string): void {
  let db: Database.Database;
  try {
    db = new Database(livePath, { fileMustExist: true, timeout: 2000 });
  } catch {
    return refuse({ code: 'live-checkpoint-blocked' });
  }
  try {
    const [row] = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
    if (row?.busy !== 0) refuse({ code: 'live-checkpoint-blocked' });
  } catch (error) {
    if (error instanceof CloneRefusal) throw error;
    return refuse({ code: 'live-checkpoint-blocked' });
  } finally {
    db.close();
  }
  if ((sizeOf(`${livePath}-wal`) ?? 0n) !== 0n) refuse({ code: 'live-checkpoint-blocked' });
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
  if (sizeOf(options.livePath) === null) refuse({ code: 'live-database-missing' });
  checkpointLive(options.livePath);
  const liveBefore = await stampLive(options.livePath);

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
    const liveAfter = await stampLive(options.livePath);
    if (!liveUnchanged(liveBefore, liveAfter)) refuse({ code: 'live-changed-during-snapshot' });
    const sha256 = await sha256Of(path);
    checkSnapshot(path);
    return { path, sha256, bytes: statSync(path).size, liveBefore, liveAfter, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
