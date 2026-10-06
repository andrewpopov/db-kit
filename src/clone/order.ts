import { jsonPgType, type ColumnSpec, type CodecManifest } from '../codecs/manifest.js';
import { quoteIdent } from './catalog.js';

type TableSpec = CodecManifest['tables'][string];

/** Codecs whose Postgres type is text: collatable, and bytewise-ordered with `COLLATE "C"` / SQLite BINARY. */
function isTextual(spec: ColumnSpec): boolean {
  return spec.codec === 'text' || (spec.codec === 'timestamp-iso' && spec.preserveText) || (spec.codec === 'json-text' && jsonPgType(spec) === 'text');
}

/**
 * ORDER BY for the SQLite snapshot: text keys `COLLATE BINARY` (never the column's declared collation), uuid text
 * lowercased (Postgres `uuid` orders by value, so spelling must not matter), everything else (integers, blobs,
 * epoch integers, booleans, reals) in its natural order.
 */
export function sqliteOrderBy(spec: TableSpec): string {
  return spec.primaryKey
    .map((name) => {
      const column = spec.columns[name];
      const quoted = quoteIdent(name);
      if (column?.codec === 'uuid-text') return `lower(${quoted}) COLLATE BINARY`;
      return column && isTextual(column) ? `${quoted} COLLATE BINARY` : quoted;
    })
    .join(', ');
}

/** ORDER BY for the Postgres side: the same order, `COLLATE "C"` on textual keys only (`uuid`, `bytea`, numbers are not collatable). */
export function postgresOrderBy(spec: TableSpec): string {
  return spec.primaryKey
    .map((name) => {
      const column = spec.columns[name];
      const quoted = quoteIdent(name);
      return column && isTextual(column) ? `${quoted} COLLATE "C"` : quoted;
    })
    .join(', ');
}
