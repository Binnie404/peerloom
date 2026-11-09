// The user-level harness registry: external harnesses added from a JSON file, without editing core/harnesses.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { harnessList, harnessOf, loadUserHarnesses, userHarnesses, userRegistryPath } from '../core/harnesses.ts';

const root = resolve(import.meta.dirname, '..');
const entry = (over: Record<string, unknown> = {}) => ({ id: 'mycli', label: 'My CLI', wake: 'self-arming', approvals: 'none',
  detect: { bin: 'mycli', version: ['--version'] }, probe: { date: '2026-11-06', version: 'mycli 1.2.3', ok: true, evidence: ['answered a message in a test room'] }, ...over });
function file(t: any, value: unknown, raw?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'peerloom-registry-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'harnesses.json'); writeFileSync(path, raw ?? JSON.stringify(value)); return path;
}

test('the registry file is found by PEERLOOM_HARNESSES, then AGENTLINK_HOME, then the home folder; empty reads none', () => {
  assert.equal(userRegistryPath({ PEERLOOM_HARNESSES: '/x/h.json' }), '/x/h.json');
  assert.equal(userRegistryPath({ PEERLOOM_HARNESSES: '' }), null);
  assert.equal(userRegistryPath({ AGENTLINK_HOME: '/home/al' }), '/home/al/harnesses.json');
  assert.match(userRegistryPath({}) ?? '', /\/\.agentlink\/harnesses\.json$/);
  assert.deepEqual(loadUserHarnesses(null), { path: null, loaded: [], errors: [] });
  assert.deepEqual(loadUserHarnesses('/no/such/peerloom/harnesses.json').errors, [], 'a missing file is not an error');
});

test('a valid entry becomes an external harness the console can invite, marked as the user\'s', t => {
  const loaded = loadUserHarnesses(file(t, { version: 1, harnesses: [entry(), entry({ id: 'quiet-cli', label: 'Quiet', wake: 'in-turn', approvals: 'native', probe: { date: '2026-11-06', version: '', ok: false, evidence: [], missing: 'not probed yet' } })] }));
  assert.deepEqual(loaded.errors, []); assert.deepEqual(loaded.loaded, ['mycli', 'quiet-cli']);
  const mine = harnessOf('mycli')!;
  assert.deepEqual(mine.routes, ['external']); assert.deepEqual(mine.wake, { external: 'self-arming' }); assert.equal(mine.hubName, 'mycli');
  assert.equal(mine.probe.ok, true); assert.equal(mine.source, 'user'); assert.equal(mine.host, undefined);
  assert.deepEqual(harnessList().find(h => h.id === 'mycli'), { id: 'mycli', label: 'My CLI', routes: ['external'], enabled: true, reason: null, source: 'user' });
  assert.deepEqual(harnessList().find(h => h.id === 'quiet-cli'), { id: 'quiet-cli', label: 'Quiet', routes: ['external'], enabled: false, reason: 'not probed yet', source: 'user' });
  assert.equal(harnessList().find(h => h.id === 'claude')!.source, 'built-in');
  assert.deepEqual(userHarnesses().loaded, ['mycli', 'quiet-cli']);
});

test('bad entries are skipped one by one with a reason; a built-in id is never replaced', t => {
  const loaded = loadUserHarnesses(file(t, { version: 1, harnesses: [
    entry({ id: 'claude', label: 'Not Claude' }),
    entry({ id: 'Bad Id' }),
    entry({ id: 'hosted-cli', routes: ['owned'] }),
    entry({ id: 'no-evidence', probe: { date: '2026-11-06', version: '1', ok: true, evidence: [] } }),
    entry({ id: 'no-reason', probe: { date: '2026-11-06', version: '1', ok: false, evidence: [] } }),
    entry({ id: 'bad-wake', wake: 'hosted' }),
    entry({ id: 'bad-label', label: 'two\nlines' }),
    entry({ id: 'no-probe', probe: undefined }),
    entry({ id: 'good-one' }),
    entry({ id: 'good-one' }),
  ] }));
  assert.deepEqual(loaded.loaded, ['good-one']);
  assert.equal(loaded.errors.length, 9);
  for (const [at, pattern] of [[0, /claude is already a built-in harness/], [1, /id is 2–32/], [2, /unknown keys: routes/], [3, /needs at least one line of evidence/], [4, /says why in probe\.missing/],
    [5, /wake is "self-arming" or "in-turn"/], [6, /label is one line/], [7, /probe is required/], [8, /good-one is already listed earlier in this file/]] as const) assert.match(loaded.errors[at], pattern);
  assert.equal(harnessOf('claude')!.label, 'Claude Code'); assert.equal(harnessOf('claude')!.source, undefined);
  for (const id of ['hosted-cli', 'no-evidence', 'no-reason', 'bad-wake', 'bad-label', 'no-probe']) assert.equal(harnessOf(id), undefined, id);
});

test('a file that is not the registry shape adds nothing and says why', t => {
  assert.match(loadUserHarnesses(file(t, null, '{ not json')).errors[0], /is not valid JSON/);
  assert.match(loadUserHarnesses(file(t, { harnesses: [entry({ id: 'v-less' })] })).errors[0], /must be \{ "version": 1/);
  assert.match(loadUserHarnesses(file(t, { version: 1, harnesses: [], extra: true })).errors[0], /must be \{ "version": 1/);
  assert.equal(harnessOf('v-less'), undefined);
});

test('peerloom harnesses lists user harnesses with their source and the file\'s problems', t => {
  const path = file(t, { version: 1, harnesses: [entry({ id: 'listed-cli' }), entry({ id: 'codex' })] });
  const listed = spawnSync(process.execPath, [join(root, 'bin/peerloom.mjs'), 'harnesses'], { encoding: 'utf8', input: '', env: { ...process.env, PEERLOOM_HARNESSES: path } });
  assert.equal(listed.status, 0, listed.stderr);
  const value = JSON.parse(listed.stdout);
  assert.equal(value.harnesses.at(-1).id, 'listed-cli'); assert.equal(value.harnesses.at(-1).source, 'user'); assert.equal(value.harnesses[0].source, 'built-in');
  assert.deepEqual(value.userRegistry.loaded, ['listed-cli']); assert.match(value.userRegistry.errors[0], /codex is already a built-in harness/);
  // A join line for a user harness is accepted up to the network call, like a built-in one.
  const joined = spawnSync(process.execPath, [resolve(root, 'bin/peerloom.mjs'), 'join', 'http://127.0.0.1:1/j/alj_' + 'a'.repeat(32), '--harness', 'listed-cli', '--timeout', '1'], { encoding: 'utf8', input: '', cwd: mkdtempSync(join(tmpdir(), 'peerloom-userjoin-')), env: { ...process.env, PEERLOOM_HARNESSES: path } });
  assert.doesNotMatch(joined.stdout + joined.stderr, /join_harness/, 'the user harness is not refused as unknown');
});
