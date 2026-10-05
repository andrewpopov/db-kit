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
}, z.core.$strict>, z.ZodObject<{
    nullable: z.ZodBoolean;
    generated: z.ZodOptional<z.ZodBoolean>;
    codec: z.ZodLiteral<"timestamp-epoch-ms">;
    preserveInteger: z.ZodDefault<z.ZodBoolean>;
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
        codec: "timestamp-epoch-s";
        preserveInteger: boolean;
        generated?: boolean | undefined;
    } | {
        nullable: boolean;
        codec: "timestamp-epoch-ms";
        preserveInteger: boolean;
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
export declare const CodecManifestSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    tables: z.ZodPipe<z.ZodCustom<Record<string, unknown>, Record<string, unknown>>, z.ZodTransform<Record<string, {
        columns: Record<string, {
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
            codec: "timestamp-epoch-s";
            preserveInteger: boolean;
            generated?: boolean | undefined;
        } | {
            nullable: boolean;
            codec: "timestamp-epoch-ms";
            preserveInteger: boolean;
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
    }>, Record<string, unknown>>>;
}, z.core.$strict>;
export type ColumnSpec = z.output<typeof ColumnSpecSchema>;
export type TableSpec = z.output<typeof TableSpecSchema>;
export type CodecManifest = z.output<typeof CodecManifestSchema>;
/** What an app writes: option defaults (`preserveText`, `preserveInteger`) may be omitted. */
export interface CodecManifestInput {
    version: 1;
    tables: Record<string, {
        columns: Record<string, z.input<typeof ColumnSpecSchema>>;
        primaryKey: string[];
    }>;
}
/** Validate and normalise a manifest. Throws `DbKitError('INVALID_MANIFEST')`; the message never quotes a value. */
export declare function parseCodecManifest(input: unknown): CodecManifest;
