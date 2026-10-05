import { type CustomTypesConfig } from 'pg';
/**
 * `types` option for a `pg` query/client so reads match what the codecs expect: timestamptz and json/jsonb
 * come back as raw text. `int8`, `numeric`, `uuid` and `bytea` already arrive as string/string/string/Buffer.
 *   pool.query({ text, values, types: POSTGRES_CODEC_TYPES })
 */
export declare const POSTGRES_CODEC_TYPES: CustomTypesConfig;
