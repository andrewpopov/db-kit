import { isUtf8 } from 'node:buffer';
import type { ColumnCodec } from '../codecs/bound.js';
import { quoteIdent } from './catalog.js';
import { refuse } from './errors.js';

/** Codecs whose SQLite value is TEXT. Everything else (integers, reals, blobs) has no decoding to get wrong. */
const TEXT_CODECS: ReadonlySet<string> = new Set(['text', 'decimal-as-string', 'timestamp-iso', 'json-text', 'uuid-text']);

export const readsText = (codec: string): boolean => TEXT_CODECS.has(codec);

/**
 * How a column is selected from the snapshot. TEXT comes back as its stored BYTES so they can be validated before any
 * decoding (better-sqlite3 would silently turn an invalid byte into U+FFFD, and a verification that decodes the same
 * way would accept it). A BLOB in a text column becomes the integer 0, which the codec then refuses as not-a-string.
 */
export function textAsBytes(name: string): string {
  const quoted = quoteIdent(name);
  return `CASE typeof(${quoted}) WHEN 'text' THEN CAST(${quoted} AS BLOB) WHEN 'blob' THEN 0 ELSE ${quoted} END`;
}

export const sourceColumn = (codec: ColumnCodec): string => (readsText(codec.spec.codec) ? textAsBytes(codec.column) : quoteIdent(codec.column));

/** Positions of the text columns in a row selected with `sourceColumn`. */
export const textPositions = (columns: readonly ColumnCodec[]): number[] => columns.flatMap((column, index) => (readsText(column.spec.codec) ? [index] : []));

/** Validate and decode the text columns of one selected row, in place. Refuses naming table.column, never the bytes. */
export function decodeSourceRow(columns: readonly ColumnCodec[], positions: readonly number[], row: unknown[]): void {
  for (const index of positions) {
    const value = row[index];
    if (!Buffer.isBuffer(value)) continue;
    if (!isUtf8(value)) refuse({ code: 'source-invalid-utf8', table: (columns[index] as ColumnCodec).table, column: (columns[index] as ColumnCodec).column });
    row[index] = value.toString('utf8');
  }
}
