import { isUtf8 } from 'node:buffer';
import { quoteIdent } from './catalog.js';
import { refuse } from './errors.js';
/** Codecs whose SQLite value is TEXT. Everything else (integers, reals, blobs) has no decoding to get wrong. */
const TEXT_CODECS = new Set(['text', 'decimal-as-string', 'timestamp-iso', 'json-text', 'uuid-text', 'timestamp-naive', 'date-text']);
export const readsText = (codec) => TEXT_CODECS.has(codec);
/**
 * How a column is selected from the snapshot. TEXT comes back as its stored BYTES so they can be validated before any
 * decoding (better-sqlite3 would silently turn an invalid byte into U+FFFD, and a verification that decodes the same
 * way would accept it). A BLOB in a text column becomes the integer 0, which the codec then refuses as not-a-string.
 */
export function textAsBytes(name) {
    const quoted = quoteIdent(name);
    return `CASE typeof(${quoted}) WHEN 'text' THEN CAST(${quoted} AS BLOB) WHEN 'blob' THEN 0 ELSE ${quoted} END`;
}
export const sourceColumn = (codec) => (readsText(codec.spec.codec) ? textAsBytes(codec.column) : quoteIdent(codec.column));
/** Positions of the text columns in a row selected with `sourceColumn`. */
export const textPositions = (columns) => columns.flatMap((column, index) => (readsText(column.spec.codec) ? [index] : []));
/** Validate and decode the text columns of one selected row, in place. Refuses naming table.column, never the bytes. */
export function decodeSourceRow(columns, positions, row) {
    for (const index of positions) {
        const value = row[index];
        if (!Buffer.isBuffer(value))
            continue;
        if (!isUtf8(value))
            refuse({ code: 'source-invalid-utf8', table: columns[index].table, column: columns[index].column });
        row[index] = value.toString('utf8');
    }
}
