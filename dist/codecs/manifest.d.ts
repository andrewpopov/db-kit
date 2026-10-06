import { z } from 'zod';
/** Discriminated on `codec`. Nothing is inferred: every column declares its logical type. */
export declare const ColumnSpecSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    nullable: z.ZodBoolean;
    generated: z.ZodOptional<z.ZodBoolean>;
    codec: z.ZodLiteral<"text">;
}, z.core.$strict>, z.ZodObject<{
    nullable: z.ZodBoolean;
    generated: z.ZodOptional<z.ZodBoolean>;
    codec: z.ZodLiteral<"integer">;
}, z.core.$strict>, z.ZodObject<{
    nullable: z.ZodBoolean;
    generated: z.ZodOptional<z.ZodBoolean>;
    codec: z.ZodLiteral<"bigint">;
}, z.core.$strict>, z.ZodObject<{
    nullable: z.ZodBoolean;
    generated: z.ZodOptional<z.ZodBoolean>;
    codec: z.ZodLiteral<"real">;
}, z.core.$strict>, z.ZodObject<{
    nullable: z.ZodBoolean;
    generated: z.ZodOptional<z.ZodBoolean>;
    codec: z.ZodLiteral<"decimal-as-string">;
}, z.core.$strict>, z.ZodObject<{
    nullable: z.ZodBoolean;
    generated: z.ZodOptional<z.ZodBoolean>;
    codec: z.ZodLiteral<"boolean">;
}, z.core.$strict>, z.ZodObject<{
    nullable: z.ZodBoolean;
    generated: z.ZodOptional<z.ZodBoolean>;
    codec: z.ZodLiteral<"timestamp-iso">;
    preserveText: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>, z.ZodObject<{
    nullable: z.ZodBoolean;
    generated: z.ZodOptional<z.ZodBoolean>;
    codec: z.ZodLiteral<"timestamp-epoch-s">;
    preserveInteger: z.ZodDefault<z.ZodBoolean>;
    acceptSqliteDatetimeText: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>, z.ZodObject<{
    nullable: z.ZodBoolean;
    generated: z.ZodOptional<z.ZodBoolean>;
    codec: z.ZodLiteral<"timestamp-epoch-ms">;
    preserveInteger: z.ZodDefault<z.ZodBoolean>;
    acceptSqliteDatetimeText: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>, z.ZodObject<{
    nullable: z.ZodBoolean;
    generated: z.ZodOptional<z.ZodBoolean>;
    codec: z.ZodLiteral<"json-text">;
    preserveText: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>, z.ZodObject<{
    nullable: z.ZodBoolean;
    generated: z.ZodOptional<z.ZodBoolean>;
    codec: z.ZodLiteral<"blob">;
}, z.core.$strict>, z.ZodObject<{
    nullable: z.ZodBoolean;
    generated: z.ZodOptional<z.ZodBoolean>;
    codec: z.ZodLiteral<"uuid-text">;
}, z.core.$strict>], "codec">;
export declare const TableSpecSchema: z.ZodObject<{
    columns: z.ZodPipe<z.ZodCustom<Record<string, unknown>, Record<string, unknown>>, z.ZodTransform<Record<string, {
        nullable: boolean;
        codec: "timestamp-epoch-s";
        preserveInteger: boolean;
        acceptSqliteDatetimeText: boolean;
        generated?: boolean | undefined;
    } | {
        nullable: boolean;
        codec: "timestamp-epoch-ms";
        preserveInteger: boolean;
        acceptSqliteDatetimeText: boolean;
        generated?: boolean | undefined;
    } | {
        nullable: boolean;
        codec: "text";
        generated?: boolean | undefined;
    } | {
        nullable: boolean;
        codec: "integer";
        generated?: boolean | undefined;
    } | {
        nullable: boolean;
        codec: "bigint";
        generated?: boolean | undefined;
    } | {
        nullable: boolean;
        codec: "real";
        generated?: boolean | undefined;
    } | {
        nullable: boolean;
        codec: "decimal-as-string";
        generated?: boolean | undefined;
    } | {
        nullable: boolean;
        codec: "boolean";
        generated?: boolean | undefined;
    } | {
        nullable: boolean;
        codec: "timestamp-iso";
        preserveText: boolean;
        generated?: boolean | undefined;
    } | {
        nullable: boolean;
        codec: "json-text";
        preserveText: boolean;
        generated?: boolean | undefined;
    } | {
        nullable: boolean;
        codec: "blob";
        generated?: boolean | undefined;
    } | {
        nullable: boolean;
        codec: "uuid-text";
        generated?: boolean | undefined;
    }>, Record<string, unknown>>>;
    primaryKey: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
/** A table that exists (or may exist) but is never copied or verified: a migration ledger, a derived search table. Still declared, so an UNDECLARED table stays an error. */
export declare const SkippedTableSchema: z.ZodObject<{
    copy: z.ZodLiteral<false>;
    reason: z.ZodString;
}, z.core.$strict>;
/** `tables` holds the copied tables; a `{ copy: false, reason }` entry moves to `skipped`. */
export declare const CodecManifestSchema: z.ZodPipe<z.ZodObject<{
    version: z.ZodLiteral<1>;
    tables: z.ZodPipe<z.ZodCustom<Record<string, unknown>, Record<string, unknown>>, z.ZodTransform<Record<string, {
        columns: Record<string, {
            nullable: boolean;
            codec: "timestamp-epoch-s";
            preserveInteger: boolean;
            acceptSqliteDatetimeText: boolean;
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "timestamp-epoch-ms";
            preserveInteger: boolean;
            acceptSqliteDatetimeText: boolean;
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "text";
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "integer";
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "bigint";
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "real";
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "decimal-as-string";
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "boolean";
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "timestamp-iso";
            preserveText: boolean;
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "json-text";
            preserveText: boolean;
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "blob";
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "uuid-text";
            generated?: boolean | undefined;
        }>;
        primaryKey: string[];
    } | {
        copy: false;
        reason: string;
    }>, Record<string, unknown>>>;
}, z.core.$strict>, z.ZodTransform<{
    version: 1;
    tables: Record<string, {
        columns: Record<string, {
            nullable: boolean;
            codec: "timestamp-epoch-s";
            preserveInteger: boolean;
            acceptSqliteDatetimeText: boolean;
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "timestamp-epoch-ms";
            preserveInteger: boolean;
            acceptSqliteDatetimeText: boolean;
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "text";
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "integer";
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "bigint";
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "real";
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "decimal-as-string";
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "boolean";
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "timestamp-iso";
            preserveText: boolean;
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "json-text";
            preserveText: boolean;
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "blob";
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "uuid-text";
            generated?: boolean | undefined;
        }>;
        primaryKey: string[];
    }>;
    skipped: Record<string, {
        reason: string;
    }>;
}, {
    version: 1;
    tables: Record<string, {
        columns: Record<string, {
            nullable: boolean;
            codec: "timestamp-epoch-s";
            preserveInteger: boolean;
            acceptSqliteDatetimeText: boolean;
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "timestamp-epoch-ms";
            preserveInteger: boolean;
            acceptSqliteDatetimeText: boolean;
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "text";
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "integer";
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "bigint";
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "real";
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "decimal-as-string";
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "boolean";
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "timestamp-iso";
            preserveText: boolean;
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "json-text";
            preserveText: boolean;
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "blob";
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "uuid-text";
            generated?: boolean | undefined;
        }>;
        primaryKey: string[];
    } | {
        copy: false;
        reason: string;
    }>;
}>>;
export type ColumnSpec = z.output<typeof ColumnSpecSchema>;
export type TableSpec = z.output<typeof TableSpecSchema>;
export type CodecManifest = z.output<typeof CodecManifestSchema>;
/** What an app writes: option defaults (`preserveText`, `preserveInteger`) may be omitted. */
export interface TableInput {
    columns: Record<string, z.input<typeof ColumnSpecSchema>>;
    primaryKey: string[];
}
export interface CodecManifestInput {
    version: 1;
    /** A copied table, or `{ copy: false, reason }` for a table that is declared but never copied or verified. */
    tables: Record<string, TableInput | {
        copy: false;
        reason: string;
    }>;
}
/** Validate and normalise a manifest. Throws `DbKitError('INVALID_MANIFEST')`; the message never quotes a value. */
export declare function parseCodecManifest(input: unknown): CodecManifest;
