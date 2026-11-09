// Item 23: the harness registry is data, so most of it can be checked without a room, a console or a native harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { HARNESSES, harnessList, harnessOf, registerHarness, type Harness } from '../core/harnesses.ts';

// The local verbs need no hub and no credential; they are the CLI surface for this registry.
const cli = (...args: string[]) => spawnSync(process.execPath, ['core/cli.ts', ...args], { encoding: 'utf8', input: '' });

test('the registry is well formed and every enabled harness has evidence', () => {
  const ids = HARNESSES.map(h => h.id);
  assert.equal(new Set(ids).size, ids.length, 'harness ids are unique');
  for (const h of HARNESSES) {
    assert.match(h.id, /^[a-z][a-z0-9-]{1,31}$/);
    assert.ok(h.label.trim() && h.hubName.trim(), `${h.id} has a label and a hub name`);
    assert.ok(h.routes.length > 0, `${h.id} names at least one route`);
    for (const route of h.routes) assert.ok(['hosted', 'self-arming', 'in-turn'].includes(h.wake[route]!), `${h.id} names how a ${route} turn starts`);
    assert.equal(h.routes.includes('owned'), !!h.host, `${h.id} has a host exactly when it has an owned route`);
    assert.ok(['relay', 'native', 'none'].includes(h.approvals));
    assert.equal(h.probe.ok, h.probe.ok === true, 'a probe is a boolean');
    if (h.probe.ok) {
      assert.ok(h.probe.version && h.probe.date && h.probe.evidence.length, `${h.id} records what was observed`);
      assert.equal(h.probe.missing, undefined, `${h.id} passes and has nothing missing`);
    } else {
      assert.ok(h.probe.missing, `${h.id} is disabled and says what is missing`);
    }
  }
});

test('ids are the stored kinds, in the invitation order', () => {
  assert.deepEqual(HARNESSES.map(h => h.id), ['claude', 'codex', 'dsh', 'cursor', 'gemini', 'kimi', 'glm']);
  assert.equal(harnessOf('claude')?.hubName, 'claude-code');
  assert.equal(harnessOf('codex')?.hubName, 'codex');
  assert.equal(harnessOf('dsh')?.label, 'DeepSeek Harness');
  assert.equal(harnessOf('claude-code'), undefined, 'the hub name is not an id');
  assert.equal(harnessOf('not-a-harness'), undefined);
  assert.equal(harnessOf(null), undefined);
});

test('the page list is serialisable and only the passing harnesses are enabled', () => {
  const list = harnessList();
  assert.deepEqual(JSON.parse(JSON.stringify(list)), list);
  assert.deepEqual(list.map(item => item.id), ['claude', 'codex', 'dsh', 'cursor', 'gemini', 'kimi', 'glm']);
  for (const item of list) {
    assert.deepEqual(Object.keys(item).sort(), ['enabled', 'id', 'label', 'reason', 'routes', 'source']);
    assert.equal(typeof item.enabled, 'boolean');
    assert.ok(Array.isArray(item.routes) && item.routes.length);
    if (!item.enabled) assert.ok(item.reason, `${item.id} says why it cannot be invited`);
  }
  assert.deepEqual(list.filter(item => item.enabled).map(item => item.id), ['claude', 'codex', 'dsh', 'cursor']);
  assert.equal(list.find(item => item.id === 'cursor')!.reason, null, 'the Cursor wake probe passed (item 25), so Cursor is enabled');
  assert.equal(list.find(item => item.id === 'dsh')!.reason, null, 'the idle-wake probe passed, so DSH is enabled');
  assert.match(list.find(item => item.id === 'gemini')!.reason!, /unprobed/);
  assert.match(list.find(item => item.id === 'kimi')!.reason!, /not installed/);
});

test('a harness existing only in a test registers through the same shape', () => {
  const fake: Harness = {
    id: 'fake', label: 'Fake Harness', hubName: 'fake', routes: ['external'], wake: { external: 'self-arming' },
    approvals: 'none', detect: { bin: '', version: [] },
    probe: { date: '2026-10-26T00:00:00.000Z', version: 'test', ok: true, evidence: ['registered by test/harnesses.test.ts'] },
  };
  assert.equal(harnessOf('fake'), undefined);
  registerHarness(fake);
  assert.equal(harnessOf('fake')?.label, 'Fake Harness');
  const item = harnessList().find(h => h.id === 'fake')!;
  assert.deepEqual(item, { id: 'fake', label: 'Fake Harness', routes: ['external'], enabled: true, reason: null, source: 'built-in' });
  assert.throws(() => registerHarness(fake), /already registered/);
});

test('registering a malformed harness is refused rather than half-known', () => {
  const base: Harness = { id: 'fake2', label: 'Fake Two', hubName: 'fake2', routes: ['external'], wake: { external: 'self-arming' }, approvals: 'none', detect: { bin: '', version: [] }, probe: { date: '2026-10-26T00:00:00.000Z', version: 'test', ok: true, evidence: ['test'] } };
  assert.throws(() => registerHarness({ ...base, id: 'Bad Id' }), /lower-case/);
  assert.throws(() => registerHarness({ ...base, label: '' }), /label/);
  assert.throws(() => registerHarness({ ...base, routes: [], wake: {} }), /route/);
  assert.throws(() => registerHarness({ ...base, routes: ['owned'], wake: { owned: 'hosted' } }), /host class/);
  assert.throws(() => registerHarness({ ...base, wake: {} }), /wake mode/);
  assert.equal(harnessOf('fake2'), undefined, 'a refused registration changes nothing');
});

test('the CLI lists the registry without a credential, and refuses a credential flag', () => {
  const listed = cli('harnesses');
  assert.equal(listed.status, 0, listed.stderr);
  const value = JSON.parse(listed.stdout);
  assert.equal(value.status, 'harnesses');
  assert.deepEqual(value.harnesses.map((h: any) => h.id), ['claude', 'codex', 'dsh', 'cursor', 'gemini', 'kimi', 'glm']);
  assert.equal(value.harnesses.find((h: any) => h.id === 'dsh').enabled, true);
  assert.ok(!JSON.stringify(value).includes('token'), 'no credential or token is printed');
  const stray = cli('harnesses', '--client', 'x');
  assert.equal(stray.status, 1);
  assert.equal(JSON.parse(stray.stdout).error, 'usage');
});

test('harness-probe reports a harness with no CLI as a finding, not a failed call', () => {
  const probed = cli('harness-probe', 'dsh');
  assert.equal(probed.status, 0, probed.stderr);
  const value = JSON.parse(probed.stdout);
  assert.equal(value.status, 'probe');
  assert.equal(value.harness, 'dsh');
  assert.equal(value.found, false);
  assert.equal(value.ok, false);
  assert.equal(value.enables, false);
  assert.match(value.reason, /no CLI/);
});

test('harness-probe needs a known harness and bounds its timeout', () => {
  assert.equal(cli('harness-probe').status, 1);
  const unknown = cli('harness-probe', 'nope');
  assert.equal(unknown.status, 1);
  assert.equal(JSON.parse(unknown.stdout).error, 'unknown_harness');
  const slow = cli('harness-probe', 'claude', '--timeout', '10');
  assert.equal(slow.status, 1);
  assert.equal(JSON.parse(slow.stdout).error, 'usage');
});

test('the fake external harness refuses to start without a credential', () => {
  const run = spawnSync(process.execPath, ['test/helpers/fake-harness.ts'], { encoding: 'utf8', input: '', env: { ...process.env, FAKE_HARNESS_CLIENT: '' } });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /FAKE_HARNESS_CLIENT is required/);
});
