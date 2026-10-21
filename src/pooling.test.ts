import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { renderPgBouncer, runtimeDatabaseUrl } from './pooling.js';
import { runPoolCli } from './pooling-cli.js';

const direct = 'postgresql://app:secret@database.example:5432/app?sslmode=require&connection_limit=4';
const pooled = 'postgresql://app:secret@127.0.0.1:6432/app?sslmode=disable&connection_limit=4';
const database = { name: 'app', url: direct };

describe('shared runtime routing', () => {
  it('requires a pool by default, preserves SQLite, and routes dedicated operations directly', () => {
    const env = { DATABASE_URL: direct, POOLED_DATABASE_URL: pooled };
    expect(runtimeDatabaseUrl(env)).toBe(pooled);
    for (const purpose of ['migration', 'backup', 'session'] as const) expect(runtimeDatabaseUrl(env, { purpose })).toBe(direct);
    expect(runtimeDatabaseUrl({ DATABASE_URL: 'file:./app.db', POOLED_DATABASE_URL: pooled })).toBe('file:./app.db');
    expect(() => runtimeDatabaseUrl({ DATABASE_URL: direct })).toThrow('POOLED_DATABASE_URL is required');
    expect(runtimeDatabaseUrl({ DATABASE_URL: direct }, { pooling: 'preferred' })).toBe(direct);
    expect(runtimeDatabaseUrl(env, { pooling: 'off' })).toBe(direct);
  });
  it('refuses a pool that changes database identity or credentials without leaking either URL', () => {
    for (const url of [pooled.replace('/app?', '/other?'), pooled.replace('app:secret', 'other:secret'), pooled.replace('secret', 'private-password')]) {
      try { runtimeDatabaseUrl({ DATABASE_URL: direct, POOLED_DATABASE_URL: url }); throw new Error('expected refusal'); }
      catch (error) { expect(String(error)).toContain('preserve'); expect(String(error)).not.toContain('secret'); expect(String(error)).not.toContain('private-password'); }
    }
    expect(() => runtimeDatabaseUrl({ DATABASE_URL: direct + '&schema=private', POOLED_DATABASE_URL: pooled })).toThrow('schema');
  });
});

describe('PgBouncer renderer', () => {
  it('bounds server connections, keeps upstream TLS and tracks db-kit startup settings', () => {
    const result = renderPgBouncer({ databases: [database, { name: 'other', url: direct.replaceAll('app', 'other'), mode: 'session' }], serverConnectionBudget: 14 });
    expect(result.serverConnectionCap).toBe(14);
    expect(result.config).toContain('listen_addr = 127.0.0.1');
    expect(result.config).toContain('server_tls_sslmode = require');
    expect(result.config).toContain('max_prepared_statements = 100');
    expect(result.config).toContain('track_extra_parameters = statement_timeout,bytea_output,extra_float_digits');
    expect(result.config).toContain('pool_mode=session');
    expect(result.config).not.toContain('secret');
    expect(result.auth).toContain('"app" "secret"');
    expect(result.runtimeUrls.app).toBe(pooled);
  });
  it('refuses over-budget configurations, aliases, conflicting roles and TLS downgrades', () => {
    expect(() => renderPgBouncer({ databases: [database], serverConnectionBudget: 6 })).toThrow('budget');
    expect(() => renderPgBouncer({ databases: [database, database], serverConnectionBudget: 20 })).toThrow('unique');
    expect(() => renderPgBouncer({ databases: [{ ...database, name: 'alias' }], serverConnectionBudget: 20 })).toThrow('matching');
    expect(() => renderPgBouncer({ databases: [database, { name: 'other', url: direct.replace('/app?', '/other?').replace('secret', 'different') }], serverConnectionBudget: 20 })).toThrow('Conflicting credentials');
    expect(() => renderPgBouncer({ databases: [database, { name: 'other', url: direct.replace('/app?', '/other?').replace('require', 'disable') }], serverConnectionBudget: 20 })).toThrow('TLS modes');
    expect(() => renderPgBouncer({ databases: [{ ...database, url: direct.replace('require', 'verify-full') }], serverConnectionBudget: 7 })).toThrow('CA file');
  });
  it('round trips percent-encoded credentials and quotes auth-file values safely', () => {
    const password = 'a%40"b\\c';
    const url = `postgresql://app:${encodeURIComponent(password)}@database.example/app?sslmode=require`;
    const result = renderPgBouncer({ databases: [{ name: 'app', url }], serverConnectionBudget: 7 });
    expect(decodeURIComponent(new URL(result.runtimeUrls.app).password)).toBe(password);
    expect(result.auth).toContain('a%40""b\\c');
    expect(runtimeDatabaseUrl({ DATABASE_URL: url, POOLED_DATABASE_URL: result.runtimeUrls.app })).toBe(result.runtimeUrls.app);
    expect(() => renderPgBouncer({ databases: [database], serverConnectionBudget: 7, authFile: '/tmp/users\nmalicious' })).toThrow();
  });
});

describe('pool CLI', () => {
  it('plans without writing secrets, renders private files, refuses overwrite and redacts errors', () => {
    const directory = mkdtempSync(join(tmpdir(), 'db-kit-pool-'));
    try {
      const config = join(directory, 'manifest.json');
      const output = join(directory, 'rendered');
      writeFileSync(config, JSON.stringify({ databases: [{ name: 'app', urlEnv: 'APP_DATABASE_URL' }], serverConnectionBudget: 7 }));
      const messages: string[] = [];
      const io = { out: (value: string) => messages.push(value), err: (value: string) => messages.push(value) };
      const env = { APP_DATABASE_URL: direct };
      expect(runPoolCli(['plan', '--config', config], env, io)).toBe(0);
      expect(runPoolCli(['render', '--config', config, '--output-dir', output], env, io)).toBe(0);
      expect(statSync(output).mode & 0o777).toBe(0o700);
      for (const file of ['pgbouncer.ini', 'users.txt', 'runtime.json']) expect(statSync(join(output, file)).mode & 0o777).toBe(0o600);
      const before = readFileSync(join(output, 'users.txt'), 'utf8');
      expect(runPoolCli(['render', '--config', config, '--output-dir', output], env, io)).toBe(1);
      expect(readFileSync(join(output, 'users.txt'), 'utf8')).toBe(before);
      expect(runPoolCli(['plan', '--config', config], { APP_DATABASE_URL: 'malformed-secret' }, io)).toBe(1);
      expect(messages.join('')).not.toContain('secret');
      expect(messages.join('')).not.toContain(direct);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
