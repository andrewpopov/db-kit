import { createHash } from 'node:crypto';

export type Dialect = 'sqlite' | 'postgres';
/** What better-sqlite3 hands over/accepts (`safeIntegers(true)` yields bigint for INTEGER). */
export type SqliteValue = number | bigint | string | Buffer;
/** What `pg` accepts as a parameter / returns when read with {@link POSTGRES_CODEC_TYPES}. */
export type PgValue = number | bigint | string | boolean | Buffer;

/** Internal: a value a codec refuses. `bound.ts` turns it into a `CodecError` that names table.column. */
export class ValueRejection extends Error {
  constructor(
    readonly kind: 'invalid' | 'lossy',
    readonly reason: string,
  ) {
    super(reason);
  }
}

function reject(kind: 'invalid' | 'lossy', reason: string): never {
  throw new ValueRejection(kind, reason);
}

export interface CodecImpl {
  /** Accepted `information_schema.columns.data_type` values; the first is the preferred one. */
  readonly pgTypes: readonly string[];
  toPostgres(sqliteValue: unknown): PgValue;
  toSqlite(pgValue: unknown): SqliteValue;
  /** Dialect-independent string for exact comparison; `value` is the dialect's own representation. */
  canonical(value: unknown, dialect: Dialect): string;
}

/** Each codec parses either dialect's value into one logical value `L`, and renders `L` back out. */
interface Logical<L> {
  pgTypes: readonly string[];
  fromSqlite(value: unknown): L;
  fromPg(value: unknown): L;
  toSqlite(logical: L): SqliteValue;
  toPg(logical: L): PgValue;
  canonical(logical: L): string;
}

function implement<L>(def: Logical<L>): CodecImpl {
  return {
    pgTypes: def.pgTypes,
    toPostgres: (value) => def.toPg(def.fromSqlite(value)),
    toSqlite: (value) => def.toSqlite(def.fromPg(value)),
    canonical: (value, dialect) => def.canonical(dialect === 'sqlite' ? def.fromSqlite(value) : def.fromPg(value)),
  };
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** number (safe integer), bigint or decimal-integer string -> bigint. */
function toBigInt(value: unknown, what: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) reject('invalid', `${what} must be a safe integer (read SQLite with safeIntegers for 64-bit values)`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return reject('invalid', `${what} must be an integer`);
}

function toInt64(value: unknown, what: string): bigint {
  const parsed = toBigInt(value, what);
  if (parsed < INT64_MIN || parsed > INT64_MAX) reject('lossy', `${what} is outside the 64-bit range`);
  return parsed;
}

function toSafeInteger(value: unknown): number {
  const parsed = toInt64(value, 'integer');
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
    reject('lossy', 'integer exceeds 2^53-1; declare the column as bigint');
  }
  return Number(parsed);
}

function toFiniteReal(value: unknown): number {
  if (typeof value !== 'number') return reject('invalid', 'real must be a number');
  if (!Number.isFinite(value)) reject('invalid', 'real must be finite (NaN and Infinity do not survive both engines)');
  return value;
}

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function toDecimalString(value: unknown): string {
  if (typeof value === 'number') {
    return reject(Number.isFinite(value) ? 'invalid' : 'lossy', Number.isFinite(value) ? 'decimal must be a string, not a JS number' : 'NaN/Infinity cannot be a decimal');
  }
  if (typeof value !== 'string' || !DECIMAL.test(value)) return reject('invalid', 'decimal must be a plain numeric string (no exponent, NaN or Infinity)');
  return value;
}

function canonicalDecimal(text: string): string {
  const negative = text.startsWith('-');
  const [integer = '', fraction = ''] = text.replace(/^[+-]/, '').split('.');
  const whole = integer.replace(/^0+/, '') || '0';
  const frac = fraction.replace(/0+$/, '');
  const magnitude = frac ? `${whole}.${frac}` : whole;
  return negative && magnitude !== '0' ? `-${magnitude}` : magnitude;
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return reject('invalid', 'blob must be a Buffer');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) return reject('invalid', 'uuid must be 8-4-4-4-12 hex text');
  return value.toLowerCase();
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : reject('invalid', 'text must be a string');
}

