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

/** User tables only. `table_xinfo` `hidden` is 2 for a VIRTUAL and 3 for a STORED generated column; 1 is a virtual-table internal. */
export function introspectSqlite(db: BetterSqlite3.Database): IntrospectedSchema {
  const tables = db
    .prepare<[], { name: string }>("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")
    .all();
  const columnsOf = db.prepare<[string], SqliteColumnRow>('select name, type, hidden from pragma_table_xinfo(?)');
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
  column_name: string;
  data_type: string;
  is_generated: string;
}

/** Base tables of one schema (default `public`). A column is generated when `is_generated = 'ALWAYS'`; identity columns are not. */
export async function introspectPostgres(pool: Pool, schema = 'public'): Promise<IntrospectedSchema> {
  const { rows } = await pool.query<PostgresColumnRow>(
    `select c.table_name, c.column_name, c.data_type, c.is_generated
       from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = $1 and t.table_type = 'BASE TABLE'
      order by c.table_name, c.ordinal_position`,
    [schema],
  );
  const tables = new Map<string, IntrospectedColumn[]>();
  for (const row of rows) {
    const columns = tables.get(row.table_name) ?? [];
    columns.push({ name: row.column_name, type: row.data_type, generated: row.is_generated === 'ALWAYS' });
    tables.set(row.table_name, columns);
  }
  return tables;
}
