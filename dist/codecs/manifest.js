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
export const TableSpecSchema = z
    .strictObject({
    columns: z.record(z.string(), ColumnSpecSchema),
    primaryKey: z.array(z.string()).min(1),
})
    .superRefine((table, ctx) => {
    for (const name of table.primaryKey) {
        const column = table.columns[name];
        if (!column)
            ctx.addIssue({ code: 'custom', message: `primaryKey column "${name}" is not declared in columns`, path: ['primaryKey'] });
        else if (column.nullable)
            ctx.addIssue({ code: 'custom', message: `primaryKey column "${name}" must not be nullable`, path: ['primaryKey'] });
    }
});
export const CodecManifestSchema = z.strictObject({
    version: z.literal(1),
    tables: z.record(z.string(), TableSpecSchema),
});
/** Validate and normalise a manifest. Throws `DbKitError('INVALID_MANIFEST')`; the message never quotes a value. */
export function parseCodecManifest(input) {
    const result = CodecManifestSchema.safeParse(input);
    if (result.success)
        return result.data;
    const detail = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new DbKitError('INVALID_MANIFEST', `invalid codec manifest: ${detail}`);
}
