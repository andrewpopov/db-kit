import { DbKitError } from '../errors.js';
import { CodecError } from './errors.js';
import { IMPLEMENTATIONS, ValueRejection, type CodecImpl, type Dialect, type PgValue, type SqliteValue } from './implementations.js';
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

function implementationFor(spec: ColumnSpec): CodecImpl {
  switch (spec.codec) {
    case 'timestamp-iso':
      return IMPLEMENTATIONS.timestampIso(spec.preserveText);
    case 'timestamp-epoch-s':
      return IMPLEMENTATIONS.timestampEpoch(1_000_000n, 's', spec.preserveInteger, spec.acceptSqliteDatetimeText);
    case 'timestamp-epoch-ms':
      return IMPLEMENTATIONS.timestampEpoch(1_000n, 'ms', spec.preserveInteger, spec.acceptSqliteDatetimeText);
    case 'json-text':
      return IMPLEMENTATIONS.jsonText(spec.preserveText);
    case 'text':
    case 'integer':
    case 'bigint':
    case 'real':
    case 'decimal-as-string':
    case 'boolean':
    case 'blob':
    case 'uuid-text':
      return IMPLEMENTATIONS[spec.codec];
  }
}

function bindColumn(table: string, column: string, spec: ColumnSpec): ColumnCodec {
  const impl = implementationFor(spec);
  const run = <T>(value: unknown, convert: (value: unknown) => T): T | null => {
    if (value === null || value === undefined) {
      if (spec.nullable) return null;
      throw new CodecError('CODEC_NULL', table, column, 'NULL in a column declared non-nullable');
    }
    try {
      return convert(value);
    } catch (error) {
      if (error instanceof ValueRejection) {
        throw new CodecError(error.kind === 'lossy' ? 'CODEC_LOSSY' : 'CODEC_INVALID', table, column, error.reason);
      }
      throw error;
    }
  };
  return {
    table,
    column,
    spec,
    nullable: spec.nullable,
    generated: spec.generated === true,
    pgTypes: impl.pgTypes,
    toPostgres: (value) => run(value, impl.toPostgres),
    toSqlite: (value) => run(value, impl.toSqlite),
    canonical: (value, dialect) => run(value, (v) => impl.canonical(v, dialect)),
  };
}

/** Bind every column of an already-parsed manifest (see `parseCodecManifest`). */
export function buildCodecs(manifest: CodecManifest): ManifestCodecs {
  const bound = new Map<string, Map<string, ColumnCodec>>();
  for (const [table, tableSpec] of Object.entries(manifest.tables)) {
    bound.set(table, new Map(Object.entries(tableSpec.columns).map(([column, spec]) => [column, bindColumn(table, column, spec)])));
  }
  return {
    manifest,
    column(table, column) {
      const found = bound.get(table)?.get(column);
      if (!found) throw new DbKitError('INVALID_MANIFEST', `${table}.${column} is not declared in the manifest`);
      return found;
    },
    copyColumns(table) {
      const columns = bound.get(table);
      if (!columns) throw new DbKitError('INVALID_MANIFEST', `table ${table} is not declared in the manifest`);
      return [...columns.values()].filter((codec) => !codec.generated).map((codec) => codec.column);
    },
  };
}
