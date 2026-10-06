#!/usr/bin/env node
import { runCloneCli } from './clone/cli.js';
const [command, ...rest] = process.argv.slice(2);
if (command !== 'clone') {
    process.stderr.write('usage: db-kit clone ... (see the README)\n');
    process.exit(2);
}
process.exitCode = await runCloneCli(rest, process.env, {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
});
