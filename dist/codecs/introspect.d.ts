import type BetterSqlite3 from 'better-sqlite3';
import type { QueryResult, QueryResultRow } from 'pg';
export interface IntrospectedColumn {
    name: string;
    /** SQLite: the declared type text (may be empty). Postgres: `information_schema` `data_type`. */
    type: string;
    generated: boolean;
}
/** Table name -> columns in declaration order. */
export type IntrospectedSchema = ReadonlyMap<string, readonly IntrospectedColumn[]>;
/**
 * User tables only (`sqlite\_%` with an explicit escape: a bare `_` would also hide `sqliteXlost`). `table_xinfo`
 * `hidden` is 2 for a VIRTUAL and 3 for a STORED generated column; 1 is a virtual-table internal. Statements read
 * with `safeIntegers(false)` so the caller's `defaultSafeIntegers` cannot turn `hidden` into a bigint.
 */
export declare function introspectSqlite(db: BetterSqlite3.Database): IntrospectedSchema;
/** A `pg.Pool` or a single `pg.Client`: introspection only reads. */
export interface PostgresQueryable {
    query<Row extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
}
/** Base tables of one schema (default `public`), zero-column tables included. A column is generated when `is_generated = 'ALWAYS'`; identity columns are not. */
export declare function introspectPostgres(pool: PostgresQueryable, schema?: string): Promise<IntrospectedSchema>;
