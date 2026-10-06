import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { types as pgTypes, type Client, type CustomTypesConfig } from 'pg';
import type { ColumnCodec } from '../codecs/bound.js';
import type { Dialect } from '../codecs/implementations.js';
import { quoteIdent, TARGET_SCHEMA } from './catalog.js';
import { refuse } from './errors.js';
import { decodeSourceRow, sourceColumn, textPositions } from './text-read.js';

/**
 * Parsers for the verification reads, fixed here: `pg.types` is process-global, so anything an application registered
 * (a lowercasing TEXT parser, a Date parser) would otherwise decide what the target "says". timestamptz and json/jsonb
 * stay raw text, int8 and numeric stay strings (the codecs' contract); an unlisted type arrives as its text.
 */
const FIXED_PARSERS = new Map<number, (text: string) => unknown>([
  [pgTypes.builtins.INT2, (text) => Number.parseInt(text, 10)],
  [pgTypes.builtins.INT4, (text) => Number.parseInt(text, 10)],
  [pgTypes.builtins.FLOAT4, Number.parseFloat],
  [pgTypes.builtins.FLOAT8, Number.parseFloat],
  [pgTypes.builtins.BOOL, (text) => text === 't'],
  [pgTypes.builtins.BYTEA, (text) => Buffer.from(text.slice(2), 'hex')],
]);
const VERIFY_TYPES: CustomTypesConfig = { getTypeParser: (oid: number) => FIXED_PARSERS.get(oid) ?? ((text: string) => text) } as CustomTypesConfig;

const HEADER = Buffer.from('db-kit clone row encoding v1\0');
const NULL_MARK = Buffer.from([0]);
const VALUE_MARK = Buffer.from([1]);

/**
 * Versioned, type-tagged, length-prefixed row encoding of the codecs' canonical forms: per column a tag byte (0 NULL,
 * 1 value) and, for a value, a 4-byte big-endian byte length and the UTF-8 canonical string. The framing makes
 * ("ab","c") and ("a","bc") different, and NULL different from the empty string.
 */
export function encodeRow(columns: readonly ColumnCodec[], values: readonly unknown[], dialect: Dialect): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < columns.length; i++) {
    const canonical = (columns[i] as ColumnCodec).canonical(values[i], dialect);
    if (canonical === null) {
      parts.push(NULL_MARK);
      continue;
    }
    const bytes = Buffer.from(canonical, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    parts.push(VALUE_MARK, length, bytes);
  }
  return Buffer.concat(parts);
}

function digestRow(hash: ReturnType<typeof createHash>, row: Buffer): void {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(row.length);
  hash.update(length);
  hash.update(row);
}

export interface VerifyOptions {
  client: Client;
  db: Database.Database;
  table: string;
  /** Every declared column (generated included), in manifest order. */
  columns: readonly ColumnCodec[];
  primaryKey: readonly string[];
  sqliteOrderBy: string;
  postgresOrderBy: string;
  /** Rows fetched from the Postgres cursor per round trip. */
  fetchRows: number;
}

export interface TableDigest {
  rows: number;
  /** SHA-256 over the row encodings. Every row matched byte for byte across both sides, so this is both sides' digest. */
  sha256: string;
}

const CURSOR = 'db_kit_verify';

/**
 * Compare one table row by row, in primary-key order, on two INDEPENDENT reads: the snapshot file through SQLite and
 * the target through a server-side cursor (bounded memory: one fetch batch). The first difference refuses naming
 * table (and column), never a value. The matched encodings are folded into a digest, which is the receipt.
 */
export async function verifyTable(options: VerifyOptions): Promise<TableDigest> {
  const { client, db, table, columns, fetchRows } = options;
  const names = columns.map((column) => quoteIdent(column.column)).join(', ');
  const sourceNames = columns.map(sourceColumn).join(', ');
  const textColumns = textPositions(columns);
  const source = (db.prepare(`select ${sourceNames} from ${quoteIdent(table)} order by ${options.sqliteOrderBy}`).raw(true).iterate() as IterableIterator<unknown[]>)[Symbol.iterator]();
  const pkIndexes = options.primaryKey.map((name) => columns.findIndex((column) => column.column === name));
  const sourceHash = createHash('sha256').update(HEADER);
  let rows = 0;
  let previousKey: Buffer | undefined;
  const mismatch = (column?: string): never => refuse({ code: 'verification-mismatch', table, ...(column === undefined ? {} : { column }) });

  await client.query(`DECLARE ${CURSOR} NO SCROLL CURSOR FOR select ${names} from ${quoteIdent(TARGET_SCHEMA)}.${quoteIdent(table)} order by ${options.postgresOrderBy}`);
  try {
    for (;;) {
      const { rows: batch } = await client.query<unknown[]>({ text: `FETCH FORWARD ${fetchRows} FROM ${CURSOR}`, rowMode: 'array', types: VERIFY_TYPES });
      if (batch.length === 0) break;
      for (const targetRow of batch) {
        const next = source.next();
        if (next.done === true) return mismatch();
        const sourceRow = next.value as unknown[];
        decodeSourceRow(columns, textColumns, sourceRow);
        const sourceEncoded = encodeRow(columns, sourceRow, 'sqlite');
        const targetEncoded = encodeRow(columns, targetRow, 'postgres');
        if (!sourceEncoded.equals(targetEncoded)) {
          const differing = columns.find((column, i) => encodeRow([column], [sourceRow[i]], 'sqlite').compare(encodeRow([column], [targetRow[i]], 'postgres')) !== 0);
          return mismatch(differing?.column);
        }
        const key = encodeRow(
          pkIndexes.map((i) => columns[i] as ColumnCodec),
          pkIndexes.map((i) => sourceRow[i]),
          'sqlite',
        );
        if (previousKey?.equals(key)) return mismatch(options.primaryKey[0]);
        previousKey = key;
        digestRow(sourceHash, sourceEncoded);
        rows++;
      }
    }
    if (source.next().done !== true) return mismatch();
  } finally {
    source.return?.();
    await client.query(`CLOSE ${CURSOR}`).catch(() => undefined);
  }
  return { rows, sha256: sourceHash.digest('hex') };
}
