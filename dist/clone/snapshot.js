import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteSnapshot } from '@andrewpopov/db-backup';
import Database from 'better-sqlite3';
import { refuse } from './errors.js';
function stamp(path) {
    try {
        const stats = statSync(path, { bigint: true });
        return { size: stats.size, mtimeNs: stats.mtimeNs };
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        return refuse({ code: 'snapshot-failed' });
    }
}
export function stampLive(livePath) {
    return { main: stamp(livePath), wal: stamp(`${livePath}-wal`), shm: stamp(`${livePath}-shm`) };
}
const sameStamp = (a, b) => (a === null || b === null ? a === b : a.size === b.size && a.mtimeNs === b.mtimeNs);
export function liveUnchanged(before, after) {
    return sameStamp(before.main, after.main) && sameStamp(before.wal, after.wal) && sameStamp(before.shm, after.shm);
}
async function sha256Of(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path))
        hash.update(chunk);
    return hash.digest('hex');
}
/** `PRAGMA integrity_check`, `foreign_key_check` and `encoding` on the snapshot, read-only. Refuses on the first failure. */
function checkSnapshot(path) {
    let db;
    try {
        db = new Database(path, { readonly: true });
    }
    catch {
        return refuse({ code: 'snapshot-integrity-failed' });
    }
    try {
        let integrity;
        let violations;
        try {
            integrity = db.pragma('integrity_check');
            violations = db.pragma('foreign_key_check');
        }
        catch {
            return refuse({ code: 'snapshot-integrity-failed' });
        }
        if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
            refuse({ code: 'snapshot-integrity-failed' });
        if (violations.length > 0)
            refuse({ code: 'snapshot-foreign-key-violation', table: violations[0]?.table });
        if (db.pragma('encoding', { simple: true }) !== 'UTF-8')
            refuse({ code: 'snapshot-not-utf8' });
    }
    finally {
        db.close();
    }
}
const defaultSnapshotFile = (source, destination) => {
    createSqliteSnapshot({ sourcePath: source, destPath: destination });
};
/**
 * Snapshot a stopped live SQLite database into a private temp directory and verify the copy. Refuses (typed
 * `CloneRefusal`) without `writersStopped`, if the live file or its `-wal`/`-shm` changed size or mtime while the
 * snapshot ran, or if the copy fails integrity, foreign-key or encoding checks. The temp directory is removed on
 * every failing path; on success the caller owns `dispose()`.
 */
export async function takeSnapshot(options) {
    if (options.writersStopped !== true)
        refuse({ code: 'writers-not-stopped' });
    const liveBefore = stampLive(options.livePath);
    if (liveBefore.main === null)
        refuse({ code: 'live-database-missing' });
    const dir = mkdtempSync(join(tmpdir(), 'db-kit-clone-'));
    const dispose = () => rmSync(dir, { recursive: true, force: true });
    try {
        chmodSync(dir, 0o700);
        const path = join(dir, 'snapshot.db');
        try {
            (options.createSnapshotFile ?? defaultSnapshotFile)(options.livePath, path);
        }
        catch {
            return refuse({ code: 'snapshot-failed' });
        }
        const liveAfter = stampLive(options.livePath);
        if (!liveUnchanged(liveBefore, liveAfter))
            refuse({ code: 'live-changed-during-snapshot' });
        const sha256 = await sha256Of(path);
        checkSnapshot(path);
        return { path, sha256, bytes: statSync(path).size, liveBefore, liveAfter, dispose };
    }
    catch (error) {
        dispose();
        throw error;
    }
}
