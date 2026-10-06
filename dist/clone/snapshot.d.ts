/**
 * What our own reads cannot disturb: the main file's size, mtime and sha256, and the `-wal` size (absent and empty
 * are the same, `0n`). `-shm` is ignored on purpose: every reader of a WAL database touches it.
 */
export interface LiveStamp {
    main: {
        size: bigint;
        mtimeNs: bigint;
        sha256: string;
    };
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
export declare function stampLive(livePath: string): Promise<LiveStamp>;
export declare function liveUnchanged(before: LiveStamp, after: LiveStamp): boolean;
/**
 * Snapshot a stopped live SQLite database into a private temp directory and verify the copy. Refuses (typed
 * `CloneRefusal`) without `writersStopped`, if the live file or its `-wal`/`-shm` changed size or mtime while the
 * snapshot ran, or if the copy fails integrity, foreign-key or encoding checks. The temp directory is removed on
 * every failing path; on success the caller owns `dispose()`.
 */
export declare function takeSnapshot(options: SnapshotOptions): Promise<Snapshot>;
