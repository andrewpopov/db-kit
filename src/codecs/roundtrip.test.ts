import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPostgres, type PostgresHandle } from '../postgres.js';
import { startThrowawayPostgres, type ThrowawayPostgres } from '../test-support/embedded-pg.js';
import { buildCodecs, type ManifestCodecs } from './bound.js';
import { parseCodecManifest, type CodecManifestInput } from './manifest.js';
import { POSTGRES_CODEC_TYPES } from './pg-types.js';

const MANIFEST = {
  version: 1,
  tables: {
    t: {
      primaryKey: ['id'],
      columns: {
        id: { codec: 'integer', nullable: false },
        txt: { codec: 'text', nullable: true },
        n: { codec: 'integer', nullable: true },
        big: { codec: 'bigint', nullable: true },
        real: { codec: 'real', nullable: true },
        dec: { codec: 'decimal-as-string', nullable: true },
        flag: { codec: 'boolean', nullable: true },
        iso_keep: { codec: 'timestamp-iso', preserveText: true, nullable: true },
        iso_conv: { codec: 'timestamp-iso', preserveText: false, nullable: true },
        epoch_s: { codec: 'timestamp-epoch-s', preserveInteger: false, nullable: true },
        epoch_ms: { codec: 'timestamp-epoch-ms', preserveInteger: false, nullable: true },
        epoch_ms_keep: { codec: 'timestamp-epoch-ms', preserveInteger: true, nullable: true },
        json_conv: { codec: 'json-text', preserveText: false, nullable: true },
        json_keep: { codec: 'json-text', preserveText: true, nullable: true },
        bin: { codec: 'blob', nullable: true },
        uid: { codec: 'uuid-text', nullable: true },
      },
    },
  },
} satisfies CodecManifestInput;

const SQLITE_DDL = `create table t (id integer primary key, txt text, n integer, big integer, real real, dec text, flag integer,
  iso_keep text, iso_conv text, epoch_s integer, epoch_ms integer, epoch_ms_keep integer, json_conv text, json_keep text, bin blob, uid text)`;
const PG_DDL = `create table t (id bigint primary key, txt text, n bigint, big bigint, real double precision, dec numeric, flag boolean,
  iso_keep text, iso_conv timestamptz, epoch_s timestamptz, epoch_ms timestamptz, epoch_ms_keep bigint, json_conv jsonb, json_keep text, bin bytea, uid uuid)`;

type Row = Record<string, unknown>;

const ROWS: Row[] = [
  {
    id: 1, txt: 'héllo', n: 42, big: 2n ** 62n, real: 1.5, dec: '12345678901234567890.123456789', flag: 1,
    iso_keep: '2024-03-01 10:00:00+02:00', iso_conv: '2024-03-01T10:00:00.123456+02:00', epoch_s: 1709280000, epoch_ms: 1709280000123,
    epoch_ms_keep: 1709280000123, json_conv: '{"b":1,"a":2}', json_keep: '{ "b": 1,  "a": 2 }', bin: Buffer.from([0, 1, 2, 255]),
    uid: '123E4567-E89B-12D3-A456-426614174000',
  },
  {
    id: 2, txt: '', n: -7, big: -(2n ** 62n), real: -0.25, dec: '-0.50', flag: 0,
    iso_keep: '2024-03-01T08:00:00Z', iso_conv: '2024-03-01T08:00:00Z', epoch_s: -1, epoch_ms: -1,
    epoch_ms_keep: 0, json_conv: '[3,{"z":null,"y":[true]}]', json_keep: '"plain"', bin: Buffer.alloc(0),
    uid: '00000000-0000-0000-0000-000000000000',
  },
  Object.fromEntries(Object.keys(MANIFEST.tables.t.columns).map((c) => [c, c === 'id' ? 3 : null])),
];

let server: ThrowawayPostgres;
let pg: PostgresHandle;
let dir: string;
let codecs: ManifestCodecs;

beforeAll(async () => {
  server = await startThrowawayPostgres();
  pg = openPostgres(server.config, { applicationName: 'db-kit-codec-test' });
  await pg.pool.query(PG_DDL);
  dir = mkdtempSync(join(tmpdir(), 'db-kit-codecs-'));
  codecs = buildCodecs(parseCodecManifest(MANIFEST));
}, 180_000);

