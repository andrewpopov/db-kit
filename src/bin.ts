#!/usr/bin/env node
import { runPoolCli } from './pooling-cli.js';
import { runCloneCli } from './clone/cli.js';

const [command, ...rest] = process.argv.slice(2);
if (command !== 'clone' && command !== 'pool') {
  process.stderr.write('usage: db-kit clone ... | db-kit pool (plan|render) ... (see the README)\n');
  process.exit(2);
}
process.exitCode = await (command === 'pool' ? runPoolCli : runCloneCli)(rest, process.env, {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
