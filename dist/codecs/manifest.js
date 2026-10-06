import { z } from 'zod';
import { DbKitError } from '../errors.js';
const columnFields = {
    /** Required on purpose: NULL handling is never a default. */
    nullable: z.boolean(),
    /** A generated column is verified, not copied: the target computes it. */
    generated: z.boolean().optional(),
};
/** Discriminated on `codec`. Nothing is inferred: every column declares its logical type. */
export const ColumnSpecSchema = z.discriminatedUnion('codec', [
    z.strictObject({ codec: z.literal('text'), ...columnFields }),
    z.strictObject({ codec: z.literal('integer'), ...columnFields }),
    z.strictObject({ codec: z.literal('bigint'), ...columnFields }),
    z.strictObject({ codec: z.literal('real'), ...columnFields }),
    z.strictObject({ codec: z.literal('decimal-as-string'), ...columnFields }),
    z.strictObject({ codec: z.literal('boolean'), ...columnFields }),
    z.strictObject({ codec: z.literal('timestamp-iso'), preserveText: z.boolean().default(true), ...columnFields }),
    z.strictObject({ codec: z.literal('timestamp-epoch-s'), preserveInteger: z.boolean().default(true), ...columnFields }),
    z.strictObject({ codec: z.literal('timestamp-epoch-ms'), preserveInteger: z.boolean().default(true), ...columnFields }),
    z.strictObject({ codec: z.literal('json-text'), preserveText: z.boolean().default(true), ...columnFields }),
    z.strictObject({ codec: z.literal('blob'), ...columnFields }),
    z.strictObject({ codec: z.literal('uuid-text'), ...columnFields }),
]);
/**
 * A record whose keys are copied with `defineProperty`: zod's own `record` assigns `result[key]`, which for the key
 * `__proto__` rewrites the prototype and silently drops the entry, so the object is read directly instead.
 */
function ownRecord(value) {
    return z
        .custom((input) => typeof input === 'object' && input !== null && !Array.isArray(input), 'expected an object')
        .transform((input, ctx) => {
        const out = {};
        for (const key of Object.keys(input)) {
            const parsed = value.safeParse(input[key]);
            if (!parsed.success) {
                for (const issue of parsed.error.issues)
                    ctx.addIssue({ code: 'custom', message: issue.message, path: [key, ...issue.path] });
                return z.NEVER;
            }
            Object.defineProperty(out, key, { value: parsed.data, enumerable: true, writable: true, configurable: true });
        }
        return out;
    });
}
export const TableSpecSchema = z
    .strictObject({
    columns: ownRecord(ColumnSpecSchema),
    primaryKey: z.array(z.string()).min(1),
})
    .superRefine((table, ctx) => {
    for (const name of table.primaryKey) {
        const column = Object.hasOwn(table.columns, name) ? table.columns[name] : undefined;
        if (!column)
            ctx.addIssue({ code: 'custom', message: `primaryKey column "${name}" is not declared in columns`, path: ['primaryKey'] });
        else if (column.nullable)
            ctx.addIssue({ code: 'custom', message: `primaryKey column "${name}" must not be nullable`, path: ['primaryKey'] });
    }
});
/** A table that exists (or may exist) but is never copied or verified: a migration ledger, a derived search table. Still declared, so an UNDECLARED table stays an error. */
export const SkippedTableSchema = z.strictObject({ copy: z.literal(false), reason: z.string().min(1, 'a skipped table needs a reason') });
const RawManifestSchema = z.strictObject({
    version: z.literal(1),
    tables: ownRecord(z.union([SkippedTableSchema, TableSpecSchema])),
});
/** `tables` holds the copied tables; a `{ copy: false, reason }` entry moves to `skipped`. */
export const CodecManifestSchema = RawManifestSchema.transform((raw) => {
    const tables = {};
    const skipped = {};
    for (const [name, entry] of Object.entries(raw.tables)) {
        const target = 'copy' in entry ? skipped : tables;
        Object.defineProperty(target, name, { value: 'copy' in entry ? { reason: entry.reason } : entry, enumerable: true, writable: true, configurable: true });
    }
    return { version: raw.version, tables, skipped };
});
/** Validate and normalise a manifest. Throws `DbKitError('INVALID_MANIFEST')`; the message never quotes a value. */
export function parseCodecManifest(input) {
    const result = CodecManifestSchema.safeParse(input);
    if (result.success)
        return result.data;
    const detail = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new DbKitError('INVALID_MANIFEST', `invalid codec manifest: ${detail}`);
}
