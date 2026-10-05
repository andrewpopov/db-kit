import { types } from 'pg';
const RAW_TEXT_OIDS = new Set([
    types.builtins.TIMESTAMPTZ, // the default parser rounds to milliseconds
    types.builtins.JSON, // the default parser would hand codecs a parsed value, not the document text
    types.builtins.JSONB,
]);
/**
 * `types` option for a `pg` query/client so reads match what the codecs expect: timestamptz and json/jsonb
 * come back as raw text. `int8`, `numeric`, `uuid` and `bytea` already arrive as string/string/string/Buffer.
 *   pool.query({ text, values, types: POSTGRES_CODEC_TYPES })
 */
export const POSTGRES_CODEC_TYPES = {
    getTypeParser: (oid, format) => (RAW_TEXT_OIDS.has(oid) ? (text) => text : types.getTypeParser(oid, format)),
};
