import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, createReadStream, fsyncSync, linkSync, lstatSync, openSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { buildCodecs } from '../codecs/bound.js';
import { introspectPostgres, introspectSqlite } from '../codecs/introspect.js';
import { validateManifest } from '../codecs/validate.js';
import { quoteIdent, readIdentity, readTargetFacts, TARGET_SCHEMA } from './catalog.js';
import { CloneRefusal, refuse, toRefusal } from './errors.js';
import { postgresOrderBy, sqliteOrderBy } from './order.js';
import { positiveInteger } from './options.js';
import { connectClient, pinSession } from './plan.js';
import { evaluateShape } from './rules.js';
import { openSnapshot, sqliteSkippedKeyRefusals } from './source.js';
import { isProduction, productionConfirmation } from './topology.js';
import { VERIFY_TYPES, verifyTable } from './verify.js';
const seconds = (since) => (performance.now() - since) / 1000;
const exists = (path) => {
    try {
        lstatSync(path);
        return true;
    }
    catch {
        return false;
    }
};
async function sha256File(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path))
        hash.update(chunk);
    return hash.digest('hex');
}
function fsyncPath(path) {
    const fd = openSync(path, 'r');
    try {
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
/**
 * Clone Postgres into a FRESH SQLite file, the rollback-window path: writers stopped and drained, one REPEATABLE READ
 * READ ONLY snapshot of the source, the app's own empty SQLite schema (a template file, copied) filled inside one
 * SQLite transaction with foreign keys off, then `foreign_key_check` and `integrity_check` clean, committed, and
 * verified row by row against a second read of the same Postgres snapshot. Only then is the file fsynced and linked
 * into place without clobbering anything, with a receipt beside it. Everything before that happens in a hidden temp
 * file next to the target, so a crash at any point leaves nothing at the target path. Only a `CloneRefusal` ever leaves.
 */
export async function reverseClone(options) {
    positiveInteger('fetchRows', options.fetchRows);
    try {
        return await runReverse(options);
    }
    catch (error) {
        throw error instanceof CloneRefusal ? error : new CloneRefusal(toRefusal(error, 'execute-failed'));
    }
}
async function runReverse(options) {
    const started = performance.now();
    const { manifest } = options;
    if (options.writersStopped !== true)
        refuse({ code: 'writers-not-stopped' });
    const target = resolve(options.toSqlitePath);
    if (exists(target))
        refuse({ code: 'sqlite-target-exists' });
    refuseTargetDebris(target);
    const directory = dirname(target);
    try {
        if (!statSync(directory).isDirectory())
            refuse({ code: 'sqlite-write-failed' });
    }
    catch (error) {
        if (error instanceof CloneRefusal)
            throw error;
        refuse({ code: 'sqlite-write-failed' });
    }
    const temp = join(directory, `.${basename(target)}.db-kit-tmp-${randomBytes(6).toString('hex')}`);
    const removeTemp = () => {
        for (const suffix of ['', '-wal', '-shm', '-journal'])
            rmSync(`${temp}${suffix}`, { force: true });
    };
    let client;
    let db;
    try {
        await copyTemplate(options.sqliteTemplatePath, temp);
        db = openTemp(temp);
        const originalJournal = String(db.pragma('journal_mode', { simple: true }));
        db.pragma('journal_mode = DELETE');
        db.pragma('foreign_keys = OFF');
        client = await connectClient({ target: options.source, tlsCa: options.tlsCa, wrapClient: options.wrapClient }, 0);
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SELECT pg_catalog.set_config('search_path', '', true)");
        await client.query('SET LOCAL row_security = off');
        await pinSession(client);
        const identity = await readSourceIdentity(client, options);
        const validation = validateManifest(manifest, { sqlite: introspectSqlite(db), postgres: await introspectPostgres(client, TARGET_SCHEMA) });
        if (!validation.ok) {
            const issue = validation.issues[0];
            return refuse({ code: 'manifest-invalid', table: issue?.table, ...(issue?.column === undefined ? {} : { column: issue.column }), object: `${issue?.side}:${issue?.code}` });
        }
        const skippedKeys = sqliteSkippedKeyRefusals(db, manifest, introspectSqlite(db));
        if (skippedKeys[0])
            return refuse(skippedKeys[0]);
        const facts = await readTargetFacts(client, Object.keys(manifest.tables), identity.serverVersionNum);
        const shape = evaluateShape(facts, manifest, { requireOwnership: false });
        if (shape[0])
            return refuse(shape[0]);
        for (const name of Object.keys(manifest.tables)) {
            if (db.prepare(`select 1 from ${quoteIdent(name)} limit 1`).get() !== undefined)
                refuse({ code: 'sqlite-template-not-empty', table: name });
        }
        const codecs = buildCodecs(manifest);
        const fetchRows = options.fetchRows ?? 5000;
        const results = [];
        db.exec('BEGIN IMMEDIATE');
        for (const [table, spec] of Object.entries(manifest.tables)) {
            const loadStarted = performance.now();
            const columns = Object.keys(spec.columns).map((name) => codecs.column(table, name)).filter((column) => !column.generated);
            let rows;
            try {
                rows = await loadTable(client, db, table, columns, postgresOrderBy(spec), fetchRows);
            }
            catch (error) {
                if (error instanceof CloneRefusal || error.name === 'CodecError')
                    throw error;
                return refuse({ code: 'load-failed', table });
            }
            const loadSeconds = seconds(loadStarted);
            options.onProgress?.({ phase: 'load', table, rows, seconds: loadSeconds });
            results.push({ table, rows, sha256: '', loadSeconds, verifySeconds: 0 });
        }
        options.hooks?.afterLoad?.(db);
        const violations = db.pragma('foreign_key_check');
        if (violations[0])
            refuse({ code: 'sqlite-foreign-key-violation', table: violations[0].table });
        const integrity = db.pragma('integrity_check');
        if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
            refuse({ code: 'sqlite-integrity-failed' });
        const sequences = await setAutoincrementHighWater(client, db, facts.sequenceRefs, manifest);
        db.exec('COMMIT');
        db.pragma(`journal_mode = ${originalJournal}`);
        db.close();
        db = undefined;
        removeSidecars(temp);
        options.hooks?.beforeVerify?.(temp);
        const verifyDb = openSnapshot(temp);
        try {
            for (const result of results) {
                const spec = manifest.tables[result.table];
                if (!spec)
                    continue;
                const verifyStarted = performance.now();
                const digest = await verifyTable({
                    client,
                    db: verifyDb,
                    table: result.table,
                    columns: Object.keys(spec.columns).map((name) => codecs.column(result.table, name)),
                    primaryKey: spec.primaryKey,
                    sqliteOrderBy: sqliteOrderBy(spec),
                    postgresOrderBy: postgresOrderBy(spec),
                    fetchRows,
                });
                result.verifySeconds = seconds(verifyStarted);
                result.sha256 = digest.sha256;
                options.onProgress?.({ phase: 'verify', table: result.table, rows: digest.rows, seconds: result.verifySeconds });
            }
        }
        finally {
            verifyDb.close();
            removeSidecars(temp);
        }
        const runId = randomUUID();
        const summary = {
            runId,
            source: { host: options.source.host, port: options.source.port, database: identity.database, systemIdentifier: identity.systemIdentifier, serverVersion: identity.serverVersion },
            tables: results,
            sequences,
            totals: { rows: results.reduce((sum, result) => sum + result.rows, 0), seconds: seconds(started) },
        };
        if (options.dryRun === true)
            return { outcome: 'dry-run', path: null, receiptPath: null, ...summary, warnings: [] };
        const sqliteSha256 = await sha256File(temp);
        fsyncPath(temp);
        options.hooks?.beforeRename?.(temp, target);
        refuseTargetDebris(target); // again: something may have appeared while we worked
        try {
            linkSync(temp, target); // fails if anything appeared at the path meanwhile: never clobbers
        }
        catch (error) {
            if (error.code === 'EEXIST')
                return refuse({ code: 'sqlite-target-exists' });
            return refuse({ code: 'sqlite-write-failed' });
        }
        // From here the database IS in place. Nothing below may turn that into a refusal: failures become warnings.
        const warnings = [];
        const attempt = (warning, step) => {
            try {
                step();
                return true;
            }
            catch {
                warnings.push(warning);
                return false;
            }
        };
        attempt('hook-failed', () => options.hooks?.afterPublish?.(target));
        attempt('temp-not-removed', () => unlinkSync(temp));
        attempt('directory-fsync-failed', () => fsyncPath(directory));
        const receiptPath = `${target}.receipt.json`;
        const receiptWritten = attempt('receipt-not-written', () => {
            const receipt = {
                version: 1,
                direction: 'postgres-to-sqlite',
                runId,
                completedAt: new Date().toISOString(),
                source: summary.source,
                manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
                sqlite: { path: target, bytes: statSync(target).size, sha256: sqliteSha256 },
                tables: results.map(({ table, rows, sha256 }) => ({ table, rows, sha256 })),
                sequences,
            };
            const receiptTemp = `${receiptPath}.tmp-${runId}`;
            try {
                writeFileSync(receiptTemp, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
                fsyncPath(receiptTemp);
                linkSync(receiptTemp, receiptPath); // no-clobber, like the database
            }
            finally {
                rmSync(receiptTemp, { force: true });
            }
        });
        return { outcome: 'written', path: target, receiptPath: receiptWritten ? receiptPath : null, ...summary, warnings };
    }
    finally {
        if (client) {
            await client.query('ROLLBACK').catch(() => undefined);
            await client.end().catch(() => undefined);
        }
        try {
            db?.close();
        }
        catch {
            // the temp file is removed below
        }
        try {
            removeTemp();
        }
        catch {
            // best effort: after publication a stuck temp file is only a warning
        }
    }
}
/** Anything already at the target's neighbourhood that SQLite or we would trip over: a hot `-journal` would be replayed over the verified file, `-wal`/`-shm` adopted, a receipt silently replaced. */
function refuseTargetDebris(target) {
    for (const suffix of ['-journal', '-wal', '-shm', '.receipt.json']) {
        if (exists(`${target}${suffix}`))
            refuse({ code: 'sqlite-target-exists', object: suffix });
    }
}
function removeSidecars(temp) {
    for (const suffix of ['-wal', '-shm', '-journal'])
        rmSync(`${temp}${suffix}`, { force: true });
}
function openTemp(path) {
    try {
        const db = new Database(path, { fileMustExist: true });
        db.defaultSafeIntegers(false);
        return db;
    }
    catch {
        return refuse({ code: 'sqlite-write-failed' });
    }
}
/** Copy the template with SQLite's backup API (consistent even if it is in WAL mode); refuse one that is not a healthy SQLite database. */
async function copyTemplate(template, temp) {
    if (!exists(template))
        refuse({ code: 'sqlite-template-missing' });
    let source;
    try {
        source = new Database(template, { readonly: true, fileMustExist: true });
    }
    catch {
        return refuse({ code: 'sqlite-template-invalid' });
    }
    try {
        const integrity = source.pragma('integrity_check');
        if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
            refuse({ code: 'sqlite-template-invalid' });
        await source.backup(temp);
    }
    catch (error) {
        if (error instanceof CloneRefusal)
            throw error;
        refuse({ code: 'sqlite-template-invalid' });
    }
    finally {
        source.close();
    }
}
async function readSourceIdentity(client, options) {
    let identity;
    try {
        identity = await readIdentity(client);
    }
    catch {
        return refuse({ code: 'target-identity-unreadable' });
    }
    if (identity.inRecovery)
        refuse({ code: 'source-in-recovery' });
    const where = { host: options.source.host, port: options.source.port, database: identity.database };
    if (isProduction({ ...where, systemIdentifier: identity.systemIdentifier }, options.topology) && options.confirmProduction !== productionConfirmation(where))
        refuse({ code: 'production-unconfirmed' });
    return identity;
}
const CURSOR = 'db_kit_reverse_load';
/** Codecs whose SQLite value is an INTEGER. better-sqlite3 binds a JS number as REAL, which an untyped (or BLOB-affinity) column would keep as REAL: bind these as bigint. */
const INTEGER_VALUED = new Set(['integer', 'boolean', 'timestamp-epoch-s', 'timestamp-epoch-ms']);
/** Stream one table out of the Postgres snapshot into the SQLite transaction, converted by each column's codec. Lossy values refuse by name. */
async function loadTable(client, db, table, columns, orderBy, fetchRows) {
    const names = columns.map((column) => quoteIdent(column.column)).join(', ');
    const insert = db.prepare(`insert into ${quoteIdent(table)} (${names}) values (${columns.map(() => '?').join(', ')})`);
    await client.query(`DECLARE ${CURSOR} NO SCROLL CURSOR FOR select ${names} from ${quoteIdent(TARGET_SCHEMA)}.${quoteIdent(table)} order by ${orderBy}`);
    let rows = 0;
    const integerColumns = columns.map((column) => INTEGER_VALUED.has(column.spec.codec));
    try {
        for (;;) {
            const { rows: batch } = await client.query({ text: `FETCH FORWARD ${fetchRows} FROM ${CURSOR}`, rowMode: 'array', types: VERIFY_TYPES });
            if (batch.length === 0)
                break;
            for (const row of batch) {
                const values = new Array(columns.length);
                for (let i = 0; i < columns.length; i++) {
                    const converted = columns[i].toSqlite(row[i]);
                    values[i] = typeof converted === 'number' && integerColumns[i] ? BigInt(converted) : converted;
                }
                insert.run(...values);
                rows++;
            }
        }
    }
    finally {
        await client.query(`CLOSE ${CURSOR}`).catch(() => undefined);
    }
    return rows;
}
/**
 * For a table declared AUTOINCREMENT in the SQLite schema whose integer primary key owns an ascending Postgres sequence,
 * `sqlite_sequence` becomes the highest value that sequence ever handed out (never lower than the rows now present), so
 * ids are never reused after the flip. Reads the sequence inside the same snapshot.
 */
async function setAutoincrementHighWater(client, db, refs, manifest) {
    const out = [];
    const hasSequenceTable = db.prepare("select 1 from sqlite_master where name = 'sqlite_sequence'").get() !== undefined;
    if (!hasSequenceTable)
        return out;
    const copied = new Map((await client.query('select c.oid::int as oid, c.relname::text as name from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = $1::text and c.relname = any($2::text[])', [TARGET_SCHEMA, Object.keys(manifest.tables)])).rows.map((row) => [row.oid, row.name]));
    for (const [table, spec] of Object.entries(manifest.tables)) {
        const sql = db.prepare("select sql from sqlite_master where type = 'table' and name = ?").get(table)?.sql ?? '';
        if (!/\bautoincrement\b/i.test(sql) || spec.primaryKey.length !== 1)
            continue;
        const key = spec.primaryKey[0];
        const owned = refs.find((ref) => ref.kind === 'owner' && copied.get(ref.tableOid) === table && ref.column === key && ref.increment > 0n);
        const max = db.prepare(`select max(${quoteIdent(key)}) as m from ${quoteIdent(table)}`).safeIntegers(true).get().m;
        let seq = max ?? 0n;
        if (owned) {
            const row = (await client.query(`select last_value::text as last, is_called as called from ${quoteIdent(owned.schema)}.${quoteIdent(owned.name)}`)).rows[0];
            if (row) {
                const issued = row.called ? BigInt(row.last) : BigInt(row.last) - owned.increment;
                if (issued > seq)
                    seq = issued;
            }
        }
        if (seq === 0n && max === null)
            continue;
        const updated = db.prepare('update sqlite_sequence set seq = ? where name = ?').run(seq, table);
        if (updated.changes === 0)
            db.prepare('insert into sqlite_sequence (name, seq) values (?, ?)').run(table, seq);
        out.push({ table, seq: seq.toString() });
    }
    return out;
}