function parseJson(text: string): void {
  try {
    JSON.parse(text);
  } catch {
    return reject('invalid', 'not valid JSON');
  }
}

const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const LITERAL = /[a-z]+/y;
const MAX_EXPANDED_DIGITS = 100_000;

/** Exact decimal form of a JSON number token: exponent expanded, leading zeros and trailing fractional zeros dropped, -0 is 0. */
function canonicalJsonNumber(token: string): string {
  const [, sign = '', integer = '', fraction = '', exponent = '0'] = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token) ?? [];
  let digits = (integer + fraction).replace(/^0+/, '');
  if (digits === '') return '0';
  let scale = Number(exponent) - fraction.length;
  const trailing = /0*$/.exec(digits)?.[0].length ?? 0;
  digits = digits.slice(0, digits.length - trailing);
  scale += trailing;
  if (Math.abs(scale) + digits.length > MAX_EXPANDED_DIGITS) return reject('invalid', 'JSON number exponent is too large to compare exactly');
  if (scale >= 0) return `${sign}${digits}${'0'.repeat(scale)}`;
  const point = digits.length + scale;
  return point > 0 ? `${sign}${digits.slice(0, point)}.${digits.slice(point)}` : `${sign}0.${'0'.repeat(-point)}${digits}`;
}

/**
 * Re-emit valid JSON text by walking its tokens, never through `JSON.parse` values, so a number keeps every digit.
 * `canonical` also sorts keys (last duplicate wins, as in jsonb) and normalises numbers; without it only whitespace
 * is dropped. Strings are decoded and re-encoded, so `"\u0041"` and `"A"` are the same.
 */
function renderJson(text: string, canonical: boolean): string {
  let at = 0;
  const skip = (): void => {
    while (text[at] === ' ' || text[at] === '\t' || text[at] === '\n' || text[at] === '\r') at++;
  };
  const str = (): string => {
    const start = at++;
    while (text[at] !== '"') at += text[at] === '\\' ? 2 : 1;
    at++;
    const decoded: unknown = JSON.parse(text.slice(start, at));
    return typeof decoded === 'string' ? decoded : reject('invalid', 'not valid JSON');
  };
  const value = (): string => {
    skip();
    const c = text[at];
    if (c === '{') {
      at++;
      const members: [string, string][] = [];
      skip();
      if (text[at] === '}') at++;
      else {
        for (;;) {
          skip();
          const key = str();
          skip();
          at++;
          members.push([key, value()]);
          skip();
          if (text[at++] === '}') break;
        }
      }
      const kept = canonical ? [...new Map(members)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) : members;
      return `{${kept.map(([key, child]) => `${JSON.stringify(key)}:${child}`).join(',')}}`;
    }
    if (c === '[') {
      at++;
      const items: string[] = [];
      skip();
      if (text[at] === ']') at++;
      else {
        for (;;) {
          items.push(value());
          skip();
          if (text[at++] === ']') break;
        }
      }
      return `[${items.join(',')}]`;
    }
    if (c === '"') return JSON.stringify(str());
    NUMBER.lastIndex = at;
    const number = NUMBER.exec(text);
    if (number) {
      at = NUMBER.lastIndex;
      return canonical ? canonicalJsonNumber(number[0]) : number[0];
    }
    LITERAL.lastIndex = at;
    const literal = LITERAL.exec(text)?.[0] ?? '';
    at += literal.length;
    return literal;
  };
  return value();
}

// Timestamps. The supported range is years 0001-9999 (well inside timestamptz's), as microseconds since the epoch.
const MICROS_MIN = -62135596800000n * 1000n;
const MICROS_MAX = 253402300799999n * 1000n + 999n;
const ISO =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(Z|z|[+-]\d{2}(?::?\d{2})?)$/;

