import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { DbKitError } from '../errors.js';
function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            server.close(() => resolve(port));
        });
    });
}
function localeFlags(locale) {
    if (locale === undefined)
        return [];
    if (locale.startsWith('builtin:'))
        return ['--encoding=UTF8', '--locale-provider=builtin', `--builtin-locale=${locale.slice(8)}`];
    if (locale.startsWith('icu:'))
        return ['--encoding=UTF8', '--locale-provider=icu', `--icu-locale=${locale.slice(4)}`];
    return ['--encoding=UTF8', `--locale=${locale}`];
}
export function postgresUrl(config, database = config.database) {
    const auth = `${encodeURIComponent(config.user ?? 'postgres')}:${encodeURIComponent(config.password ?? '')}`;
    return `postgres://${auth}@${config.host}:${config.port}/${encodeURIComponent(database)}?sslmode=${config.sslmode}`;
}
/**
 * Importing `embedded-postgres` calls `async-exit-hook` at module top level, which listens on these process events.
 * Its `beforeExit` listener runs `process.exit(0)`, overriding a test runner's `process.exitCode = 1`: a failing run
 * then reports success. Its `exit` listener stops servers by a callback only the other events supply.
 */
const HOOKED_EVENTS = ['exit', 'beforeExit', 'SIGHUP', 'SIGINT', 'SIGTERM', 'SIGBREAK', 'message'];
function snapshotListeners() {
    const emitter = process;
    return new Map(HOOKED_EVENTS.map((event) => [event, emitter.listeners(event)]));
}
let embeddedPostgresLoad;
/**
 * Imports `embedded-postgres` and removes exactly the process listeners that import added, right away, so the
 * library's hook can never fire, even when `stop()` is never called. The module is cached, so only the first import
 * adds listeners; the load is memoized and the removal happens once. (An import of the library elsewhere in the
 * process before this one is outside our reach: its listeners were not added by us.) db-kit's own `reapOnExit`
 * takes over the cleanup the library's hook used to do.
 */
function loadEmbeddedPostgres() {
    embeddedPostgresLoad ??= (async () => {
        const before = snapshotListeners();
        let module;
        try {
            module = await import('embedded-postgres');
        }
        catch (error) {
            if (error.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (package|module)/.test(String(error.message))) {
                throw new DbKitError('INVALID_OPTIONS', 'Testing against Postgres needs the optional peer "embedded-postgres": install it as a devDependency (npm i -D embedded-postgres)');
            }
            throw error;
        }
        finally {
            const after = snapshotListeners();
            for (const event of HOOKED_EVENTS) {
                const previous = new Set(before.get(event));
                for (const listener of after.get(event) ?? []) {
                    if (!previous.has(listener))
                        process.removeListener(event, listener);
                }
            }
        }
        return module.default;
    })();
    embeddedPostgresLoad.catch(() => {
        embeddedPostgresLoad = undefined;
    });
    return embeddedPostgresLoad;
}
const REAP_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'];
const REAP_WAIT_MS = 5000;
const liveServers = new Set();
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/** Synchronous (usable in an `exit` handler): stop the postgres child, wait for its clean shutdown, remove the directory. */
function reapSync(live) {
    const pid = live.child?.pid;
    if (pid !== undefined && live.child?.exitCode === null && live.child.signalCode === null) {
        try {
            process.kill(pid, 'SIGINT');
        }
        catch {
            // already gone
        }
        // A clean shutdown removes postmaster.pid; the child cannot be reaped here (the event loop is not running).
        const deadline = Date.now() + REAP_WAIT_MS;
        while (existsSync(join(live.dir, 'data', 'postmaster.pid')) && Date.now() < deadline)
            sleepSync(25);
        if (existsSync(join(live.dir, 'data', 'postmaster.pid'))) {
            try {
                process.kill(pid, 'SIGKILL');
            }
            catch {
                // already gone
            }
        }
    }
    rmSync(live.dir, { recursive: true, force: true });
}
function reapAllSync() {
    for (const live of liveServers)
        reapSync(live);
    liveServers.clear();
}
function onReapSignal(signal) {
    reapAllSync();
    uninstallReapHandlers();
    // Another listener owns the exit decision; otherwise keep default semantics: die from this very signal, never exit 0.
    if (process.listenerCount(signal) === 0)
        process.kill(process.pid, signal);
}
const signalHandlers = new Map(REAP_SIGNALS.map((signal) => [signal, () => onReapSignal(signal)]));
function installReapHandlers() {
    process.on('exit', reapAllSync);
    for (const [signal, handler] of signalHandlers)
        process.on(signal, handler);
}
function uninstallReapHandlers() {
    process.removeListener('exit', reapAllSync);
    for (const [signal, handler] of signalHandlers)
        process.removeListener(signal, handler);
}
/**
 * Registers `server` for cleanup if the process ends without `stop()` being called: on `exit` and on SIGHUP/SIGINT/SIGTERM
 * the child is stopped and the directory removed, and a signal is then re-raised so the exit status stays the signal's.
 * Never touches `process.exitCode`. The child is unref'd so an unstopped server cannot keep the process alive.
 */
