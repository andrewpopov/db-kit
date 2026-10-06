import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type Database from 'better-sqlite3';
import type { Client } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import type { ColumnCodec } from '../codecs/bound.js';
import { quoteIdent, TARGET_SCHEMA } from './catalog.js';
import { decodeSourceRow, sourceColumn, textPositions } from './text-read.js';
import type { PgValue } from '../codecs/implementations.js';

const SPECIAL = /[\\\t\n\r]/;
const ESCAPES: Readonly<Record<string, string>> = { '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' };

function escapeText(text: string): string {
  return SPECIAL.test(text) ? text.replace(/[\\\t\n\r]/g, (char) => ESCAPES[char] ?? char) : text;
}

/**
 * One value in COPY text format. Backslash, tab, newline and CR are escaped, which also makes a literal `\N` or `\.`
 * in data harmless (its backslash becomes `\\`); NULL is the bare `\N`; bytea is `\\x` + hex (the escaped backslash
 * leaves `\x...` for the bytea input function); -0 keeps its sign.
 */
export function copyField(value: PgValue | null): string {
  if (value === null) return '\\N';
  switch (typeof value) {
    case 'string':
      return escapeText(value);
    case 'boolean':
      return value ? 't' : 'f';
    case 'bigint':
      return value.toString();
    case 'number':
      return Object.is(value, -0) ? '-0' : String(value);
    default:
      return `\\\\x${value.toString('hex')}`;
  }
}

export interface LoadOptions {
  client: Client;
  db: Database.Database;
  table: string;
  /** Non-generated columns, in manifest order: what is written. */
  columns: readonly ColumnCodec[];
  orderBy: string;
  /** Approximate size of one COPY chunk handed to the stream. Bounds memory together with the stream's own buffer. */
  batchBytes: number;
}

/** Stream one table from the snapshot into Postgres with COPY. Memory is one chunk, never the table. Returns rows written. */
export async function loadTable(options: LoadOptions): Promise<number> {
  const { client, db, table, columns, orderBy, batchBytes } = options;
  const textColumns = textPositions(columns);
  const select = db.prepare(`select ${columns.map(sourceColumn).join(', ')} from ${quoteIdent(table)} order by ${orderBy}`).raw(true);
  let rows = 0;
  async function* chunks(): AsyncGenerator<string> {
    let lines: string[] = [];
    let size = 0;
    for (const row of select.iterate() as IterableIterator<unknown[]>) {
      decodeSourceRow(columns, textColumns, row);
      const fields = new Array<string>(columns.length);
      for (let i = 0; i < columns.length; i++) fields[i] = copyField((columns[i] as ColumnCodec).toPostgres(row[i]));
      const line = `${fields.join('\t')}\n`;
      lines.push(line);
      size += line.length;
      rows++;
      if (size >= batchBytes) {
        yield lines.join('');
        lines = [];
        size = 0;
      }
    }
    if (lines.length > 0) yield lines.join('');
  }
  const sql = `COPY ${quoteIdent(TARGET_SCHEMA)}.${quoteIdent(table)} (${columns.map((column) => quoteIdent(column.column)).join(', ')}) FROM STDIN`;
  await pipeline(Readable.from(chunks(), { objectMode: false }), client.query(copyFrom(sql)));
  return rows;
}