function checkRange(micros: bigint): bigint {
  if (micros < MICROS_MIN || micros > MICROS_MAX) reject('lossy', 'timestamp is outside the supported range (years 0001-9999)');
  return micros;
}

function parseTimestamp(value: unknown): bigint {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return reject('invalid', 'invalid Date');
    return checkRange(BigInt(value.getTime()) * 1000n);
  }
  const match = typeof value === 'string' ? ISO.exec(value) : null;
  if (!match) return reject('invalid', 'timestamp must be ISO-8601 text with an explicit UTC offset');
  const [, year = '', month = '', day = '', hour = '', minute = '', second = '0', fraction = '', zone = ''] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  date.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  const real =
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day) &&
    date.getUTCHours() === Number(hour) &&
    date.getUTCMinutes() === Number(minute) &&
    date.getUTCSeconds() === Number(second);
  if (!real) return reject('invalid', 'not a real calendar timestamp');
  let offsetMinutes = 0;
  if (zone.toUpperCase() !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    const hours = Number(digits.slice(0, 2));
    const minutes = Number(digits.slice(2) || '0');
    if (hours > 23 || minutes > 59) return reject('invalid', 'UTC offset out of range');
    offsetMinutes = (zone.startsWith('-') ? -1 : 1) * (hours * 60 + minutes);
  }
  if (/[1-9]/.test(fraction.slice(6))) reject('lossy', 'timestamp has sub-microsecond precision');
  const micros = BigInt(date.getTime()) * 1000n + BigInt(fraction.slice(0, 6).padEnd(6, '0')) - BigInt(offsetMinutes) * 60_000_000n;
  return checkRange(micros);
}

function floorDiv(a: bigint, b: bigint): bigint {
  const quotient = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? quotient - 1n : quotient;
}

/** `shortest` drops the microsecond digits when they are zero, matching `Date#toISOString`. */
function formatTimestamp(micros: bigint, digits: 'microseconds' | 'shortest'): string {
  const millis = floorDiv(micros, 1000n);
  const subMillis = micros - millis * 1000n;
  const iso = new Date(Number(millis)).toISOString();
  const head = iso.slice(0, 23);
  return digits === 'shortest' && subMillis === 0n ? `${head}Z` : `${head}${subMillis.toString().padStart(3, '0')}Z`;
}

const canonicalTimestamp = (micros: bigint): string => formatTimestamp(micros, 'microseconds');

interface IsoLogical {
  micros: bigint;
  text: string;
}

function timestampIso(preserveText: boolean): CodecImpl {
  return implement<IsoLogical>({
    pgTypes: preserveText ? ['text'] : ['timestamp with time zone'],
    fromSqlite: (value) => {
      if (typeof value !== 'string') return reject('invalid', 'timestamp-iso must be TEXT');
      return { micros: parseTimestamp(value), text: value };
    },
    fromPg: (value) => {
      const micros = parseTimestamp(value);
      return { micros, text: typeof value === 'string' && preserveText ? value : formatTimestamp(micros, 'shortest') };
    },
    toSqlite: (logical) => (preserveText ? logical.text : formatTimestamp(logical.micros, 'shortest')),
    toPg: (logical) => (preserveText ? logical.text : formatTimestamp(logical.micros, 'microseconds')),
    canonical: (logical) => canonicalTimestamp(logical.micros),
  });
}

interface EpochLogical {
  raw: bigint;
  micros: bigint;
}

