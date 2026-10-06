import type { PostgresHandle } from '../postgres.js';
import type { SqliteHandle } from '../sqlite.js';
export type DifferenceKind = 'table-missing' | 'column-missing' | 'column-type' | 'column-nullability' | 'column-default' | 'primary-key' | 'unique' | 'index' | 'check';
export interface SchemaDifference {
    kind: DifferenceKind;
    table: string;
    /** The column, or the index name (the one the side that has it calls it); absent for table-level kinds. */
    name?: string;
    sqlite?: string;
    postgres?: string;
    message: string;
}
/** Matches a difference when every field given equals the difference's. Use it to record an INTENTIONAL difference. */
export interface AllowedDifference {
    kind?: DifferenceKind;
    table?: string;
    name?: string;
}
export interface SchemaComparison {
    /** True when every difference is allowed. */
    ok: boolean;
    differences: SchemaDifference[];
    allowed: SchemaDifference[];
    report: string;
}
export interface CompareSchemasOptions {
    allow?: readonly AllowedDifference[];
    /** Postgres schema to compare. Default `public`. */
    schema?: string;
}
/** Text of an expression or predicate with everything that is spelling, not meaning: case, quotes, whitespace, parentheses and Postgres casts. */
export declare function normalizeExpression(text: string): string;
/**
 * Compare the schema one app migration produced on SQLite with the one it produced on Postgres: tables, columns (logical
 * type class, nullability, default presence), primary keys, unique constraints, indexes (partial `WHERE` and expression
 * indexes included; a unique index of plain columns counts as a unique constraint) and CHECK constraints. Names are
 * not compared except as the label of an index or check; expressions are compared after normalising case, quoting,
 * whitespace, parentheses and Postgres casts. List intentional differences in `allow`. Call it from a test.
 */
export declare function compareSchemas(sqliteHandle: SqliteHandle, postgresHandle: PostgresHandle, options?: CompareSchemasOptions): Promise<SchemaComparison>;
