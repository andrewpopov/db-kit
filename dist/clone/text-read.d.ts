import type { ColumnCodec } from '../codecs/bound.js';
export declare const readsText: (codec: string) => boolean;
/**
 * How a column is selected from the snapshot. TEXT comes back as its stored BYTES so they can be validated before any
 * decoding (better-sqlite3 would silently turn an invalid byte into U+FFFD, and a verification that decodes the same
 * way would accept it). A BLOB in a text column becomes the integer 0, which the codec then refuses as not-a-string.
 */
export declare function textAsBytes(name: string): string;
export declare const sourceColumn: (codec: ColumnCodec) => string;
/** Positions of the text columns in a row selected with `sourceColumn`. */
export declare const textPositions: (columns: readonly ColumnCodec[]) => number[];
/** Validate and decode the text columns of one selected row, in place. Refuses naming table.column, never the bytes. */
export declare function decodeSourceRow(columns: readonly ColumnCodec[], positions: readonly number[], row: unknown[]): void;
