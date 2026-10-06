import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPostgres, type PostgresHandle } from '../postgres.js';
import { startThrowawayPostgres, type ThrowawayPostgres } from '../test-support/embedded-pg.js';
import { buildCodecs, type ColumnCodec } from './bound.js';
import { CodecError } from './errors.js';
import { introspectPostgres, introspectSqlite } from './introspect.js';
import { parseCodecManifest, type CodecManifestInput, type TableInput } from './manifest.js';
import { POSTGRES_CODEC_TYPES } from './pg-types.js';
import { validateManifest } from './validate.js';

type Spec = TableInput['columns'][string];
type Row = Record<string, unknown>;

const codecOf = (spec: Spec): ColumnCodec =>
  buildCodecs(parseCodecManifest({ version: 1, tables: { main: { columns: { id: { codec: 'integer', nullable: false }, col: spec }, primaryKey: ['id'] } } } satisfies CodecManifestInput)).column('main', 'col');

function errorOf(fn: () => unknown): CodecError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CodecError) return error;
    throw error;
  }
  throw new Error('expected a CodecError');
}

const MANIFEST = {
  version: 1,
  tables: {
    t: {
      primaryKey: ['id'],
      columns: {
        id: { codec: 'integer', nullable: false },
        ts: { codec: 'timestamp-naive', nullable: true },
        d: { codec: 'date-text', nullable: true },
        j_json: { codec: 'json-text', pgType: 'json', nullable: true },
        j_jsonb: { codec: 'json-text', pgType: 'jsonb', nullable: true },
        j_text: { codec: 'json-text', pgType: 'text', nullable: true },
      },
    },
  },
} satisfies CodecManifestInput;
const SQLITE_DDL = 'create table t (id integer primary key, ts text, d text, j_json text, j_jsonb text, j_text text)';
const PG_DDL = 'create table t (id bigint primary key, ts timestamp, d date, j_json json, j_jsonb jsonb, j_text text)';

const ROWS: Row[] = [
  { id: 1, ts: '2026-03-01 10:11:12', d: '2026-03-01', j_json: '{ "b": 1,  "a": 2 }', j_jsonb: '{"b":1,"a":2}', j_text: '{ "b": 1 }' },
  { id: 2, ts: '2026-03-01 10:11:12.123456', d: '0001-01-01', j_json: '[1.0,  2e0]', j_jsonb: '[1.0]', j_text: '"x"' },
  { id: 3, ts: '2026-03-01 10:11:12.5', d: '9999-12-31', j_json: null, j_jsonb: null, j_text: null },
  { id: 4, ts: '2024-02-29 23:59:59.000001', d: null, j_json: null, j_jsonb: null, j_text: null },
];

let server: ThrowawayPostgres;
let pg: PostgresHandle;
let dir: string;

