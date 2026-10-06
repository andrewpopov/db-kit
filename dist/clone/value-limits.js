import { quoteIdent, TARGET_SCHEMA } from './catalog.js';
import { refuse } from './errors.js';
/** Inclusive range of each Postgres integer type a clone may target; SQLite INTEGER is 64-bit, so a narrower target can overflow mid-COPY. */
const INTEGER_RANGES = {
    smallint: [-(2n ** 15n), 2n ** 15n - 1n],
    integer: [-(2n ** 31n), 2n ** 31n - 1n],
    bigint: [-(2n ** 63n), 2n ** 63n - 1n],
};
const INTEGER_CODECS = new Set(['integer', 'bigint']);
/** The values the integer/bigint codecs accept: INTEGER storage, or TEXT that is a plain decimal integer (`toBigInt`). A REAL fails codec validation with its own error. SQLite saturates a cast past int64; the codec refuses those at load. */
const acceptedInteger = (quoted) => `case typeof(${quoted}) when 'integer' then ${quoted} when 'text' then case when ${quoted} glob '[0-9]*' or ${quoted} glob '-[0-9]*' then case when substr(${quoted}, 1 + (${quoted} glob '-*')) not glob '*[^0-9]*' then cast(${quoted} as integer) end end end`;
const asBigint = (value) => (typeof value === 'bigint' ? value : null);
/**
 * What the target's own column limits and constraints would reject mid-load, found on the snapshot instead: a value
 * longer than a `character varying(n)`, an integer outside the target's int2/int4/int8 range, and a child row with no
 * parent for a foreign key clone drops and re-adds (SQLite never enforced it if `PRAGMA foreign_keys` was off).
 * One aggregate scan per table and one anti-join per key. Counts and bounds are reported, never a value.
 * `db` must read integers as bigint (`openSnapshot`).
 */
export function sourceLimitRefusals(db, manifest, postgres, foreignKeys) {
    const columns = columnLimitRefusals(db, manifest, postgres);
    const orphans = orphanChecks(db, manifest, foreignKeys);
    return { refusals: [...columns, ...orphans.refusals], skipped: orphans.skipped };
}
function columnLimitRefusals(db, manifest, postgres) {
    const refusals = [];
    for (const [table, spec] of Object.entries(manifest.tables)) {
        const targetColumns = new Map((postgres.get(table) ?? []).map((column) => [column.name, column]));
        const selects = [];
        const checks = [];
        Object.entries(spec.columns).forEach(([name, column], index) => {
            const target = targetColumns.get(name);
            if (!target || column.generated === true)
                return;
            const quoted = quoteIdent(name);
            const limit = target.maxLength;
            if (limit !== undefined) {
                selects.push(`coalesce(sum(typeof(${quoted}) = 'text' and length(${quoted}) > ${limit}), 0) as over_${index}`, `max(case when typeof(${quoted}) = 'text' then length(${quoted}) end) as longest_${index}`);
                checks.push((row) => {
                    const over = Number(row[`over_${index}`] ?? 0);
                    if (over > 0)
                        refusals.push({ code: 'varchar-overflow', table, column: name, object: `max ${limit} chars, ${over} rows over, longest ${String(row[`longest_${index}`])}` });
                });
            }
            const range = INTEGER_CODECS.has(column.codec) ? INTEGER_RANGES[target.type] : undefined;
            if (range) {
                const accepted = acceptedInteger(quoted);
                selects.push(`min(${accepted}) as lo_${index}`, `max(${accepted}) as hi_${index}`);
                checks.push((row) => {
                    const lo = asBigint(row[`lo_${index}`]);
                    const hi = asBigint(row[`hi_${index}`]);
                    if (lo !== null && lo < range[0])
                        refusals.push({ code: 'integer-width', table, column: name, object: `${target.type}, min ${lo}` });
                    if (hi !== null && hi > range[1])
                        refusals.push({ code: 'integer-width', table, column: name, object: `${target.type}, max ${hi}` });
                });
            }
        });
        if (selects.length === 0)
            continue;
        let row;
        try {
            row = db.prepare(`select ${selects.join(', ')} from ${quoteIdent(table)}`).get();
        }
        catch {
            return refuse({ code: 'source-read-failed', table });
        }
        for (const check of checks)
            check(row);
    }
    return refusals;
}
/**
 * MATCH SIMPLE: a child row with any NULL key column is not checked. Keys between copied tables only; skipped tables are refused elsewhere.
 * SQLite equality is not Postgres equality (affinity, collation, codec conversion), so a key is checked only when raw comparison provably equals it:
 * integer/bigint codecs on both sides with every value INTEGER-stored, or text codecs on both sides with every value TEXT-stored, compared `COLLATE BINARY`
 * (Postgres text equality is byte equality). Anything else is reported as skipped.
 */
