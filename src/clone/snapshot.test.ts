import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, copyFileSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { createSqliteSnapshot } from '@andrewpopov/db-backup';
import { liveSqlite, scratchDir } from '../test-support/clone-fixture.js';
import { CloneRefusal, type Refusal } from './errors.js';
import { liveUnchanged, takeSnapshot } from './snapshot.js';

const dir = scratchDir();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ROWS = ['create table items(id integer primary key, name text not null)', "insert into items values (1, 'a'), (2, 'b')"];

async function refusalOf(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CloneRefusal) return error.refusal;
    throw error;
  }
  throw new Error('expected a CloneRefusal');
}

/** A seam that copies for real, then lets the test act as the "concurrent writer" and returns where the copy went. */
function seam(afterCopy: (live: string) => void): { createSnapshotFile(source: string, destination: string): void; destination: () => string } {
  let where = '';
  return {
    createSnapshotFile(source, destination) {
      where = destination;
      createSqliteSnapshot({ sourcePath: source, destPath: destination });
      afterCopy(source);
    },
    destination: () => where,
  };
}


describe('takeSnapshot', () => {
  it('snapshots a stopped database into a private 0700 directory and records its sha256', async () => {
    const livePath = liveSqlite(dir, ROWS);
    const snapshot = await takeSnapshot({ livePath, writersStopped: true });
    try {
      expect(snapshot.sha256).toBe(createHash('sha256').update(readFileSync(snapshot.path)).digest('hex'));
      expect(statSync(dirname(snapshot.path)).mode & 0o777).toBe(0o700);
      expect(snapshot.bytes).toBe(statSync(snapshot.path).size);
      expect(snapshot.liveBefore).toEqual(snapshot.liveAfter);
      expect(snapshot.liveBefore.main.size).toBeGreaterThan(0n);
      expect(snapshot.liveBefore.main.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(snapshot.liveBefore.walBytes).toBe(0n);
    } finally {
      snapshot.dispose();
    }
    expect(existsSync(dirname(snapshot.path))).toBe(false);
    snapshot.dispose(); // idempotent
  });

  it('refuses without writersStopped: true, before reading anything', async () => {
    const livePath = liveSqlite(dir, ROWS);
    let called = false;
    const createSnapshotFile = (): void => void (called = true);
    expect(await refusalOf(() => takeSnapshot({ livePath, writersStopped: false, createSnapshotFile }))).toEqual({ code: 'writers-not-stopped' });
    expect(await refusalOf(() => takeSnapshot({ livePath, writersStopped: undefined as unknown as boolean, createSnapshotFile }))).toEqual({ code: 'writers-not-stopped' });
    expect(called).toBe(false);
  });

  it('refuses a live file that does not exist', async () => {
    expect(await refusalOf(() => takeSnapshot({ livePath: `${dir}/nope.db`, writersStopped: true }))).toEqual({ code: 'live-database-missing' });
  });

  it('refuses when the live main file changes while the snapshot runs, and removes the copy', async () => {
    const livePath = liveSqlite(dir, ROWS);
    const racing = seam((live) => appendFileSync(live, Buffer.alloc(4096)));
    expect(await refusalOf(() => takeSnapshot({ livePath, writersStopped: true, createSnapshotFile: racing.createSnapshotFile }))).toEqual({ code: 'live-changed-during-snapshot' });
    expect(existsSync(dirname(racing.destination()))).toBe(false);
  });

  it('refuses when only the mtime of the live file changes (same size)', async () => {
    const livePath = liveSqlite(dir, ROWS);
    const racing = seam((live) => {
      const fd = openSync(live, 'r+');
      writeSync(fd, readFileSync(live).subarray(0, 1), 0, 1, 0); // rewrite the first byte unchanged
      closeSync(fd);
    });
    expect(await refusalOf(() => takeSnapshot({ livePath, writersStopped: true, createSnapshotFile: racing.createSnapshotFile }))).toEqual({ code: 'live-changed-during-snapshot' });
  });

  it('refuses when a non-empty -wal appears while the snapshot runs, but ignores -shm (every reader touches it)', async () => {
    const wal = liveSqlite(dir, ROWS);
    const racingWal = seam((live) => writeFileSync(`${live}-wal`, 'x'));
    expect(await refusalOf(() => takeSnapshot({ livePath: wal, writersStopped: true, createSnapshotFile: racingWal.createSnapshotFile }))).toEqual({ code: 'live-changed-during-snapshot' });
    const shm = liveSqlite(dir, ROWS);
    const touchingShm = seam((live) => writeFileSync(`${live}-shm`, 'x'));
    const snapshot = await takeSnapshot({ livePath: shm, writersStopped: true, createSnapshotFile: touchingShm.createSnapshotFile });
    snapshot.dispose();
  });

  it('refuses when a -wal sidecar changes size while the snapshot runs', async () => {
    const livePath = liveSqlite(dir, ROWS);
    writeFileSync(`${livePath}-wal`, '');
    const racing = seam((live) => appendFileSync(`${live}-wal`, 'x'));
    expect(await refusalOf(() => takeSnapshot({ livePath, writersStopped: true, createSnapshotFile: racing.createSnapshotFile }))).toEqual({ code: 'live-changed-during-snapshot' });
  });

  it('refuses a UTF-16 database', async () => {
    const livePath = liveSqlite(dir, ['create table items(id integer primary key, name text)', "insert into items values (1, 'a')"], ["encoding = 'UTF-16le'"]);
    const refusal = await refusalOf(() => takeSnapshot({ livePath, writersStopped: true }));
    expect(refusal).toEqual({ code: 'snapshot-not-utf8' });
  });

  it('refuses a snapshot that fails integrity_check', async () => {
    const livePath = liveSqlite(dir, ['create table items(id integer primary key, name text)', 'create index by_name on items(name)', "with recursive n(i) as (select 1 union all select i + 1 from n where i < 2000) insert into items select i, 'name' || i from n"]);
    const corrupting = seam(() => undefined);
    const corrupt = (source: string, destination: string): void => {
      corrupting.createSnapshotFile(source, destination);
      const fd = openSync(destination, 'r+');
      writeSync(fd, Buffer.alloc(2048, 0xff), 0, 2048, 4096 * 2); // trash an index/table page
      closeSync(fd);
    };
    expect(await refusalOf(() => takeSnapshot({ livePath, writersStopped: true, createSnapshotFile: corrupt }))).toEqual({ code: 'snapshot-integrity-failed' });
    expect(existsSync(dirname(corrupting.destination()))).toBe(false);
  });

  it('refuses a snapshot whose integrity_check reports a problem without throwing (an orphaned index page)', async () => {
    const livePath = liveSqlite(dir, ['create table items(id integer primary key, name text)', 'create index by_name on items(name)', "insert into items values (1, 'a'), (2, 'b')"]);
    execFileSync('sqlite3', [livePath, '.dbconfig defensive off', "pragma writable_schema = on; delete from sqlite_master where type = 'index' and name = 'by_name';"]);
    // db-backup's own check already throws on this file; a plain copy isolates clone's second check.
    const plainCopy = (source: string, destination: string): void => copyFileSync(source, destination);
    expect(await refusalOf(() => takeSnapshot({ livePath, writersStopped: true, createSnapshotFile: plainCopy }))).toEqual({ code: 'snapshot-integrity-failed' });
    expect(await refusalOf(() => takeSnapshot({ livePath, writersStopped: true }))).toEqual({ code: 'snapshot-failed' });
  });

  it('refuses a snapshot whose foreign_key_check finds an orphan, naming the table', async () => {
    const livePath = liveSqlite(dir, [
      'create table parent(id integer primary key)',
      'create table child(id integer primary key, parent_id integer references parent(id))',
      'insert into child values (1, 99)',
    ], ['foreign_keys = off']);
    expect(await refusalOf(() => takeSnapshot({ livePath, writersStopped: true }))).toEqual({ code: 'snapshot-foreign-key-violation', table: 'child' });
  });

  it('removes its temp directory when the snapshot primitive throws', async () => {
    const livePath = liveSqlite(dir, ROWS);
    let where = '';
    const failing = (_source: string, destination: string): void => {
      where = destination;
      throw new Error('sqlite3 exploded: /secret/path');
    };
    const refusal = await refusalOf(() => takeSnapshot({ livePath, writersStopped: true, createSnapshotFile: failing }));
    expect(refusal).toEqual({ code: 'snapshot-failed' });
    expect(existsSync(dirname(where))).toBe(false);
  });
});

describe('live databases in WAL mode', () => {
  const rowsIn = (path: string): number => {
    const db = new Database(path, { readonly: true });
    try {
      return (db.prepare('select count(*) as n from items').get() as { n: number }).n;
    } finally {
      db.close();
    }
  };

  /** A WAL database stopped with its -wal still on disk: copy main + -wal while a writer holds it, then let the writer go. */
  function stoppedWithWal(): string {
    const source = liveSqlite(dir, ['create table items(id integer primary key, name text not null)'], ['journal_mode = wal']);
    const writer = new Database(source);
    writer.pragma('wal_autocheckpoint = 0');
    writer.exec("insert into items values (1, 'a'), (2, 'b'), (3, 'c')");
    const copy = `${source}.stopped.db`;
    copyFileSync(source, copy);
    copyFileSync(`${source}-wal`, `${copy}-wal`);
    writer.close();
    return copy;
  }

  it('checkpoints a non-empty -wal first, so the snapshot holds the WAL-only rows and the stamps agree', async () => {
    const livePath = stoppedWithWal();
    expect(statSync(`${livePath}-wal`).size).toBeGreaterThan(0);
    const snapshot = await takeSnapshot({ livePath, writersStopped: true });
    try {
      expect(rowsIn(snapshot.path)).toBe(3);
      expect(snapshot.liveBefore.walBytes).toBe(0n);
      expect(snapshot.liveBefore).toEqual(snapshot.liveAfter);
    } finally {
      snapshot.dispose();
    }
  });

  it('refuses a writer that commits while the snapshot runs', async () => {
    const livePath = stoppedWithWal();
    const racing = seam((live) => {
      const writer = new Database(live);
      writer.pragma('wal_autocheckpoint = 0');
      writer.exec("insert into items values (99, 'late')");
      writer.pragma('journal_mode'); // keep the connection's -wal frames on disk until after the stamp
      lateWriter = writer;
    });
    let lateWriter: Database.Database | undefined;
    try {
      expect(await refusalOf(() => takeSnapshot({ livePath, writersStopped: true, createSnapshotFile: racing.createSnapshotFile }))).toEqual({ code: 'live-changed-during-snapshot' });
    } finally {
      lateWriter?.close();
    }
  });

  it('refuses by name when a held read transaction blocks the checkpoint', async () => {
    const source = liveSqlite(dir, ['create table items(id integer primary key, name text not null)', "insert into items values (1, 'a')"], ['journal_mode = wal']);
    const writer = new Database(source);
    writer.pragma('wal_autocheckpoint = 0');
    const reader = new Database(source);
    reader.exec('begin');
    reader.prepare('select * from items').all();
    writer.exec("insert into items values (2, 'b')"); // past the reader's snapshot: TRUNCATE cannot finish
    try {
      expect(await refusalOf(() => takeSnapshot({ livePath: source, writersStopped: true }))).toEqual({ code: 'live-checkpoint-blocked' });
    } finally {
      reader.close();
      writer.close();
    }
  });
});

describe('liveUnchanged', () => {
  const base = { main: { size: 10n, mtimeNs: 5n, sha256: 'a'.repeat(64) }, walBytes: 0n };
  it('compares size, mtime, main-file sha256 and -wal size, each on its own', () => {
    expect(liveUnchanged(base, structuredClone(base))).toBe(true);
    expect(liveUnchanged(base, { ...base, main: { ...base.main, size: 11n } })).toBe(false);
    expect(liveUnchanged(base, { ...base, main: { ...base.main, mtimeNs: 6n } })).toBe(false);
    expect(liveUnchanged(base, { ...base, main: { ...base.main, sha256: 'b'.repeat(64) } })).toBe(false);
    expect(liveUnchanged(base, { ...base, walBytes: 1n })).toBe(false);
  });
});
