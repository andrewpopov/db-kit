import { type Dialect, type PgValue, type SqliteValue } from './implementations.js';
import type { CodecManifest, ColumnSpec } from './manifest.js';
/** One declared column: a codec plus its table.column identity, NULL rule and generated flag. */
export interface ColumnCodec {
    readonly table: string;
    readonly column: string;
    readonly spec: ColumnSpec;
    readonly nullable: boolean;
    readonly generated: boolean;
    /** Accepted `information_schema` `data_type` values; the first is the preferred column type. */
    readonly pgTypes: readonly string[];
    /** NULL passes through when `nullable`; otherwise throws `CodecError('CODEC_NULL')`. */
    toPostgres(sqliteValue: unknown): PgValue | null;
    toSqlite(pgValue: unknown): SqliteValue | null;
    /** Dialect-independent comparison string; NULL is `null`. `value` is the dialect's own representation. */
    canonical(value: unknown, dialect: Dialect): string | null;
}
export interface ManifestCodecs {
    readonly manifest: CodecManifest;
    /** Throws `DbKitError('INVALID_MANIFEST')` if the column was never declared. */
    column(table: string, column: string): ColumnCodec;
    /** Declared, non-generated columns in manifest order: what a copy writes. */
    copyColumns(table: string): string[];
}
/** Bind every column of an already-parsed manifest (see `parseCodecManifest`). */
export declare function buildCodecs(manifest: CodecManifest): ManifestCodecs;
