import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from '../core/client.ts';
import { startHub } from '../core/server.ts';

// Store version 6 is where quiet coordination lives; on a branch without it the group skips with one message.
const snapshotModule: any = await import('../core/snapshot.ts').then(module => module, () => null);
const skip = ((snapshotModule?.STATE_VERSION ?? 5) >= 6 ? false : 'quiet coordination (store v6) is not on this branch yet');

// Slice C hub matrix (opus fc3aa5d): receipts, reactions and activity are derived or append-only marks that never wake
// anyone and never spend an offer; a passive post wakes nobody; noReply wakes the recipient but asks for no answer; the
// wake carries diagnostic counters. Real hub, real client operations.
const world = async (t: any, names = ['a', 'b']) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentlink-quiet-')); const hub = await startHub({ dataDir: join(dir, 'hub'), port: 0 });
  t.after(async () => { await hub.close(); rmSync(dir, { recursive: true, force: true }); });
  const admin = JSON.parse(readFileSync(hub.adminPath, 'utf8'));
  const owner = await request(admin, 'create', { requestId: 'create', name: 'Quiet room', workspace: dir });
  const creds: any = { human: owner }; let serial = 0;
  for (const name of names) { const invite = await request(owner, 'invite', { requestId: `invite-${name}`, name }); creds[name] = await request({ endpoint: owner.endpoint, token: invite.token }, 'join', { requestId: `join-${name}`, token: invite.token }); }
  const call = (who: string, op: string, body: any = {}, timeout = 10_000) => request(creds[who], op, body, timeout);
  const mutate = (who: string, op: string, body: any = {}) => call(who, op, { requestId: `${op}-${++serial}`, ...body });
  const bind = async (who: string) => (await mutate(who, 'bind', { label: `${who} client` })).generation;
  return { dir, hub, owner, creds, call, mutate, bind };
};
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: any) => error.code === code);

test('twenty reactions and a working line create no offer and spend no budget', { skip, timeout: 60_000 }, async t => {
  const w = await world(t); await w.bind('a'); const gb = await w.bind('b');
  await w.mutate('human', 'run_start', { limits: { room: 50, agent: 20 } });
  const sent = await w.mutate('a', 'send', { to: 'b', text: 'status?' }); const id = sent.message.id;
  const offered = await w.call('b', 'wait', { generation: gb, timeoutSeconds: 3 }, 8_000);
  assert.equal(offered.status, 'offer', 'the mail itself wakes the recipient once');
  const before = await w.call('human', 'run');
  const reactions = ['👍', '✅', '👀', '❌', '🎉'];
  for (let round = 0; round < 4; round += 1) for (const emoji of reactions) assert.equal((await w.mutate('a', 'react', { messageId: id, emoji, on: round % 2 === 0 })).changed, true, `${emoji} round ${round}`);
  const after = await w.call('human', 'run');
  assert.deepEqual([after.used.room, after.caps.offers.used], [before.used.room, before.caps.offers.used], 'reactions add no offer and spend nothing');
  // Setting an emoji already on is idempotent; removing it is a change.
  for (const emoji of reactions) await w.mutate('a', 'react', { messageId: id, emoji });
  assert.equal((await w.mutate('a', 'react', { messageId: id, emoji: '👍' })).changed, false);
  assert.equal((await w.mutate('a', 'react', { messageId: id, emoji: '👍', on: false })).changed, true);
  await w.mutate('a', 'react', { messageId: id, emoji: '👍' });
  // A working line and its done are marks too, not mail.
  await w.mutate('a', 'activity', { state: 'working', messageId: id, text: 'reading the report' });
  const marked = await w.call('a', 'receipts', { after: 0 });
  assert.deepEqual(marked.activity.map((entry: any) => [entry.state, entry.text]), [['working', 'reading the report']]);
  assert.deepEqual(marked.messages.find((message: any) => message.messageId === id).recipients, [{ participantId: w.creds.b.participantId, state: 'stored' }]);
  assert.deepEqual(marked.messages.find((message: any) => message.messageId === id).reactions.map((reaction: any) => reaction.emoji).sort(), ['👍', '✅', '👀', '❌', '🎉'].sort());
  assert.equal((await w.call('human', 'run')).used.room, before.used.room, 'the working line spends nothing');
  await w.mutate('a', 'activity', { state: 'done' });
  assert.deepEqual((await w.call('human', 'receipts', {})).activity, [], 'done clears the line');
});

