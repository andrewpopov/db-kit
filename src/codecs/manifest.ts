import { z } from 'zod';
import { DbKitError } from '../errors.js';

const columnFields = {
  /** Required on purpose: NULL handling is never a default. */
  nullable: z.boolean(),
  /** A generated column is verified, not copied: the target computes it. */
  generated: z.boolean().optional(),
};

const DATETIME_TEXT_MESSAGE = { message: 'acceptSqliteDatetimeText only makes sense with preserveInteger: false (the column is converted to timestamptz)', path: ['acceptSqliteDatetimeText'] };
const datetimeTextNeedsConversion = (spec: { preserveInteger: boolean; acceptSqliteDatetimeText: boolean }): boolean => !(spec.acceptSqliteDatetimeText && spec.preserveInteger);

const JSON_PG_TYPE_MESSAGE = { message: 'pgType and preserveText disagree (preserveText: true means text, false means jsonb); declare only pgType', path: ['pgType'] };
const jsonOptionsAgree = (spec: { pgType?: 'text' | 'json' | 'jsonb' | undefined; preserveText?: boolean | undefined }): boolean =>
  spec.pgType === undefined || spec.preserveText === undefined || (spec.preserveText ? spec.pgType === 'text' : spec.pgType === 'jsonb');

/** Discriminated on `codec`. Nothing is inferred: every column declares its logical type. */
export const ColumnSpecSchema = z.discriminatedUnion('codec', [
  z.strictObject({ codec: z.literal('text'), ...columnFields }),
  z.strictObject({ codec: z.literal('integer'), ...columnFields }),
  z.strictObject({ codec: z.literal('bigint'), ...columnFields }),
  z.strictObject({ codec: z.literal('real'), ...columnFields }),
  z.strictObject({ codec: z.literal('decimal-as-string'), acceptSqliteNumeric: z.boolean().default(false), ...columnFields }),
  z.strictObject({ codec: z.literal('boolean'), ...columnFields }),
  z.strictObject({ codec: z.literal('timestamp-iso'), preserveText: z.boolean().default(true), ...columnFields }),
  z.strictObject({ codec: z.literal('timestamp-epoch-s'), preserveInteger: z.boolean().default(true), acceptSqliteDatetimeText: z.boolean().default(false), ...columnFields }).refine(datetimeTextNeedsConversion, DATETIME_TEXT_MESSAGE),
  z.strictObject({ codec: z.literal('timestamp-epoch-ms'), preserveInteger: z.boolean().default(true), acceptSqliteDatetimeText: z.boolean().default(false), ...columnFields }).refine(datetimeTextNeedsConversion, DATETIME_TEXT_MESSAGE),
  z.strictObject({ codec: z.literal('json-text'), preserveText: z.boolean().optional(), pgType: z.enum(['text', 'json', 'jsonb']).optional(), ...columnFields }).refine(jsonOptionsAgree, JSON_PG_TYPE_MESSAGE),
  z.strictObject({ codec: z.literal('timestamp-naive'), ...columnFields }),
  z.strictObject({ codec: z.literal('date-text'), ...columnFields }),
  z.strictObject({ codec: z.literal('blob'), ...columnFields }),
  z.strictObject({ codec: z.literal('uuid-text'), ...columnFields }),
]);

/** The Postgres column type a `json-text` column maps to: `pgType`, else `preserveText` (default true -> text, false -> jsonb). */
export function jsonPgType(spec: { pgType?: 'text' | 'json' | 'jsonb' | undefined; preserveText?: boolean | undefined }): 'text' | 'json' | 'jsonb' {
  return spec.pgType ?? (spec.preserveText === false ? 'jsonb' : 'text');
}

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

/** A table that exists (or may exist) but is never copied or verified: a migration ledger, a derived search table. Still declared, so an UNDECLARED table stays an error. */
export const SkippedTableSchema = z.strictObject({ copy: z.literal(false), reason: z.string().min(1, 'a skipped table needs a reason') });

/** Picks the schema by shape (a `copy` key means a skipped table) rather than `z.union`, so a bad column reports ITS message, not "Invalid input". */
const TableEntrySchema = z.unknown().transform((entry, ctx): z.output<typeof SkippedTableSchema> | z.output<typeof TableSpecSchema> => {
  const skipped = typeof entry === 'object' && entry !== null && 'copy' in entry;
  const parsed = (skipped ? SkippedTableSchema : TableSpecSchema).safeParse(entry);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
  return z.NEVER;
});

const RawManifestSchema = z.strictObject({
  version: z.literal(1),
  tables: ownRecord(TableEntrySchema),
});

/** `tables` holds the copied tables; a `{ copy: false, reason }` entry moves to `skipped`. */
export const CodecManifestSchema = RawManifestSchema.transform((raw) => {
  const tables: Record<string, z.output<typeof TableSpecSchema>> = {};
  const skipped: Record<string, { reason: string }> = {};
  for (const [name, entry] of Object.entries(raw.tables)) {
    const target = 'copy' in entry ? skipped : tables;
    Object.defineProperty(target, name, { value: 'copy' in entry ? { reason: entry.reason } : entry, enumerable: true, writable: true, configurable: true });
  }
  return { version: raw.version, tables, skipped };
});

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
  tables: Record<string, TableInput | { copy: false; reason: string }>;
}

/** Validate and normalise a manifest. Throws `DbKitError('INVALID_MANIFEST')`; the message never quotes a value. */
export function parseCodecManifest(input: unknown): CodecManifest {
  const result = CodecManifestSchema.safeParse(input);
  if (result.success) return result.data;
  const detail = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
  throw new DbKitError('INVALID_MANIFEST', `invalid codec manifest: ${detail}`);
}
