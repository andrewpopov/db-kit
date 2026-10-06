import Database from 'better-sqlite3';
import type { CodecManifest } from '../codecs/manifest.js';
import type { IntrospectedSchema } from '../codecs/introspect.js';
import { quoteIdent } from './catalog.js';
import { refuse, type Refusal } from './errors.js';

export interface SourceTableFacts {
  table: string;
  rows: number;
  /** Sum of stored byte lengths of the copied columns: what the load will carry, before any codec or COPY framing. */
  estimatedBytes: number;
}

export interface SourceFacts {
  tables: SourceTableFacts[];
  refusals: Refusal[];
}

/** Open the verified snapshot read-only. Every statement reads 64-bit values as bigint. */
export function openSnapshot(path: string): Database.Database {
  try {
    const db = new Database(path, { readonly: true });
    db.defaultSafeIntegers(true);
    return db;
  } catch {
    return refuse({ code: 'source-read-failed' });
  }
}

const count = (value: unknown): number => Number(value ?? 0);

/**
 * One scan per table: row count, byte estimate, and a NUL check on every copied non-blob column. Postgres TEXT cannot
 * store U+0000, so a NUL byte in a stored string is refused here, naming table.column, instead of failing mid-load.
 * Tables or columns missing from the snapshot are left to manifest validation.
 */
export function scanSource(db: Database.Database, manifest: CodecManifest, schema: IntrospectedSchema): SourceFacts {
  const tables: SourceTableFacts[] = [];
  const refusals: Refusal[] = [];
  for (const [table, spec] of Object.entries(manifest.tables)) {
    const present = new Set((schema.get(table) ?? []).map((column) => column.name));
    const columns = Object.entries(spec.columns).filter(([name, column]) => present.has(name) && column.generated !== true);
    if (!schema.has(table)) continue;
    const bytes = columns.map(([name]) => `coalesce(length(cast(${quoteIdent(name)} as blob)), 0)`);
    const checked = columns.filter(([, column]) => column.codec !== 'blob');
    const flags = checked.map(([name], index) => `max(typeof(${quoteIdent(name)}) = 'text' and instr(cast(${quoteIdent(name)} as blob), x'00') > 0) as nul_${index}`);
    const select = ['count(*) as n', `${bytes.length > 0 ? `sum(${bytes.join(' + ')})` : '0'} as bytes`, ...flags].join(', ');
    let row: Record<string, unknown> | undefined;
    try {
      row = db.prepare(`select ${select} from ${quoteIdent(table)}`).get() as Record<string, unknown> | undefined;
    } catch {
      return refuse({ code: 'source-read-failed', table });
    }
    tables.push({ table, rows: count(row?.n), estimatedBytes: count(row?.bytes) });
    checked.forEach(([name], index) => {
      if (count(row?.[`nul_${index}`]) > 0) refusals.push({ code: 'source-nul-in-text', table, column: name });
    });
  }
  return { tables, refusals };
}

export interface SequenceSourceFacts {
  /** max and min of the column over the snapshot; null for an empty table. */
  highest: bigint | null;
  lowest: bigint | null;
  /** `sqlite_sequence.seq` for an AUTOINCREMENT table; null otherwise. */
  autoincrementHighWater: bigint | null;
}

function asBigInt(value: unknown, table: string, column: string): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value;
  return refuse({ code: 'sequence-out-of-range', table, column });
}

export function readSequenceSource(db: Database.Database, table: string, column: string): SequenceSourceFacts {
  const row = db.prepare(`select max(${quoteIdent(column)}) as hi, min(${quoteIdent(column)}) as lo from ${quoteIdent(table)}`).get() as { hi: unknown; lo: unknown };
  const hasSequenceTable = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'sqlite_sequence'").get() !== undefined;
  const water = hasSequenceTable ? (db.prepare('select seq from sqlite_sequence where name = ?').get(table) as { seq: unknown } | undefined) : undefined;
  return { highest: asBigInt(row.hi, table, column), lowest: asBigInt(row.lo, table, column), autoincrementHighWater: asBigInt(water?.seq, table, column) };
}

/**
 * The value `ALTER SEQUENCE ... RESTART WITH` must use (A4): the extreme in the sequence's own direction (max for
 * ascending, min for descending; AUTOINCREMENT's high-water counts for ascending) plus the increment. `null` means the
 * table is empty, so the sequence is restarted at its own start value. A result outside min/max is a refusal.
 */
export function restartValue(source: SequenceSourceFacts, sequence: { increment: bigint; min: bigint; max: bigint }): { restartWith: bigint | null; inRange: boolean } {
  const ascending = sequence.increment > 0n;
  let extreme = ascending ? source.highest : source.lowest;
  const water = source.autoincrementHighWater;
  if (ascending && water !== null && (extreme === null || water > extreme)) extreme = water;
  if (extreme === null) return { restartWith: null, inRange: true };
  const restartWith = extreme + sequence.increment;
  return { restartWith, inRange: restartWith >= sequence.min && restartWith <= sequence.max };
}
