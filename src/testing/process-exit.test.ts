import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Each scenario is a real child Node process: only a separate process can observe its own exit status.
const SCENARIOS: Record<string, string> = {
  'stops, then fails': `
    const server = await startTestPostgres();
    await server.stop();
    process.exitCode = 1;`,
  'never stops, then fails': `
    await startTestPostgres();
    process.exitCode = 1;`,
  'never stops, succeeds': `
    await startTestPostgres();`,
  'waits for a signal': `
    await startTestPostgres();
    console.log('ready');
    setInterval(() => undefined, 1000);`,
};

describe('startTestPostgres does not change how the process exits', () => {
  const work = mkdtempSync(join(tmpdir(), 'db-kit-exit-'));
  const build = join(root, 'node_modules', '.cache', 'db-kit-process-exit-test');
  const tmp = join(work, 'tmp');

  beforeAll(() => {
    rmSync(build, { recursive: true, force: true });
    mkdirSync(tmp);
    // Compile the helper where its dependencies resolve; the child runs the real code, not a mock of it.
    execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), join(root, 'src/testing/postgres.ts'), '--outDir', build, '--rootDir', join(root, 'src'), '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', '--strict', '--skipLibCheck'], { cwd: root, stdio: 'pipe' });
    for (const [name, body] of Object.entries(SCENARIOS)) {
      writeFileSync(join(build, `${name.replace(/\W+/g, '-')}.mjs`), `import { startTestPostgres } from './testing/postgres.js';\n${body}\n`);
    }
  }, 120_000);
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(build, { recursive: true, force: true });
  });

  const script = (name: string): string => join(build, `${name.replace(/\W+/g, '-')}.mjs`);
  const env = (): NodeJS.ProcessEnv => ({ ...process.env, TMPDIR: tmp });
  const leftovers = (): { dirs: string[]; processes: boolean } => ({
    dirs: readdirSync(tmp).filter((entry) => entry.startsWith('db-kit-pg-')),
    // every server's command line carries its data directory under the private TMPDIR
    processes: spawnSync('pgrep', ['-f', join(tmp, 'db-kit-pg-')]).status === 0,
  });
  const run = (name: string) => spawnSync(process.execPath, [script(name)], { env: env(), encoding: 'utf8', timeout: 150_000 });

  it('a run that stops its server and sets exitCode 1 exits 1 (embedded-postgres exit hook must not override it)', () => {
    const result = run('stops, then fails');
    expect(result.status, result.stderr).toBe(1);
    expect(leftovers()).toEqual({ dirs: [], processes: false });
  }, 180_000);

  it('a run that never stops its server still exits 1, and leaves no postgres process or data directory', () => {
    const result = run('never stops, then fails');
    expect(result.status, result.stderr).toBe(1);
    expect(leftovers()).toEqual({ dirs: [], processes: false });
  }, 180_000);

  it('a run that never stops its server exits 0 when it succeeded, and cleans up', () => {
    const result = run('never stops, succeeds');
    expect(result.status, result.stderr).toBe(0);
    expect(leftovers()).toEqual({ dirs: [], processes: false });
  }, 180_000);

  it('SIGTERM to the process still ends it by SIGTERM (never exit 0) and cleans up the server', async () => {
    const child = spawn(process.execPath, [script('waits for a signal')], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('ready')) resolve();
      });
      child.once('exit', () => reject(new Error('child exited before it was ready')));
    });
    child.kill('SIGTERM');
    expect(await exited).toEqual({ code: null, signal: 'SIGTERM' });
    expect(leftovers()).toEqual({ dirs: [], processes: false });
  }, 180_000);
});