function reapOnExit(live) {
    live.child?.unref();
    for (const stream of [live.child?.stdin, live.child?.stdout, live.child?.stderr])
        stream?.unref?.();
    if (liveServers.size === 0)
        installReapHandlers();
    liveServers.add(live);
    return () => {
        liveServers.delete(live);
        if (liveServers.size === 0)
            uninstallReapHandlers();
    };
}
/**
 * Start a real, throwaway Postgres in a temp directory on a random free port with password auth. Needs the optional
 * peer `embedded-postgres` (a devDependency of the app, never of production). Torn down by `stop()`.
 */
export async function startTestPostgres(options = {}) {
    const EmbeddedPostgres = await loadEmbeddedPostgres();
    const started = performance.now();
    const dir = mkdtempSync(join(tmpdir(), 'db-kit-pg-'));
    const port = await freePort();
    const password = 'correct-horse-battery';
    const tlsFlags = [];
    let caPem;
    try {
        if (options.tls) {
            const cert = join(dir, 'server.crt');
            const key = join(dir, 'server.key');
            execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=db-kit-test', '-addext', `subjectAltName=${options.tls.san ?? 'DNS:localhost'}`, '-keyout', key, '-out', cert], { stdio: 'ignore' });
            tlsFlags.push('-c', 'ssl=on', '-c', `ssl_cert_file=${cert}`, '-c', `ssl_key_file=${key}`);
            caPem = readFileSync(cert, 'utf8');
        }
        const server = new EmbeddedPostgres({
            initdbFlags: localeFlags(options.locale),
            postgresFlags: [...tlsFlags, ...(options.extraFlags ?? [])],
            databaseDir: join(dir, 'data'),
            user: 'postgres',
            password,
            port,
            persistent: true,
            onLog: () => undefined,
            onError: () => undefined,
        });
        await server.initialise();
        await server.start();
        const live = { dir, child: server.process };
        const unregister = reapOnExit(live);
        const config = { dialect: 'postgres', host: '127.0.0.1', port, database: 'postgres', user: 'postgres', password, sslmode: 'disable' };
        return {
            url: postgresUrl(config),
            config,
            caPem,
            startupMs: Math.round(performance.now() - started),
            async stop() {
                live.child?.ref(); // stop() awaits the child's exit, which an unref'd child cannot wake the loop for
                try {
                    await server.stop();
                }
                finally {
                    unregister();
                    rmSync(dir, { recursive: true, force: true });
                }
            },
        };
    }
    catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
    }
}
/** A fresh `test_<random>` database on `server`; `release()` drops it. */
export async function createTestDatabase(server) {
    const name = `test_${randomBytes(6).toString('hex')}`;
    const admin = new Client({ host: server.config.host, port: server.config.port, user: server.config.user, password: server.config.password, database: 'postgres', ssl: false });
    admin.on('error', () => undefined);
    await admin.connect();
    try {
        await admin.query(`create database ${name}`);
    }
    finally {
        await admin.end();
    }
    const config = { ...server.config, database: name };
    let released = false;
    return {
        name,
        url: postgresUrl(config),
        config,
        async release() {
            if (released)
                return;
            released = true;
            const dropper = new Client({ host: config.host, port: config.port, user: config.user, password: config.password, database: 'postgres', ssl: false });
            dropper.on('error', () => undefined);
            await dropper.connect();
            try {
                await dropper.query(`drop database if exists ${name} with (force)`);
            }
            finally {
                await dropper.end();
            }
        },
    };
}
