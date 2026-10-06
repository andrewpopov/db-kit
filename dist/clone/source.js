import Database from 'better-sqlite3';
import { quoteIdent } from './catalog.js';
import { refuse } from './errors.js';
/** Open the verified snapshot read-only. Every statement reads 64-bit values as bigint. */
export function openSnapshot(path) {
    try {
        const db = new Database(path, { readonly: true });
        db.defaultSafeIntegers(true);
        return db;
    }
    catch {
        return refuse({ code: 'source-read-failed' });
    }
}
const count = (value) => Number(value ?? 0);
/**
 * One scan per table: row count, byte estimate, and a NUL check on every copied non-blob column. Postgres TEXT cannot
 * store U+0000, so a NUL byte in a stored string is refused here, naming table.column, instead of failing mid-load.
 * Tables or columns missing from the snapshot are left to manifest validation.
 */
export function scanSource(db, manifest, schema) {
    const tables = [];
    const refusals = [];
    for (const [table, spec] of Object.entries(manifest.tables)) {
        const present = new Set((schema.get(table) ?? []).map((column) => column.name));
        const columns = Object.entries(spec.columns).filter(([name, column]) => present.has(name) && column.generated !== true);
        if (!schema.has(table))
            continue;
        const bytes = columns.map(([name]) => `coalesce(length(cast(${quoteIdent(name)} as blob)), 0)`);
        const checked = columns.filter(([, column]) => column.codec !== 'blob');
        const flags = checked.map(([name], index) => `max(typeof(${quoteIdent(name)}) = 'text' and instr(cast(${quoteIdent(name)} as blob), x'00') > 0) as nul_${index}`);
        const select = ['count(*) as n', `${bytes.length > 0 ? `sum(${bytes.join(' + ')})` : '0'} as bytes`, ...flags].join(', ');
        let row;
        try {
            row = db.prepare(`select ${select} from ${quoteIdent(table)}`).get();
        }
        catch {
            return refuse({ code: 'source-read-failed', table });
        }
        tables.push({ table, rows: count(row?.n), estimatedBytes: count(row?.bytes) });
        checked.forEach(([name], index) => {
            if (count(row?.[`nul_${index}`]) > 0)
                refusals.push({ code: 'source-nul-in-text', table, column: name });
        });
    }
    return { tables, refusals };
}
function asBigInt(value, table, column) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === 'bigint')
        return value;
    return refuse({ code: 'sequence-out-of-range', table, column });
}
export function readSequenceSource(db, table, column) {
    const row = db.prepare(`select max(${quoteIdent(column)}) as hi, min(${quoteIdent(column)}) as lo from ${quoteIdent(table)}`).get();
    const hasSequenceTable = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'sqlite_sequence'").get() !== undefined;
    const water = hasSequenceTable ? db.prepare('select seq from sqlite_sequence where name = ?').get(table) : undefined;
    return { highest: asBigInt(row.hi, table, column), lowest: asBigInt(row.lo, table, column), autoincrementHighWater: asBigInt(water?.seq, table, column) };
}
/**
 * The value `ALTER SEQUENCE ... RESTART WITH` must use (A4): the extreme in the sequence's own direction (max for
 * ascending, min for descending; AUTOINCREMENT's high-water counts for ascending) plus the increment. `null` means the
 * table is empty, so the sequence is restarted at its own start value. A result outside min/max is a refusal.
 */
export function restartValue(source, sequence) {
    const ascending = sequence.increment > 0n;
    let extreme = ascending ? source.highest : source.lowest;
    const water = source.autoincrementHighWater;
    if (ascending && water !== null && (extreme === null || water > extreme))
        extreme = water;
    if (extreme === null)
        return { restartWith: null, inRange: true };
    const restartWith = extreme + sequence.increment;
    return { restartWith, inRange: restartWith >= sequence.min && restartWith <= sequence.max };
}
