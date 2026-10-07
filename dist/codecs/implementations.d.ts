export type Dialect = 'sqlite' | 'postgres';
/** What better-sqlite3 hands over/accepts (`safeIntegers(true)` yields bigint for INTEGER). */
export type SqliteValue = number | bigint | string | Buffer;
/** What `pg` accepts as a parameter / returns when read with {@link POSTGRES_CODEC_TYPES}. */
export type PgValue = number | bigint | string | boolean | Buffer;
/** Internal: a value a codec refuses. `bound.ts` turns it into a `CodecError` that names table.column. */
export declare class ValueRejection extends Error {
    readonly kind: 'invalid' | 'lossy';
    readonly reason: string;
    constructor(kind: 'invalid' | 'lossy', reason: string);
}
export interface CodecImpl {
    /** Accepted `information_schema.columns.data_type` values; the first is the preferred one. */
    readonly pgTypes: readonly string[];
    toPostgres(sqliteValue: unknown): PgValue;
    toSqlite(pgValue: unknown): SqliteValue;
    /** Dialect-independent string for exact comparison; `value` is the dialect's own representation. */
    canonical(value: unknown, dialect: Dialect): string;
}
/** Nesting deeper than this is refused when JSON is parsed, so walking it can never overflow the stack. */
export declare const MAX_JSON_DEPTH = 512;
declare function timestampIso(preserveText: boolean): CodecImpl;
declare function timestampEpoch(microsPerUnit: bigint, unitName: string, preserveInteger: boolean, acceptDatetimeText: boolean): CodecImpl;
export declare const IMPLEMENTATIONS: {
    text: CodecImpl;
    integer: CodecImpl;
    bigint: CodecImpl;
    real: CodecImpl;
    'decimal-as-string': CodecImpl;
    boolean: CodecImpl;
    blob: CodecImpl;
    'uuid-text': CodecImpl;
    'timestamp-naive': CodecImpl;
    'date-text': CodecImpl;
    decimalAsString: typeof decimalAsString;
    timestampIso: typeof timestampIso;
    timestampEpoch: typeof timestampEpoch;
    jsonText: typeof jsonText;
};
/** `acceptSqliteNumeric`: also accept INTEGER/REAL storage (a Prisma `Decimal` on a NUMERIC-affinity column) and write exactly-representable decimals back as numbers. */
declare function decimalAsString(acceptSqliteNumeric: boolean): CodecImpl;
/** `text` and `json` keep the stored text exactly (Postgres `json` stores its input verbatim, duplicate keys included); only `jsonb` normalises, and refuses duplicate keys. */
declare function jsonText(pgType: 'text' | 'json' | 'jsonb'): CodecImpl;
export {};
