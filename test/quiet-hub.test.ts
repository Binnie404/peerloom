import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from '../core/client.ts';
import { startHub, upgradeHubData, inspectHubUpgrade } from '../core/server.ts';
import { STATE_VERSION } from '../core/snapshot.ts';

// Hub contract for quiet coordination (item 24, slice C): reactions, activity, derived receipts, passive posts, noReply.
const rejects = (p: Promise<unknown>, code: string, status?: number) => assert.rejects(p, (e: any) => e.code === code && (status === undefined || e.status === status || e.statusCode === status));

async function world(t: { after(fn: () => unknown): void }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agentlink-quiet-'));
  let hub = await startHub({ dataDir, port: 0 });
  t.after(async () => { await hub.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const admin = { ...JSON.parse(readFileSync(hub.adminPath, 'utf8')), endpoint: hub.endpoint };
  const creds: Record<string, any> = {}; const gens: Record<string, number> = {}; let serial = 0;
  const call = (who: string, op: string, body: any = {}, timeoutMs = 10_000) => request({ ...creds[who], endpoint: hub.endpoint }, op, body, timeoutMs);
  const mutate = (who: string, op: string, body: any = {}) => call(who, op, { requestId: `${op}-${++serial}`, ...body });
  creds.human = await request(admin, 'create', { requestId: 'create', name: 'Quiet', workspace: dataDir });
  for (const who of ['a', 'b', 'c']) {
    const invite = await mutate('human', 'invite', { name: who });
    creds[who] = await request({ endpoint: hub.endpoint }, 'join', { requestId: `join-${who}`, token: invite.token });
  }
  const bind = async (who: string) => { gens[who] = (await mutate(who, 'bind', { label: `${who} client` })).generation; };
  const wait = (who: string, seconds = 1) => call(who, 'wait', { generation: gens[who], timeoutSeconds: seconds }, (seconds + 10) * 1000);
  const fetchWake = (who: string, wakeId: string) => call(who, 'fetch', { generation: gens[who], wakeId });
  const confirm = (who: string, wakeId: string) => mutate(who, 'confirm', { generation: gens[who], wakeId });
  const offers = async () => (await call('human', 'run')).caps.offers.used;
  const state = () => JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'));
  const stateOf = (who: string) => creds[who];
  return { dataDir, hub: () => hub, call, mutate, bind, wait, fetchWake, confirm, offers, state, stateOf, creds,
    restart: async () => { await hub.close(); hub = await startHub({ dataDir, port: 0 }); } };
}
// Refusals run in a fresh hub each, which also keeps each case independent.
async function refused(t: any, code: string, status: number, run: (w: any, messageId: string) => Promise<unknown>) {
  const f = await world(t); const m = (await f.mutate('a', 'send', { to: 'b', text: 'hello' })).message;
  await rejects(run(f, m.id), code, status);
}
const rec = (r: any, id: string) => r.messages.find((m: any) => m.messageId === id);

test('react accepts the five emoji, refuses others, is idempotent, removable and visible only to those who saw the message', async t => {
  const w = await world(t);
  const sent = (await w.mutate('a', 'send', { to: 'b', text: 'hello' })).message;
  for (const emoji of ['👍', '✅', '👀', '❌', '🎉']) assert.equal((await w.mutate('b', 'react', { messageId: sent.id, emoji })).changed, true);
  await refused(t, 'invalid_reaction', 400, (f, id) => f.mutate('b', 'react', { messageId: id, emoji: '😀' }));
  const again = await w.mutate('b', 'react', { messageId: sent.id, emoji: '👍' });
  assert.equal(again.changed, false);
  const on = (await w.call('a', 'receipts')); assert.equal(rec(on, sent.id).reactions.filter((r: any) => r.emoji === '👍').length, 1);
  assert.equal((await w.mutate('b', 'react', { messageId: sent.id, emoji: '👍', on: false })).changed, true);
  assert.equal((await w.mutate('b', 'react', { messageId: sent.id, emoji: '👍', on: false })).changed, false);
  assert.ok(!rec(await w.call('a', 'receipts'), sent.id).reactions.some((r: any) => r.emoji === '👍'));
  await refused(t, 'unknown_message', 404, (f, id) => f.mutate('c', 'react', { messageId: id, emoji: '👍' }));
  assert.equal((await w.mutate('human', 'react', { messageId: sent.id, emoji: '👀' })).changed, true);
  assert.equal(w.state().sessions[0].marks.length, 7);
});

test('activity takes working, blocked and done; blocked needs text; long text is refused; done clears it', async t => {
  const w = await world(t);
  const sent = (await w.mutate('a', 'send', { to: 'b', text: 'hello' })).message;
  await w.mutate('b', 'activity', { state: 'working', messageId: sent.id, text: 'reading' });
  let act = (await w.call('human', 'receipts')).activity;
  assert.deepEqual(act.map((a: any) => [a.participantId, a.state, a.messageId, a.text]), [[w.creds.b.participantId, 'working', sent.id, 'reading']]);
  await w.mutate('b', 'activity', { state: 'blocked', text: 'waiting for a decision' });
  assert.equal((await w.call('human', 'receipts')).activity[0].state, 'blocked');
  await refused(t, 'invalid_activity', 400, f => f.mutate('b', 'activity', { state: 'blocked' }));
  await refused(t, 'invalid_activity', 400, f => f.mutate('b', 'activity', { state: 'working', text: 'x'.repeat(201) }));
  await refused(t, 'invalid_activity', 400, f => f.mutate('b', 'activity', { state: 'sleeping' }));
  await w.mutate('b', 'activity', { state: 'working', text: 'x'.repeat(200) });
  await w.mutate('b', 'activity', { state: 'done' });
  assert.deepEqual((await w.call('human', 'receipts')).activity, []);
});

test('receipts move stored, fetched, acknowledged through the real delivery flow, and only senders see recipients', async t => {
  const w = await world(t);
  await w.bind('b'); await w.mutate('human', 'run_start');
  const sent = (await w.mutate('human', 'send', { to: 'b', text: 'please look' })).message;
  const state = async () => rec(await w.call('human', 'receipts'), sent.id).recipients[0].state;
  assert.equal(await state(), 'stored');
  const wake = await w.wait('b'); assert.equal(wake.status, 'offer');
  assert.equal(await state(), 'stored');
  await w.fetchWake('b', wake.wakeId); await w.confirm('b', wake.wakeId);
  assert.equal(await state(), 'fetched');
  // The recipient sees reactions but no per-recipient states for mail it received.
  const mine = rec(await w.call('b', 'receipts'), sent.id); assert.equal(mine.recipients, undefined); assert.deepEqual(mine.reactions, []);
  await w.mutate('b', 'ack', { messageIds: [sent.id] });
  assert.equal(await state(), 'acknowledged');
  // An agent sees recipients for what it sent.
  const fromA = (await w.mutate('a', 'send', { to: ['b', 'c'], text: 'peer note' })).message;
  const seen = rec(await w.call('a', 'receipts'), fromA.id);
  assert.deepEqual(seen.recipients.map((r: any) => r.state), ['stored', 'stored']);
  assert.equal(rec(await w.call('b', 'receipts'), fromA.id).recipients, undefined);
  assert.equal(rec(await w.call('c', 'receipts'), sent.id), undefined);
});

test('post with noReply, or post: false, is refused', async t => {
  await refused(t, 'invalid_field', 400, f => f.mutate('a', 'send', { to: 'b', text: 'x', post: true, noReply: true }));
  await refused(t, 'invalid_field', 400, f => f.mutate('a', 'send', { to: 'b', text: 'x', post: false }));
});

test('posts are history without wakes; ordinary mail and noReply mail wake; post with noReply is refused', async t => {
  const w = await world(t);
  await w.bind('b'); await w.mutate('human', 'run_start');
  const post = (await w.mutate('a', 'send', { to: 'b', text: 'fyi, a post', post: true })).message;
  assert.equal(post.messageKind, 'post');
  assert.ok((await w.call('b', 'history')).messages.some((m: any) => m.id === post.id && m.messageKind === 'post'));
  const quiet = await w.wait('b', 1); assert.notEqual(quiet.status, 'offer'); assert.equal(quiet.wakeId, undefined);
  const nr = (await w.mutate('human', 'send', { to: 'b', text: 'no answer needed', noReply: true })).message;
  assert.equal(nr.noReply, true);
  const wake = await w.wait('b'); assert.equal(wake.status, 'offer');
  const got = (await w.fetchWake('b', wake.wakeId)).units.find((u: any) => u.id === nr.id);
  assert.ok(got); assert.equal(JSON.stringify(got).includes('"noReply":true'), true);
});

test('twenty reactions and activity changes create no delivery offers', async t => {
  const w = await world(t);
  await w.bind('b'); await w.mutate('human', 'run_start');
  const sent = (await w.mutate('a', 'send', { to: 'b', text: 'hi', post: true })).message;
  const before = await w.offers();
  for (let i = 0; i < 10; i++) {
    await w.mutate('b', 'react', { messageId: sent.id, emoji: '👍', on: i % 2 === 1 });
    await w.mutate('b', 'activity', { state: i % 2 ? 'working' : 'done', text: `step ${i}` });
  }
  assert.equal(await w.offers(), before);
  assert.notEqual((await w.wait('b', 1)).status, 'offer');
  assert.equal(await w.offers(), before);
});

test('fetch carries conversation counters since the last human message', async t => {
  const w = await world(t);
  await w.bind('b'); await w.mutate('human', 'run_start');
  const h = (await w.mutate('human', 'send', { to: 'b', text: 'start' })).message;
  await w.mutate('a', 'send', { to: 'b', text: 'one', post: true });
  await w.mutate('b', 'send', { to: 'a', text: 'two' });
  const wake = await w.wait('b'); const fetched = await w.fetchWake('b', wake.wakeId);
  assert.equal(fetched.conversation.agentMessagesSinceHuman, 2); assert.equal(fetched.conversation.yoursSinceHuman, 1);
  assert.equal(fetched.conversation.lastHumanAt, w.state().sessions[0].messages.find((m: any) => m.id === h.id).createdAt);
});

test('a version 5 store refuses the new operations until upgraded, then they work with marks: []', async t => {
  const w = await world(t);
  const sent = (await w.mutate('a', 'send', { to: 'b', text: 'old mail' })).message;
  await w.hub().close();
  const path = join(w.dataDir, 'state.json'); const s = JSON.parse(readFileSync(path, 'utf8'));
  s.version = 5; for (const x of s.sessions) delete x.marks;
  writeFileSync(path, JSON.stringify(s, null, 2));
  await w.restart();
  await rejects(w.mutate('b', 'react', { messageId: sent.id, emoji: '👍' }), 'upgrade_required', 409);
  await rejects(w.mutate('b', 'activity', { state: 'working' }), 'upgrade_required', 409);
  await rejects(w.call('b', 'receipts'), 'upgrade_required', 409);
  await rejects(w.mutate('a', 'send', { to: 'b', text: 'p', post: true }), 'upgrade_required', 409);
  await rejects(w.mutate('a', 'send', { to: 'b', text: 'p', noReply: true }), 'upgrade_required', 409);
  assert.ok(!(await w.call('b', 'capabilities')).operations.includes('react'));
  await w.hub().close();
  const preview = inspectHubUpgrade({ dataDir: w.dataDir }); assert.equal(preview.fromVersion, 5);
  const up = upgradeHubData({ dataDir: w.dataDir, expectedDigest: preview.sourceDigest });
  assert.equal(up.toVersion, STATE_VERSION); assert.equal(STATE_VERSION, 6);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).sessions.map((x: any) => x.marks), [[]]);
  await w.restart();
  assert.equal((await w.mutate('b', 'react', { messageId: sent.id, emoji: '👍' })).changed, true);
  assert.equal(rec(await w.call('a', 'receipts'), sent.id).reactions.length, 1);
  assert.equal((await w.mutate('a', 'send', { to: 'b', text: 'p', post: true })).message.messageKind, 'post');
});

// A refused reaction or activity is a domain refusal: the hub rolls it back and keeps serving (found by this file).
test('a refused reaction leaves the hub serving', async t => {
  const w = await world(t); const m = (await w.mutate('a', 'send', { to: 'b', text: 'hello' })).message;
  await rejects(w.mutate('b', 'react', { messageId: m.id, emoji: '😀' }), 'invalid_reaction', 400);
  assert.equal((await w.mutate('b', 'react', { messageId: m.id, emoji: '👍' })).changed, true);
});
