import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Client } from 'pg';
import { parseCodecManifest, type CodecManifest, type CodecManifestInput } from '../codecs/manifest.js';
import type { PostgresConfig } from '../url.js';
import type { ThrowawayPostgres } from './embedded-pg.js';

let counter = 0;

/** A scratch directory for live SQLite files; remove with `rmSync` in `afterAll`. */
export function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'db-kit-clone-test-'));
}

/** A real live SQLite file built from `statements`, closed cleanly (no `-wal`/`-shm` left behind). */
export function liveSqlite(dir: string, statements: readonly string[], pragmas: readonly string[] = []): string {
  const path = join(dir, `live-${++counter}.db`);
  mkdirSync(dir, { recursive: true });
  const db = new Database(path);
  for (const pragma of pragmas) db.pragma(pragma);
  for (const statement of statements) db.exec(statement);
  db.close();
  return path;
}

export const manifestOf = (input: CodecManifestInput): CodecManifest => parseCodecManifest(input);

export interface TargetDatabase {
  config: PostgresConfig;
  /** Superuser connection to the target database, for building the offending object under test. */
  admin: Client;
  close(): Promise<void>;
}

/** Create a fresh database on the throwaway server, run `ddl` in it as the superuser (`{db}` is replaced by its name), and connect. */
export async function targetDatabase(server: ThrowawayPostgres, ddl: readonly string[]): Promise<TargetDatabase> {
  const name = `clone_t${++counter}`;
  const root = new Client({ ...server.config, ssl: false });
  await root.connect();
  await root.query(`create database ${name}`);
  await root.end();
  const config: PostgresConfig = { ...server.config, database: name };
  const admin = new Client({ host: config.host, port: config.port, user: config.user, password: config.password, database: name, ssl: false });
  admin.on('error', () => undefined); // the server may be stopped under an idle admin connection
  await admin.connect();
  for (const statement of ddl) await admin.query(statement.replaceAll('{db}', name));
  return { config, admin, close: () => admin.end() };
}
