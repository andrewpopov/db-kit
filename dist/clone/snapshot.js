import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteSnapshot } from '@andrewpopov/db-backup';
import Database from 'better-sqlite3';
import { CloneRefusal, refuse, toRefusal } from './errors.js';
function sizeOf(path) {
    try {
        return statSync(path, { bigint: true }).size;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        return refuse({ code: 'snapshot-failed' });
    }
}
export async function stampLive(livePath) {
    let stats;
    try {
        stats = statSync(livePath, { bigint: true });
    }
    catch {
        return refuse({ code: 'live-database-missing' });
    }
    return { main: { size: stats.size, mtimeNs: stats.mtimeNs, sha256: await sha256Of(livePath) }, walBytes: sizeOf(`${livePath}-wal`) ?? 0n };
}
export function liveUnchanged(before, after) {
    return (before.main.size === after.main.size && before.main.mtimeNs === after.main.mtimeNs && before.main.sha256 === after.main.sha256 && before.walBytes === after.walBytes);
}
async function sha256Of(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path))
        hash.update(chunk);
    return hash.digest('hex');
}
/**
 * With writers stopped: fold the live `-wal` into the main file and empty it, then take and HOLD the write lock
 * (`BEGIN IMMEDIATE`) until `release()`. While held, no other connection can commit in either journal mode, so a writer
 * that was not actually stopped is refused (`live-writer-active`) instead of committing data the snapshot lacks; readers,
 * db-backup's snapshot included, are unaffected. A busy checkpoint or a `-wal` that is not empty afterwards also means
 * somebody still holds the database (`live-checkpoint-blocked`). A database that is not in WAL mode reports busy=0, log=-1.
 */
function holdLive(livePath) {
    let db;
    try {
        db = new Database(livePath, { fileMustExist: true, timeout: 2000 });
    }
    catch {
        return refuse({ code: 'live-checkpoint-blocked' });
    }
    const release = () => {
        try {
            if (db.inTransaction)
                db.exec('ROLLBACK');
        }
        finally {
            db.close();
        }
    };
    try {
        const [row] = db.pragma('wal_checkpoint(TRUNCATE)');
        if (row?.busy !== 0)
            refuse({ code: 'live-checkpoint-blocked' });
        try {
            db.exec('BEGIN IMMEDIATE');
        }
        catch {
            return refuse({ code: 'live-writer-active' });
        }
        if ((sizeOf(`${livePath}-wal`) ?? 0n) !== 0n)
            refuse({ code: 'live-checkpoint-blocked' });
    }
    catch (error) {
        release();
        throw error instanceof CloneRefusal ? error : new CloneRefusal({ code: 'live-checkpoint-blocked' });
    }
    return release;
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
    try {
        return await takeVerifiedSnapshot(options);
    }
    catch (error) {
        throw error instanceof CloneRefusal ? error : new CloneRefusal(toRefusal(error, 'snapshot-failed'));
    }
}
async function takeVerifiedSnapshot(options) {
    if (options.writersStopped !== true)
        refuse({ code: 'writers-not-stopped' });
    if (sizeOf(options.livePath) === null)
        refuse({ code: 'live-database-missing' });
    const releaseLive = holdLive(options.livePath);
    let dir = '';
    const dispose = () => (dir === '' ? undefined : rmSync(dir, { recursive: true, force: true }));
    try {
        dir = mkdtempSync(join(tmpdir(), 'db-kit-clone-'));
        const liveBefore = await stampLive(options.livePath);
        chmodSync(dir, 0o700);
        const path = join(dir, 'snapshot.db');
        try {
            (options.createSnapshotFile ?? defaultSnapshotFile)(options.livePath, path);
        }
        catch {
            return refuse({ code: 'snapshot-failed' });
        }
        const liveAfter = await stampLive(options.livePath);
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
    finally {
        releaseLive();
    }
}
