import type Database from 'better-sqlite3';
import type { Client } from 'pg';
import type { ColumnCodec } from '../codecs/bound.js';
import type { Dialect } from '../codecs/implementations.js';
/**
 * Versioned, type-tagged, length-prefixed row encoding of the codecs' canonical forms: per column a tag byte (0 NULL,
 * 1 value) and, for a value, a 4-byte big-endian byte length and the UTF-8 canonical string. The framing makes
 * ("ab","c") and ("a","bc") different, and NULL different from the empty string.
 */
export declare function encodeRow(columns: readonly ColumnCodec[], values: readonly unknown[], dialect: Dialect): Buffer;
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
/**
 * Compare one table row by row, in primary-key order, on two INDEPENDENT reads: the snapshot file through SQLite and
 * the target through a server-side cursor (bounded memory: one fetch batch). The first difference refuses naming
 * table (and column), never a value. The matched encodings are folded into a digest, which is the receipt.
 */
export declare function verifyTable(options: VerifyOptions): Promise<TableDigest>;
