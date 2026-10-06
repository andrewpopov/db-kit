#!/usr/bin/env node
/**
 * Pack the package, install the tarball into a throwaway consumer and assert:
 *   1. the declared entry points ship in the tarball;
 *   2. native ESM import resolves the root entry and the ./drizzle subpath;
 *   3. an installed openDatabase('file::memory:') opens a real SQLite handle (native better-sqlite3 loads) and reports healthy;
 *   4. an invalid URL's error message does not echo its password.
 * The package is ESM-only: a CommonJS require() is not part of the contract.
 * Exits non-zero with a clear message on any failure.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
function fail(message) {
  console.error(`\n[verify:pack] FAIL: ${message}\n`);
  process.exit(1);
}

const REQUIRED_FILES = ['dist/index.js', 'dist/index.d.ts', 'dist/drizzle.js', 'dist/drizzle.d.ts', 'dist/clone.js', 'dist/clone.d.ts', 'dist/bin.js'];

const workDir = mkdtempSync(join(tmpdir(), 'db-kit-verify-'));
try {
  console.log('[verify:pack] Building...');
  run('npm', ['run', 'build'], { cwd: pkgRoot, stdio: 'inherit' });

  console.log('[verify:pack] Packing tarball...');
  const [{ filename }] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', workDir], { cwd: pkgRoot }));
  const tarballPath = join(workDir, filename);

  const contents = run('tar', ['-tzf', tarballPath]).split('\n');
  for (const file of REQUIRED_FILES) {
    if (!contents.includes(`package/${file}`)) fail(`${file} is not present in the packed tarball`);
  }
  console.log(`[verify:pack] OK: ${REQUIRED_FILES.join(', ')} ship in tarball`);

  const consumerDir = join(workDir, 'consumer');
  mkdirSync(consumerDir);
  writeFileSync(
    join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'db-kit-consumer', version: '1.0.0', private: true, type: 'module' }, null, 2),
  );
  console.log('[verify:pack] Installing tarball (+ drizzle-orm peer) into consumer...');
  run('npm', ['install', '--no-audit', '--no-fund', tarballPath, `drizzle-orm@${pkg.devDependencies['drizzle-orm']}`], {
    cwd: consumerDir,
    stdio: 'inherit',
  });

  const esm = `
    import { openDatabase, parseDatabaseUrl, describe } from '${pkg.name}';
    import { drizzleFor } from '${pkg.name}/drizzle';
    import { planClone } from '${pkg.name}/clone';
    if (typeof planClone !== 'function') throw new Error('clone subpath export missing');
    if (typeof drizzleFor !== 'function') throw new Error('drizzle subpath export missing');
    const handle = openDatabase('file::memory:');
    const health = await handle.health();
    if (!health.ok) throw new Error('installed sqlite handle unhealthy: ' + health.error);
    if (drizzleFor(handle).all === undefined) throw new Error('drizzleFor returned an unusable instance');
    await handle.close();
    const pw = 'pack-smoke-pw';
    if (describe(parseDatabaseUrl('postgres://u:' + pw + '@h/db')).includes(pw)) throw new Error('describe leaked the password');
    try { parseDatabaseUrl('mysql://u:' + pw + '@h/db'); throw new Error('expected a parse error'); }
    catch (e) { if (String(e).includes(pw)) throw new Error('parse error leaked the password'); if (!String(e).includes('Invalid DATABASE_URL')) throw e; }
  `;
  run('node', ['--input-type=module', '-e', esm], { cwd: consumerDir, stdio: 'inherit' });
  // The installed bin must run (its imports resolve, db-backup included) and refuse an unknown command with exit 2.
  const bin = spawnSync(join(consumerDir, 'node_modules', '.bin', 'db-kit'), ['nope'], { encoding: 'utf8' });
  if (bin.status !== 2 || !bin.stderr.includes('usage: db-kit clone')) fail(`installed db-kit bin did not print its usage and exit 2 (status ${bin.status}): ${bin.stderr}`);
  console.log('[verify:pack] OK: native ESM import resolves root + ./drizzle; sqlite opens, healthy, redaction holds');

  console.log('[verify:pack] PASS');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
