import { describe, expect, it } from 'vitest';
import { DbKitError } from '../errors.js';
import type { IntrospectedColumn, IntrospectedSchema } from './introspect.js';
import { parseCodecManifest } from './manifest.js';
import { validateManifest } from './validate.js';

const items = { columns: { id: { codec: 'integer', nullable: false } }, primaryKey: ['id'] } as const;
const col = (name: string, type: string): IntrospectedColumn => ({ name, type, generated: false });
const schema = (tables: Record<string, IntrospectedColumn[]>): IntrospectedSchema => new Map(Object.entries(tables));

describe('copy:false tables', () => {
  it('parse into `skipped`, apart from the copied tables', () => {
    const manifest = parseCodecManifest({ version: 1, tables: { items, _prisma_migrations: { copy: false, reason: 'migration ledger' } } });
    expect(Object.keys(manifest.tables)).toEqual(['items']);
    expect(manifest.skipped).toEqual({ _prisma_migrations: { reason: 'migration ledger' } });
  });

  it('need a reason and nothing else (strict)', () => {
    for (const entry of [{ copy: false }, { copy: false, reason: '' }, { copy: false, reason: 'x', columns: {} }, { copy: true, reason: 'x' }]) {
      expect(() => parseCodecManifest({ version: 1, tables: { items, t: entry } }), JSON.stringify(entry)).toThrow(DbKitError);
    }
  });

  it('count as declared: an undeclared table is still an error, a skipped one is fine on either side or neither', () => {
    const manifest = parseCodecManifest({ version: 1, tables: { items, ledger: { copy: false, reason: 'ledger' } } });
    const both = validateManifest(manifest, { sqlite: schema({ items: [col('id', 'INTEGER')], ledger: [col('x', 'TEXT')] }), postgres: schema({ items: [col('id', 'bigint')], ledger: [col('x', 'text')] }) });
    expect(both.ok).toBe(true);
    const oneSide = validateManifest(manifest, { sqlite: schema({ items: [col('id', 'INTEGER')] }), postgres: schema({ items: [col('id', 'bigint')], ledger: [col('y', 'integer')] }) });
    expect(oneSide.ok).toBe(true);
    const undeclared = validateManifest(manifest, { sqlite: schema({ items: [col('id', 'INTEGER')], other: [col('x', 'TEXT')] }), postgres: schema({ items: [col('id', 'bigint')] }) });
    expect(undeclared.issues).toMatchObject([{ code: 'undeclared-table', table: 'other', side: 'sqlite' }]);
  });
});
