import { describe, expect, it } from 'vitest';
import { DbKitError } from '../errors.js';
import { buildCodecs, type ColumnCodec } from './bound.js';
import { CodecError } from './errors.js';
import type { Dialect } from './implementations.js';
import { parseCodecManifest, type CodecManifestInput } from './manifest.js';

type Spec = CodecManifestInput['tables'][string]['columns'][string];

function codecOf(spec: Spec, table = 'main', column = 'col'): ColumnCodec {
  const manifest = parseCodecManifest({ version: 1, tables: { [table]: { columns: { id: { codec: 'integer', nullable: false }, [column]: spec }, primaryKey: ['id'] } } } satisfies CodecManifestInput);
  return buildCodecs(manifest).column(table, column);
}

function errorOf(fn: () => unknown): CodecError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CodecError) return error;
    throw error;
  }
  throw new Error('expected a CodecError');
}

const notNull = { nullable: false } as const;

interface Case {
  name: string;
  spec: Spec;
  sqlite: unknown;
  pg: unknown;
  /** One unit different from `sqlite` / `pg` respectively. */
  sqliteOther: unknown;
  pgOther: unknown;
}

const CASES: Case[] = [
  { name: 'text', spec: { codec: 'text', ...notNull }, sqlite: 'abc', pg: 'abc', sqliteOther: 'abd', pgOther: 'abd' },
  { name: 'integer', spec: { codec: 'integer', ...notNull }, sqlite: 41, pg: '41', sqliteOther: 42, pgOther: '42' },
  { name: 'bigint', spec: { codec: 'bigint', ...notNull }, sqlite: 2n ** 62n, pg: '4611686018427387904', sqliteOther: 2n ** 62n + 1n, pgOther: '4611686018427387905' },
  { name: 'real', spec: { codec: 'real', ...notNull }, sqlite: 0.1, pg: 0.1, sqliteOther: 0.1 + Number.EPSILON, pgOther: 0.2 },
  {
    name: 'decimal-as-string',
    spec: { codec: 'decimal-as-string', ...notNull },
    sqlite: '12345678901234567890.123456789',
    pg: '12345678901234567890.1234567890',
    sqliteOther: '12345678901234567890.123456788',
    pgOther: '12345678901234567891.123456789',
  },
  { name: 'boolean', spec: { codec: 'boolean', ...notNull }, sqlite: 1, pg: true, sqliteOther: 0, pgOther: false },
  {
    name: 'timestamp-iso (preserveText)',
    spec: { codec: 'timestamp-iso', preserveText: true, ...notNull },
    sqlite: '2024-03-01T10:00:00+02:00',
    pg: '2024-03-01T08:00:00.000000Z',
    sqliteOther: '2024-03-01T10:00:00.000001+02:00',
    pgOther: '2024-03-01 08:00:00.000001+00',
  },
  {
    name: 'timestamp-iso (timestamptz)',
    spec: { codec: 'timestamp-iso', preserveText: false, ...notNull },
    sqlite: '2024-03-01T10:00:00.123456+02:00',
    pg: '2024-03-01 08:00:00.123456+00',
    sqliteOther: '2024-03-01T10:00:00.123457+02:00',
    pgOther: '2024-03-01 08:00:00.123457+00',
  },
  {
    name: 'timestamp-epoch-s',
    spec: { codec: 'timestamp-epoch-s', preserveInteger: false, ...notNull },
    sqlite: 1709280000,
    pg: '2024-03-01 08:00:00+00',
    sqliteOther: 1709280001,
    pgOther: '2024-03-01 08:00:01+00',
  },
  {
    name: 'timestamp-epoch-ms',
    spec: { codec: 'timestamp-epoch-ms', preserveInteger: false, ...notNull },
    sqlite: 1709280000123,
    pg: '2024-03-01 08:00:00.123+00',
    sqliteOther: 1709280000124,
    pgOther: '2024-03-01 08:00:00.124+00',
  },
  {
    name: 'timestamp-epoch-ms (preserveInteger)',
    spec: { codec: 'timestamp-epoch-ms', preserveInteger: true, ...notNull },
    sqlite: 1709280000123,
    pg: '1709280000123',
    sqliteOther: 1709280000124,
    pgOther: '1709280000124',
  },
  {
    name: 'json-text (jsonb)',
    spec: { codec: 'json-text', preserveText: false, ...notNull },
    sqlite: '{"b":1,"a":[2,{"d":1,"c":2}]}',
    pg: '{"a": [2, {"c": 2, "d": 1}], "b": 1}',
    sqliteOther: '{"b":1,"a":[2,{"d":1,"c":3}]}',
    pgOther: '{"a": [2, {"c": 2, "d": 1}], "b": 2}',
  },
  {
    name: 'blob',
    spec: { codec: 'blob', ...notNull },
    sqlite: Buffer.from([0, 1, 255]),
    pg: Buffer.from([0, 1, 255]),
    sqliteOther: Buffer.from([0, 1, 254]),
    pgOther: Buffer.from([0, 2, 255]),
  },
  {
    name: 'uuid-text',
    spec: { codec: 'uuid-text', ...notNull },
    sqlite: '123E4567-E89B-12D3-A456-426614174000',
    pg: '123e4567-e89b-12d3-a456-426614174000',
    sqliteOther: '123e4567-e89b-12d3-a456-426614174001',
    pgOther: '123e4567-e89b-12d3-a456-426614174002',
  },
];

