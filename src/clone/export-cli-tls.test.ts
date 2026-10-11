import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteExportApp } from './export-sqlite.js';

const exportToSqlite = vi.hoisted(() => vi.fn());
vi.mock('./export-sqlite.js', async (original) => ({ ...(await original<typeof import('./export-sqlite.js')>()), exportToSqlite }));

const { runExportSqliteCli } = await import('./export-cli.js');

let PEM = '';
let ENV_PEM = '';
const MARKERS_ONLY = '-----BEGIN CERTIFICATE-----\nnot-a-certificate\n-----END CERTIFICATE-----\n';

/** A real self-signed certificate (EC, one day), so the CLI's X509 parse is exercised on something valid. */
function selfSigned(folder: string, name: string): string {
  const key = join(folder, `${name}.key`);
  const cert = join(folder, `${name}.pem`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-subj', `/CN=${name}`, '-days', '1'], { stdio: 'ignore' });
  return readFileSync(cert, 'utf8');
}
const app = {} as SqliteExportApp;
const urlWith = (sslmode: string): string => `postgres://u:fixture-secret-x9q@db.internal:5432/app?sslmode=${sslmode}`;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'export-cli-tls-'));
  mkdirSync(join(dir, 'ca'));
  PEM = selfSigned(join(dir, 'ca'), 'private-ca');
  ENV_PEM = selfSigned(join(dir, 'ca'), 'env-file-ca');
  writeFileSync(join(dir, 'ca', 'markers-only.pem'), MARKERS_ONLY);
  writeFileSync(join(dir, 'ca', 'bundle.pem'), `${MARKERS_ONLY}${PEM}`);
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
    const result = await run({ DATABASE_URL: urlWith('verify-full'), PG_CA: join(dir, 'ca', 'private-ca.pem') }, { tlsCaFileEnv: 'PG_CA' });
    expect(result).toEqual({ code: 0, err: '' });
    expect(calledWith().tlsCa).toBe(PEM);
  });

  it('reads the CA path from --env-file, which wins over the environment', async () => {
    const envFile = join(dir, 'app.env');
    writeFileSync(envFile, `DATABASE_URL=${urlWith('verify-full')}&connection_limit=5\nPG_CA=${join(dir, 'ca', 'env-file-ca.pem')}\n`);
    const result = await run({ PG_CA: join(dir, 'ca', 'private-ca.pem') }, { tlsCaFileEnv: 'PG_CA' }, ['--env-file', envFile]);
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
    const result = await run({ DATABASE_URL: urlWith('verify-full'), PG_CA: join(dir, 'ca', 'private-ca.pem') });
    expect(result).toEqual({ code: 0, err: '' });
    expect(calledWith()).not.toHaveProperty('tlsCa');
    expect(Object.keys(calledWith()).sort()).toEqual(['app', 'dryRun', 'source', 'toSqlitePath', 'writersStopped']);
  });

  it('refuses tls-ca-unreadable for a file that only has PEM markers around garbage', async () => {
    const result = await run({ DATABASE_URL: urlWith('verify-full'), PG_CA: join(dir, 'ca', 'markers-only.pem') }, { tlsCaFileEnv: 'PG_CA' });
    expect(result.code).toBe(1);
    expect(refusalOf(result.err).code).toBe('tls-ca-unreadable');
    expect(result.err).not.toContain('not-a-certificate');
    expect(exportToSqlite).not.toHaveBeenCalled();
  });

  it('accepts a bundle when at least one block is a real certificate, passing the file as is', async () => {
    const result = await run({ DATABASE_URL: urlWith('verify-full'), PG_CA: join(dir, 'ca', 'bundle.pem') }, { tlsCaFileEnv: 'PG_CA' });
    expect(result).toEqual({ code: 0, err: '' });
    expect(calledWith().tlsCa).toBe(`${MARKERS_ONLY}${PEM}`);
  });

  it('never echoes inline PEM held in the variable (a quoted multiline env-file value)', async () => {
    const envFile = join(dir, 'inline.env');
    writeFileSync(envFile, `DATABASE_URL=${urlWith('verify-full')}\nPG_CA="${PEM}"\n`);
    const result = await run({}, { tlsCaFileEnv: 'PG_CA' }, ['--env-file', envFile]);
    expect(result.code).toBe(1);
    expect(refusalOf(result.err).code).toBe('tls-ca-unreadable');
    expect(result.err).toContain('PG_CA is not a file path');
    expect(result.err).not.toContain('MII');
    expect(result.err).not.toContain('BEGIN');
    expect(exportToSqlite).not.toHaveBeenCalled();
  });

  it.each(['verify-full', 'require'])('treats an explicitly empty CA value as unset (%s)', async (sslmode) => {
    const result = await run({ DATABASE_URL: urlWith(sslmode), PG_CA: '' }, { tlsCaFileEnv: 'PG_CA' });
    if (sslmode === 'verify-full') {
      expect(refusalOf(result.err).code).toBe('tls-ca-missing');
    } else {
      expect(result).toEqual({ code: 0, err: '' });
      expect(calledWith()).not.toHaveProperty('tlsCa');
    }
  });

  it.each(['lacks the CA', 'sets the CA empty'])('--env-file wins like the URL does: a file that %s is unset even when the environment supplies one', async (shape) => {
    const envFile = join(dir, 'no-ca.env');
    writeFileSync(envFile, `DATABASE_URL=${urlWith('verify-full')}\n${shape === 'sets the CA empty' ? 'PG_CA=\n' : ''}`);
    const result = await run({ PG_CA: join(dir, 'ca', 'private-ca.pem') }, { tlsCaFileEnv: 'PG_CA' }, ['--env-file', envFile]);
    expect(result.code).toBe(1);
    expect(refusalOf(result.err).code).toBe('tls-ca-missing');
    expect(exportToSqlite).not.toHaveBeenCalled();
  });

  it('still redacts the environment URL password in a message when the env file does not set the URL', async () => {
    const envFile = join(dir, 'fixture-secret-x9q.env');
    writeFileSync(envFile, 'OTHER=1\n');
    const result = await run({ DATABASE_URL: urlWith('require') }, {}, ['--env-file', envFile]);
    expect(result.code).toBe(1);
    expect(refusalOf(result.err).code).toBe('source-url-missing');
    expect(result.err).not.toContain('fixture-secret-x9q');
    expect(result.err).toContain(`${dir}/[redacted].env does not set DATABASE_URL`);
  });

  it('without the option, an env file supplies the URL exactly as before (no tlsCa, same call keys)', async () => {
    const envFile = join(dir, 'plain.env');
    writeFileSync(envFile, `DATABASE_URL=${urlWith('require')}&connection_limit=5\nPG_CA=${join(dir, 'ca', 'private-ca.pem')}\n`);
    const result = await run({}, {}, ['--env-file', envFile]);
    expect(result).toEqual({ code: 0, err: '' });
    expect(Object.keys(calledWith()).sort()).toEqual(['app', 'dryRun', 'source', 'toSqlitePath', 'writersStopped']);
  });
});
