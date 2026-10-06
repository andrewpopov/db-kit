import { createHash } from 'node:crypto';
import { quoteIdent, TARGET_SCHEMA } from './catalog.js';
import { refuse } from './errors.js';
const HEADER = Buffer.from('db-kit clone row encoding v1\0');
const NULL_MARK = Buffer.from([0]);
const VALUE_MARK = Buffer.from([1]);
/**
 * Versioned, type-tagged, length-prefixed row encoding of the codecs' canonical forms: per column a tag byte (0 NULL,
 * 1 value) and, for a value, a 4-byte big-endian byte length and the UTF-8 canonical string. The framing makes
 * ("ab","c") and ("a","bc") different, and NULL different from the empty string.
 */
export function encodeRow(columns, values, dialect) {
    const parts = [];
    for (let i = 0; i < columns.length; i++) {
        const canonical = columns[i].canonical(values[i], dialect);
        if (canonical === null) {
            parts.push(NULL_MARK);
            continue;
        }
        const bytes = Buffer.from(canonical, 'utf8');
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(bytes.length);
        parts.push(VALUE_MARK, length, bytes);
    }
    return Buffer.concat(parts);
}
function digestRow(hash, row) {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(row.length);
    hash.update(length);
    hash.update(row);
}
const CURSOR = 'db_kit_verify';
/**
 * Compare one table row by row, in primary-key order, on two INDEPENDENT reads: the snapshot file through SQLite and
 * the target through a server-side cursor (bounded memory: one fetch batch). The first difference refuses naming
 * table (and column), never a value. The matched encodings are folded into a digest, which is the receipt.
 */
export async function verifyTable(options) {
    const { client, db, table, columns, fetchRows } = options;
    const names = columns.map((column) => quoteIdent(column.column)).join(', ');
    const source = db.prepare(`select ${names} from ${quoteIdent(table)} order by ${options.sqliteOrderBy}`).raw(true).iterate()[Symbol.iterator]();
    const pkIndexes = options.primaryKey.map((name) => columns.findIndex((column) => column.column === name));
    const sourceHash = createHash('sha256').update(HEADER);
    let rows = 0;
    let previousKey;
    const mismatch = (column) => refuse({ code: 'verification-mismatch', table, ...(column === undefined ? {} : { column }) });
    await client.query(`DECLARE ${CURSOR} NO SCROLL CURSOR FOR select ${names} from ${quoteIdent(TARGET_SCHEMA)}.${quoteIdent(table)} order by ${options.postgresOrderBy}`);
    try {
        for (;;) {
            const { rows: batch } = await client.query({ text: `FETCH FORWARD ${fetchRows} FROM ${CURSOR}`, rowMode: 'array' });
            if (batch.length === 0)
                break;
            for (const targetRow of batch) {
                const next = source.next();
                if (next.done === true)
                    return mismatch();
                const sourceRow = next.value;
                const sourceEncoded = encodeRow(columns, sourceRow, 'sqlite');
                const targetEncoded = encodeRow(columns, targetRow, 'postgres');
                if (!sourceEncoded.equals(targetEncoded)) {
                    const differing = columns.find((column, i) => encodeRow([column], [sourceRow[i]], 'sqlite').compare(encodeRow([column], [targetRow[i]], 'postgres')) !== 0);
                    return mismatch(differing?.column);
                }
                const key = encodeRow(pkIndexes.map((i) => columns[i]), pkIndexes.map((i) => sourceRow[i]), 'sqlite');
                if (previousKey?.equals(key))
                    return mismatch(options.primaryKey[0]);
                previousKey = key;
                digestRow(sourceHash, sourceEncoded);
                rows++;
            }
        }
        if (source.next().done !== true)
            return mismatch();
    }
    finally {
        source.return?.();
        await client.query(`CLOSE ${CURSOR}`).catch(() => undefined);
    }
    return { rows, sha256: sourceHash.digest('hex') };
}
