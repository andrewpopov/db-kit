import { DbKitError } from '../errors.js';
import { CodecError } from './errors.js';
import { IMPLEMENTATIONS, ValueRejection } from './implementations.js';
import { jsonPgType } from './manifest.js';
function implementationFor(spec) {
    switch (spec.codec) {
        case 'timestamp-iso':
            return IMPLEMENTATIONS.timestampIso(spec.preserveText);
        case 'timestamp-epoch-s':
            return IMPLEMENTATIONS.timestampEpoch(1000000n, 's', spec.preserveInteger, spec.acceptSqliteDatetimeText);
        case 'timestamp-epoch-ms':
            return IMPLEMENTATIONS.timestampEpoch(1000n, 'ms', spec.preserveInteger, spec.acceptSqliteDatetimeText);
        case 'json-text':
            return IMPLEMENTATIONS.jsonText(jsonPgType(spec));
        case 'text':
        case 'timestamp-naive':
        case 'date-text':
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
function bindColumn(table, column, spec) {
    const impl = implementationFor(spec);
    const run = (value, convert) => {
        if (value === null || value === undefined) {
            if (spec.nullable)
                return null;
            throw new CodecError('CODEC_NULL', table, column, 'NULL in a column declared non-nullable');
        }
        try {
            return convert(value);
        }
        catch (error) {
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
export function buildCodecs(manifest) {
    const bound = new Map();
    for (const [table, tableSpec] of Object.entries(manifest.tables)) {
        bound.set(table, new Map(Object.entries(tableSpec.columns).map(([column, spec]) => [column, bindColumn(table, column, spec)])));
    }
    return {
        manifest,
        column(table, column) {
            const found = bound.get(table)?.get(column);
            if (!found)
                throw new DbKitError('INVALID_MANIFEST', `${table}.${column} is not declared in the manifest`);
            return found;
        },
        copyColumns(table) {
            const columns = bound.get(table);
            if (!columns)
                throw new DbKitError('INVALID_MANIFEST', `table ${table} is not declared in the manifest`);
            return [...columns.values()].filter((codec) => !codec.generated).map((codec) => codec.column);
        },
    };
}