afterAll(async () => {
  await pg?.close();
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

function openSqlite(name: string): Database.Database {
  const db = new Database(join(dir, name));
  db.exec(SQLITE_DDL);
  return db;
}

function readRows(db: Database.Database): Row[] {
  return db.prepare<[], Row>('select * from t order by id').safeIntegers(true).all();
}

describe('SQLite -> Postgres -> SQLite through real databases', () => {
  it('round-trips every codec; each side keeps its own representation and canonical forms agree', async () => {
    const columns = codecs.copyColumns('t');

    const source = openSqlite('source.db');
    const insert = source.prepare(`insert into t (${columns.join(',')}) values (${columns.map((c) => `@${c}`).join(',')})`);
    for (const row of ROWS) insert.run(row);
    const sourceRows = readRows(source);
    source.close();

    for (const row of sourceRows) {
      const params = columns.map((c) => codecs.column('t', c).toPostgres(row[c]));
      await pg.pool.query(`insert into t (${columns.join(',')}) values (${columns.map((_, i) => `$${i + 1}`).join(',')})`, params);
    }
    const { rows: pgRows } = await pg.pool.query<Row>({ text: 'select * from t order by id', types: POSTGRES_CODEC_TYPES });

    const target = openSqlite('target.db');
    const write = target.prepare(`insert into t (${columns.join(',')}) values (${columns.map((c) => `@${c}`).join(',')})`);
    for (const row of pgRows) write.run(Object.fromEntries(columns.map((c) => [c, codecs.column('t', c).toSqlite(row[c])])));
    const targetRows = readRows(target);
    target.close();

    expect(pgRows).toHaveLength(ROWS.length);
    expect(targetRows).toHaveLength(ROWS.length);

    // Representation genuinely differs between the dialects.
    const [pgFirst, pgSecond] = pgRows;
    const [srcFirst] = sourceRows;
    expect(srcFirst?.flag).toBe(1n);
    expect(pgFirst?.flag).toBe(true);
    expect(pgSecond?.flag).toBe(false);
    expect(pgFirst?.json_conv).toBe('{"a": 2, "b": 1}');
    expect(pgFirst?.big).toBe('4611686018427387904');
    expect(pgFirst?.epoch_ms).toMatch(/^2024-03-01 \d\d:00:00\.123[+-]\d\d$/);
    expect(pgFirst?.epoch_ms_keep).toBe('1709280000123');
    expect(pgFirst?.iso_keep).toBe('2024-03-01 10:00:00+02:00');
    expect(pgFirst?.uid).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(pgFirst?.dec).toBe('12345678901234567890.123456789');
    expect(pgSecond?.dec).toBe('-0.50');

    // Canonical forms agree for every column of every row, NULLs included.
    for (const [i, source_] of sourceRows.entries()) {
      for (const column of columns) {
        const codec = codecs.column('t', column);
        const fromSource = codec.canonical(source_[column], 'sqlite');
        expect(codec.canonical(pgRows[i]?.[column], 'postgres'), `pg ${column} row ${i}`).toBe(fromSource);
        expect(codec.canonical(targetRows[i]?.[column], 'sqlite'), `sqlite2 ${column} row ${i}`).toBe(fromSource);
      }
    }

    // Round trip is byte-identical except where the engine normalises the spelling.
    const normalised = new Set(['iso_conv', 'json_conv', 'uid']);
    for (const [i, source_] of sourceRows.entries()) {
      for (const column of columns.filter((c) => !normalised.has(c))) {
        expect(targetRows[i]?.[column], `${column} row ${i}`).toEqual(source_[column]);
      }
    }
    expect(targetRows[0]?.iso_conv).toBe('2024-03-01T08:00:00.123456Z');
    expect(targetRows[1]?.iso_conv).toBe('2024-03-01T08:00:00.000Z');
    expect(targetRows[0]?.json_conv).toBe('{"a":2,"b":1}');
    expect(targetRows[0]?.uid).toBe('123e4567-e89b-12d3-a456-426614174000');
  });

  it('a one-unit change on either side stops the canonical forms agreeing', async () => {
    const codec = codecs.column('t', 'big');
    const { rows } = await pg.pool.query<Row>({ text: 'select big from t where id = 1', types: POSTGRES_CODEC_TYPES });
    expect(codec.canonical(2n ** 62n + 1n, 'sqlite')).not.toBe(codec.canonical(rows[0]?.big, 'postgres'));
    const ms = codecs.column('t', 'epoch_ms');
    const { rows: ts } = await pg.pool.query<Row>({ text: 'select epoch_ms from t where id = 1', types: POSTGRES_CODEC_TYPES });
    expect(ms.canonical(1709280000124, 'sqlite')).not.toBe(ms.canonical(ts[0]?.epoch_ms, 'postgres'));
    expect(ms.canonical(1709280000123, 'sqlite')).toBe(ms.canonical(ts[0]?.epoch_ms, 'postgres'));
  });

  it('jsonb spellings of numbers and nesting compare EQUAL to the SQLite text; one digit off does not', async () => {
    await pg.pool.query('create table jb (id int primary key, j jsonb)');
    const codec = codecs.column('t', 'json_conv');
    const equal = ['1e2', '1.50', '-0', '0.0', '12345678901234567890123', '[1.0,[2e0,{"b":1,"a":[0.10]}],{"z":-0.0,"y":"\\u0041"}]', '{"n":9007199254740993}'];
    const seen: string[] = [];
    for (const [i, text] of equal.entries()) {
      await pg.pool.query('insert into jb values ($1, $2)', [i, codec.toPostgres(text)]);
      const { rows } = await pg.pool.query<Row>({ text: 'select j from jb where id = $1', values: [i], types: POSTGRES_CODEC_TYPES });
      seen.push(`${text} -> ${String(rows[0]?.j)}`);
      expect(codec.canonical(rows[0]?.j, 'postgres'), text).toBe(codec.canonical(text, 'sqlite'));
      expect(codec.canonical(codec.toSqlite(rows[0]?.j), 'sqlite'), `back ${text}`).toBe(codec.canonical(text, 'sqlite'));
    }
    console.log(`jsonb outputs:\n${seen.join('\n')}`);
    await pg.pool.query('insert into jb values (100, $1)', ['{"n":9007199254740993}']);
    const { rows } = await pg.pool.query<Row>({ text: 'select j from jb where id = 100', types: POSTGRES_CODEC_TYPES });
    expect(codec.canonical(rows[0]?.j, 'postgres')).not.toBe(codec.canonical('{"n":9007199254740992}', 'sqlite'));
    expect(codec.canonical(rows[0]?.j, 'postgres')).not.toBe(codec.canonical('{"n":9007199254740994}', 'sqlite'));
    await pg.pool.query('drop table jb');
  });
});