function timestampEpoch(microsPerUnit: bigint, unitName: string, preserveInteger: boolean): CodecImpl {
  const fromRaw = (raw: bigint): EpochLogical => ({ raw, micros: checkRange(raw * microsPerUnit) });
  return implement<EpochLogical>({
    pgTypes: preserveInteger ? ['bigint'] : ['timestamp with time zone'],
    fromSqlite: (value) => fromRaw(toInt64(value, `epoch ${unitName}`)),
    fromPg: (value) => {
      if (preserveInteger) return fromRaw(toInt64(value, `epoch ${unitName}`));
      const micros = parseTimestamp(value);
      if (micros % microsPerUnit !== 0n) reject('lossy', `timestamp has sub-${unitName === 's' ? 'second' : 'millisecond'} precision and cannot be stored as epoch ${unitName}`);
      return { raw: micros / microsPerUnit, micros };
    },
    toSqlite: (logical) => Number(logical.raw),
    toPg: (logical) => (preserveInteger ? logical.raw : formatTimestamp(logical.micros, 'microseconds')),
    canonical: (logical) => canonicalTimestamp(logical.micros),
  });
}

const identity = <T>(value: T): T => value;

export const IMPLEMENTATIONS = {
  text: implement<string>({
    pgTypes: ['text', 'character varying'],
    fromSqlite: toText,
    fromPg: toText,
    toSqlite: identity,
    toPg: identity,
    canonical: identity,
  }),
  integer: implement<number>({
    pgTypes: ['bigint', 'integer', 'smallint'],
    fromSqlite: toSafeInteger,
    fromPg: toSafeInteger,
    toSqlite: identity,
    toPg: identity,
    canonical: String,
  }),
  bigint: implement<bigint>({
    pgTypes: ['bigint'],
    fromSqlite: (value) => toInt64(value, 'bigint'),
    fromPg: (value) => toInt64(value, 'bigint'),
    toSqlite: identity,
    toPg: identity,
    canonical: (value) => value.toString(),
  }),
  real: implement<number>({
    pgTypes: ['double precision'],
    fromSqlite: toFiniteReal,
    fromPg: toFiniteReal,
    toSqlite: identity,
    toPg: identity,
    canonical: (value) => (Object.is(value, -0) ? '-0' : String(value)),
  }),
  'decimal-as-string': implement<string>({
    pgTypes: ['numeric'],
    fromSqlite: toDecimalString,
    fromPg: toDecimalString,
    toSqlite: identity,
    toPg: identity,
    canonical: canonicalDecimal,
  }),
  boolean: implement<boolean>({
    pgTypes: ['boolean'],
    fromSqlite: (value) => {
      if (value === 0 || value === 0n) return false;
      if (value === 1 || value === 1n) return true;
      return reject('invalid', 'SQLite boolean must be exactly 0 or 1');
    },
    fromPg: (value) => (typeof value === 'boolean' ? value : reject('invalid', 'Postgres boolean must be true or false')),
    toSqlite: (value) => (value ? 1 : 0),
    toPg: identity,
    canonical: String,
  }),
  blob: implement<Buffer>({
    pgTypes: ['bytea'],
    fromSqlite: toBuffer,
    fromPg: toBuffer,
    toSqlite: identity,
    toPg: identity,
    canonical: (value) => createHash('sha256').update(value).digest('hex'),
  }),
  'uuid-text': implement<string>({
    pgTypes: ['uuid'],
    fromSqlite: toUuid,
    fromPg: toUuid,
    toSqlite: identity,
    toPg: identity,
    canonical: identity,
  }),
  timestampIso,
  timestampEpoch,
  jsonText,
};

function jsonText(preserveText: boolean): CodecImpl {
  const parse = (value: unknown): string => {
    if (typeof value !== 'string') return reject('invalid', 'JSON must be text (read Postgres with POSTGRES_CODEC_TYPES)');
    parseJson(value);
    return value;
  };
  return implement<string>({
    pgTypes: preserveText ? ['text'] : ['jsonb'],
    fromSqlite: parse,
    fromPg: parse,
    toSqlite: (text) => (preserveText ? text : renderJson(text, false)),
    toPg: (text) => text,
    canonical: (text) => renderJson(text, true),
  });
}
