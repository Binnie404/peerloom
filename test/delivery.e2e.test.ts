import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from '../core/client.ts';
import { startHub } from '../core/server.ts';

// Independent contract tests. Domain decisions are exercised through a real
// hub process; no reducer internals or transport hooks are used here.
const root = resolve(import.meta.dirname, '..');
const sleep = (ms: number) => new Promise(ok => setTimeout(ok, ms));
const until = async (condition: () => Promise<boolean>, what: string) => {
  for (let n = 0; n < 200; n++) { if (await condition()) return; await sleep(20); }
  assert.fail(`Timed out waiting for ${what}`);
};
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: any) => error.code === code);

async function launch(data: string, ...flags: string[]) {
  const child = spawn(process.execPath, ['core/server.ts', '--data', data, '--port', '0', ...flags], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stderr.on('data', chunk => { err += chunk; });
  const done = once(child, 'exit');
  const ready = new Promise<any>((ok, reject) => {
    child.stdout.on('data', chunk => {
      out += chunk;
      if (out.includes('\n')) { try { ok(JSON.parse(out.split('\n')[0])); } catch (error) { reject(error); } }
    });
    child.once('exit', () => reject(new Error(`Hub did not start: ${err}`)));
    child.once('error', reject);
  });
  return {
    child, ready, done, stderr: () => err,
    stop: async (signal: 'SIGKILL' | 'SIGTERM' = 'SIGKILL') => {
      if (child.exitCode === null && child.signalCode === null) { child.kill(signal); await done; }
    },
  };
}

async function world(t: { after(fn: () => unknown): void }, version = 4) {
  const dir = mkdtempSync(join(tmpdir(), 'peerloom-delivery-http-')); const data = join(dir, 'hub');
  if (version < 4) { mkdirSync(data); writeFileSync(join(data, 'state.json'), JSON.stringify({ version, sessions: [], requests: {} })); }
  let hub = await launch(data); let ready = await hub.ready; let serial = 0;
  t.after(async () => { await hub.stop(); rmSync(dir, { recursive: true, force: true }); });
  const credentials: Record<string, any> = {};
  const generations: Record<string, number> = {};
  const auth = (who: string) => ({ ...credentials[who], endpoint: ready.endpoint });
  const call = (who: string, op: string, body: any = {}, timeoutMs = 10_000) => request(auth(who), op, body, timeoutMs);
  const mutate = (who: string, op: string, body: any = {}) => call(who, op, { requestId: `${op}-${++serial}`, ...body });
  credentials.admin = JSON.parse(readFileSync(ready.adminFile, 'utf8'));
  credentials.human = await mutate('admin', 'create', { name: 'Delivery contract', workspace: dir });
  for (const who of ['a', 'b', 'c']) {
    const invite = await mutate('human', 'invite', { name: who });
    credentials[who] = await request(invite, 'join', { requestId: `join-${who}`, token: invite.token });
  }
  const bind = async (who: string) => { generations[who] = (await mutate(who, 'bind', { label: `${who} test client` })).generation; return generations[who]; };
  const wait = (who: string, seconds = 1, generation = generations[who]) => call(who, 'wait', { generation, timeoutSeconds: seconds }, (seconds + 10) * 1000);
  const run = () => call('human', 'run');
  const armed = (who: string) => until(async () => (await run()).bindings.find((b: any) => b.participantId === credentials[who].participantId).armed === 'waiting', `${who} to hold a wait`);
  const snapshot = () => JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'));
  const delivery = () => snapshot().sessions[0].delivery;
  const fetch = (who: string, wakeId: string, generation = generations[who]) => call(who, 'fetch', { generation, wakeId });
  const confirm = (who: string, wakeId: string, extra: any = {}) => mutate(who, 'confirm', { generation: generations[who], wakeId, ...extra });
  const slot = async (to = 'b', by = 'a', text = 'Review this', itemId?: string) => {
    itemId ??= (await mutate(by, 'item_open', { itemType: 'task', title: 'Addressed work' })).itemId;
    return mutate(by, 'request', { itemId, purpose: 'answer', to: [to], text });
  };
  const restart = async (...flags: string[]) => { await hub.stop(); hub = await launch(data, ...flags); ready = await hub.ready; };
  return { dir, data, credentials, generations, auth, call, mutate, bind, wait, run, armed, snapshot, delivery, fetch, confirm, slot, restart,
    stop: (signal?: 'SIGKILL' | 'SIGTERM') => hub.stop(signal), seed: (value: any) => writeFileSync(join(data, 'state.json'), JSON.stringify(value)) };
}

test('a response dropped after durable preparation returns the same pointer and charges once', async t => {
  const w = await world(t); await w.bind('b'); await w.mutate('human', 'run_start');
  const asked = await w.slot(); const auth = w.auth('b');
  // Destroy on headers, before reading the body. The server has committed
  // the offer, but this client never obtains the wake ID from the response.
  await new Promise<void>((ok, reject) => {
    const req = httpRequest(`${auth.endpoint}/v1/wait`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` } });
    req.on('response', response => { response.destroy(); req.destroy(); ok(); });
    req.on('error', reject);
    req.end(JSON.stringify({ generation: w.generations.b, timeoutSeconds: 2 }));
  });
  const committed = w.delivery(); assert.equal(committed.offers.length, 1);
  assert.deepEqual(committed.offers[0].units, [{ kind: 'slot', id: asked.collabRequestId }]);
  const again = await w.wait('b'); assert.equal(again.wakeId, committed.offers[0].wakeId);
  assert.equal((await w.run()).used.room, 1); assert.deepEqual(w.delivery(), committed);
});

test('client death after fetching before confirmation leaves the same pending offer', async t => {
  const w = await world(t); await w.bind('b'); await w.mutate('human', 'run_start'); await w.slot();
  const offered = await w.wait('b');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {request} from ${JSON.stringify(new URL('../core/client.ts', import.meta.url).href)};
    const payload = await request(JSON.parse(process.argv[1]), 'fetch', JSON.parse(process.argv[2]));
    console.log(JSON.stringify({wakeId:payload.wakeId, count:payload.units.length}));
    setInterval(() => {}, 1000);
  `, JSON.stringify(w.auth('b')), JSON.stringify({ generation: w.generations.b, wakeId: offered.wakeId })], { stdio: ['ignore', 'pipe', 'pipe'] });
  const gone = once(child, 'exit'); t.after(() => child.kill('SIGKILL'));
  const ready = await once(child.stdout, 'data'); assert.equal(JSON.parse(String(ready[0])).wakeId, offered.wakeId);
  child.kill('SIGKILL'); await gone;
  assert.equal(w.delivery().offers[0].confirmedAt, undefined);
  assert.equal((await w.wait('b')).wakeId, offered.wakeId); assert.equal((await w.run()).used.room, 1);
});

test('confirmed intake stays covered while owed; human reoffer and exact retries act once', async t => {
  const w = await world(t); await w.bind('b'); await w.mutate('human', 'run_start'); const asked = await w.slot();
  const first = await w.wait('b'); const confirmed = await w.confirm('b', first.wakeId);
  assert.equal((await w.wait('b')).status, 'timeout');
  assert.equal((await w.call('b', 'requests', { filter: 'owed_by_me' })).requests[0].collabRequestId, asked.collabRequestId);
  const grant = { requestId: 'one-reoffer', participant: 'b' };
  const changes = (await w.run()).changes; await w.call('human', 'run_reoffer', grant);
  const after = (await w.run()).changes; assert.equal(after, changes + 1);
  await w.call('human', 'run_reoffer', grant); assert.equal((await w.run()).changes, after);
  assert.equal(w.delivery().grants.length, 1); assert.equal(w.delivery().epochs[w.credentials.b.participantId], 2);
  const second = await w.wait('b'); assert.notEqual(second.wakeId, first.wakeId);
  assert.deepEqual(second.units, first.units); assert.equal((await w.run()).used.room, 2);
  assert.equal(w.delivery().offers[0].confirmedAt, confirmed.confirmedAt);
});

test('same-binding double wait is refused; disconnect releases without an empty charge', async t => {
  const w = await world(t); await w.bind('b'); await w.mutate('human', 'run_start');
  const controller = new AbortController(); const auth = w.auth('b');
  const held = fetch(`${auth.endpoint}/v1/wait`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` }, body: JSON.stringify({ generation: w.generations.b, timeoutSeconds: 30 }), signal: controller.signal });
  const stopped = assert.rejects(held, (error: any) => error.name === 'AbortError');
  await w.armed('b'); await rejects(w.wait('b'), 'already_waiting');
  // Generation validation precedes the duplicate-wait check.
  await rejects(w.wait('b', 1, 99), 'stale_binding');
  controller.abort(); await stopped;
  await until(async () => (await w.run()).bindings.find((b: any) => b.participantId === w.credentials.b.participantId).armed === 'not_armed', 'disconnected wait release');
  assert.equal(w.delivery().empties[w.credentials.b.participantId] ?? 0, 0);
  const again = w.wait('b', 5); await w.armed('b'); await w.slot(); assert.equal((await again).status, 'offer');
});

test('rebinding supersedes a held wait, closes pending intake and refuses all old-generation calls', async t => {
  const w = await world(t); const old = await w.bind('b'); await w.mutate('human', 'run_start'); await w.slot();
  const first = await w.wait('b'); await w.mutate('human', 'run_pause');
  const held = w.wait('b', 5); await w.armed('b'); await w.bind('b');
  assert.deepEqual(await held, { status: 'superseded' });
  assert.equal(w.delivery().offers[0].closed.reason, 'rebound');
  await rejects(w.wait('b', 1, old), 'stale_binding');
  await rejects(w.fetch('b', first.wakeId, old), 'stale_binding');
  await rejects(w.confirm('b', first.wakeId, { generation: old }), 'stale_binding');
  await w.mutate('human', 'run_resume'); const second = await w.wait('b');
  await rejects(w.confirm('b', second.wakeId, { generation: old }), 'stale_binding');
  assert.equal(w.delivery().offers[1].confirmedAt, undefined); assert.equal((await w.run()).used.room, 2);
});

test('concurrent mutation and wait registration never lose addressed work, including after rollback', async t => {
  const w = await world(t); await w.bind('b'); await w.mutate('human', 'run_start', { limits: { room: 100, agent: 100 } });
  const item = await w.mutate('a', 'item_open', { itemType: 'task', title: 'Registration race' });
  for (let n = 0; n < 40; n++) {
    const [wake, asked] = await Promise.all([w.wait('b', 2), w.slot('b', 'a', `Concurrent request ${n}`, item.itemId)]);
    assert.equal(wake.status, 'offer', `race ${n}`); assert.deepEqual(wake.units, [{ kind: 'slot', id: asked.collabRequestId }]);
    await w.confirm('b', wake.wakeId);
  }
  // A rejected mutation rolls back by replacing the whole state object.
  const held = w.wait('b', 3); await w.armed('b');
  await rejects(w.mutate('a', 'request', { itemId: item.itemId, purpose: 'answer', to: ['unknown'], text: 'Refuse' }), 'unknown_recipient');
  const asked = await w.slot('b', 'a', 'After rollback', item.itemId);
  assert.deepEqual((await held).units, [{ kind: 'slot', id: asked.collabRequestId }]);
  assert.equal((await w.run()).used.room, 41);
});

test('mail from another agent wakes its recipient once, never its sender, and not after it is acknowledged', async t => {
  const w = await world(t); await w.bind('a'); await w.bind('b'); await w.mutate('human', 'run_start');
  const sender = w.wait('b', 2); const held = w.wait('a', 5); await w.armed('a'); await w.armed('b');
  const mail = await w.mutate('b', 'send', { to: 'a', text: 'Peer text that must not ride in the pointer' });
  const wake = await held; assert.deepEqual(wake.units, [{ kind: 'agent_message', id: mail.message.id }]); assert.doesNotMatch(JSON.stringify(wake), /Peer text/);
  assert.deepEqual(await sender, { status: 'timeout', held: 'none' }, 'the sender is not told about its own message');
  const payload = await w.fetch('a', wake.wakeId); assert.equal(payload.units[0].view.text, 'Peer text that must not ride in the pointer');
  assert.deepEqual({ kind: payload.units[0].sender.kind, id: payload.units[0].sender.id }, { kind: 'agent', id: w.credentials.b.participantId }, 'the sender comes from the hub\'s records');
  await w.confirm('a', wake.wakeId);
  // Confirmed intake is not offered again; neither is mail acknowledged before any wait saw it.
  assert.deepEqual(await w.wait('a', 1), { status: 'timeout', held: 'none' });
  const read = await w.mutate('b', 'send', { to: 'a', text: 'Already read' }); await w.mutate('a', 'ack', { messageIds: [read.message.id] });
  assert.deepEqual(await w.wait('a', 1), { status: 'timeout', held: 'none' });
  // It is charged to the run like any other offer, which is what bounds two agents talking.
  assert.equal((await w.run()).used.agents[w.credentials.a.participantId], 1);
});

test('a later response wakes its requester; publication, status and ACK do not', async t => {
  const w = await world(t); await w.bind('a'); await w.bind('b'); await w.mutate('human', 'run_start');
  const asked = await w.slot(); const offered = await w.wait('b'); await w.confirm('b', offered.wakeId);
  const held = w.wait('a', 5); await w.armed('a');
  await w.mutate('b', 'status', { text: 'Working' });
  const mail = await w.mutate('human', 'send', { to: 'b', text: 'For Bolt only' });
  await w.mutate('b', 'ack', { messageIds: [mail.message.id] });
  const itemId = (await w.call('b', 'requests', { filter: 'owed_by_me' })).requests[0].itemId;
  await w.mutate('a', 'publish', { itemId, text: 'Passive revision' });
  assert.equal((await w.run()).bindings.find((b: any) => b.participantId === w.credentials.a.participantId).armed, 'waiting');
  const response = await w.mutate('b', 'respond', { collabRequestId: asked.collabRequestId, outcome: 'answered', text: 'Here is the answer' });
  const wake = await held; assert.deepEqual(wake.units, [{ kind: 'response', id: response.responseId }]);
  const payload = await w.fetch('a', wake.wakeId); assert.equal(payload.units[0].view.response.text, 'Here is the answer');
  await w.mutate('a', 'accept', { collabRequestId: asked.collabRequestId, responseIds: [response.responseId] });
  const stale = await w.fetch('a', wake.wakeId); assert.equal(stale.units[0].current, false);
  assert.equal(stale.units[0].view.response.text, 'Here is the answer', 'inactive response remains complete evidence');
});

test('paused waits hold despite pending offers; held pointers remain usable and resume preserves the charge', async t => {
  const w = await world(t); await w.bind('b'); await w.bind('c'); await w.mutate('human', 'run_start');
  await w.slot('b'); await w.slot('c'); const b = await w.wait('b'); const c = await w.wait('c');
  await w.mutate('human', 'run_pause');
  const held = w.wait('b'); await w.armed('b');
  assert.equal((await w.fetch('b', b.wakeId)).units[0].current, true);
  await w.confirm('b', b.wakeId);
  assert.deepEqual(await held, { status: 'timeout', held: 'not_running' });
  await w.mutate('human', 'run_resume'); assert.equal((await w.wait('c')).wakeId, c.wakeId);
  for (let n = 0; n < 4; n++) { await w.mutate('human', 'run_pause'); await w.mutate('human', 'run_resume'); }
  const before = await w.run(); assert.equal(before.used.room, 2); assert.equal(before.number, 1);
  await w.restart(); const after = await w.run();
  assert.deepEqual(after.used, before.used); assert.equal(after.number, 1); assert.equal(after.control, before.control);
  assert.equal((await w.wait('c')).wakeId, c.wakeId);
});

test('two agents compete for one room offer; a durable raised limit releases the held peer', async t => {
  const w = await world(t); await w.bind('b'); await w.bind('c'); await w.mutate('human', 'run_start', { limits: { room: 1 } });
  await w.slot('b'); await w.slot('c'); const results = await Promise.all([w.wait('b'), w.wait('c')]);
  assert.equal(results.filter(r => r.status === 'offer').length, 1);
  assert.deepEqual(results.find(r => r.status === 'timeout'), { status: 'timeout', held: 'budget_room' });
  assert.equal((await w.run()).used.room, 1);
  const loser = results[0].status === 'timeout' ? 'b' : 'c'; const held = w.wait(loser, 5); await w.armed(loser);
  await w.mutate('human', 'run_limits', { limits: { room: 2 } }); assert.equal((await held).status, 'offer');
  assert.equal((await w.run()).used.room, 2);
});

test('empty limits survive restart and binding, exact rearm acts once and a real offer resets empties', async t => {
  const w = await world(t); await w.bind('b'); await w.mutate('human', 'run_start', { limits: { emptyWaits: 2 } });
  assert.equal((await w.wait('b')).status, 'timeout'); assert.equal((await w.wait('b')).status, 'timeout');
  await w.restart(); assert.deepEqual(await w.wait('b', 30), { status: 'disarmed' });
  await w.bind('b'); assert.deepEqual(await w.wait('b', 30), { status: 'disarmed' });
  const rearm = { requestId: 'once-rearm', participant: 'b' }; await w.call('human', 'run_rearm', rearm);
  assert.equal((await w.wait('b')).status, 'timeout'); await w.call('human', 'run_rearm', rearm);
  assert.equal(w.delivery().empties[w.credentials.b.participantId], 1); assert.equal(w.delivery().grants.length, 1);
  await w.slot(); assert.equal((await w.wait('b')).status, 'offer'); assert.equal(w.delivery().empties[w.credentials.b.participantId], 0);
});

test('twelve addressed units arrive oldest first in three bounded offers', async t => {
  const w = await world(t); await w.bind('b'); await w.mutate('human', 'run_start');
  const ids = []; for (let n = 0; n < 12; n++) { ids.push((await w.slot('b', 'a', `Unit ${n}`)).collabRequestId); await sleep(2); }
  const seen = [];
  for (const [size, more] of [[5, true], [5, true], [2, false]]) {
    const wake = await w.wait('b'); assert.equal(wake.units.length, size); assert.equal(wake.more, more);
    assert.equal((await w.fetch('b', wake.wakeId)).units.length, size);
    seen.push(...wake.units.map((u: any) => u.id)); await w.confirm('b', wake.wakeId);
  }
  assert.deepEqual(seen, ids); assert.equal((await w.run()).used.room, 3);
});

test('new Start closes old pending offers, resetting budgets while preserving confirmations and history', async t => {
  const w = await world(t); await w.bind('b'); await w.mutate('human', 'run_start'); await w.slot();
  const first = await w.wait('b'); await w.mutate('human', 'run_end'); await w.mutate('human', 'run_start');
  assert.equal(w.delivery().offers[0].closed.reason, 'new_run'); await rejects(w.confirm('b', first.wakeId), 'offer_closed');
  const second = await w.wait('b'); assert.notEqual(second.wakeId, first.wakeId); assert.deepEqual(second.units, first.units);
  assert.equal((await w.run()).used.room, 1); assert.equal(w.delivery().offers.length, 2);
});

test('SIGKILL after bind, offer, fetch and confirm preserves every delivery fact and count', async t => {
  const w = await world(t); await w.mutate('human', 'run_start'); await w.bind('b');
  const bound = w.delivery(); await w.restart(); assert.deepEqual(w.delivery(), bound);
  await w.slot(); const wake = await w.wait('b'); const offered = w.delivery();
  await w.restart(); assert.deepEqual(w.delivery(), offered); assert.equal((await w.wait('b')).wakeId, wake.wakeId);
  await w.fetch('b', wake.wakeId); const fetched = w.delivery();
  await w.restart(); assert.deepEqual(w.delivery(), fetched); assert.equal((await w.wait('b')).wakeId, wake.wakeId);
  await w.confirm('b', wake.wakeId); const confirmed = w.delivery();
  await w.restart(); assert.deepEqual(w.delivery(), confirmed); assert.equal((await w.run()).used.room, 1);
  assert.equal((await w.wait('b')).status, 'timeout');
});

test('run authority, own-offer scopes, strict wait input and cross-room isolation', async t => {
  const w = await world(t); await w.bind('a'); await w.bind('b'); await w.mutate('human', 'run_start'); await w.slot(); const wake = await w.wait('b');
  for (const op of ['run_start', 'run_pause', 'run_resume', 'run_end', 'run_limits', 'run_reoffer', 'run_rearm']) {
    const fields = op === 'run_limits' ? { limits: { room: 1 } } : op === 'run_reoffer' || op === 'run_rearm' ? { participant: 'a' } : {};
    await rejects(w.mutate('a', op, fields), 'owner_required');
  }
  await rejects(w.call('human', 'wait', { generation: 1, timeoutSeconds: 1 }), 'agent_required');
  await rejects(w.fetch('a', wake.wakeId), 'unknown_wake'); await rejects(w.confirm('a', wake.wakeId), 'unknown_wake');
  await rejects(w.call('b', 'wait', { generation: w.generations.b, timeoutSeconds: 1, requestId: 'forbidden' }), 'unknown_field');
  await rejects(w.call('b', 'wait', { generation: w.generations.b, timeoutSeconds: 1, after: 0 }), 'unknown_field');
  const other = await w.mutate('admin', 'create', { name: 'Other room', workspace: w.dir });
  const invite = await request(other, 'invite', { requestId: 'other-invite', name: 'other' });
  const agent = await request(invite, 'join', { requestId: 'other-join', token: invite.token });
  const binding = await request(agent, 'bind', { requestId: 'other-bind', label: 'other' });
  await rejects(request(agent, 'fetch', { generation: binding.generation, wakeId: wake.wakeId }), 'unknown_wake');
  await rejects(request(other, 'run_reoffer', { requestId: 'cross', participant: w.credentials.b.participantId }), 'unknown_participant');
});

test('a never-started room holds current work; Start releases it and counts no idle wake', async t => {
  const w = await world(t); await w.bind('b'); await w.slot();
  assert.deepEqual(await w.wait('b'), { status: 'timeout', held: 'not_running' });
  assert.equal(w.delivery().offers.length, 0); assert.equal((await w.run()).used.room, 0);
  const held = w.wait('b', 5); await w.armed('b'); await w.mutate('human', 'run_start');
  assert.equal((await held).status, 'offer'); assert.equal(w.delivery().empties[w.credentials.b.participantId], 0);
});

test('limits lowered below current use are valid on restart and hold further work', async t => {
  const w = await world(t); await w.bind('b'); await w.mutate('human', 'run_start');
  await w.slot(); const first = await w.wait('b'); await w.confirm('b', first.wakeId);
  await w.slot(); const second = await w.wait('b'); await w.confirm('b', second.wakeId);
  await w.mutate('human', 'run_limits', { limits: { room: 1, agent: 1 } }); await w.slot();
  const before = w.delivery(); await w.restart(); assert.deepEqual(w.delivery(), before);
  assert.deepEqual(await w.wait('b'), { status: 'timeout', held: 'budget_room' });
  await w.mutate('human', 'run_limits', { limits: { room: 3 } });
  assert.deepEqual(await w.wait('b'), { status: 'timeout', held: 'budget_agent' });
  await w.mutate('human', 'run_limits', { limits: { agent: 3 } }); assert.equal((await w.wait('b')).status, 'offer');
});

test('forged v4 delivery evidence refuses process startup and preserves exact bytes', async t => {
  const w = await world(t); await w.bind('a'); await w.bind('b'); await w.mutate('human', 'run_start', { limits: { room: 1 } }); await w.slot(); await w.wait('b');
  await w.mutate('human', 'run_pause'); await w.stop(); const good = w.snapshot();
  const damage: [string, (d: any, s: any) => void][] = [
    ['wrong recipient', d => { d.offers[0].participantId = w.credentials.a.participantId; }],
    ['wrong unit kind', d => { d.offers[0].units[0].kind = 'human_message'; }],
    ['both confirmed and closed', d => { d.offers[0].confirmedAt = d.offers[0].preparedAt; d.offers[0].closed = { at: d.offers[0].preparedAt, reason: 'rebound' }; }],
    ['two pending', d => { d.offers.push({ ...structuredClone(d.offers[0]), wakeId: 'wk_second' }); }],
    ['epoch without grant', d => { d.epochs[w.credentials.b.participantId] = 2; }],
    ['nonhuman grant', d => { d.grants.push({ seq: 1, type: 'rearm', participantId: w.credentials.b.participantId, by: w.credentials.a.participantId, at: d.offers[0].preparedAt, run: 1 }); }],
    ['nonhuman control', d => { d.controls[0].by = w.credentials.b.participantId; }],
    ['future run', d => { d.offers[0].run = 2; }],
    ['paused control', d => { d.offers[0].control = 2; }],
    ['budget exceeded', d => { d.offers[0].confirmedAt = d.offers[0].preparedAt; d.offers.push({ ...structuredClone(d.offers[0]), wakeId: 'wk_second' }); }],
    ['current limits disagree', d => { d.run.limits.room = 7; }],
    ['delivery missing', (_d, s) => { delete s.delivery; }],
    ['unknown field', d => { d.cursor = 0; }],
  ];
  for (const [name, corrupt] of damage) {
    const bad = structuredClone(good); corrupt(bad.sessions[0].delivery, bad.sessions[0]); const bytes = Buffer.from(JSON.stringify(bad));
    writeFileSync(join(w.data, 'state.json'), bytes); const refused = await launch(w.data);
    await assert.rejects(refused.ready, /did not start/); const [exit] = await refused.done; assert.notEqual(exit, 0, name);
    assert.deepEqual(readFileSync(join(w.data, 'state.json')), bytes, name); assert.equal(existsSync(join(w.data, 'hub.lock')), false, name);
  }
  w.seed(good); await w.restart(); assert.equal((await w.run()).state, 'paused');
});

test('shutdown resolves held waits without charging empties or hanging the listener', async t => {
  const w = await world(t); await w.bind('b'); await w.mutate('human', 'run_start');
  const held = w.wait('b', 60); await w.armed('b'); const before = w.delivery();
  const began = Date.now(); await w.stop('SIGTERM'); assert.ok(Date.now() - began < 5000);
  assert.deepEqual(await held, { status: 'closing' }); assert.deepEqual(w.delivery(), before);
});

test('offer persistence failure returns no pointer, fails held waits and preserves previous evidence', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'peerloom-delivery-save-'));
  const hub = await startHub({ dataDir: dir, port: 0 }); t.after(async () => { await hub.close(); rmSync(dir, { recursive: true, force: true }); });
  const admin = JSON.parse(readFileSync(hub.adminPath, 'utf8'));
  const owner = await request(admin, 'create', { requestId: 'room', name: 'Failure boundary', workspace: dir });
  const invite = await request(owner, 'invite', { requestId: 'invite', name: 'peer' });
  const peer = await request(invite, 'join', { requestId: 'join', token: invite.token });
  const binding = await request(peer, 'bind', { requestId: 'bind', label: 'peer' });
  const secondInvite = await request(owner, 'invite', { requestId: 'invite-second', name: 'second' });
  const second = await request(secondInvite, 'join', { requestId: 'join-second', token: secondInvite.token });
  const secondBinding = await request(second, 'bind', { requestId: 'bind-second', label: 'second' });
  await request(owner, 'run_start', { requestId: 'start' });
  await request(owner, 'send', { requestId: 'work', to: 'peer', text: 'Durable work' });
  const held = request(second, 'wait', { generation: secondBinding.generation, timeoutSeconds: 30 }, 40_000);
  const heldFailure = rejects(held, 'storage_failed');
  await until(async () => (await request(owner, 'run')).bindings.find((b: any) => b.participantId === second.participantId).armed === 'waiting', 'second peer held before failed save');
  const before = readFileSync(join(dir, 'state.json')); mkdirSync(join(dir, 'state.json.tmp'));
  await rejects(request(peer, 'wait', { generation: binding.generation, timeoutSeconds: 1 }), 'internal_error');
  await heldFailure;
  assert.deepEqual(readFileSync(join(dir, 'state.json')), before);
  await rejects(request(owner, 'run'), 'storage_failed');
});

test('room change counter advances for durable changes and stays fixed for reads and exact replay', async t => {
  const w = await world(t); const before = await w.run();
  assert.equal(before.changes, 7, 'create, three invitations and three joins');
  await w.call('a', 'room'); await w.call('a', 'heartbeat'); await w.call('a', 'inbox'); assert.equal((await w.run()).changes, before.changes);
  const body = { requestId: 'once-status', text: 'Ready' }; await w.call('a', 'status', body); const after = (await w.run()).changes;
  assert.equal(after, before.changes + 1); await w.call('a', 'status', body); assert.equal((await w.run()).changes, after);
  await w.bind('b'); await w.mutate('human', 'run_start'); const beforeTimeout = (await w.run()).changes;
  await w.wait('b'); assert.equal((await w.run()).changes, beforeTimeout + 1);
  await w.slot(); const beforeOffer = (await w.run()).changes; const wake = await w.wait('b');
  assert.equal((await w.run()).changes, beforeOffer + 1); assert.equal(w.delivery().offers[0].changesAt, beforeOffer + 1);
  await w.wait('b'); await w.fetch('b', wake.wakeId); assert.equal((await w.run()).changes, beforeOffer + 1);
});

test('v1, v2 and v3 stay in their mode until explicit upgrade; only current legacy work is offered', async t => {
  for (const version of [1, 2, 3]) {
    const w = await world(t, version);
    const past = await w.mutate('human', 'send', { to: 'b', text: 'Already acknowledged' });
    await w.mutate('b', 'ack', { messageIds: [past.message.id] });
    const current = await w.mutate('human', 'send', { to: 'b', text: 'Still pending before upgrade' });
    const peer = await w.mutate('a', 'send', { to: 'b', text: 'Legacy peer mail, read before the upgrade' }); await w.mutate('b', 'ack', { messageIds: [peer.message.id] });
    let open: any;
    if (version >= 2) {
      const closed = await w.slot('b', 'a', 'Answered before upgrade');
      await w.mutate('b', 'respond', { collabRequestId: closed.collabRequestId, outcome: 'answered', text: 'Already answered' });
      open = await w.slot('b', 'a', 'Still owed before upgrade');
    }
    await rejects(w.call('b', 'run'), 'upgrade_required'); await rejects(w.mutate('b', 'bind', { label: 'too early' }), 'upgrade_required');
    const caps = await w.call('b', 'capabilities'); assert.equal(caps.stateVersion, version); assert.equal(caps.delivery, false); assert.ok(!caps.operations.includes('wait'));
    await w.restart(); assert.equal(w.snapshot().version, version); assert.equal(w.snapshot().sessions[0].delivery, undefined);
    const bytes = readFileSync(join(w.data, 'state.json')); const before = w.snapshot().sessions[0];
    await w.restart('--upgrade-state'); assert.equal(w.snapshot().version, 6);
    assert.deepEqual(readFileSync(join(w.data, `state.v${version}.backup.json`)), bytes);
    const migrated = w.snapshot().sessions[0];
    for (const field of ['participants', 'invitations', 'messages']) assert.deepEqual(migrated[field], before[field]);
    assert.deepEqual(migrated.events, before.events ?? []); assert.equal((await w.run()).state, 'idle');
    await w.bind('b'); await w.mutate('human', 'run_start'); const wake = await w.wait('b');
    assert.deepEqual(wake.units, [{ kind: 'human_message', id: current.message.id }, ...(open ? [{ kind: 'slot', id: open.collabRequestId }] : [])]);
    await w.confirm('b', wake.wakeId); assert.equal((await w.wait('b')).status, 'timeout');
    const saved = readFileSync(join(w.data, 'state.json')); await w.restart('--upgrade-state');
    assert.deepEqual(readFileSync(join(w.data, 'state.json')), saved); assert.equal(existsSync(join(w.data, 'state.v4.backup.json')), false);
  }
});

test('v3 upgrade refuses an existing backup and preserves the original file and credentials', async t => {
  const w = await world(t, 3); await w.stop(); const before = readFileSync(join(w.data, 'state.json'));
  writeFileSync(join(w.data, 'state.v3.backup.json'), 'Existing evidence');
  const refused = await launch(w.data, '--upgrade-state'); await assert.rejects(refused.ready, /did not start/); await refused.done;
  assert.deepEqual(readFileSync(join(w.data, 'state.json')), before); assert.equal(readFileSync(join(w.data, 'state.v3.backup.json'), 'utf8'), 'Existing evidence');
  await w.restart(); assert.equal((await w.call('b', 'room')).self, w.credentials.b.participantId);
});

test('retention boundaries use the literal 2000/500/1000 caps and retain pause/end through restart', async t => {
  const w = await world(t); await w.bind('b'); await w.mutate('human', 'run_start'); await w.slot(); await w.wait('b'); await w.stop();
  const base = w.snapshot(); const human = w.credentials.human.participantId; const peer = w.credentials.b.participantId;
  const stamp = (n: number) => new Date(Date.parse(base.sessions[0].delivery.offers[0].preparedAt) + n).toISOString();
  // Reachable boundary fixtures: twenty runs with 100 unconfirmed offers
  // rebound each time, then a final binding. Every run was below both wake
  // limits; the same still-open slot remains eligible after each rebound.
  const full = structuredClone(base); const d = full.sessions[0].delivery; const template = d.offers[0];
  const limits = { room: 500, agent: 200, emptyWaits: 30 }; d.controls = []; d.offers = [];
  for (let run = 1; run <= 20; run++) {
    const control = d.controls.length + 1;
    d.controls.push({ seq: control, type: 'start', by: human, at: stamp((run - 1) * 1000), run, control, limits: { ...limits } });
    for (let index = 0; index < 100; index++) {
      const n = d.offers.length + 1; const at = stamp((run - 1) * 1000 + index * 2 + 1);
      d.offers.push({ ...template, wakeId: `wk_boundary_${n}`, bindingGeneration: n, run, control, changesAt: n, preparedAt: at,
        closed: { at: stamp((run - 1) * 1000 + index * 2 + 2), reason: 'rebound' } });
    }
    if (run < 20) { const end = d.controls.length + 1; d.controls.push({ seq: end, type: 'end', by: human, at: stamp((run - 1) * 1000 + 500), run, control: end, limits: { ...limits } }); }
  }
  d.run = { number: 20, state: 'running', control: 39, limits }; d.changes = 6000;
  d.bindings[peer] = { generation: 2001, label: 'boundary', activatedAt: stamp(20_000) }; d.empties = {};
  w.seed(full); w.generations.b = 2001; await w.restart(); const offers = w.delivery().offers;
  const run = await w.run(); assert.deepEqual(run.caps.offers, { used: 2000, cap: 2000 }); assert.equal(run.used.agents[peer], 100);
  assert.deepEqual(await w.wait('b'), { status: 'timeout', held: 'storage' }); assert.deepEqual(w.delivery().offers, offers);
  await w.stop();
  // At the grant cap, both grants and non-stop control actions are refused.
  const grants = structuredClone(base); const g = grants.sessions[0].delivery;
  g.grants = Array.from({ length: 500 }, (_, n) => ({ seq: n + 1, type: 'rearm', participantId: peer, by: human, at: stamp(n), run: 1 }));
  g.changes += 500; w.generations.b = 1; w.seed(grants); await w.restart();
  assert.deepEqual((await w.run()).caps.grants, { used: 500, cap: 500 });
  await rejects(w.mutate('human', 'run_rearm', { participant: 'b' }), 'storage');
  await rejects(w.mutate('human', 'run_reoffer', { participant: 'b' }), 'storage');
  await rejects(w.mutate('human', 'run_limits', { limits: { room: 2 } }), 'storage');
  await w.mutate('human', 'run_pause'); await rejects(w.mutate('human', 'run_resume'), 'storage');
  await w.mutate('human', 'run_end'); await rejects(w.mutate('human', 'run_start'), 'storage');
  await w.restart(); assert.equal((await w.run()).state, 'ended'); assert.equal(w.delivery().grants.length, 500); await w.stop();
  // 1000 controls: start followed by valid limits records, all one run.
  const controls = structuredClone(base); const c = controls.sessions[0].delivery; const oldLimits = c.run.limits;
  c.controls = Array.from({ length: 1000 }, (_, n) => ({ seq: n + 1, type: n === 0 ? 'start' : 'limits', by: human, at: stamp(n), run: 1, control: n + 1, limits: { ...oldLimits } }));
  c.run.control = 1000; c.changes += 1000; w.seed(controls); await w.restart();
  assert.deepEqual((await w.run()).caps.controls, { used: 1000, cap: 1000 });
  await rejects(w.mutate('human', 'run_rearm', { participant: 'b' }), 'storage');
  await rejects(w.mutate('human', 'run_limits', { limits: { room: 2 } }), 'storage');
  await w.mutate('human', 'run_pause'); await rejects(w.mutate('human', 'run_resume'), 'storage'); await w.mutate('human', 'run_end');
  await rejects(w.mutate('human', 'run_start'), 'storage');
  assert.equal(w.delivery().controls.length, 1002); await w.restart(); assert.equal((await w.run()).state, 'ended');
  assert.equal(w.delivery().offers.length, base.sessions[0].delivery.offers.length);
});

test('control entries above the retention cap may record only pause or end', async t => {
  const w = await world(t); await w.mutate('human', 'run_start'); await w.stop(); const bad = w.snapshot(); const d = bad.sessions[0].delivery;
  const original = d.controls[0];
  d.controls = Array.from({ length: 1001 }, (_, n) => ({ ...original, seq: n + 1, type: n === 0 ? 'start' : 'limits', control: n + 1 }));
  d.run.control = 1001; d.changes += 1000;
  const bytes = Buffer.from(JSON.stringify(bad)); writeFileSync(join(w.data, 'state.json'), bytes);
  const refused = await launch(w.data); let started = false;
  try { await refused.ready; started = true; } catch { /* expected refusal */ }
  await refused.stop(); assert.equal(started, false, 'a limits change past the cap cannot be valid retained history');
  assert.deepEqual(readFileSync(join(w.data, 'state.json')), bytes);
});

test('equivalent limits with reordered JSON keys load without a false corruption refusal', async t => {
  const w = await world(t); await w.mutate('human', 'run_start', { limits: { room: 7, agent: 3, emptyWaits: 6 } }); await w.stop();
  const state = w.snapshot(); state.sessions[0].delivery.run.limits = { emptyWaits: 6, agent: 3, room: 7 };
  w.seed(state); await w.restart(); assert.deepEqual((await w.run()).limits, { room: 7, agent: 3, emptyWaits: 6 });
});

test('all four kinds retain sender identity and stale evidence; withdrawal IDs must match exactly', async t => {
  const w = await world(t); for (const who of ['a', 'b', 'c']) await w.bind(who); await w.mutate('human', 'run_start');
  const item = await w.mutate('a', 'item_open', { itemType: 'task', title: 'Four delivery kinds' });
  await w.mutate('a', 'publish', { itemId: item.itemId, text: 'REVISION-TEXT-MUST-NOT-TRAVEL-IN-FETCH' });
  const q = await w.mutate('a', 'request', { itemId: item.itemId, purpose: 'answer', to: ['b', 'c'], text: 'Answer this' });
  const slot = await w.wait('b'); await w.confirm('b', slot.wakeId);
  const cSlot = await w.wait('c'); await w.confirm('c', cSlot.wakeId);
  const respondent = w.wait('c'); await w.armed('c');
  const response = await w.mutate('b', 'respond', { collabRequestId: q.collabRequestId, outcome: 'answered', text: 'An answer' });
  await sleep(2); const withdrawal = await w.mutate('human', 'withdraw', { collabRequestId: q.collabRequestId, respondents: ['c'], reason: 'Human override' });
  assert.deepEqual(await respondent, { status: 'timeout', held: 'none' }, 'withdrawing its slot is passive for the respondent');
  const wake = await w.wait('a'); assert.deepEqual(wake.units, [{ kind: 'response', id: response.responseId }, { kind: 'withdrawal', id: `${q.collabRequestId}:${withdrawal.seq}` }]);
  const fetched = await w.fetch('a', wake.wakeId);
  assert.equal(fetched.units[0].sender.kind, 'agent'); assert.equal(fetched.units[0].sender.id, w.credentials.b.participantId);
  assert.equal(fetched.units[1].sender.kind, 'human'); assert.equal(fetched.units[1].sender.id, w.credentials.human.participantId);
  assert.ok(!JSON.stringify(fetched).includes('REVISION-TEXT-MUST-NOT-TRAVEL-IN-FETCH'));
  await w.confirm('a', wake.wakeId); await w.mutate('a', 'accept', { collabRequestId: q.collabRequestId, responseIds: [response.responseId] });
  const stale = await w.fetch('a', wake.wakeId); assert.ok(stale.units.every((u: any) => !u.current));
  assert.equal(stale.units[0].view.response.text, 'An answer'); assert.equal(stale.units[1].view.withdrawal.reason, 'Human override');
  const staleSlot = (await w.fetch('b', slot.wakeId)).units[0]; assert.equal(staleSlot.current, false); assert.equal(staleSlot.view.collabRequestId, q.collabRequestId); assert.equal(staleSlot.sender.id, w.credentials.a.participantId);
  const mail = await w.mutate('human', 'send', { to: 'b', text: 'Human mail' }); const humanWake = await w.wait('b');
  assert.deepEqual(humanWake.units, [{ kind: 'human_message', id: mail.message.id }]); assert.equal((await w.fetch('b', humanWake.wakeId)).units[0].sender.kind, 'human');
  await w.stop(); const good = w.snapshot(); const bad = structuredClone(good);
  bad.sessions[0].delivery.offers.find((o: any) => o.wakeId === wake.wakeId).units[1].id += ':invented';
  const bytes = Buffer.from(JSON.stringify(bad)); writeFileSync(join(w.data, 'state.json'), bytes);
  const refused = await launch(w.data);
  let started = false; try { await refused.ready; started = true; } catch { /* expected refusal */ }
  await refused.stop(); assert.equal(started, false, 'a nonexistent withdrawal unit cannot masquerade as an existing one');
  assert.deepEqual(readFileSync(join(w.data, 'state.json')), bytes); w.seed(good); await w.restart();
});

test('a 3300-second CLI wait remains armed beyond 300 seconds and receives actual work', { timeout: 360_000, skip: process.env.AGENTLINK_SLOW_TESTS ? false : 'holds a real wait for 310 seconds; run npm run test:all' }, async t => {
  const w = await world(t); await w.bind('b'); await w.mutate('human', 'run_start');
  const client = join(w.dir, 'long-wait-client.json'); writeFileSync(client, JSON.stringify(w.auth('b')), { mode: 0o600 });
  writeFileSync(`${client}.binding.json`, JSON.stringify({ generation: w.generations.b }), { mode: 0o600 });
  const child = spawn(process.execPath, ['core/cli.ts', 'wait', '--client', client, '--timeout', '3300'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  const done = once(child, 'exit'); t.after(() => child.kill('SIGKILL'));
  await w.armed('b'); const began = performance.now();
  // Real elapsed time: the old fetch transport silently abandoned response
  // headers after about 300 s despite its requested 3310-second deadline.
  // A timer can fire just before its requested wall-clock deadline. Measure
  // monotonic elapsed time and wait the remainder so this native boundary
  // check cannot fail on clock adjustments or a fractionally early timer.
  while (performance.now() - began < 310_000) await sleep(Math.max(1, Math.ceil(310_000 - (performance.now() - began))));
  assert.equal(child.exitCode, null, `wait exited before work arrived: ${out}${err}`);
  assert.equal(child.signalCode, null);
  assert.equal(w.delivery().empties[w.credentials.b.participantId] ?? 0, 0);
  assert.equal(w.delivery().offers.length, 0);
  const mail = await w.mutate('human', 'send', { to: 'b', text: 'Work after the five-minute boundary' });
  const [exit] = await done; assert.equal(exit, 0, out + err); assert.ok(performance.now() - began >= 310_000);
  const pointer = JSON.parse(out); assert.equal(pointer.status, 'offer'); assert.deepEqual(pointer.units, [{ kind: 'human_message', id: mail.message.id }]);
  assert.ok(!out.includes('Work after the five-minute boundary'));
  assert.equal((await w.fetch('b', pointer.wakeId)).units[0].view.text, 'Work after the five-minute boundary');
  // The human's message spends no budget (item 19), and was still made one durable offer.
  assert.equal((await w.run()).used.room, 0); assert.equal(w.delivery().offers.length, 1);
});
