import { type CodecManifest } from '../codecs/manifest.js';
type TableSpec = CodecManifest['tables'][string];
/**
 * ORDER BY for the SQLite snapshot: text keys `COLLATE BINARY` (never the column's declared collation), uuid text
 * lowercased (Postgres `uuid` orders by value, so spelling must not matter), everything else (integers, blobs,
 * epoch integers, booleans, reals) in its natural order.
 */
export declare function sqliteOrderBy(spec: TableSpec): string;
/** ORDER BY for the Postgres side: the same order, `COLLATE "C"` on textual keys only (`uuid`, `bytea`, numbers are not collatable). */
export declare function postgresOrderBy(spec: TableSpec): string;
export {};
