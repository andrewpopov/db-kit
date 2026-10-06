import { it } from 'vitest';
import { manifestOf } from '../../test-support/clone-fixture.js';
import { parseDatabaseUrl } from '../../url.js';
import { reverseClone } from '../reverse.js';

// Run only by reverse.test.ts, in a child vitest: the worker kills ITSELF in the middle of a reverse clone.
it('killed with SIGKILL after the rows are loaded but before anything is verified or renamed', async () => {
  const source = parseDatabaseUrl(process.env.REVERSE_SOURCE_URL ?? '');
  if (source.dialect !== 'postgres') throw new Error('REVERSE_SOURCE_URL must be a postgres URL');
  await reverseClone({
    source,
    manifest: manifestOf({ version: 1, tables: { items: { primaryKey: ['id'], columns: { id: { codec: 'integer', nullable: false }, name: { codec: 'text', nullable: false } } } } }),
    toSqlitePath: process.env.REVERSE_TARGET ?? '',
    sqliteTemplatePath: process.env.REVERSE_TEMPLATE ?? '',
    writersStopped: true,
    confirmProduction: process.env.REVERSE_CONFIRM ?? '',
    hooks: { afterLoad: () => process.kill(process.pid, 'SIGKILL') },
  });
}, 60_000);
