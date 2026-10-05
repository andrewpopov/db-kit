import type { IntrospectedSchema } from './introspect.js';
import type { CodecManifest } from './manifest.js';
export type ManifestIssueCode = 'undeclared-table' | 'undeclared-column' | 'missing-table' | 'missing-column' | 'generated-undeclared' | 'generated-mismatch' | 'pg-type-mismatch';
export interface ManifestIssue {
    code: ManifestIssueCode;
    table: string;
    column?: string;
    /** The database the problem is on. */
    side: 'sqlite' | 'postgres';
    message: string;
}
export interface ManifestValidation {
    /** True only when there are no issues. */
    ok: boolean;
    issues: ManifestIssue[];
    /** Declared-generated columns that checked out on both sides: verified, never copied. */
    generated: {
        table: string;
        column: string;
    }[];
    report: string;
}
export interface IntrospectedDatabases {
    sqlite: IntrospectedSchema;
    postgres: IntrospectedSchema;
}
/**
 * Check a manifest against both live schemas. Nothing is inferred and nothing is skipped: every table and column
 * on either side must be declared, every declared one must exist on both sides, `generated` must match each
 * engine, and the Postgres column type must be one the declared codec expects.
 */
export declare function validateManifest(manifest: CodecManifest, databases: IntrospectedDatabases): ManifestValidation;