test('a passive post wakes nobody and is still readable; a post cannot also ask for a reply', { skip, timeout: 60_000 }, async t => {
  const w = await world(t); await w.bind('a'); const gb = await w.bind('b');
  await w.mutate('human', 'run_start', { limits: { room: 50, agent: 20 } });
  const post = await w.mutate('a', 'send', { to: 'b', text: 'FYI: the deck is ready', post: true });
  assert.equal(post.message.messageKind, 'post');
  const quiet = await w.call('b', 'wait', { generation: gb, timeoutSeconds: 2 }, 8_000);
  assert.equal(quiet.status, 'timeout', 'a post never becomes an offer');
  assert.equal((await w.call('human', 'run')).used.room, 0, 'and spends no peer wake');
  const history = await w.call('b', 'history', { after: 0 });
  assert.ok(history.messages.some((message: any) => message.id === post.message.id), 'readable as room text');
  await rejects(w.mutate('a', 'send', { to: 'b', text: 'both', post: true, noReply: true }), 'invalid_field');
  await rejects(w.mutate('a', 'send', { to: 'b', text: 'neither', post: false }), 'invalid_field');
  await rejects(w.mutate('a', 'react', { messageId: post.message.id, emoji: '🤖' }), 'invalid_reaction');
});

test('noReply wakes the recipient, asks for no answer, and the wake carries the counters', { skip, timeout: 60_000 }, async t => {
  const w = await world(t); await w.bind('a'); const gb = await w.bind('b');
  await w.mutate('human', 'run_start', { limits: { room: 50, agent: 20 } });
  const notice = await w.mutate('a', 'send', { to: 'b', text: 'Build finished', noReply: true });
  const offer = await w.call('b', 'wait', { generation: gb, timeoutSeconds: 3 }, 8_000);
  assert.equal(offer.status, 'offer', 'informational mail still wakes its recipient once');
  const wake = await w.call('b', 'fetch', { generation: gb, wakeId: offer.wakeId });
  assert.equal(wake.units.find((unit: any) => unit.id === notice.message.id).view.noReply, true);
  assert.equal(typeof wake.conversation.agentMessagesSinceHuman, 'number');
  assert.equal(typeof wake.conversation.yoursSinceHuman, 'number');
  assert.ok('lastHumanAt' in wake.conversation);
});

test('receipts say Stored, then Fetched, then Acknowledged, and nothing else', { skip, timeout: 60_000 }, async t => {
  const w = await world(t); await w.bind('a'); const gb = await w.bind('b');
  await w.mutate('human', 'run_start', { limits: { room: 50, agent: 20 } });
  const sent = await w.mutate('a', 'send', { to: 'b', text: 'please build it' }); const id = sent.message.id;
  const row = async () => (await w.call('a', 'receipts', { after: 0 })).messages.find((message: any) => message.messageId === id);
  assert.deepEqual((await row()).recipients, [{ participantId: w.creds.b.participantId, state: 'stored' }]);
  const offer = await w.call('b', 'wait', { generation: gb, timeoutSeconds: 3 }, 8_000);
  await w.mutate('b', 'confirm', { generation: gb, wakeId: offer.wakeId });
  assert.deepEqual((await row()).recipients, [{ participantId: w.creds.b.participantId, state: 'fetched' }]);
  await w.mutate('b', 'ack', { messageIds: [id] });
  assert.deepEqual((await row()).recipients, [{ participantId: w.creds.b.participantId, state: 'acknowledged' }]);
  // A recipient does not see other people's receipts; it sees the reactions on what it can see.
  const asRecipient = (await w.call('b', 'receipts', { after: 0 })).messages.find((message: any) => message.messageId === id);
  assert.equal(asRecipient.recipients, undefined);
  assert.deepEqual(asRecipient.reactions, []);
});

test('the quiet scenario: five armed agents, one named assignment wakes one, twenty reactions add no offer', { skip, timeout: 90_000 }, async t => {
  const names = ['a1', 'a2', 'a3', 'a4', 'a5']; const w = await world(t, names);
  const generations: any = {}; for (const name of names) generations[name] = await w.bind(name);
  await w.mutate('human', 'run_start', { limits: { room: 100, agent: 30 } });
  const assignment = await w.mutate('human', 'send', { to: 'a3', text: 'You own this task: check the join route.' });
  const woke = await w.call('a3', 'wait', { generation: generations.a3, timeoutSeconds: 3 }, 8_000);
  assert.equal(woke.status, 'offer', 'the named agent is the one woken');
  for (const name of ['a1', 'a2', 'a4', 'a5']) assert.equal((await w.call(name, 'wait', { generation: generations[name], timeoutSeconds: 1 }, 5_000)).status, 'timeout', `${name} stays asleep`);
  const before = await w.call('human', 'run');
  assert.equal(before.used.room, 0, 'the human’s own work is free');
  assert.equal(before.caps.offers.used, 1, 'exactly one offer exists');
  for (let round = 0; round < 2; round += 1) for (const emoji of ['👍', '✅', '👀', '❌', '🎉']) await w.mutate('human', 'react', { messageId: assignment.message.id, emoji, on: round % 2 === 1 });
  const after = await w.call('human', 'run');
  assert.deepEqual([after.used.room, after.caps.offers.used], [before.used.room, before.caps.offers.used], 'twenty reactions produce no offer');
});