describe('canonical comparison', () => {
  for (const c of CASES) {
    it(`${c.name}: equal across dialects, unequal for a one-unit difference`, () => {
      const codec = codecOf(c.spec);
      const canon = (value: unknown, dialect: Dialect): string | null => codec.canonical(value, dialect);
      expect(canon(c.sqlite, 'sqlite')).toBe(canon(c.pg, 'postgres'));
      expect(canon(c.sqlite, 'sqlite')).not.toBe(canon(c.sqliteOther, 'sqlite'));
      expect(canon(c.pg, 'postgres')).not.toBe(canon(c.pgOther, 'postgres'));
      expect(canon(c.sqlite, 'sqlite')).not.toBe(canon(c.pgOther, 'postgres'));
    });
  }

  it('canonical forms are the documented ones', () => {
    expect(codecOf({ codec: 'timestamp-epoch-ms', preserveInteger: false, ...notNull }).canonical(1709280000123, 'sqlite')).toBe('2024-03-01T08:00:00.123000Z');
    expect(codecOf({ codec: 'boolean', ...notNull }).canonical(0, 'sqlite')).toBe('false');
    expect(codecOf({ codec: 'blob', ...notNull }).canonical(Buffer.alloc(0), 'sqlite')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(codecOf({ codec: 'decimal-as-string', ...notNull }).canonical('-0.00', 'sqlite')).toBe('0');
    expect(codecOf({ codec: 'decimal-as-string', ...notNull }).canonical('+007.500', 'sqlite')).toBe('7.5');
  });
});

describe('json-text canonical form is lossless', () => {
  const canon = (text: string): string | null => codecOf({ codec: 'json-text', preserveText: false, ...notNull }).canonical(text, 'sqlite');

  it('equal spellings of one number compare equal', () => {
    for (const same of ['1', '1.0', '1e0', '10e-1', '1E+0', '0.1e1', '100e-2']) expect(canon(same), same).toBe(canon('1'));
    expect(canon('1e2')).toBe(canon('100'));
    expect(canon('1.50')).toBe(canon('1.5'));
    expect(canon('-0')).toBe(canon('0'));
    expect(canon('0.0')).toBe(canon('0'));
    expect(canon('-1.5e-3')).toBe('-0.0015');
    expect(canon('12345678901234567890123')).toBe('12345678901234567890123');
    expect(canon('[1.0,{"a":2e0}]')).toBe(canon('[ 1 , { "a" : 2 } ]'));
  });

  it('a one-digit difference never compares equal, even past 2^53 or in the fraction', () => {
    expect(canon('9007199254740993')).not.toBe(canon('9007199254740992'));
    expect(canon('12345678901234567890123')).not.toBe(canon('12345678901234567890124'));
    expect(canon('0.1000000000000000055511151231257827')).not.toBe(canon('0.1'));
    expect(canon('{"n":[9007199254740993]}')).not.toBe(canon('{"n":[9007199254740992]}'));
    expect(canon('1e2')).not.toBe(canon('1e3'));
  });

  it('strings are exact; only escape spelling is normalised; keys sort and nest', () => {
    expect(canon('"\\u0041"')).toBe(canon('"A"'));
    expect(canon('"a"')).not.toBe(canon('"b"'));
    expect(canon('"1"')).not.toBe(canon('1'));
    expect(canon('{"b":1,"a":{"d":[],"c":{}}}')).toBe(canon('{"a":{"c":{},"d":[]},"b":1}'));
    expect(canon('{"a":1,"a":2}')).toBe(canon('{"a":2}'));
    expect(canon('[true,false,null]')).toBe('[true,false,null]');
  });

  it('toSqlite from jsonb keeps every digit of a big number', () => {
    const codec = codecOf({ codec: 'json-text', preserveText: false, ...notNull });
    expect(codec.toSqlite('{"a": 9007199254740993, "b": 1.50}')).toBe('{"a":9007199254740993,"b":1.50}');
  });
});

describe('conversions', () => {
  it('bigint stays a bigint end to end, never a JS number', () => {
    const codec = codecOf({ codec: 'bigint', ...notNull });
    expect(codec.toPostgres(2n ** 62n)).toBe(2n ** 62n);
    expect(codec.toSqlite('4611686018427387904')).toBe(2n ** 62n);
  });

  it('timestamp-iso with preserveText keeps the text; with timestamptz it emits µs UTC and ms-short text back', () => {
    const keep = codecOf({ codec: 'timestamp-iso', preserveText: true, ...notNull });
    expect(keep.toPostgres('2024-03-01 10:00:00+02:00')).toBe('2024-03-01 10:00:00+02:00');
    const convert = codecOf({ codec: 'timestamp-iso', preserveText: false, ...notNull });
    expect(convert.toPostgres('2024-03-01T10:00:00.5+02:00')).toBe('2024-03-01T08:00:00.500000Z');
    expect(convert.toSqlite('2024-03-01 08:00:00.5+00')).toBe('2024-03-01T08:00:00.500Z');
    expect(convert.toSqlite(new Date('2024-03-01T08:00:00.250Z'))).toBe('2024-03-01T08:00:00.250Z');
  });

  it('epoch codecs convert to timestamptz text, or pass the integer through with preserveInteger', () => {
    expect(codecOf({ codec: 'timestamp-epoch-s', preserveInteger: false, ...notNull }).toPostgres(0)).toBe('1970-01-01T00:00:00.000000Z');
    expect(codecOf({ codec: 'timestamp-epoch-ms', preserveInteger: false, ...notNull }).toPostgres(-1)).toBe('1969-12-31T23:59:59.999000Z');
    expect(codecOf({ codec: 'timestamp-epoch-ms', preserveInteger: true, ...notNull }).toPostgres(1709280000123)).toBe(1709280000123n);
    expect(codecOf({ codec: 'timestamp-epoch-s', preserveInteger: false, ...notNull }).toSqlite('2024-03-01 08:00:00+00')).toBe(1709280000);
  });

  it('json-text with jsonb semantics rewrites to compact JSON; preserveText keeps the exact text', () => {
    expect(codecOf({ codec: 'json-text', preserveText: false, ...notNull }).toSqlite('{"a": 2, "b": 1}')).toBe('{"a":2,"b":1}');
    expect(codecOf({ codec: 'json-text', preserveText: true, ...notNull }).toSqlite('{ "a": 2 }')).toBe('{ "a": 2 }');
  });

  it('options default to preserving the existing contract', () => {
    const manifest = parseCodecManifest({
      version: 1,
      tables: { t: { columns: { a: { codec: 'timestamp-iso', nullable: false }, b: { codec: 'timestamp-epoch-s', nullable: false }, c: { codec: 'json-text', nullable: false }, id: { codec: 'integer', nullable: false } }, primaryKey: ['id'] } },
    } satisfies CodecManifestInput);
    expect(Object.values(buildCodecs(manifest).column('t', 'a').pgTypes)).toEqual(['text']);
    expect(buildCodecs(manifest).column('t', 'b').pgTypes).toEqual(['bigint']);
    expect(buildCodecs(manifest).column('t', 'c').pgTypes).toEqual(['text']);
  });
});

describe('rejections name table.column and the reason', () => {
  it('int8 beyond 2^53 into integer is lossy (both directions)', () => {
    const codec = codecOf({ codec: 'integer', ...notNull }, 'users', 'age');
    const fromSqlite = errorOf(() => codec.toPostgres(2n ** 53n + 1n));
    expect(fromSqlite.code).toBe('CODEC_LOSSY');
    expect(fromSqlite.message).toMatch(/^users\.age: .*2\^53/);
    expect(errorOf(() => codec.toSqlite('9007199254740993')).code).toBe('CODEC_LOSSY');
    expect(codec.toSqlite('9007199254740991')).toBe(9007199254740991);
  });

  it('bigint refuses an unsafe JS number and a value past int64', () => {
    const codec = codecOf({ codec: 'bigint', ...notNull }, 'users', 'id');
    expect(errorOf(() => codec.toPostgres(2 ** 60)).code).toBe('CODEC_INVALID');
    expect(errorOf(() => codec.toPostgres(2n ** 63n)).code).toBe('CODEC_LOSSY');
  });

  it('boolean accepts exactly 0 and 1', () => {
    const codec = codecOf({ codec: 'boolean', ...notNull }, 'flags', 'on');
    for (const bad of [2, -1, '1', 'true', true, 0.5, 1.0000001]) {
      expect(errorOf(() => codec.toPostgres(bad)).message).toMatch(/^flags\.on: /);
    }
    expect(codec.toPostgres(1n)).toBe(true);
    expect(errorOf(() => codec.toSqlite(1)).code).toBe('CODEC_INVALID');
  });

  it('json-text rejects invalid JSON and non-text', () => {
    const codec = codecOf({ codec: 'json-text', preserveText: false, ...notNull }, 'docs', 'body');
    expect(errorOf(() => codec.toPostgres('{"a":')).message).toBe('docs.body: not valid JSON');
    expect(errorOf(() => codec.toSqlite({ a: 1 })).code).toBe('CODEC_INVALID');
  });

  it('NULL into a non-nullable column names table.column; a nullable column passes NULL through', () => {
    const strict = codecOf({ codec: 'text', ...notNull }, 'users', 'email');
    expect(errorOf(() => strict.toPostgres(null)).code).toBe('CODEC_NULL');
    expect(errorOf(() => strict.toSqlite(null)).message).toMatch(/^users\.email: /);
    expect(errorOf(() => strict.canonical(null, 'sqlite')).code).toBe('CODEC_NULL');
    const loose = codecOf({ codec: 'text', nullable: true }, 'users', 'email');
    expect(loose.toPostgres(null)).toBeNull();
    expect(loose.toSqlite(undefined)).toBeNull();
    expect(loose.canonical(null, 'postgres')).toBeNull();
  });

  it('decimal rejects non-numeric text, exponents, JS numbers and NaN/Infinity', () => {
    const codec = codecOf({ codec: 'decimal-as-string', ...notNull }, 'ledger', 'amount');
    for (const bad of ['abc', '1e5', '', 'NaN', 'Infinity', '1,5', 12.5]) expect(errorOf(() => codec.toPostgres(bad)).code).toBe('CODEC_INVALID');
    expect(errorOf(() => codec.toPostgres(Number.NaN)).code).toBe('CODEC_LOSSY');
    expect(errorOf(() => codec.toPostgres(Number.POSITIVE_INFINITY)).code).toBe('CODEC_LOSSY');
    expect(errorOf(() => codec.toSqlite('NaN')).code).toBe('CODEC_INVALID');
  });

  it('real rejects NaN and Infinity', () => {
    const codec = codecOf({ codec: 'real', ...notNull }, 'm', 'x');
    expect(errorOf(() => codec.toPostgres(Number.NaN)).code).toBe('CODEC_INVALID');
    expect(errorOf(() => codec.toSqlite(Number.NEGATIVE_INFINITY)).code).toBe('CODEC_INVALID');
  });

  it('timestamps: sub-µs precision, missing offset, impossible date, out-of-range epoch', () => {
    const iso = codecOf({ codec: 'timestamp-iso', preserveText: false, ...notNull }, 'ev', 'at');
    expect(errorOf(() => iso.toPostgres('2024-01-01T00:00:00.1234567Z')).code).toBe('CODEC_LOSSY');
    expect(iso.toPostgres('2024-01-01T00:00:00.1234560Z')).toBe('2024-01-01T00:00:00.123456Z');
    expect(errorOf(() => iso.toPostgres('2024-01-01T00:00:00')).code).toBe('CODEC_INVALID');
    expect(errorOf(() => iso.toPostgres('2024-02-30T00:00:00Z')).code).toBe('CODEC_INVALID');
    expect(errorOf(() => iso.toPostgres('2024-01-01T24:00:00Z')).code).toBe('CODEC_INVALID');
    expect(errorOf(() => iso.toPostgres('0000-01-01T00:00:00Z')).code).toBe('CODEC_LOSSY');
    const ms = codecOf({ codec: 'timestamp-epoch-ms', preserveInteger: false, ...notNull }, 'ev', 'ms');
    expect(errorOf(() => ms.toPostgres(9e15)).message).toMatch(/^ev\.ms: .*range/);
    expect(errorOf(() => ms.toPostgres(1.5)).code).toBe('CODEC_INVALID');
    expect(errorOf(() => ms.toSqlite('2024-03-01 08:00:00.000001+00')).code).toBe('CODEC_LOSSY');
    const s = codecOf({ codec: 'timestamp-epoch-s', preserveInteger: false, ...notNull }, 'ev', 's');
    expect(errorOf(() => s.toSqlite('2024-03-01 08:00:00.5+00')).code).toBe('CODEC_LOSSY');
    expect(errorOf(() => s.toPostgres(2n ** 62n)).code).toBe('CODEC_LOSSY');
  });

  it('uuid, blob and text refuse the wrong shape; error messages never contain the value', () => {
    expect(errorOf(() => codecOf({ codec: 'uuid-text', ...notNull }).toPostgres('not-a-uuid')).code).toBe('CODEC_INVALID');
    expect(errorOf(() => codecOf({ codec: 'blob', ...notNull }).toPostgres('abc')).code).toBe('CODEC_INVALID');
    expect(errorOf(() => codecOf({ codec: 'text', ...notNull }).toPostgres(5)).code).toBe('CODEC_INVALID');
    const secret = 'hunter2-secret';
    expect(errorOf(() => codecOf({ codec: 'integer', ...notNull }).toPostgres(secret)).message).not.toContain(secret);
  });
});

describe('manifest schema', () => {
  const base = { version: 1, tables: { t: { columns: { id: { codec: 'integer', nullable: false } }, primaryKey: ['id'] } } };

  it('accepts a valid manifest', () => {
    expect(parseCodecManifest(base).tables.t?.primaryKey).toEqual(['id']);
  });

  it('rejects unknown codecs, missing nullable, unknown options, a bad version and bad primary keys', () => {
    const cases: unknown[] = [
      { ...base, tables: { t: { columns: { id: { codec: 'varchar', nullable: false } }, primaryKey: ['id'] } } },
      { ...base, tables: { t: { columns: { id: { codec: 'integer' } }, primaryKey: ['id'] } } },
      { ...base, tables: { t: { columns: { id: { codec: 'integer', nullable: false, preserveText: true } }, primaryKey: ['id'] } } },
      { ...base, version: 2 },
      { ...base, tables: { t: { columns: { id: { codec: 'integer', nullable: false } }, primaryKey: ['nope'] } } },
      { ...base, tables: { t: { columns: { id: { codec: 'integer', nullable: true } }, primaryKey: ['id'] } } },
      { ...base, tables: { t: { columns: { id: { codec: 'integer', nullable: false } }, primaryKey: [] } } },
    ];
    for (const input of cases) {
      expect(() => parseCodecManifest(input)).toThrow(DbKitError);
      try {
        parseCodecManifest(input);
      } catch (error) {
        expect(error).toMatchObject({ code: 'INVALID_MANIFEST' });
      }
    }
  });

  it('copyColumns excludes generated columns; column() refuses an undeclared one', () => {
    const codecs = buildCodecs(
      parseCodecManifest({
        version: 1,
        tables: { t: { columns: { id: { codec: 'integer', nullable: false }, twice: { codec: 'integer', nullable: false, generated: true } }, primaryKey: ['id'] } },
      }),
    );
    expect(codecs.copyColumns('t')).toEqual(['id']);
    expect(() => codecs.column('t', 'ghost')).toThrow(/t\.ghost is not declared/);
    expect(() => codecs.copyColumns('nope')).toThrow(DbKitError);
  });
});
