const CAST = /::(?:character varying|timestamp with time zone|timestamp without time zone|time with time zone|time without time zone|double precision)|::[a-z_0-9]+(?:\[\])?(?:\(\d+(?:,\d+)?\))?/g;
/** Text of an expression or predicate with everything that is spelling, not meaning: case, quotes, whitespace, parentheses and Postgres casts. */
export function normalizeExpression(text) {
    return text.toLowerCase().replaceAll('"', '').replace(CAST, '').replace(/[\s()]+/g, '');
}
/** The text inside the first balanced parentheses at or after `from`, and what follows the closing one. */
function balanced(text, from) {
    const open = text.indexOf('(', from);
    if (open < 0)
        return undefined;
    let depth = 0;
    let quote;
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === quote)
                quote = undefined;
        }
        else if (c === "'" || c === '"')
            quote = c;
        else if (c === '(')
            depth++;
        else if (c === ')' && --depth === 0)
            return { inside: text.slice(open + 1, i), rest: text.slice(i + 1) };
    }
    return undefined;
}
/** `((x))` -> `x`, only while one pair of parentheses wraps the whole text. */
function unwrap(text) {
    let current = text.trim();
    for (;;) {
        const parsed = current.startsWith('(') ? balanced(current, 0) : undefined;
        if (!parsed || parsed.rest.trim() !== '')
            return current;
        current = parsed.inside.trim();
    }
}
function splitTopLevel(text) {
    const parts = [];
    let depth = 0;
    let quote;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === quote)
                quote = undefined;
        }
        else if (c === "'" || c === '"')
            quote = c;
        else if (c === '(')
            depth++;
        else if (c === ')')
            depth--;
        else if (c === ',' && depth === 0) {
            parts.push(text.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(text.slice(start));
    return parts;
}
const entryOf = (entry) => normalizeExpression(entry.trim().replace(/\s+asc$/i, ''));
const PLAIN = /^[a-z_][a-z0-9_]*$/;
/** `CREATE [UNIQUE] INDEX n ON t [USING m] (entries) [WHERE predicate]`, from either dialect's text. */
function parseIndexSql(sql) {
    const using = /\busing\s+([a-z_]+)/i.exec(sql);
    const parsed = balanced(sql, using ? using.index + using[0].length : sql.search(/\bon\b/i));
    if (!parsed)
        return undefined;
    const where = /\bwhere\b([\s\S]*)$/i.exec(parsed.rest);
    return { entries: splitTopLevel(parsed.inside).map(entryOf), predicate: where?.[1] ? normalizeExpression(where[1]) : '', method: using?.[1]?.toLowerCase() ?? 'btree' };
}
/** A unique index with only plain columns and no predicate is the same thing as a UNIQUE constraint; anything else is a signature of its own. */
function classifyIndex(model, name, unique, parsed) {
    if (unique && !parsed.predicate && parsed.method === 'btree' && parsed.entries.every((entry) => PLAIN.test(entry))) {
        model.uniques.set(parsed.entries.join(','), name);
        return;
    }
    model.indexes.set(`${unique ? 'unique ' : ''}${parsed.method === 'btree' ? '' : `${parsed.method} `}(${parsed.entries.join(', ')})${parsed.predicate ? ` where ${parsed.predicate}` : ''}`, name);
}
function sqliteClass(declared) {
    const t = declared.toUpperCase();
    if (t.includes('BOOL'))
        return 'boolean';
    if (t.includes('DATE') || t.includes('TIME'))
        return 'datetime';
    if (t.includes('JSON'))
        return 'json';
    if (t.includes('UUID'))
        return 'uuid';
    if (t.includes('INT'))
        return 'integer';
    if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT'))
        return 'text';
    if (t === '' || t.includes('BLOB'))
        return 'blob';
    if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB'))
        return 'real';
    return 'numeric';
}
function postgresClass(formatted) {
    const t = formatted.toLowerCase();
    if (t === 'boolean')
        return 'boolean';
    if (t === 'smallint' || t === 'integer' || t === 'bigint')
        return 'integer';
    if (t.startsWith('numeric') || t === 'money')
        return 'numeric';
    if (t === 'real' || t === 'double precision')
        return 'real';
    if (t === 'text' || t.startsWith('character') || t === 'name' || t === 'citext')
        return 'text';
    if (t === 'uuid')
        return 'uuid';
    if (t === 'json' || t === 'jsonb')
        return 'json';
    if (t.startsWith('timestamp') || t.startsWith('time') || t === 'date')
        return 'datetime';
    if (t === 'bytea')
        return 'blob';
    return 'other';
}
function readSqlite(handle) {
    const db = handle.db;
    const model = new Map();
    const tables = db.prepare("select name, sql from sqlite_master where type = 'table' and name not like 'sqlite\\_%' escape '\\' order by name").safeIntegers(false).all();
    for (const { name, sql } of tables) {
        const table = { columns: new Map(), primaryKey: [], uniques: new Map(), indexes: new Map(), checks: new Map() };
        const columns = db.prepare('select name, type, "notnull", dflt_value, pk, hidden from pragma_table_xinfo(?)').safeIntegers(false).all(name);
        table.primaryKey = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
        for (const c of columns.filter((c) => c.hidden !== 1)) {
            table.columns.set(c.name, { rawType: c.type, type: sqliteClass(c.type), notNull: c.notnull === 1 || c.pk > 0, hasDefault: c.hidden < 2 && c.dflt_value !== null });
        }
        const indexes = db.prepare('select name, "unique", origin from pragma_index_list(?)').safeIntegers(false).all(name);
        for (const index of indexes.filter((i) => i.origin !== 'pk')) {
            const indexSql = (db.prepare("select sql from sqlite_master where type = 'index' and name = ?").get(index.name))?.sql;
            if (indexSql) {
                const parsed = parseIndexSql(indexSql);
                if (parsed)
                    classifyIndex(table, index.name, index.unique === 1, parsed);
            }
            else {
                const cols = db.prepare('select name from pragma_index_info(?) order by seqno').all(index.name).map((c) => normalizeExpression(c.name));
                table.uniques.set(cols.join(','), index.name);
            }
        }
        for (const match of sql.matchAll(/\bcheck\s*\(/gi)) {
            const expression = balanced(sql, match.index)?.inside;
            if (expression)
                table.checks.set(normalizeExpression(expression), unwrap(expression));
        }
        model.set(name, table);
    }
    return model;
}
async function readPostgres(handle, schema) {
    const { pool } = handle;
    const model = new Map();
    const tables = await pool.query(`select c.oid::int as oid, c.relname::text as name from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind in ('r', 'p') order by 1`, [schema]);
    for (const { oid, name } of tables.rows) {
        const table = { columns: new Map(), primaryKey: [], uniques: new Map(), indexes: new Map(), checks: new Map() };
        const columns = await pool.query(`select a.attname::text as name, pg_catalog.format_type(a.atttypid, null) as type, a.attnotnull as not_null,
              (ad.adbin is not null and a.attgenerated = '' and a.attidentity = '' and pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) not like 'nextval(%') as has_default
         from pg_catalog.pg_attribute a left join pg_catalog.pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
        where a.attrelid = $1::oid and a.attnum > 0 and not a.attisdropped order by a.attnum`, [oid]);
        for (const c of columns.rows)
            table.columns.set(c.name, { rawType: c.type, type: postgresClass(c.type), notNull: c.not_null, hasDefault: c.has_default });
        const pk = await pool.query(`select array(select a.attname::text from unnest(k.conkey) with ordinality u(attnum, ord) join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum order by u.ord) as cols
         from pg_catalog.pg_constraint k where k.conrelid = $1::oid and k.contype = 'p'`, [oid]);
        table.primaryKey = pk.rows[0]?.cols ?? [];
        const indexes = await pool.query(`select ic.relname::text as name, pg_catalog.pg_get_indexdef(i.indexrelid) as def, i.indisunique as unique
         from pg_catalog.pg_index i join pg_catalog.pg_class ic on ic.oid = i.indexrelid where i.indrelid = $1::oid and not i.indisprimary order by 1`, [oid]);
        for (const index of indexes.rows) {
            const parsed = parseIndexSql(index.def);
            if (parsed)
                classifyIndex(table, index.name, index.unique, parsed);
        }
        const checks = await pool.query("select pg_catalog.pg_get_constraintdef(oid) as def from pg_catalog.pg_constraint where conrelid = $1::oid and contype = 'c' order by 1", [oid]);
        for (const { def } of checks.rows) {
            const expression = unwrap(balanced(def, 0)?.inside ?? def);
            table.checks.set(normalizeExpression(expression), expression);
        }
        model.set(name, table);
    }
    return model;
}
function diffModels(sqlite, postgres) {
    const out = [];
    const add = (difference) => void out.push(difference);
    for (const table of [...new Set([...sqlite.keys(), ...postgres.keys()])].sort()) {
        const s = sqlite.get(table);
        const p = postgres.get(table);
        if (!s || !p) {
            add({ kind: 'table-missing', table, message: `table ${table} exists only in ${s ? 'sqlite' : 'postgres'}`, ...(s ? { sqlite: table } : { postgres: table }) });
            continue;
        }
        for (const column of [...new Set([...s.columns.keys(), ...p.columns.keys()])].sort()) {
            const sc = s.columns.get(column);
            const pc = p.columns.get(column);
            if (!sc || !pc) {
                add({ kind: 'column-missing', table, name: column, message: `column ${table}.${column} exists only in ${sc ? 'sqlite' : 'postgres'}`, ...(sc ? { sqlite: sc.rawType } : { postgres: pc.rawType }) });
                continue;
            }
            if (sc.type !== pc.type)
                add({ kind: 'column-type', table, name: column, sqlite: `${sc.rawType} (${sc.type})`, postgres: `${pc.rawType} (${pc.type})`, message: `column ${table}.${column} is ${sc.type} in sqlite but ${pc.type} in postgres` });
            if (sc.notNull !== pc.notNull)
                add({ kind: 'column-nullability', table, name: column, sqlite: sc.notNull ? 'not null' : 'nullable', postgres: pc.notNull ? 'not null' : 'nullable', message: `column ${table}.${column} nullability differs` });
            if (sc.hasDefault !== pc.hasDefault)
                add({ kind: 'column-default', table, name: column, sqlite: sc.hasDefault ? 'has default' : 'no default', postgres: pc.hasDefault ? 'has default' : 'no default', message: `column ${table}.${column} default presence differs` });
        }
        if (s.primaryKey.join(',') !== p.primaryKey.join(','))
            add({ kind: 'primary-key', table, sqlite: s.primaryKey.join(', ') || '(none)', postgres: p.primaryKey.join(', ') || '(none)', message: `primary key of ${table} differs` });
        for (const [kind, a, b] of [['unique', s.uniques, p.uniques], ['index', s.indexes, p.indexes], ['check', s.checks, p.checks]]) {
            for (const signature of [...new Set([...a.keys(), ...b.keys()])].sort()) {
                const inS = a.get(signature);
                const inP = b.get(signature);
                if (inS !== undefined && inP !== undefined)
                    continue;
                const present = inS ?? inP ?? '';
                const label = kind === 'check' ? present : signature;
                add({
                    kind,
                    table,
                    name: present,
                    ...(inS === undefined ? { postgres: label } : { sqlite: label }),
                    message: `${kind} ${kind === 'check' ? `"${present}"` : `${present} ${kind === 'unique' ? `(${signature})` : signature}`} on ${table} exists only in ${inS === undefined ? 'postgres' : 'sqlite'}`,
                });
            }
        }
    }
    return out;
}
const matches = (rule, difference) => (rule.kind === undefined || rule.kind === difference.kind) && (rule.table === undefined || rule.table === difference.table) && (rule.name === undefined || rule.name === difference.name);
/**
 * Compare the schema one app migration produced on SQLite with the one it produced on Postgres: tables, columns (logical
 * type class, nullability, default presence), primary keys, unique constraints, indexes (partial `WHERE` and expression
 * indexes included; a unique index of plain columns counts as a unique constraint) and CHECK constraints. Names are
 * not compared except as the label of an index or check; expressions are compared after normalising case, quoting,
 * whitespace, parentheses and Postgres casts. List intentional differences in `allow`. Call it from a test.
 */
export async function compareSchemas(sqliteHandle, postgresHandle, options = {}) {
    const all = diffModels(readSqlite(sqliteHandle), await readPostgres(postgresHandle, options.schema ?? 'public'));
    const rules = options.allow ?? [];
    const allowed = all.filter((difference) => rules.some((rule) => matches(rule, difference)));
    const differences = all.filter((difference) => !allowed.includes(difference));
    const report = differences.length === 0 ? `schemas match (${allowed.length} allowed difference${allowed.length === 1 ? '' : 's'})` : [`schemas differ: ${differences.length} difference${differences.length === 1 ? '' : 's'}`, ...differences.map((d) => `  [${d.kind}] ${d.message}`)].join('\n');
    return { ok: differences.length === 0, differences, allowed, report };
}
