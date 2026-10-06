import type Database from 'better-sqlite3';
import type { Client } from 'pg';
import type { ColumnCodec } from '../codecs/bound.js';
import type { PgValue } from '../codecs/implementations.js';
/**
 * One value in COPY text format. Backslash, tab, newline and CR are escaped, which also makes a literal `\N` or `\.`
 * in data harmless (its backslash becomes `\\`); NULL is the bare `\N`; bytea is `\\x` + hex (the escaped backslash
 * leaves `\x...` for the bytea input function); -0 keeps its sign.
 */
export declare function copyField(value: PgValue | null): string;
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
export declare function loadTable(options: LoadOptions): Promise<number>;