beforeAll(async () => {
  server = await startThrowawayPostgres();
  pg = openPostgres(server.config, { applicationName: 'db-kit-fidash-codecs', codecSession: true });
  await pg.pool.query(PG_DDL);
  dir = mkdtempSync(join(tmpdir(), 'db-kit-fidash-codecs-'));
}, 180_000);
afterAll(async () => {
  await pg?.close();
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('timestamp-naive, date-text and json-text pgType through real SQLite and Postgres', () => {
  it('round-trips; microseconds survive Postgres; json keeps its exact text; canonical forms agree on both sides', async () => {
    const codecs = buildCodecs(parseCodecManifest(MANIFEST));
    const columns = codecs.copyColumns('t');
    const source = new Database(join(dir, 'source.db'));
    source.exec(SQLITE_DDL);
    const insert = source.prepare(`insert into t (${columns.join(',')}) values (${columns.map((c) => `@${c}`).join(',')})`);
    for (const row of ROWS) insert.run(row);
    const sourceRows = source.prepare<[], Row>('select * from t order by id').all();
    source.close();

    for (const row of sourceRows) {
      await pg.pool.query(`insert into t (${columns.join(',')}) values (${columns.map((_, i) => `$${i + 1}`).join(',')})`, columns.map((c) => codecs.column('t', c).toPostgres(row[c])));
    }
    const { rows: pgRows } = await pg.pool.query<Row>({ text: 'select * from t order by id', types: POSTGRES_CODEC_TYPES });

    // Raw text, microseconds intact, no Date objects.
    expect(pgRows.map((r) => r.ts)).toEqual(['2026-03-01 10:11:12', '2026-03-01 10:11:12.123456', '2026-03-01 10:11:12.5', '2024-02-29 23:59:59.000001']);
    expect(pgRows.map((r) => r.d)).toEqual(['2026-03-01', '0001-01-01', '9999-12-31', null]);
    // json stores its input verbatim (whitespace, key order, number spelling); jsonb normalises.
    expect(pgRows[0]?.j_json).toBe('{ "b": 1,  "a": 2 }');
    expect(pgRows[1]?.j_json).toBe('[1.0,  2e0]');
    expect(pgRows[0]?.j_jsonb).toBe('{"a": 2, "b": 1}');

    const target = new Database(join(dir, 'target.db'));
    target.exec(SQLITE_DDL);
    const write = target.prepare(`insert into t (${columns.join(',')}) values (${columns.map((c) => `@${c}`).join(',')})`);
    for (const row of pgRows) write.run(Object.fromEntries(columns.map((c) => [c, codecs.column('t', c).toSqlite(row[c])])));
    const targetRows = target.prepare<[], Row>('select * from t order by id').all();
    target.close();

    for (const [i, row] of sourceRows.entries()) {
      for (const column of columns) {
        const codec = codecs.column('t', column);
        const fromSource = codec.canonical(row[column], 'sqlite');
        expect(codec.canonical(pgRows[i]?.[column], 'postgres'), `pg ${column} row ${i}`).toBe(fromSource);
        expect(codec.canonical(targetRows[i]?.[column], 'sqlite'), `sqlite2 ${column} row ${i}`).toBe(fromSource);
      }
    }
    expect(codecs.column('t', 'ts').canonical('2026-03-01 10:11:12', 'sqlite')).toBe('2026-03-01T10:11:12.000000');
    // Both SQLite forms come back as the 6-digit form; everything else byte-identical.
    expect(targetRows.map((r) => r.ts)).toEqual(['2026-03-01 10:11:12.000000', '2026-03-01 10:11:12.123456', '2026-03-01 10:11:12.500000', '2024-02-29 23:59:59.000001']);
    expect(targetRows.map((r) => r.d)).toEqual(sourceRows.map((r) => r.d));
    expect(targetRows.map((r) => r.j_json)).toEqual(sourceRows.map((r) => r.j_json));
    expect(targetRows.map((r) => r.j_text)).toEqual(sourceRows.map((r) => r.j_text));
  });

  it('a one-microsecond or one-day difference stops the canonical forms agreeing', async () => {
    const ts = codecOf({ codec: 'timestamp-naive', nullable: false });
    const { rows } = await pg.pool.query<Row>({ text: 'select ts, d from t where id = 2', types: POSTGRES_CODEC_TYPES });
    expect(ts.canonical('2026-03-01 10:11:12.123456', 'sqlite')).toBe(ts.canonical(rows[0]?.ts, 'postgres'));
    expect(ts.canonical('2026-03-01 10:11:12.123457', 'sqlite')).not.toBe(ts.canonical(rows[0]?.ts, 'postgres'));
    const d = codecOf({ codec: 'date-text', nullable: false });
    expect(d.canonical('0001-01-02', 'sqlite')).not.toBe(d.canonical(rows[0]?.d, 'postgres'));
  });

  it('validateManifest accepts the real Postgres column types and refuses the wrong ones', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(SQLITE_DDL);
    const postgres = await introspectPostgres(pg.pool);
    expect(validateManifest(parseCodecManifest(MANIFEST), { sqlite: introspectSqlite(sqlite), postgres }).issues).toEqual([]);
    const wrong = parseCodecManifest({ version: 1, tables: { t: { primaryKey: ['id'], columns: { ...MANIFEST.tables.t.columns, ts: { codec: 'timestamp-naive', nullable: true }, d: { codec: 'date-text', nullable: true }, j_json: { codec: 'json-text', pgType: 'jsonb', nullable: true } } } } });
    // ts is timestamp (ok), j_json is json (declared jsonb)
    expect(validateManifest(wrong, { sqlite: introspectSqlite(sqlite), postgres }).issues.map((i) => `${i.code}:${i.column}`)).toEqual(['pg-type-mismatch:j_json']);
    expect(codecOf({ codec: 'timestamp-naive', nullable: true }).pgTypes).toEqual(['timestamp without time zone']);
    sqlite.close();
  });
});

describe('timestamp-naive refuses everything that is not exactly SQLAlchemy SQLite DATETIME text', () => {
  const codec = codecOf({ codec: 'timestamp-naive', nullable: false });
  const bad: unknown[] = [
    '2026-03-01T10:11:12', '2026-03-01 10:11:12Z', '2026-03-01 10:11:12+00:00', '2026-03-01 10:11:12.1234567', '2026-03-01 10:11:12.', '2026-03-01 10:11',
    '2026-02-30 10:11:12', '2026-03-01 24:00:00', '2026-03-01 10:60:00', ' 2026-03-01 10:11:12', '2026-03-01 10:11:12\n', 'infinity', '', '1772359872',
    1772359872, 1.5, 5n, Buffer.from('2026-03-01 10:11:12'), new Date(0),
  ];
  for (const value of bad) {
    it(`refuses ${typeof value === 'string' ? JSON.stringify(value) : typeof value} by table.column, never quoting the value`, () => {
      const error = errorOf(() => codec.toPostgres(value));
      expect(error.code).toBe('CODEC_INVALID');
      expect(error.message).toMatch(/^main\.col: /);
      if (typeof value === 'string' && value.length > 4) expect(error.message).not.toContain(value);
    });
  }
  it('Postgres-side bad text is refused too (infinity, a timestamptz spelling)', () => {
    for (const value of ['infinity', '-infinity', '2026-03-01 10:11:12+00', '2026-03-01 10:11:12 BC'] as const) expect(errorOf(() => codec.toSqlite(value)).code, value).toBe('CODEC_INVALID');
  });
  it('year 0000 is outside the supported range, refused as lossy by table.column', () => {
    expect(errorOf(() => codec.toPostgres('0000-01-01 00:00:00')).code).toBe('CODEC_LOSSY');
    expect(errorOf(() => codecOf({ codec: 'date-text', nullable: false }).toPostgres('0000-01-01')).message).toMatch(/^main\.col: /);
  });
  it('accepts 1 to 6 fractional digits and the bare 19-char form', () => {
    for (const [input, canonical] of [['2026-03-01 10:11:12', '2026-03-01T10:11:12.000000'], ['2026-03-01 10:11:12.1', '2026-03-01T10:11:12.100000'], ['2026-03-01 10:11:12.000001', '2026-03-01T10:11:12.000001']] as const) {
      expect(codec.canonical(input, 'sqlite')).toBe(canonical);
    }
  });
  it('has no preserveText switch', () => {
    expect(() => parseCodecManifest({ version: 1, tables: { t: { primaryKey: ['id'], columns: { id: { codec: 'integer', nullable: false }, c: { codec: 'timestamp-naive', preserveText: true, nullable: false } } } } })).toThrow(/preserveText|Unrecognized/);
  });
});

describe('date-text refuses everything that is not a calendar YYYY-MM-DD', () => {
  const codec = codecOf({ codec: 'date-text', nullable: false });
  for (const value of ['2026-02-30', '2026-13-01', '2026-3-1', '2026-03-01 00:00:00', '2026-03-01T00:00:00Z', '20260301', ' 2026-03-01', 'today', 20260301, new Date(0)]) {
    it(`refuses ${typeof value === 'string' ? JSON.stringify(value) : typeof value} by table.column`, () => {
      const error = errorOf(() => codec.toPostgres(value));
      expect(error.code).toBe('CODEC_INVALID');
      expect(error.message).toMatch(/^main\.col: /);
    });
  }
  it('refuses a Postgres-side value that is not plain text', () => {
    expect(errorOf(() => codec.toSqlite(new Date(0))).code).toBe('CODEC_INVALID');
  });
});

describe('json-text pgType', () => {
  it('maps pgType to the Postgres type; preserveText alone behaves as in 0.2.0', () => {
    const types = (spec: Spec): readonly string[] => codecOf(spec).pgTypes;
    expect(types({ codec: 'json-text', pgType: 'text', nullable: false })).toEqual(['text']);
    expect(types({ codec: 'json-text', pgType: 'json', nullable: false })).toEqual(['json']);
    expect(types({ codec: 'json-text', pgType: 'jsonb', nullable: false })).toEqual(['jsonb']);
    expect(types({ codec: 'json-text', nullable: false })).toEqual(['text']);
    expect(types({ codec: 'json-text', preserveText: true, nullable: false })).toEqual(['text']);
    expect(types({ codec: 'json-text', preserveText: false, nullable: false })).toEqual(['jsonb']);
    expect(types({ codec: 'json-text', preserveText: true, pgType: 'text', nullable: false })).toEqual(['text']);
    expect(types({ codec: 'json-text', preserveText: false, pgType: 'jsonb', nullable: false })).toEqual(['jsonb']);
  });

  it('a pgType that disagrees with preserveText is a manifest parse error', () => {
    for (const [preserveText, pgType] of [[true, 'jsonb'], [true, 'json'], [false, 'text'], [false, 'json']] as const) {
      expect(() => codecOf({ codec: 'json-text', preserveText, pgType, nullable: false }), `${preserveText}/${pgType}`).toThrow(/pgType and preserveText disagree/);
    }
  });

  it('jsonb normalises (compare via canonical); json and text compare the exact stored text', () => {
    const [text, json, jsonb] = (['text', 'json', 'jsonb'] as const).map((pgType) => codecOf({ codec: 'json-text', pgType, nullable: false }));
    expect(json?.canonical('{ "a":1 }', 'sqlite')).not.toBe(json?.canonical('{"a":1}', 'sqlite'));
    expect(text?.canonical('{ "a":1 }', 'sqlite')).not.toBe(text?.canonical('{"a":1}', 'sqlite'));
    expect(jsonb?.canonical('{ "a":1 }', 'sqlite')).toBe(jsonb?.canonical('{"a":1}', 'sqlite'));
  });

  for (const pgType of ['text', 'json', 'jsonb'] as const) {
    it(`pgType=${pgType}: NaN, Infinity and -Infinity tokens are CODEC_INVALID in both directions and in canonical`, () => {
      const codec = codecOf({ codec: 'json-text', pgType, nullable: false });
      for (const value of ['NaN', '[NaN]', '{"a": NaN}', 'Infinity', '[1, Infinity]', '{"a":-Infinity}', '[-Infinity]']) {
        expect(errorOf(() => codec.toPostgres(value)).code, value).toBe('CODEC_INVALID');
        expect(errorOf(() => codec.toSqlite(value)).code, value).toBe('CODEC_INVALID');
        expect(errorOf(() => codec.canonical(value, 'sqlite')).code, value).toBe('CODEC_INVALID');
      }
      expect(codec.toPostgres('{"a":"NaN"}')).toBe('{"a":"NaN"}');
    });
  }
});
