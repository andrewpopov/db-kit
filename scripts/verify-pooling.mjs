// Read-only compatibility probe for an operator-provided pool with two free server slots.
import assert from 'node:assert/strict';
import { openPostgres, parseDatabaseUrl } from '../dist/index.js';

const handles = [];
try {
  const url = process.env.POOLED_DATABASE_URL;
  assert(url, 'POOLED_DATABASE_URL is required');
  const config = parseDatabaseUrl(url);
  assert.equal(config.dialect, 'postgres');
  const first = openPostgres(config, { applicationName: 'db-kit-pool-verify-a', statementTimeoutMs: 11997, codecSession: true, poolSize: 1 });
  const second = openPostgres(config, { applicationName: 'db-kit-pool-verify-b', statementTimeoutMs: 21997, codecSession: true, poolSize: 1 });
  handles.push(first, second);
  assert.equal((await first.pool.query('SHOW statement_timeout')).rows[0].statement_timeout, '11997ms');
  assert.equal((await second.pool.query('SHOW statement_timeout')).rows[0].statement_timeout, '21997ms');
  assert.equal((await first.pool.query('SHOW statement_timeout')).rows[0].statement_timeout, '11997ms');
  for (const [setting, value] of [['TimeZone', 'UTC'], ['DateStyle', 'ISO, YMD'], ['bytea_output', 'hex'], ['extra_float_digits', '3']]) {
    assert.equal(Object.values((await first.pool.query(`SHOW ${setting}`)).rows[0])[0], value);
  }
  assert.equal((await first.pool.query({ name: 'db-kit-pool-verification', text: 'SELECT $1::integer AS value', values: [17] })).rows[0].value, 17);
  const transaction = await first.pool.connect();
  try { await transaction.query('BEGIN'); assert.equal((await transaction.query('SELECT $1::integer AS value', [23])).rows[0].value, 23); await transaction.query('COMMIT'); }
  finally { transaction.release(); }
  await second.close();
  assert.equal((await first.health()).ok, true);
  console.log('Pool verified: prepared query, transaction, startup settings, timeout isolation and health.');
} catch {
  console.error('Pool verification failed. Inspect configuration privately; db-kit startup settings require session pooling and two free server slots.');
  process.exitCode = 1;
} finally {
  await Promise.all(handles.map(handle => handle.close()));
}