function orphanChecks(db, manifest, foreignKeys) {
    const result = { refusals: [], skipped: [] };
    const copied = (schema, table) => schema === TARGET_SCHEMA && Object.hasOwn(manifest.tables, table);
    for (const fk of foreignKeys) {
        if (!copied(fk.tableSchema, fk.table) || !copied(fk.refSchema, fk.refTable))
            continue;
        const skip = (reason) => void result.skipped.push({ code: 'orphan-check-skipped', table: fk.table, object: `${fk.name} -> ${fk.refTable}: ${reason}` });
        const kinds = fk.columns.map((column, index) => {
            const child = manifest.tables[fk.table]?.columns[column]?.codec;
            const parent = manifest.tables[fk.refTable]?.columns[fk.refColumns[index] ?? '']?.codec;
            return { child, parent, kind: compareKind(child) === compareKind(parent) ? compareKind(child) : undefined };
        });
        const unsafe = kinds.find((pair) => pair.kind === undefined);
        if (unsafe) {
            skip(`codecs ${unsafe.child ?? '?'} / ${unsafe.parent ?? '?'} are not compared by raw equality`);
            continue;
        }
        try {
            if (hasForeignStorage(db, fk, kinds.map((pair) => pair.kind))) {
                skip('a key column holds values stored in another SQLite type than its codec reads');
                continue;
            }
            const orphans = Number(db.prepare(orphanCountSql(fk, kinds.map((pair) => pair.kind))).get().n);
            if (orphans > 0)
                result.refusals.push({ code: 'orphan-foreign-keys', table: fk.table, object: `${fk.name} -> ${fk.refTable}, ${orphans} rows` });
        }
        catch {
            return { refusals: refuse({ code: 'source-read-failed', table: fk.table }), skipped: result.skipped };
        }
    }
    return result;
}
function compareKind(codec) {
    if (codec === 'integer' || codec === 'bigint')
        return 'integer';
    return codec === 'text' ? 'text' : undefined;
}
const STORAGE_CLASS = { integer: 'integer', text: 'text' };
function hasForeignStorage(db, fk, kinds) {
    const side = (table, columns) => columns.map((column, index) => `(select count(*) from ${quoteIdent(table)} where typeof(${quoteIdent(column)}) not in ('null', '${STORAGE_CLASS[kinds[index]]}'))`);
    const sql = `select ${[...side(fk.table, fk.columns), ...side(fk.refTable, fk.refColumns)].join(' + ')} as n`;
    return Number(db.prepare(sql).get().n) > 0;
}
/** A LEFT JOIN, not a correlated `NOT EXISTS`: SQLite builds an automatic index on the parent side, so the scan is linear even when the parent key has no index. */
export function orphanCountSql(fk, kinds) {
    const present = fk.columns.map((column) => `c.${quoteIdent(column)} is not null`).join(' and ');
    const match = fk.columns.map((column, index) => `p.${quoteIdent(fk.refColumns[index] ?? '')} = c.${quoteIdent(column)}${kinds[index] === 'text' ? ' collate binary' : ''}`).join(' and ');
    const firstParent = `p.${quoteIdent(fk.refColumns[0] ?? '')}`;
    return `select count(*) as n from ${quoteIdent(fk.table)} c left join ${quoteIdent(fk.refTable)} p on ${match} where ${present} and ${firstParent} is null`;
}
