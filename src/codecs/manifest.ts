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
function ownRecord<T extends z.ZodType>(value: T) {
  return z
    .custom<Record<string, unknown>>((input) => typeof input === 'object' && input !== null && !Array.isArray(input), 'expected an object')
    .transform((input, ctx): Record<string, z.output<T>> => {
      const out: Record<string, z.output<T>> = {};
      for (const key of Object.keys(input)) {
        const parsed = value.safeParse(input[key]);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: [key, ...issue.path] });
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
      if (!column) ctx.addIssue({ code: 'custom', message: `primaryKey column "${name}" is not declared in columns`, path: ['primaryKey'] });
      else if (column.nullable) ctx.addIssue({ code: 'custom', message: `primaryKey column "${name}" must not be nullable`, path: ['primaryKey'] });
    }
  });

export const CodecManifestSchema = z.strictObject({
  version: z.literal(1),
  tables: ownRecord(TableSpecSchema),
});

export type ColumnSpec = z.output<typeof ColumnSpecSchema>;
export type TableSpec = z.output<typeof TableSpecSchema>;
export type CodecManifest = z.output<typeof CodecManifestSchema>;
/** What an app writes: option defaults (`preserveText`, `preserveInteger`) may be omitted. */
export interface CodecManifestInput {
  version: 1;
  tables: Record<string, { columns: Record<string, z.input<typeof ColumnSpecSchema>>; primaryKey: string[] }>;
}

/** Validate and normalise a manifest. Throws `DbKitError('INVALID_MANIFEST')`; the message never quotes a value. */
export function parseCodecManifest(input: unknown): CodecManifest {
  const result = CodecManifestSchema.safeParse(input);
  if (result.success) return result.data;
  const detail = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
  throw new DbKitError('INVALID_MANIFEST', `invalid codec manifest: ${detail}`);
}
