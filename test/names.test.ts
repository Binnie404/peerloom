import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';

// Peerloom is one program under two names: peerloom and its short form, plm.
const root = resolve(import.meta.dirname, '..');
const run = (file: string, ...args: string[]) => spawnSync(process.execPath, [resolve(root, file), ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

test('peerloom and plm install the same program, and nothing installs agentlink', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'peerloom');
  assert.deepEqual(pkg.bin, { peerloom: 'bin/peerloom.mjs', plm: 'bin/peerloom.mjs' });
  assert.ok(statSync(resolve(root, 'bin/peerloom.mjs')).mode & 0o111, 'bin/peerloom.mjs is executable');
});

test('help speaks of peerloom and plm only', () => {
  const now = run('bin/peerloom.mjs', 'help');
  assert.equal(now.status, 0);
  assert.match(now.stdout, /^peerloom {2,}open the room console in this folder$/m);
  assert.match(now.stdout, /plm is the short name for peerloom/);
  assert.doesNotMatch(now.stdout, /\bagentlink\b/);
});

test('an agent command without --as is refused with the way to give one', () => {
  const now = run('bin/peerloom.mjs', 'send');
  assert.match(now.stdout, /--as ID/);
});

test('brand constants come from one place and the version from package.json', async () => {
  const brand = await import('../core/brand.ts');
  assert.equal(brand.PRODUCT, 'Peerloom'); assert.equal(brand.CLI, 'peerloom'); assert.equal(brand.CLI_SHORT, 'plm'); assert.equal('CLI_OLD' in brand, false);
  assert.equal(brand.TAGLINE, 'Let your agents think together.');
  assert.equal(brand.VERSION, JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version);
});

test('installed() finds a command on PATH only when it is an executable file there', async t => {
  const { installed } = await import('../core/brand.ts');
  const dir = mkdtempSync(join(tmpdir(), 'peerloom-path-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(installed('peerloom', dir), false);
  writeFileSync(join(dir, 'peerloom'), '#!/bin/sh\n'); assert.equal(installed('peerloom', dir), false, 'not executable');
  chmodSync(join(dir, 'peerloom'), 0o755); assert.equal(installed('peerloom', `/nowhere:${dir}`), true);
  assert.equal(installed('peerloom', ''), false);
});
