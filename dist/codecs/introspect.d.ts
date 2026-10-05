import type BetterSqlite3 from 'better-sqlite3';
import type { Pool } from 'pg';
export interface IntrospectedColumn {
    name: string;
    /** SQLite: the declared type text (may be empty). Postgres: `information_schema` `data_type`. */
    type: string;
    generated: boolean;
}
/** Table name -> columns in declaration order. */
export type IntrospectedSchema = ReadonlyMap<string, readonly IntrospectedColumn[]>;
/** User tables only. `table_xinfo` `hidden` is 2 for a VIRTUAL and 3 for a STORED generated column; 1 is a virtual-table internal. */
export declare function introspectSqlite(db: BetterSqlite3.Database): IntrospectedSchema;
/** Base tables of one schema (default `public`). A column is generated when `is_generated = 'ALWAYS'`; identity columns are not. */
export declare function introspectPostgres(pool: Pool, schema?: string): Promise<IntrospectedSchema>;
