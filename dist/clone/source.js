import Database from 'better-sqlite3';
import { quoteIdent } from './catalog.js';
import { readsText, textAsBytes } from './text-read.js';
import { isUtf8 } from 'node:buffer';
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
        for (const name of invalidUtf8Columns(db, table, columns))
            refusals.push({ code: 'source-invalid-utf8', table, column: name });
        checked.forEach(([name], index) => {
            if (count(row?.[`nul_${index}`]) > 0)
                refusals.push({ code: 'source-nul-in-text', table, column: name });
        });
    }
    return { tables, refusals };
}
/** A second pass over the text columns' stored bytes: SQL cannot validate UTF-8, and a lossy decode would verify against itself. */
function invalidUtf8Columns(db, table, columns) {
    const text = columns.filter(([, column]) => readsText(column.codec));
    if (text.length === 0)
        return [];
    const bad = new Set();
    const select = db.prepare(`select ${text.map(([name]) => textAsBytes(name)).join(', ')} from ${quoteIdent(table)}`).raw(true);
    try {
        for (const row of select.iterate()) {
            for (let i = 0; i < text.length; i++)
                if (!bad.has(i) && Buffer.isBuffer(row[i]) && !isUtf8(row[i]))
                    bad.add(i);
            if (bad.size === text.length)
                break;
        }
    }
    catch {
        return refuse({ code: 'source-read-failed', table });
    }
    return text.flatMap(([name], i) => (bad.has(i) ? [name] : []));
}
/**
 * Foreign keys the SQLite schema itself declares between a copied table and a `copy: false` one, in either direction:
 * Postgres may not have that key, but the relationship would still dangle once one side is never copied.
 */
export function sqliteSkippedKeyRefusals(db, manifest, schema) {
    const refusals = [];
    const keys = db.prepare('select "table" as ref from pragma_foreign_key_list(?)').safeIntegers(false);
    for (const name of schema.keys()) {
        const copied = Object.hasOwn(manifest.tables, name);
        const skipped = Object.hasOwn(manifest.skipped, name);
        if (!copied && !skipped)
            continue;
        for (const { ref } of keys.all(name)) {
            if (copied && Object.hasOwn(manifest.skipped, ref))
                refusals.push({ code: 'foreign-key-to-skipped-table', table: name, object: `${name}->${ref}` });
            if (skipped && Object.hasOwn(manifest.tables, ref))
                refusals.push({ code: 'foreign-key-to-skipped-table', table: ref, object: `${name}->${ref}` });
        }
    }
    return refusals;
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
