import { types, type CustomTypesConfig } from 'pg';

const RAW_TEXT_OIDS: ReadonlySet<number> = new Set([
  types.builtins.TIMESTAMPTZ, // the default parser rounds to milliseconds
  types.builtins.TIMESTAMP, // the default parser builds a local-time Date, rounded to milliseconds
  types.builtins.DATE, // the default parser builds a local-midnight Date
  types.builtins.JSON, // the default parser would hand codecs a parsed value, not the document text
  types.builtins.JSONB,
]);

/**
 * `types` option for a `pg` query/client so reads match what the codecs expect: timestamp, timestamptz, date and json/jsonb
 * come back as raw text. Open the handle with `codecSession: true` so that text is UTC, ISO-formatted. `int8`, `numeric`, `uuid` and `bytea` already arrive as string/string/string/Buffer.
 *   pool.query({ text, values, types: POSTGRES_CODEC_TYPES })
 */
export const POSTGRES_CODEC_TYPES: CustomTypesConfig = {
  getTypeParser: (oid, format) => (RAW_TEXT_OIDS.has(oid) ? (text: string) => text : types.getTypeParser(oid, format)),
};
