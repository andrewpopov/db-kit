import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteExportApp } from './export-sqlite.js';

const exportToSqlite = vi.hoisted(() => vi.fn());
vi.mock('./export-sqlite.js', async (original) => ({ ...(await original<typeof import('./export-sqlite.js')>()), exportToSqlite }));

const { runExportSqliteCli } = await import('./export-cli.js');

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBprivateCA\n-----END CERTIFICATE-----\n';
const ENV_PEM = '-----BEGIN CERTIFICATE-----\nMIIBfromEnvFile\n-----END CERTIFICATE-----\n';
const app = {} as SqliteExportApp;
const urlWith = (sslmode: string): string => `postgres://u:fixture-secret-x9q@db.internal:5432/app?sslmode=${sslmode}`;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'export-cli-tls-'));
  mkdirSync(join(dir, 'ca'));
  writeFileSync(join(dir, 'ca', 'ca.pem'), PEM);
  writeFileSync(join(dir, 'ca', 'env-ca.pem'), ENV_PEM);
  writeFileSync(join(dir, 'ca', 'not-pem.txt'), 'hello');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  exportToSqlite.mockReset();
  exportToSqlite.mockResolvedValue({ outcome: 'written', path: 'x', receiptPath: 'x.receipt.json', tables: [], totals: { rows: 0 }, sequences: 0, warnings: [], templateRowsCleared: [] });
});

async function run(env: NodeJS.ProcessEnv, opts: { tlsCaFileEnv?: string } = {}, extra: string[] = []): Promise<{ code: number; err: string }> {
  let err = '';
  const code = await runExportSqliteCli(['export-sqlite', join(dir, 'out.db'), '--writers-stopped', ...extra], { out: () => undefined, err: (t) => void (err += t) }, env, app, opts);
  return { code, err };
}
const refusalOf = (err: string): { code: string } => (JSON.parse(err) as { refusal: { code: string } }).refusal;
const calledWith = (): Record<string, unknown> => exportToSqlite.mock.calls[0]?.[0] as Record<string, unknown>;

describe('runExportSqliteCli tlsCaFileEnv', () => {
  it('passes the CA file named by the env var to exportToSqlite as tlsCa', async () => {
    const result = await run({ DATABASE_URL: urlWith('verify-full'), PG_CA: join(dir, 'ca', 'ca.pem') }, { tlsCaFileEnv: 'PG_CA' });
    expect(result).toEqual({ code: 0, err: '' });
    expect(calledWith().tlsCa).toBe(PEM);
  });

  it('reads the CA path from --env-file, which wins over the environment', async () => {
    const envFile = join(dir, 'app.env');
    writeFileSync(envFile, `DATABASE_URL=${urlWith('verify-full')}&connection_limit=5\nPG_CA=${join(dir, 'ca', 'env-ca.pem')}\n`);
    const result = await run({ PG_CA: join(dir, 'ca', 'ca.pem') }, { tlsCaFileEnv: 'PG_CA' }, ['--env-file', envFile]);
    expect(result).toEqual({ code: 0, err: '' });
    expect(calledWith().tlsCa).toBe(ENV_PEM);
  });

  it('refuses tls-ca-unreadable naming the variable and path when the file cannot be read', async () => {
    const missing = join(dir, 'ca', 'nope.pem');
    const result = await run({ DATABASE_URL: urlWith('verify-full'), PG_CA: missing }, { tlsCaFileEnv: 'PG_CA' });
    expect(result.code).toBe(1);
    expect(refusalOf(result.err).code).toBe('tls-ca-unreadable');
    expect(result.err).toContain('PG_CA');
    expect(result.err).toContain(missing);
    expect(exportToSqlite).not.toHaveBeenCalled();
  });

  it('refuses tls-ca-unreadable for a file with no PEM certificate, without echoing its contents', async () => {
    const result = await run({ DATABASE_URL: urlWith('verify-full'), PG_CA: join(dir, 'ca', 'not-pem.txt') }, { tlsCaFileEnv: 'PG_CA' });
    expect(result.code).toBe(1);
    expect(refusalOf(result.err).code).toBe('tls-ca-unreadable');
    expect(result.err).not.toContain('hello');
    expect(exportToSqlite).not.toHaveBeenCalled();
  });

  it.each(['verify-full', 'verify-ca'])('refuses tls-ca-missing for a %s URL when the variable is unset', async (sslmode) => {
    const result = await run({ DATABASE_URL: urlWith(sslmode) }, { tlsCaFileEnv: 'PG_CA' });
    expect(result.code).toBe(1);
    expect(refusalOf(result.err).code).toBe('tls-ca-missing');
    expect(exportToSqlite).not.toHaveBeenCalled();
  });

  it('does not refuse a require URL with the variable unset, and passes no tlsCa', async () => {
    const result = await run({ DATABASE_URL: urlWith('require') }, { tlsCaFileEnv: 'PG_CA' });
    expect(result).toEqual({ code: 0, err: '' });
    expect(calledWith()).not.toHaveProperty('tlsCa');
  });

  it('without the option, a CA variable in the environment is ignored and the call carries no tlsCa', async () => {
    const result = await run({ DATABASE_URL: urlWith('verify-full'), PG_CA: join(dir, 'ca', 'ca.pem') });
    expect(result).toEqual({ code: 0, err: '' });
    expect(calledWith()).not.toHaveProperty('tlsCa');
    expect(Object.keys(calledWith()).sort()).toEqual(['app', 'dryRun', 'source', 'toSqlitePath', 'writersStopped']);
  });
});
