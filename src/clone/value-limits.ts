import type Database from 'better-sqlite3';
import type { IntrospectedSchema } from '../codecs/introspect.js';
import type { CodecManifest } from '../codecs/manifest.js';
import { quoteIdent, TARGET_SCHEMA, type ForeignKeyFact } from './catalog.js';
import { refuse, type Refusal } from './errors.js';

/** Inclusive range of each Postgres integer type a clone may target; SQLite INTEGER is 64-bit, so a narrower target can overflow mid-COPY. */
const INTEGER_RANGES: Readonly<Record<string, readonly [bigint, bigint]>> = {
  smallint: [-(2n ** 15n), 2n ** 15n - 1n],
  integer: [-(2n ** 31n), 2n ** 31n - 1n],
  bigint: [-(2n ** 63n), 2n ** 63n - 1n],
};
const INTEGER_CODECS: ReadonlySet<string> = new Set(['integer', 'bigint']);

const asBigint = (value: unknown): bigint | null => (typeof value === 'bigint' ? value : null);

/**
 * What the target's own column limits and constraints would reject mid-load, found on the snapshot instead: a value
 * longer than a `character varying(n)`, an integer outside the target's int2/int4/int8 range, and a child row with no
 * parent for a foreign key clone drops and re-adds (SQLite never enforced it if `PRAGMA foreign_keys` was off).
 * One aggregate scan per table and one anti-join per key. Counts and bounds are reported, never a value.
 * `db` must read integers as bigint (`openSnapshot`).
 */
export function sourceLimitRefusals(db: Database.Database, manifest: CodecManifest, postgres: IntrospectedSchema, foreignKeys: readonly ForeignKeyFact[]): Refusal[] {
  return [...columnLimitRefusals(db, manifest, postgres), ...orphanRefusals(db, manifest, foreignKeys)];
}

function columnLimitRefusals(db: Database.Database, manifest: CodecManifest, postgres: IntrospectedSchema): Refusal[] {
  const refusals: Refusal[] = [];
  for (const [table, spec] of Object.entries(manifest.tables)) {
    const targetColumns = new Map((postgres.get(table) ?? []).map((column) => [column.name, column]));
    const selects: string[] = [];
    const checks: ((row: Record<string, unknown>) => void)[] = [];
    Object.entries(spec.columns).forEach(([name, column], index) => {
      const target = targetColumns.get(name);
      if (!target || column.generated === true) return;
      const quoted = quoteIdent(name);
      const limit = target.maxLength;
      if (limit !== undefined) {
        selects.push(`coalesce(sum(typeof(${quoted}) = 'text' and length(${quoted}) > ${limit}), 0) as over_${index}`, `max(case when typeof(${quoted}) = 'text' then length(${quoted}) end) as longest_${index}`);
        checks.push((row) => {
          const over = Number(row[`over_${index}`] ?? 0);
          if (over > 0) refusals.push({ code: 'varchar-overflow', table, column: name, object: `max ${limit} chars, ${over} rows over, longest ${String(row[`longest_${index}`])}` });
        });
      }
      const range = INTEGER_CODECS.has(column.codec) ? INTEGER_RANGES[target.type] : undefined;
      if (range) {
        selects.push(`min(case when typeof(${quoted}) = 'integer' then ${quoted} end) as lo_${index}`, `max(case when typeof(${quoted}) = 'integer' then ${quoted} end) as hi_${index}`);
        checks.push((row) => {
          const lo = asBigint(row[`lo_${index}`]);
          const hi = asBigint(row[`hi_${index}`]);
          if (lo !== null && lo < range[0]) refusals.push({ code: 'integer-width', table, column: name, object: `${target.type}, min ${lo}` });
          if (hi !== null && hi > range[1]) refusals.push({ code: 'integer-width', table, column: name, object: `${target.type}, max ${hi}` });
        });
      }
    });
    if (selects.length === 0) continue;
    let row: Record<string, unknown>;
    try {
      row = db.prepare(`select ${selects.join(', ')} from ${quoteIdent(table)}`).get() as Record<string, unknown>;
    } catch {
      return refuse({ code: 'source-read-failed', table });
    }
    for (const check of checks) check(row);
  }
  return refusals;
}

/** MATCH SIMPLE: a child row with any NULL key column is not checked. Keys between copied tables only; skipped tables are refused elsewhere. */
function orphanRefusals(db: Database.Database, manifest: CodecManifest, foreignKeys: readonly ForeignKeyFact[]): Refusal[] {
  const refusals: Refusal[] = [];
  for (const fk of foreignKeys) {
    const copied = (schema: string, table: string): boolean => schema === TARGET_SCHEMA && Object.hasOwn(manifest.tables, table);
    if (!copied(fk.tableSchema, fk.table) || !copied(fk.refSchema, fk.refTable)) continue;
    const present = fk.columns.map((column) => `c.${quoteIdent(column)} is not null`).join(' and ');
    const match = fk.columns.map((column, index) => `p.${quoteIdent(fk.refColumns[index] ?? '')} = c.${quoteIdent(column)}`).join(' and ');
    let orphans: unknown;
    try {
      orphans = (db.prepare(`select count(*) as n from ${quoteIdent(fk.table)} c where ${present} and not exists (select 1 from ${quoteIdent(fk.refTable)} p where ${match})`).get() as { n: unknown }).n;
    } catch {
      return refuse({ code: 'source-read-failed', table: fk.table });
    }
    if (Number(orphans) > 0) refusals.push({ code: 'orphan-foreign-keys', table: fk.table, object: `${fk.name} -> ${fk.refTable}, ${Number(orphans)} rows` });
  }
  return refusals;
}
