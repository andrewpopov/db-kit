import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { renderPgBouncer } from './pooling.js';
const manifestSchema = z.object({
    serverConnectionBudget: z.number(), listenPort: z.number().optional(), maxClientConnections: z.number().optional(),
    authFile: z.string().optional(), socketDirectory: z.string().optional(), serverTlsCaFile: z.string().optional(),
    databases: z.array(z.object({ name: z.string(), urlEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        poolSize: z.number().optional(), reservePoolSize: z.number().optional(), maxServerConnections: z.number().optional(),
        mode: z.enum(['transaction', 'session']).optional() }).strict()).min(1),
}).strict();
export function runPoolCli(argv, env, io) {
    try {
        const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true, options: {
                config: { type: 'string' }, 'output-dir': { type: 'string' },
            } });
        if (positionals.length !== 1 || !['plan', 'render'].includes(positionals[0]) || !values.config || (positionals[0] === 'render' && !values['output-dir'])) {
            io.err('usage: db-kit pool (plan|render) --config <manifest.json> [--output-dir <new-private-directory>]');
            return 2;
        }
        const manifest = manifestSchema.parse(JSON.parse(readFileSync(values.config, 'utf8')));
        const databases = manifest.databases.map(({ urlEnv, ...database }) => {
            const url = env[urlEnv];
            if (!url)
                throw new Error('Required database environment variable is absent');
            return { ...database, url };
        });
        const files = renderPgBouncer({ ...manifest, databases });
        if (positionals[0] === 'render') {
            if (process.platform === 'win32')
                throw new Error('Render secret files through a POSIX host adapter');
            const directory = resolve(values['output-dir']);
            mkdirSync(directory, { mode: 0o700 }); // Existing directories are refused; no config is overwritten.
            for (const [name, content] of [['pgbouncer.ini', files.config], ['users.txt', files.auth], ['runtime.json', JSON.stringify(files.runtimeUrls, null, 2)]]) {
                writeFileSync(resolve(directory, name), content, { mode: 0o600, flag: 'wx' });
            }
        }
        io.out(JSON.stringify({ status: positionals[0] === 'plan' ? 'validated' : 'rendered', databases: databases.length, serverConnectionCap: files.serverConnectionCap }));
        return 0;
    }
    catch {
        // zod, filesystem and URL errors can quote private values; never print them.
        io.err('Pool configuration failed; check the manifest, environment, budget and destination privately.');
        return 1;
    }
}
