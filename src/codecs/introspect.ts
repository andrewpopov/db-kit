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

interface SqliteColumnRow {
  name: string;
  type: string;
  hidden: number;
}

/**
 * User tables only (`sqlite\_%` with an explicit escape: a bare `_` would also hide `sqliteXlost`). `table_xinfo`
 * `hidden` is 2 for a VIRTUAL and 3 for a STORED generated column; 1 is a virtual-table internal. Statements read
 * with `safeIntegers(false)` so the caller's `defaultSafeIntegers` cannot turn `hidden` into a bigint.
 */
export function introspectSqlite(db: BetterSqlite3.Database): IntrospectedSchema {
  const tables = db
    .prepare<[], { name: string }>("select name from sqlite_master where type = 'table' and name not like 'sqlite\\_%' escape '\\' order by name")
    .safeIntegers(false)
    .all();
  const columnsOf = db.prepare<[string], SqliteColumnRow>('select name, type, hidden from pragma_table_xinfo(?)').safeIntegers(false);
  return new Map(
    tables.map(({ name }) => [
      name,
      columnsOf
        .all(name)
        .filter((column) => column.hidden !== 1)
        .map((column) => ({ name: column.name, type: column.type, generated: column.hidden >= 2 })),
    ]),
  );
}

interface PostgresColumnRow {
  table_name: string;
  /** Null for the single row of a zero-column table. */
  column_name: string | null;
  data_type: string | null;
  is_generated: string | null;
}

/** Base tables of one schema (default `public`), zero-column tables included. A column is generated when `is_generated = 'ALWAYS'`; identity columns are not. */
export async function introspectPostgres(pool: Pool, schema = 'public'): Promise<IntrospectedSchema> {
  const { rows } = await pool.query<PostgresColumnRow>(
    `select t.table_name, c.column_name, c.data_type, c.is_generated
       from information_schema.tables t
       left join information_schema.columns c on c.table_schema = t.table_schema and c.table_name = t.table_name
      where t.table_schema = $1 and t.table_type = 'BASE TABLE'
      order by t.table_name, c.ordinal_position`,
    [schema],
  );
  const tables = new Map<string, IntrospectedColumn[]>();
  for (const row of rows) {
    const columns = tables.get(row.table_name) ?? [];
    tables.set(row.table_name, columns);
    if (row.column_name === null || row.data_type === null) continue;
    columns.push({ name: row.column_name, type: row.data_type, generated: row.is_generated === 'ALWAYS' });
  }
  return tables;
}
