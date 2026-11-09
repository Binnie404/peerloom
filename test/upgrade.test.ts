import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from '../core/client.ts';
import { startHub } from '../core/server.ts';

// state.json.fixture was written by core/server.ts as it stood before collaboration records existed
// (SHA-256 f8d65d41…104b). expected.json holds what that hub answered for the same room.
const root = resolve(import.meta.dirname, '..');
const fixture = join(import.meta.dirname, 'fixtures', 'v1');
const original = readFileSync(join(fixture, 'state.json.fixture'));
const credentials = JSON.parse(readFileSync(join(fixture, 'credentials.json'), 'utf8'));
const expected = JSON.parse(readFileSync(join(fixture, 'expected.json'), 'utf8'));
const COLLAB = ['item_open', 'item_close', 'publish', 'request', 'respond', 'withdraw', 'accept', 'requests', 'items', 'item', 'revision'];

function store(t: { after(fn: () => void): void }, seed: Buffer | null = original) {
  const data = mkdtempSync(join(tmpdir(), 'agentlink-upgrade-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  if (seed) writeFileSync(join(data, 'state.json'), seed, { mode: 0o600 });
  return { data, state: join(data, 'state.json'), backup: join(data, 'state.v1.backup.json') };
}
// A hub that starts when it should have refused is closed before the test fails, so the failure reports instead of hanging.
async function refusesToStart(options: { dataDir: string; port: number; upgradeState?: boolean }, name?: string) {
  let started: Awaited<ReturnType<typeof startHub>> | undefined;
  try { started = await startHub(options); } catch { return; }
  await started.close();
  assert.fail(`The hub started${name ? ` despite ${name}` : ''}`);
}
const as = (hub: { endpoint: string }, who: 'owner' | 'astra' | 'bolt') => ({ endpoint: hub.endpoint, token: credentials[who].token });
const code = async (promise: Promise<unknown>) => { try { await promise; return 'ok'; } catch (error: any) { return error.code as string; } };

// Everything a version 1 client could observe, compared with what the original hub returned.
async function mailboxUnchanged(hub: { endpoint: string }) {
  for (const who of ['astra', 'bolt'] as const) assert.deepEqual((await request(as(hub, who), 'inbox')).messages.map((m: any) => m.id), expected.inbox[who], `${who}'s unread mail`);
  assert.deepEqual((await request(as(hub, 'owner'), 'history')).messages, expected.history);
  const room = await request(as(hub, 'astra'), 'room');
  assert.equal(room.self, credentials.astra.participantId);
  assert.equal(room.roster.find((p: any) => p.name === 'Astra').status, 'Waiting for Bolt');
  assert.equal(room.roster.find((p: any) => p.name === 'Bolt').unread, expected.inbox.bolt.length);
  // The identical retry returns the first result and adds nothing; the same key with other content is refused.
  assert.deepEqual(await request(as(hub, 'astra'), 'send', { requestId: expected.retry.key, ...expected.retry.body }), expected.retry.result);
  assert.equal(await code(request(as(hub, 'astra'), 'send', { requestId: expected.retry.key, ...expected.retry.body, text: 'Changed' })), 'request_conflict');
  assert.equal((await request(as(hub, 'owner'), 'history')).messages.length, expected.history.length);
}

test('a version 1 store keeps serving the mailbox, stays version 1 and refuses collaboration until upgraded', async t => {
  const s = store(t); const hub = await startHub({ dataDir: s.data, port: 0 });
  try {
    await mailboxUnchanged(hub);
    for (const op of COLLAB) {
      assert.equal(await code(request(as(hub, 'astra'), op, { requestId: `try-${op}` })), 'upgrade_required', op);
    }
    const capabilities = await request(as(hub, 'astra'), 'capabilities');
    assert.equal(capabilities.stateVersion, 1); assert.equal(capabilities.collaboration, false);
    for (const op of COLLAB) assert.ok(!capabilities.operations.includes(op), `${op} must not be advertised on a version 1 store`);
    assert.ok(capabilities.operations.includes('send'));
    const sent = await request(as(hub, 'bolt'), 'send', { requestId: 'after-reload', to: 'Astra', text: 'Still here' });   // forces a save
    assert.equal(sent.message.sequence, expected.history.length + 1);
  } finally { await hub.close(); }
  const saved = JSON.parse(readFileSync(s.state, 'utf8'));
  assert.equal(saved.version, 1);
  assert.ok(saved.sessions.every((session: any) => session.events === undefined), 'no collaboration records appear in a version 1 file');
  assert.equal(existsSync(s.backup), false, 'serving a version 1 store makes no backup');
});

test('explicit upgrade backs up the exact version 1 file, preserves the mailbox and enables collaboration', async t => {
  const s = store(t); let hub = await startHub({ dataDir: s.data, port: 0, upgradeState: true });
  let itemId: string;
  try {
    assert.deepEqual(readFileSync(s.backup), original, 'the backup is the version 1 file, byte for byte');
    assert.equal(JSON.parse(readFileSync(s.state, 'utf8')).version, 6);
    await mailboxUnchanged(hub);
    const capabilities = await request(as(hub, 'astra'), 'capabilities');
    assert.equal(capabilities.stateVersion, 6); assert.equal(capabilities.collaboration, true);
    for (const op of COLLAB) assert.ok(capabilities.operations.includes(op), `${op} is advertised`);
    assert.deepEqual((await request(as(hub, 'astra'), 'items')).items, []);
    itemId = (await request(as(hub, 'astra'), 'item_open', { requestId: 'first-item', itemType: 'decision', title: 'After upgrade' })).itemId;
    // Old participants are usable as respondents, and the request reaches the old inbox.
    const asked = await request(as(hub, 'astra'), 'request', { requestId: 'first-request', itemId, purpose: 'answer', to: ['Bolt'], text: 'Did the upgrade keep your mail?' });
    assert.deepEqual((await request(as(hub, 'bolt'), 'inbox')).messages.map((m: any) => m.id), [...expected.inbox.bolt, asked.messageId]);
  } finally { await hub.close(); }
  hub = await startHub({ dataDir: s.data, port: 0 });                                  // an ordinary restart of the upgraded store
  try {
    assert.equal((await request(as(hub, 'bolt'), 'item', { itemId })).item.title, 'After upgrade');
    assert.equal((await request(as(hub, 'bolt'), 'requests', { filter: 'owed_by_me' })).requests.length, 1);
    assert.deepEqual(await request(as(hub, 'astra'), 'item_open', { requestId: 'first-item', itemType: 'decision', title: 'After upgrade' }), { itemId, seq: 1 });
    assert.deepEqual(readFileSync(s.backup), original);
  } finally { await hub.close(); }
});

test('upgrade never overwrites an existing backup and leaves the store as it was', async t => {
  const s = store(t); writeFileSync(s.backup, 'an earlier backup');
  await refusesToStart({ dataDir: s.data, port: 0, upgradeState: true });
  assert.equal(readFileSync(s.backup, 'utf8'), 'an earlier backup');
  assert.deepEqual(readFileSync(s.state), original);
  const hub = await startHub({ dataDir: s.data, port: 0 });                             // the failed attempt left no lock behind
  try { await mailboxUnchanged(hub); } finally { await hub.close(); }
});

test('upgrade validates version 1 state first: a damaged file is neither backed up nor rewritten', async t => {
  const damaged = JSON.parse(original.toString('utf8')); damaged.sessions[0].messages = 'gone';
  const bytes = Buffer.from(JSON.stringify(damaged)); const s = store(t, bytes);
  await refusesToStart({ dataDir: s.data, port: 0, upgradeState: true });
  assert.deepEqual(readFileSync(s.state), bytes);
  assert.equal(existsSync(s.backup), false);
});

test('a new data directory starts at version 6 with idle delivery and nothing to back up', async t => {
  const s = store(t, null); const hub = await startHub({ dataDir: s.data, port: 0 });
  try {
    const admin = JSON.parse(readFileSync(hub.adminPath, 'utf8'));
    const owner = await request(admin, 'create', { requestId: 'room', name: 'Fresh', workspace: tmpdir() });
    assert.equal((await request(owner, 'capabilities')).collaboration, true);
    assert.equal((await request(owner, 'item_open', { requestId: 'i', itemType: 'task', title: 'Works at once' })).seq, 1);
  } finally { await hub.close(); }
  assert.equal(JSON.parse(readFileSync(s.state, 'utf8')).version, 6);
  assert.equal(existsSync(s.backup), false);
});

test('a version 2 store whose records do not fit the rules stops startup and is left untouched', async t => {
  const s = store(t); let hub = await startHub({ dataDir: s.data, port: 0, upgradeState: true });
  try {
    const { itemId } = await request(as(hub, 'astra'), 'item_open', { requestId: 'i', itemType: 'decision', title: 'Plan' });
    const p = await request(as(hub, 'astra'), 'publish', { requestId: 'p', itemId, text: 'R1' });
    const target = { artifactId: p.artifactId, revision: 1, digest: p.digest };
    const q = await request(as(hub, 'astra'), 'request', { requestId: 'q', itemId, purpose: 'review', to: ['Bolt'], text: 'Review', target });
    await request(as(hub, 'bolt'), 'respond', { requestId: 'r', collabRequestId: q.collabRequestId, outcome: 'answered', verdict: 'changes_requested', target, text: 'Not yet' });
  } finally { await hub.close(); }
  const good = readFileSync(s.state);
  const damage: [string, (state: any) => void][] = [
    ['an objection rewritten as an approval without its message', state => { state.sessions[0].events.at(-1).text = 'Approved'; state.sessions[0].events.at(-1).verdict = 'approve'; }],
    ['a forged acceptance by the reviewer', state => { const events = state.sessions[0].events; events.push({ seq: events.length + 1, type: 'request_accepted', at: events.at(-1).at, by: events.at(-1).by, collabRequestId: events.at(-1).collabRequestId, responseIds: [events.at(-1).responseId] }); }],
    ['revision text edited after publication', state => { state.sessions[0].events[1].contentInline = 'R1, improved'; }],
    ['a deleted event', state => { state.sessions[0].events.splice(1, 1); }],
    ['a stored projection', state => { state.sessions[0].events[2].state = 'accepted'; }],
    ['events missing from a version 2 session', state => { delete state.sessions[0].events; }],
  ];
  for (const [name, corrupt] of damage) {
    const state = JSON.parse(good.toString('utf8')); corrupt(state);
    const bytes = Buffer.from(JSON.stringify(state)); writeFileSync(s.state, bytes);
    await refusesToStart({ dataDir: s.data, port: 0 }, name);
    assert.deepEqual(readFileSync(s.state), bytes, `${name}: the file is evidence and must not be rewritten`);
  }
  writeFileSync(s.state, good);
  hub = await startHub({ dataDir: s.data, port: 0 });                                   // the undamaged file still loads
  try { assert.equal((await request(as(hub, 'bolt'), 'items')).items[0].artifacts[0].status, 'changes_requested'); } finally { await hub.close(); }
});

test('the hub process accepts --upgrade-state and reports the upgraded store', { timeout: 30_000 }, async t => {
  const s = store(t);
  const child = spawn(process.execPath, ['core/server.ts', '--data', s.data, '--port', '0', '--upgrade-state'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  const ready = await new Promise<any>((ok, reject) => {
    let buffer = '';
    child.stdout.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { try { ok(JSON.parse(buffer.split('\n')[0])); } catch (error) { reject(error); } } });
    child.once('exit', () => reject(new Error(`Hub exited before startup: ${errors}`)));
  });
  assert.equal((await request(as(ready, 'astra'), 'capabilities')).stateVersion, 6);
  assert.deepEqual(readFileSync(s.backup), original);
  const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped;
  copyFileSync(s.backup, join(s.data, 'restored.json'));                                 // the backup is a complete, loadable version 1 file
  const t2 = store(t, readFileSync(join(s.data, 'restored.json'))); const hub = await startHub({ dataDir: t2.data, port: 0 });
  try { await mailboxUnchanged(hub); } finally { await hub.close(); }
});
