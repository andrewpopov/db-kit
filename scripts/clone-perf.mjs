#!/usr/bin/env node
/**
 * Clone throughput harness. Generates a synthetic SQLite database with a fidash-like shape (wide text rows, reals,
 * epoch-ms integers, ISO text, JSON text, foreign keys), then times plan and execute (snapshot + COPY load + FK re-add
 * + row-by-row verification + receipt + COMMIT) against an EMPTY Postgres database.
 *
 *   DB_KIT_TARGET_URL=postgres://user:pass@host:5432/scratchdb node scripts/clone-perf.mjs --gb 1 [--reset] [--dry-run] [--dir /path]
 *
 * It needs only node and this package (built: `npm run build`). It creates its own tables (perf_symbols, perf_quotes,
 * perf_news, perf_alerts) in schema public of the target and, with --reset, drops them first. Point it at a throwaway
 * database, never at one that matters. The target is treated as production by db-kit; this script passes the matching
 * --confirm-production itself.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import pg from 'pg';
import { parseDatabaseUrl } from '../dist/index.js';
import { executeClone, planClone } from '../dist/clone.js';
import { parseCodecManifest } from '../dist/index.js';

const { values } = parseArgs({ options: { gb: { type: 'string', default: '0.2' }, reset: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, dir: { type: 'string' }, keep: { type: 'boolean' } } });
const url = process.env.DB_KIT_TARGET_URL;
if (!url) {
  console.error('DB_KIT_TARGET_URL is required (a throwaway, empty database)');
  process.exit(2);
}
const gb = Number(values.gb);
const targetBytes = gb * 1024 ** 3;
const config = parseDatabaseUrl(url);
if (config.dialect !== 'postgres') throw new Error('DB_KIT_TARGET_URL must be a postgres URL');

const NEWS_ROW_BYTES = 1900;
const QUOTE_ROW_BYTES = 140;
const ALERT_ROW_BYTES = 260;
const newsRows = Math.max(1000, Math.floor((targetBytes * 0.6) / NEWS_ROW_BYTES));
const quoteRows = Math.max(1000, Math.floor((targetBytes * 0.32) / QUOTE_ROW_BYTES));
const alertRows = Math.max(1000, Math.floor((targetBytes * 0.08) / ALERT_ROW_BYTES));
const symbolRows = 500;

const workDir = values.dir ?? mkdtempSync(join(tmpdir(), 'db-kit-perf-'));
mkdirSync(workDir, { recursive: true });
const livePath = join(workDir, 'perf-live.db');
const t = () => performance.now();
const secs = (since) => ((performance.now() - since) / 1000).toFixed(1);

function generate() {
  const db = new Database(livePath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    create table perf_symbols(symbol text primary key, name text not null, active integer not null);
    create table perf_quotes(id integer primary key autoincrement, symbol text not null references perf_symbols(symbol), ts_ms integer not null, open real not null, high real not null, low real not null, close real not null, volume integer not null, meta text);
    create table perf_news(id integer primary key, symbol text not null references perf_symbols(symbol), headline text not null, body text not null, published text not null, sentiment real, raw text);
    create table perf_alerts(id integer primary key, symbol text not null, news_id integer references perf_news(id), kind text not null, created_ms integer not null, payload text);
  `);
  const fill = (sql) => db.exec(sql);
  fill(`with recursive n(i) as (select 1 union all select i + 1 from n where i < ${symbolRows}) insert into perf_symbols select 'SYM' || printf('%04d', i), 'Company ' || i, i % 2 from n`);
  fill(`with recursive n(i) as (select 1 union all select i + 1 from n where i < ${newsRows}) insert into perf_news
    select i, 'SYM' || printf('%04d', 1 + i % ${symbolRows}), 'Headline ' || i || ' ' || hex(randomblob(24)), hex(randomblob(800)),
           strftime('%Y-%m-%dT%H:%M:%SZ', 1700000000 + i * 17, 'unixepoch'), (i % 200) / 100.0 - 1, json_object('i', i, 'tags', json_array('a', 'b', hex(randomblob(6))), 'score', i * 0.25) from n`);
  fill(`with recursive n(i) as (select 1 union all select i + 1 from n where i < ${quoteRows}) insert into perf_quotes(symbol, ts_ms, open, high, low, close, volume, meta)
    select 'SYM' || printf('%04d', 1 + i % ${symbolRows}), 1700000000000 + i * 60000, 100 + (i % 97) * 0.37, 101 + (i % 89) * 0.41, 99 + (i % 83) * 0.29, 100 + (i % 79) * 0.33, i * 13 % 1000000, case when i % 5 = 0 then json_object('adj', i % 7) end from n`);
  fill(`with recursive n(i) as (select 1 union all select i + 1 from n where i < ${alertRows}) insert into perf_alerts
    select i, 'SYM' || printf('%04d', 1 + i % ${symbolRows}), case when i % 3 = 0 then null else 1 + i % ${newsRows} end, 'kind' || (i % 9), 1700000000000 + i * 1000, json_object('i', i, 'msg', hex(randomblob(60))) from n`);
  db.exec('analyze');
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}

const ddl = [
  'create table perf_symbols(symbol text primary key, name text not null, active boolean not null)',
  'create table perf_quotes(id bigint generated by default as identity primary key, symbol text not null references perf_symbols(symbol), ts_ms timestamptz not null, open double precision not null, high double precision not null, low double precision not null, close double precision not null, volume bigint not null, meta jsonb)',
  'create table perf_news(id bigint primary key, symbol text not null references perf_symbols(symbol), headline text not null, body text not null, published text not null, sentiment double precision, raw jsonb)',
  'create table perf_alerts(id bigint primary key, symbol text not null, news_id bigint references perf_news(id), kind text not null, created_ms timestamptz not null, payload jsonb)',
];
const nn = (codec, extra = {}) => ({ codec, nullable: false, ...extra });
const nullable = (codec, extra = {}) => ({ codec, nullable: true, ...extra });
const manifest = parseCodecManifest({
  version: 1,
  tables: {
    perf_symbols: { primaryKey: ['symbol'], columns: { symbol: nn('text'), name: nn('text'), active: nn('boolean') } },
    perf_quotes: { primaryKey: ['id'], columns: { id: nn('integer'), symbol: nn('text'), ts_ms: nn('timestamp-epoch-ms', { preserveInteger: false }), open: nn('real'), high: nn('real'), low: nn('real'), close: nn('real'), volume: nn('integer'), meta: nullable('json-text', { preserveText: false }) } },
    perf_news: { primaryKey: ['id'], columns: { id: nn('integer'), symbol: nn('text'), headline: nn('text'), body: nn('text'), published: nn('timestamp-iso'), sentiment: nullable('real'), raw: nullable('json-text', { preserveText: false }) } },
    perf_alerts: { primaryKey: ['id'], columns: { id: nn('integer'), symbol: nn('text'), news_id: nullable('integer'), kind: nn('text'), created_ms: nn('timestamp-epoch-ms', { preserveInteger: false }), payload: nullable('json-text', { preserveText: false }) } },
  },
});

let peakRss = 0;
const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 200);
try {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  if (values.reset) await admin.query('drop table if exists perf_alerts, perf_news, perf_quotes, perf_symbols cascade');
  for (const statement of ddl) await admin.query(statement);
  await admin.end();

  let started = t();
  generate();
  const bytes = statSync(livePath).size;
  console.log(`generated ${(bytes / 1e6).toFixed(0)} MB SQLite (${newsRows} news, ${quoteRows} quotes, ${alertRows} alerts) in ${secs(started)}s`);

  const options = { livePath, writersStopped: true, manifest, target: config, confirmProduction: `${config.host}:${config.port}/${config.database}` };
  started = t();
  const plan = await planClone(options);
  console.log(`plan (snapshot + scan + preflight) ${secs(started)}s ok=${plan.ok} refusals=${JSON.stringify(plan.refusals)}`);
  if (!plan.ok) process.exit(1);

  started = t();
  const result = await executeClone({
    ...options,
    dryRun: values['dry-run'] === true,
    onProgress: (e) => console.log(`  ${e.phase} ${e.table}: ${e.rows} rows ${e.seconds.toFixed(1)}s`),
  });
  const total = (performance.now() - started) / 1000;
  const rows = result.totals.rows;
  const loadSeconds = result.tables.reduce((s, x) => s + x.loadSeconds, 0);
  const verifySeconds = result.tables.reduce((s, x) => s + x.verifySeconds, 0);
  console.log(`${result.outcome}: ${rows} rows in ${total.toFixed(1)}s total (snapshot+preflight+load+FK+verify+commit)`);
  console.log(`  load ${loadSeconds.toFixed(1)}s = ${Math.round(rows / loadSeconds)} rows/s, ${(bytes / 1e6 / loadSeconds).toFixed(1)} MB/s of SQLite`);
  console.log(`  verify ${verifySeconds.toFixed(1)}s = ${Math.round(rows / verifySeconds)} rows/s`);
  console.log(`  peak RSS ${(peakRss / 1e6).toFixed(0)} MB`);
  console.log(`  extrapolated 3.6 GB: ~${((total * 3.6) / gb / 60).toFixed(1)} min`);
} finally {
  clearInterval(sampler);
  if (!values.keep && !values.dir) rmSync(workDir, { recursive: true, force: true });
}
