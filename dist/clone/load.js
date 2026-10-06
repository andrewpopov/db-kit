import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import { quoteIdent, TARGET_SCHEMA } from './catalog.js';
const SPECIAL = /[\\\t\n\r]/;
const ESCAPES = { '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' };
function escapeText(text) {
    return SPECIAL.test(text) ? text.replace(/[\\\t\n\r]/g, (char) => ESCAPES[char] ?? char) : text;
}
/**
 * One value in COPY text format. Backslash, tab, newline and CR are escaped, which also makes a literal `\N` or `\.`
 * in data harmless (its backslash becomes `\\`); NULL is the bare `\N`; bytea is `\\x` + hex (the escaped backslash
 * leaves `\x...` for the bytea input function); -0 keeps its sign.
 */
export function copyField(value) {
    if (value === null)
        return '\\N';
    switch (typeof value) {
        case 'string':
            return escapeText(value);
        case 'boolean':
            return value ? 't' : 'f';
        case 'bigint':
            return value.toString();
        case 'number':
            return Object.is(value, -0) ? '-0' : String(value);
        default:
            return `\\\\x${value.toString('hex')}`;
    }
}
/** Stream one table from the snapshot into Postgres with COPY. Memory is one chunk, never the table. Returns rows written. */
export async function loadTable(options) {
    const { client, db, table, columns, orderBy, batchBytes } = options;
    const select = db.prepare(`select ${columns.map((column) => quoteIdent(column.column)).join(', ')} from ${quoteIdent(table)} order by ${orderBy}`).raw(true);
    let rows = 0;
    async function* chunks() {
        let lines = [];
        let size = 0;
        for (const row of select.iterate()) {
            const fields = new Array(columns.length);
            for (let i = 0; i < columns.length; i++)
                fields[i] = copyField(columns[i].toPostgres(row[i]));
            const line = `${fields.join('\t')}\n`;
            lines.push(line);
            size += line.length;
            rows++;
            if (size >= batchBytes) {
                yield lines.join('');
                lines = [];
                size = 0;
            }
        }
        if (lines.length > 0)
            yield lines.join('');
    }
    const sql = `COPY ${quoteIdent(TARGET_SCHEMA)}.${quoteIdent(table)} (${columns.map((column) => quoteIdent(column.column)).join(', ')}) FROM STDIN`;
    await pipeline(Readable.from(chunks(), { objectMode: false }), client.query(copyFrom(sql)));
    return rows;
}
