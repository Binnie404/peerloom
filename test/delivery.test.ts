import test from 'node:test';
import assert from 'node:assert/strict';
import * as collab from '../core/collab.ts';
import { apply, read, evaluate, expire, checkWait, upgrade, validate, CAPS, OPERATIONS } from '../core/delivery.ts';
import { DomainError } from '../core/collab.ts';

// A session as the hub holds it, with deterministic IDs and a clock that only moves forward.
function room() {
  let n = 0; let tick = 0;
  const person = (name: string, kind = 'agent') => ({ id: `p_${name.toLowerCase()}`, name, kind, role: kind === 'human' ? 'owner' : 'Peer', harness: 'cli', tokenHash: 'x', status: '', ack: [] as string[] });
  const session: any = { id: 's_1', participants: [person('human', 'human'), person('Astra'), person('Bolt'), person('Cleo')], invitations: [], messages: [], events: [] };
  upgrade(session);
  const env = { now: () => new Date(Date.UTC(2026, 9, 8, 12, 0, tick++)).toISOString(), id: (prefix: string) => `${prefix}_${++n}` };
  const as = (name: string) => session.participants.find((p: any) => p.name === name);
  const live = { waiting: () => false };
  const act = (name: string, op: string, body: any = {}): any => OPERATIONS[op].mutating ? apply(session, as(name), op, { requestId: `k${++n}`, ...body }, env) : read(session, as(name), op, body, live);
  const work = (name: string, op: string, body: any): any => collab.apply(session, as(name), op, { requestId: `k${++n}`, ...body }, env);
  const bind = (name: string) => act(name, 'bind', { label: `${name} session` }).generation as number;
  // What a wait would do right now: an offer, a terminal status, or the reason it would hold.
  const wait = (name: string, generation: number, held = false): any => { const r = evaluate(session, as(name), generation, env, held); return 'reply' in r ? r.reply : r; };
  const say = (text: string, to: string[]) => { const id = env.id('m'); session.messages.push({ id, sequence: session.messages.length + 1, sender: { id: 'p_human', name: 'human', kind: 'human', role: 'owner' }, recipientIds: to.map(t => as(t).id), text, createdAt: env.now(), threadId: id }); return id; };
  const state = () => session.delivery;
  return { session, env, as, act, work, bind, wait, say, state };
}
function refused(action: () => unknown, code: string, status?: number) {
  assert.throws(action, (error: any) => { assert.ok(error instanceof DomainError, `expected a DomainError, got ${error}`); assert.equal(error.code, code); if (status) assert.equal(error.status, status); return true; });
}
// A started room where Astra has asked Bolt for a review.
function asked(r = room()) {
  const { itemId } = r.work('Astra', 'item_open', { itemType: 'decision', title: 'Plan' });
  const p = r.work('Astra', 'publish', { itemId, text: 'R1' });
  const target = { artifactId: p.artifactId, revision: 1, digest: p.digest };
  const ask = (to: string[], text = 'Please review') => r.work('Astra', 'request', { itemId, purpose: 'review', to, text, target }).collabRequestId as string;
  const answer = (who: string, q: string, verdict = 'approve') => r.work(who, 'respond', { collabRequestId: q, outcome: 'answered', verdict, target, text: verdict }).responseId as string;
  r.act('human', 'run_start');
  return { ...r, itemId, target, ask, answer };
}
const names = (units: any[]) => units.map(u => `${u.kind}:${u.id}`);

test('an offer names what is owed by ID only, and is returned again unchanged until it is confirmed', () => {
  const r = asked(); const q = r.ask(['Bolt'], 'SECRET-MARKER please review'); const g = r.bind('Bolt');
  const first = r.wait('Bolt', g);
  assert.equal(first.status, 'offer'); assert.deepEqual(names(first.units), [`slot:${q}`]); assert.equal(first.more, false);
  assert.ok(!JSON.stringify(first).includes('SECRET-MARKER'), 'a pointer carries no peer text');
  // The response was lost, or the client died before fetching, or after fetching: the same offer, charged once.
  for (let i = 0; i < 3; i++) assert.deepEqual(r.wait('Bolt', g), first);
  assert.equal(r.state().offers.length, 1);
  assert.deepEqual(r.act('human', 'run').used, { room: 1, agents: { p_bolt: 1 } });
  const fetched = r.act('Bolt', 'fetch', { generation: g, wakeId: first.wakeId });
  assert.equal(fetched.confirmed, false); assert.equal(fetched.units[0].current, true); assert.equal(fetched.units[0].view.text, 'SECRET-MARKER please review');
  assert.deepEqual(r.wait('Bolt', g), first, 'fetching is not confirming');
  const confirmed = r.act('Bolt', 'confirm', { generation: g, wakeId: first.wakeId });
  assert.deepEqual(r.act('Bolt', 'confirm', { generation: g, wakeId: first.wakeId }), confirmed, 'confirming again returns the first timestamp');
  assert.deepEqual(r.wait('Bolt', g), { hold: 'none' });
  validate(JSON.parse(JSON.stringify(r.session)));
});

test('confirmed intake is not an answer: the slot stays owed and is offered again only when the human says so', () => {
  const r = asked(); const q = r.ask(['Bolt']); const g = r.bind('Bolt');
  const first = r.wait('Bolt', g); r.act('Bolt', 'confirm', { generation: g, wakeId: first.wakeId });
  assert.deepEqual(r.wait('Bolt', g), { hold: 'none' }, 'no repeat loop after a crash that followed intake');
  assert.deepEqual(collab.read(r.session, r.as('Bolt'), 'requests', { filter: 'owed_by_me' }).requests.map((x: any) => x.collabRequestId), [q]);
  const again = r.act('human', 'run_reoffer', { participant: 'Bolt' });
  assert.equal(again.epoch, 2);
  const second = r.wait('Bolt', g);
  assert.equal(second.status, 'offer'); assert.notEqual(second.wakeId, first.wakeId); assert.deepEqual(names(second.units), [`slot:${q}`]);
  assert.ok(r.state().offers[0].confirmedAt, 'the earlier confirmation is still on record');
  assert.equal(r.act('human', 'run').used.room, 2);
  refused(() => r.act('Bolt', 'run_reoffer', { participant: 'Bolt' }), 'owner_required', 403);
  refused(() => r.act('human', 'run_reoffer', { participant: 'human' }), 'unknown_participant', 404);
});

test('each transition is its own unit: an offered slot does not hide the later answer from the requester', () => {
  const r = asked(); const q = r.ask(['Bolt', 'Cleo']); const a = r.bind('Astra'); const b = r.bind('Bolt');
  assert.deepEqual(r.wait('Astra', a), { hold: 'none' }, 'the requester is not told about its own request');
  const slot = r.wait('Bolt', b); r.act('Bolt', 'confirm', { generation: b, wakeId: slot.wakeId });
  // A status change is passive. So is a message of one's own, even addressed to oneself.
  r.as('Bolt').status = 'Reviewing'; r.session.messages.push({ id: 'm_peer', sequence: 99, sender: { id: 'p_bolt', name: 'Bolt', kind: 'agent', role: 'Peer' }, recipientIds: ['p_astra'], text: 'on it', createdAt: r.env.now(), threadId: 'm_peer' });
  r.session.messages.push({ id: 'm_own', sequence: 100, sender: { id: 'p_astra', name: 'Astra', kind: 'agent', role: 'Peer' }, recipientIds: ['p_astra'], text: 'note to self', createdAt: r.env.now(), threadId: 'm_own' });
  // An unacknowledged peer message is a unit of its own kind, offered once; one's own message is never a unit.
  const peer = r.wait('Astra', a); assert.deepEqual(names(peer.units), ['agent_message:m_peer']); r.act('Astra', 'confirm', { generation: a, wakeId: peer.wakeId });
  assert.deepEqual(r.wait('Astra', a), { hold: 'none' });
  const rs = r.answer('Bolt', q);
  const told = r.wait('Astra', a);
  assert.deepEqual(names(told.units), [`response:${rs}`]);
  r.act('Astra', 'confirm', { generation: a, wakeId: told.wakeId });
  // The human releases Cleo; the requester is told. A withdrawal by the requester itself tells nobody.
  r.work('human', 'withdraw', { collabRequestId: q, respondents: ['Cleo'], reason: 'Cleo is away' });
  const withdrawn = r.wait('Astra', a);
  assert.equal(withdrawn.units.length, 1); assert.equal(withdrawn.units[0].kind, 'withdrawal'); assert.ok(withdrawn.units[0].id.startsWith(`${q}:`));
  const unit = r.act('Astra', 'fetch', { generation: a, wakeId: withdrawn.wakeId }).units[0]; const view = unit.view;
  assert.equal(view.withdrawal.reason, 'Cleo is away'); assert.equal(view.withdrawal.by, 'p_human');
  assert.deepEqual(unit.sender, { id: 'p_human', name: 'human', kind: 'human', role: 'owner' }, 'who withdrew, from the session and not from the text');
  r.act('Astra', 'confirm', { generation: a, wakeId: withdrawn.wakeId });
  // Accepting is the requester's own act and wakes no one.
  r.work('Astra', 'accept', { collabRequestId: q, responseIds: [rs] });
  assert.deepEqual(r.wait('Astra', a), { hold: 'none' }); assert.deepEqual(r.wait('Bolt', b), { hold: 'none' });
  // Units that are no longer current are still returned whole, marked, with their authenticated sender.
  const stale = r.act('Astra', 'fetch', { generation: a, wakeId: told.wakeId }).units[0];
  assert.equal(stale.current, false, 'the request was accepted, so the response no longer awaits anything');
  assert.equal(stale.view.response.responseId, rs); assert.equal(stale.view.response.text, 'approve'); assert.equal(stale.view.request.state, 'accepted');
  assert.deepEqual(stale.sender, { id: 'p_bolt', name: 'Bolt', kind: 'agent', role: 'Peer' });
  const oldSlot = r.act('Bolt', 'fetch', { generation: b, wakeId: slot.wakeId }).units[0];
  assert.equal(oldSlot.current, false); assert.equal(oldSlot.view.collabRequestId, q); assert.equal(oldSlot.sender.name, 'Astra');
  const oldWithdrawal = r.act('Astra', 'fetch', { generation: a, wakeId: withdrawn.wakeId }).units[0];
  assert.equal(oldWithdrawal.current, false); assert.equal(oldWithdrawal.view.withdrawal.reason, 'Cleo is away');
  assert.ok(!JSON.stringify([stale, oldSlot]).includes('"contentInline"'), 'no revision text travels in a fetch');
  // A requester withdrawing its own request already knows; it is not told.
  const own = r.ask(['Cleo'], 'never mind'); r.work('Astra', 'withdraw', { collabRequestId: own, reason: 'changed my mind' });
  assert.deepEqual(r.wait('Astra', a), { hold: 'none' });
});

test('a human message is a unit until its recipient acknowledges it; an agent message never is', () => {
  const r = asked(); const g = r.bind('Bolt'); const id = r.say('Bolt, stop and check the logs', ['Bolt', 'Cleo']);
  const offer = r.wait('Bolt', g);
  assert.deepEqual(names(offer.units), [`human_message:${id}`]);
  const fetched = r.act('Bolt', 'fetch', { generation: g, wakeId: offer.wakeId }).units[0];
  assert.equal(fetched.view.sender.kind, 'human'); assert.deepEqual(fetched.sender, { id: 'p_human', name: 'human', kind: 'human', role: 'owner' });
  // Cleo read and acknowledged it through the inbox, so there is nothing left to tell her.
  r.as('Cleo').ack.push(id); const c = r.bind('Cleo');
  assert.deepEqual(r.wait('Cleo', c), { hold: 'none' });
});

test('a new binding supersedes the old one, which can then confirm nothing', () => {
  const r = asked(); r.ask(['Bolt']); const g1 = r.bind('Bolt'); const first = r.wait('Bolt', g1);
  const g2 = r.bind('Bolt');
  assert.equal(g2, g1 + 1);
  assert.deepEqual(r.wait('Bolt', g1, true), { status: 'superseded' }, 'a wait that was already held is told it was superseded');
  refused(() => r.wait('Bolt', g1), 'stale_binding', 409);
  refused(() => r.act('Bolt', 'confirm', { generation: g1, wakeId: first.wakeId }), 'stale_binding');
  refused(() => r.act('Bolt', 'fetch', { generation: g1, wakeId: first.wakeId }), 'stale_binding');
  // The new binding cannot adopt the old pointer either; the work comes again under a new wake ID, at a second charge.
  refused(() => r.act('Bolt', 'confirm', { generation: g2, wakeId: first.wakeId }), 'stale_binding');
  assert.deepEqual(r.state().offers[0].closed.reason, 'rebound');
  const second = r.wait('Bolt', g2);
  assert.notEqual(second.wakeId, first.wakeId); assert.equal(r.act('human', 'run').used.room, 2);
  assert.deepEqual(expire(r.session, r.as('Bolt'), g1, 'none'), { reply: { status: 'superseded' }, changed: false }, 'an old wait timing out counts nothing');
  validate(JSON.parse(JSON.stringify(r.session)));
});

test('pause is checked before any offer, old or new; resume returns the same offer without a second charge', () => {
  const r = asked(); r.ask(['Bolt']); const g = r.bind('Bolt'); const first = r.wait('Bolt', g);
  r.act('human', 'run_pause');
  assert.deepEqual(r.wait('Bolt', g), { hold: 'not_running' }, 'an unconfirmed offer is not handed out again while paused');
  assert.equal(r.act('Bolt', 'fetch', { generation: g, wakeId: first.wakeId }).units.length, 1, 'a pointer already held still fetches');
  r.act('human', 'run_resume');
  assert.deepEqual(r.wait('Bolt', g), first);
  for (let i = 0; i < 3; i++) { r.act('human', 'run_pause'); r.act('human', 'run_resume'); }
  assert.deepEqual(r.wait('Bolt', g), first);
  assert.deepEqual(r.act('human', 'run').used, { room: 1, agents: { p_bolt: 1 } }, 'use is counted from offers, so control changes cannot move it');
  r.act('Bolt', 'confirm', { generation: g, wakeId: first.wakeId });
  const reloaded = JSON.parse(JSON.stringify(r.session)); validate(reloaded);
  assert.deepEqual(read(reloaded, r.as('human'), 'run', {}, { waiting: () => false }), r.act('human', 'run'));
  // Paused with new work arriving: held, then offered on resume.
  r.act('human', 'run_pause'); r.ask(['Bolt'], 'second');
  assert.deepEqual(r.wait('Bolt', g), { hold: 'not_running' });
  r.act('human', 'run_resume');
  assert.equal(r.wait('Bolt', g).status, 'offer');
});

test('nothing is offered in a room the human has not started, or has ended', () => {
  const r = room(); const { itemId } = r.work('Astra', 'item_open', { itemType: 'task', title: 'T' });
  r.work('Astra', 'request', { itemId, purpose: 'answer', to: ['Bolt'], text: '?' });
  const g = r.bind('Bolt');
  assert.deepEqual(r.wait('Bolt', g), { hold: 'not_running' });
  assert.equal(r.act('Bolt', 'run').state, 'idle');
  for (const op of ['run_start', 'run_pause', 'run_resume', 'run_end', 'run_limits', 'run_rearm']) refused(() => r.act('Bolt', op, op === 'run_limits' ? { limits: { room: 1 } } : op === 'run_rearm' ? { participant: 'Bolt' } : {}), 'owner_required', 403);
  refused(() => r.act('human', 'run_pause'), 'run_state', 409);
  r.act('human', 'run_start');
  assert.equal(r.wait('Bolt', g).status, 'offer', 'work that was already owed before Start is offered');
  r.act('human', 'run_end');
  assert.deepEqual(r.wait('Bolt', g), { hold: 'not_running' });
  refused(() => r.act('human', 'run_resume'), 'run_state');
});

test('a new run closes what the old run left unconfirmed and offers it afresh at its own cost', () => {
  const r = asked(); r.ask(['Bolt']); const g = r.bind('Bolt'); const old = r.wait('Bolt', g);
  r.act('human', 'run_end'); const started = r.act('human', 'run_start');
  assert.equal(started.number, 2);
  assert.equal(r.state().offers[0].closed.reason, 'new_run');
  refused(() => r.act('Bolt', 'confirm', { generation: g, wakeId: old.wakeId }), 'offer_closed', 409);
  refused(() => r.act('Bolt', 'fetch', { generation: g, wakeId: old.wakeId }), 'offer_closed');
  const fresh = r.wait('Bolt', g);
  assert.notEqual(fresh.wakeId, old.wakeId);
  assert.deepEqual(r.act('human', 'run').used, { room: 1, agents: { p_bolt: 1 } }, 'the new run starts its own count');
  validate(JSON.parse(JSON.stringify(r.session)));
});

test('budgets hold further offers; raising a limit releases them; lowering one is valid history', () => {
  const r = asked(); r.act('human', 'run_limits', { limits: { room: 1 } });
  r.ask(['Bolt', 'Cleo']); const b = r.bind('Bolt'); const c = r.bind('Cleo');
  assert.equal(r.wait('Bolt', b).status, 'offer');
  assert.deepEqual(r.wait('Cleo', c), { hold: 'budget_room' });
  r.act('human', 'run_limits', { limits: { room: 5, agent: 1 } });
  const cleo = r.wait('Cleo', c); assert.equal(cleo.status, 'offer');
  r.act('Cleo', 'confirm', { generation: c, wakeId: cleo.wakeId }); r.ask(['Cleo'], 'another');
  assert.deepEqual(r.wait('Cleo', c), { hold: 'budget_agent' });
  // Lowered below what was already used: nothing more is offered, and the store is still valid.
  r.act('human', 'run_limits', { limits: { room: 1, agent: 1 } });
  assert.deepEqual(r.wait('Cleo', c), { hold: 'budget_room' });
  validate(JSON.parse(JSON.stringify(r.session)));
  refused(() => r.act('human', 'run_limits', { limits: { room: 0 } }), 'invalid_field', 400);
  refused(() => r.act('human', 'run_limits', { limits: { rooms: 3 } }), 'unknown_field', 400);
});

test('a backlog is offered five at a time, oldest first, one charge per offer', () => {
  const r = asked(); const asked12 = Array.from({ length: 12 }, (_, i) => r.ask(['Bolt'], `request ${i + 1}`)); const g = r.bind('Bolt');
  const seen: string[] = []; const more: boolean[] = [];
  for (let i = 0; i < 3; i++) {
    const offer = r.wait('Bolt', g); seen.push(...offer.units.map((u: any) => u.id)); more.push(offer.more);
    assert.ok(offer.units.length <= CAPS.unitsPerOffer);
    r.act('Bolt', 'confirm', { generation: g, wakeId: offer.wakeId });
  }
  assert.deepEqual(seen, asked12); assert.deepEqual(more, [true, true, false]);
  assert.equal(r.act('human', 'run').used.room, 3);
  assert.deepEqual(r.wait('Bolt', g), { hold: 'none' });
});

test('the empty-return allowance is per agent per run: binding again does not reset it, an offer and the human do', () => {
  const r = asked(); r.act('human', 'run_limits', { limits: { emptyWaits: 3 } }); const g = r.bind('Bolt');
  for (let i = 0; i < 3; i++) { assert.deepEqual(r.wait('Bolt', g), { hold: 'none' }); assert.deepEqual(expire(r.session, r.as('Bolt'), g, 'none'), { reply: { status: 'timeout', held: 'none' }, changed: true }); }
  assert.deepEqual(r.wait('Bolt', g), { status: 'disarmed' });
  const g2 = r.bind('Bolt');
  assert.deepEqual(r.wait('Bolt', g2), { status: 'disarmed' }, 'rebinding does not evade the limit');
  r.ask(['Bolt']);
  assert.deepEqual(r.wait('Bolt', g2), { status: 'disarmed' }, 'disarmed is answered before anything is offered');
  assert.equal(r.act('human', 'run').bindings.find((x: any) => x.participantId === 'p_bolt').armed, 'disarmed');
  assert.equal(r.act('human', 'run_rearm', { participant: 'Bolt' }).empties, 0);
  const offer = r.wait('Bolt', g2); assert.equal(offer.status, 'offer');
  // Two more empty returns, then real work: the count returns to zero because only the hub decides work exists.
  r.act('Bolt', 'confirm', { generation: g2, wakeId: offer.wakeId });
  expire(r.session, r.as('Bolt'), g2, 'none'); expire(r.session, r.as('Bolt'), g2, 'none');
  assert.equal(r.state().empties.p_bolt, 2);
  r.ask(['Bolt'], 'more'); r.wait('Bolt', g2);
  assert.equal(r.state().empties.p_bolt, 0);
  validate(JSON.parse(JSON.stringify(r.session)));
});

test('the run view reports armed state from the live connection and the allowance, never from a guess', () => {
  const r = asked(); r.bind('Bolt');
  const view = (waiting: string[]) => read(r.session, r.as('human'), 'run', {}, { waiting: id => waiting.includes(id) }) as any;
  const armed = (v: any) => Object.fromEntries(v.bindings.map((b: any) => [b.participantId, b.armed]));
  assert.deepEqual(armed(view([])), { p_astra: 'unknown', p_bolt: 'not_armed', p_cleo: 'unknown' });
  assert.deepEqual(armed(view(['p_bolt'])), { p_astra: 'unknown', p_bolt: 'waiting', p_cleo: 'unknown' });
  assert.equal(view([]).bindings[1].label, 'Bolt session');
  assert.deepEqual(view([]).caps.offers, { used: 0, cap: CAPS.offers });
});

test('one participant cannot see or settle another\'s offer, and the human does not wait', () => {
  const r = asked(); r.ask(['Bolt']); const b = r.bind('Bolt'); const c = r.bind('Cleo'); const offer = r.wait('Bolt', b);
  refused(() => r.act('Cleo', 'fetch', { generation: c, wakeId: offer.wakeId }), 'unknown_wake', 404);
  refused(() => r.act('Cleo', 'confirm', { generation: c, wakeId: offer.wakeId }), 'unknown_wake', 404);
  refused(() => r.act('human', 'bind', { label: 'me' }), 'agent_required', 403);
  refused(() => evaluate(r.session, r.as('human'), 1, r.env, false), 'agent_required', 403);
  refused(() => r.wait('Astra', 1), 'stale_binding', 409);                             // never bound
  refused(() => checkWait({ generation: 1 }), 'invalid_field', 400);
  refused(() => checkWait({ generation: 1, timeoutSeconds: 3301 }), 'invalid_field');
  refused(() => checkWait({ generation: 1, timeoutSeconds: 30, after: 5 }), 'unknown_field', 400);
  refused(() => r.act('Bolt', 'bind', { label: 'x', nativeSession: 'abc' }), 'unknown_field');
  assert.deepEqual(checkWait({ generation: 2, timeoutSeconds: 55 }), { generation: 2, timeoutSeconds: 55 });
});

test('at a storage cap offers are held and grants refused, nothing is deleted, and pause and end still work', () => {
  const saved = { ...CAPS };
  try {
    const r = asked(); r.ask(['Bolt']); const g = r.bind('Bolt');
    CAPS.offers = 1; CAPS.grants = 1; CAPS.controls = 99;
    const first = r.wait('Bolt', g); r.act('Bolt', 'confirm', { generation: g, wakeId: first.wakeId });
    r.ask(['Bolt'], 'second');
    assert.deepEqual(r.wait('Bolt', g), { hold: 'storage' });
    // The grant cap is reached: further grants are refused, and so is every control action except pause and end.
    r.act('human', 'run_rearm', { participant: 'Bolt' });
    refused(() => r.act('human', 'run_reoffer', { participant: 'Bolt' }), 'storage', 409);
    refused(() => r.act('human', 'run_limits', { limits: { room: 9 } }), 'storage', 409);
    r.act('human', 'run_pause');
    refused(() => r.act('human', 'run_resume'), 'storage', 409);
    // The other way round: with room for grants but the control cap reached, grants are refused too.
    CAPS.grants = 99; CAPS.controls = 2;
    refused(() => r.act('human', 'run_rearm', { participant: 'Bolt' }), 'storage', 409);
    refused(() => r.act('human', 'run_resume'), 'storage');
    assert.equal(r.act('human', 'run_end').state, 'ended', 'a full room can always be stopped');
    refused(() => r.act('human', 'run_start'), 'storage');
    assert.equal(r.state().offers.length, 1); assert.equal(r.state().controls.length, 3); assert.equal(r.state().grants.length, 1);
    // What was written past the cap loads again, because only pause and end can be there. Anything else there is damage.
    validate(JSON.parse(JSON.stringify(r.session)));
    const forged = JSON.parse(JSON.stringify(r.session)); const last = forged.delivery.controls.at(-1);
    forged.delivery.controls.push({ ...last, seq: last.seq + 1, type: 'start', run: last.run + 1, control: last.control + 1 });
    forged.delivery.run = { ...forged.delivery.run, number: last.run + 1, state: 'running', control: last.control + 1 };
    assert.throws(() => validate(forged), /beyond the retention cap/);
  } finally { Object.assign(CAPS, saved); }
});

test('a store that predates pull delivery is refused, not silently given records', () => {
  const r = room(); delete r.session.delivery;
  refused(() => apply(r.session, r.as('Bolt'), 'bind', { requestId: 'k', label: 'x' }, r.env), 'upgrade_required', 409);
  refused(() => read(r.session, r.as('Bolt'), 'run', {}, { waiting: () => false }), 'upgrade_required');
  refused(() => evaluate(r.session, r.as('Bolt'), 1, r.env, false), 'upgrade_required');
  assert.equal(r.session.delivery, undefined);
});

// A history touching every record kind, for the persistence checks.
function history() {
  const r = asked(); const q = r.ask(['Bolt', 'Cleo']); const a = r.bind('Astra'); const b = r.bind('Bolt');
  const slot = r.wait('Bolt', b); r.act('Bolt', 'confirm', { generation: b, wakeId: slot.wakeId });
  r.answer('Bolt', q); const told = r.wait('Astra', a); r.act('Astra', 'confirm', { generation: a, wakeId: told.wakeId });
  r.act('human', 'run_pause'); r.act('human', 'run_limits', { limits: { room: 30 } }); r.act('human', 'run_resume');
  r.act('human', 'run_reoffer', { participant: 'Astra' }); r.act('human', 'run_rearm', { participant: 'Bolt' });
  r.work('human', 'withdraw', { collabRequestId: q, respondents: ['Cleo'], reason: 'away' });
  const gone = r.wait('Astra', a); r.act('Astra', 'confirm', { generation: a, wakeId: gone.wakeId });   // a withdrawal unit, confirmed
  const q2 = r.ask(['Cleo'], 'another'); void q2;
  const c = r.bind('Cleo'); r.wait('Cleo', c);                                          // left pending
  r.say('carry on', ['Bolt']); r.wait('Bolt', b);
  return r;
}

test('validate accepts what the rules produced and survives serialization', () => {
  const r = history(); const copy = JSON.parse(JSON.stringify(r.session));
  validate(copy);
  assert.deepEqual(read(copy, r.as('human'), 'run', {}, { waiting: () => false }), r.act('human', 'run'));
  assert.equal(JSON.stringify(copy), JSON.stringify(r.session));
  // Limits are compared by value: the same numbers in another key order are the same limits.
  const reordered = JSON.parse(JSON.stringify(r.session)); const { room: cap, agent, emptyWaits } = reordered.delivery.run.limits;
  reordered.delivery.run.limits = { emptyWaits, agent, room: cap };
  for (const c of reordered.delivery.controls) c.limits = { agent: c.limits.agent, emptyWaits: c.limits.emptyWaits, room: c.limits.room };
  validate(reordered);
});

test('validate refuses delivery state the rules could not have produced, and never repairs it', () => {
  const damage: [string, (s: any) => void, RegExp][] = [
    ['an offer whose unit belongs to another participant', s => { s.delivery.offers[0].participantId = 'p_astra'; }, /does not exist or belongs to someone else/],
    ['a unit of the wrong kind', s => { s.delivery.offers[0].units[0].kind = 'response'; }, /does not exist or belongs/],
    ['a unit that does not exist', s => { s.delivery.offers[0].units[0].id = 'rq_forged'; }, /does not exist or belongs/],
    ['a real withdrawal ID with something appended', s => { const unit = s.delivery.offers.flatMap((x: any) => x.units).find((u: any) => u.kind === 'withdrawal'); unit.id += ':invented'; }, /does not exist or belongs/],
    ['a real slot ID with something appended', s => { s.delivery.offers[0].units[0].id += ':1'; }, /does not exist or belongs/],
    ['an offer both confirmed and closed', s => { s.delivery.offers[0].closed = { at: s.delivery.offers[0].confirmedAt, reason: 'rebound' }; }, /both confirmed and closed/],
    ['two pending offers for one participant', s => { const o = s.delivery.offers.find((x: any) => !x.confirmedAt && !x.closed); s.delivery.offers.push({ ...o, wakeId: 'wk_dup' }); }, /pending offer must be the only one/],
    ['a duplicate wake ID', s => { s.delivery.offers.push({ ...s.delivery.offers[0] }); }, /offer \d+/],
    ['an epoch without its grant', s => { s.delivery.epochs.p_bolt = 4; }, /intake epoch/],
    ['a reoffer grant without its epoch', s => { delete s.delivery.epochs.p_astra; }, /intake epoch/],
    ['a grant not made by the human', s => { s.delivery.grants[0].by = 'p_bolt'; }, /grant 1/],
    ['a control entry not made by the human', s => { s.delivery.controls[0].by = 'p_astra'; }, /control 1/],
    ['an offer for a run that has not happened', s => { s.delivery.offers[0].run = 7; }, /running control of its run/],
    ['an offer prepared under a paused control generation', s => { s.delivery.offers[0].control = s.delivery.controls.find((c: any) => c.type === 'pause').control; }, /running control/],
    ['an offer beyond the limit in force when it was prepared', s => { s.delivery.controls[0].limits.room = 1; }, /does not match its control history|beyond the limit/],
    ['current limits that do not match the control history', s => { s.delivery.run.limits.room = 499; }, /does not match its control history/],
    ['a run state the history does not reach', s => { s.delivery.run.state = 'paused'; }, /does not match its control history/],
    ['a resume that follows no pause', s => { s.delivery.controls.splice(1, 1); }, /control \d/],
    ['a confirmation earlier than the offer', s => { s.delivery.offers[0].confirmedAt = '2020-01-01T00:00:00.000Z'; }, /confirmation time/],
    ['a pending offer from an old binding', s => { s.delivery.bindings.p_cleo.generation = 5; }, /pending offer must be/],
    ['an offer with six units', s => { const o = s.delivery.offers[0]; o.units = Array(6).fill(o.units[0]); }, /unit/],
    ['a binding for the human', s => { s.delivery.bindings.p_human = { generation: 1, label: 'x', activatedAt: s.delivery.offers[0].preparedAt }; }, /binding of p_human/],
    ['an unknown field on an offer', s => { s.delivery.offers[0].note = 'x'; }, /offer 1/],
    ['a negative counter', s => { s.delivery.changes = -1; }, /malformed/],
    ['delivery missing altogether', s => { delete s.delivery; }, /malformed|Cannot|undefined/],
  ];
  for (const [label, corrupt, expected] of damage) {
    const s = JSON.parse(JSON.stringify(history().session)); corrupt(s); const snapshot = JSON.stringify(s);
    assert.throws(() => validate(s), expected, label);
    assert.equal(JSON.stringify(s), snapshot, `${label}: validate must not alter state`);
  }
});

// ── Item 19: a budget that bounds agent chatter without stalling the work ──────────────────────────────
test('a wait held by a spent budget or a pause is not an empty return; one with nothing to offer still is', () => {
  const r = asked(); r.act('human', 'run_limits', { limits: { room: 1, emptyWaits: 2 } });
  r.ask(['Bolt', 'Cleo']); const b = r.bind('Bolt'); const c = r.bind('Cleo');
  assert.equal(r.wait('Bolt', b).status, 'offer');
  assert.deepEqual(r.wait('Cleo', c), { hold: 'budget_room' });
  // Held for far longer than the allowance: Cleo has work, so none of it is an empty return.
  for (let i = 0; i < 5; i++) assert.deepEqual(expire(r.session, r.as('Cleo'), c, 'budget_room'), { reply: { status: 'timeout', held: 'budget_room' }, changed: false });
  r.act('human', 'run_pause');
  for (let i = 0; i < 5; i++) assert.deepEqual(expire(r.session, r.as('Cleo'), c, 'not_running'), { reply: { status: 'timeout', held: 'not_running' }, changed: false });
  r.act('human', 'run_resume');
  assert.equal(r.state().empties.p_cleo ?? 0, 0);
  r.act('human', 'run_limits', { limits: { room: 5 } });
  assert.equal(r.wait('Cleo', c).status, 'offer', 'raising the limit releases it however long it was held');
  // Nothing to offer is still idle, and still counted.
  const g = r.bind('Astra');
  for (let i = 0; i < 2; i++) assert.deepEqual(expire(r.session, r.as('Astra'), g, 'none'), { reply: { status: 'timeout', held: 'none' }, changed: true });
  assert.deepEqual(r.wait('Astra', g), { status: 'disarmed' });
  validate(JSON.parse(JSON.stringify(r.session)));
});

test('only agent-caused wakes spend the budget, and the human gets through a spent one', () => {
  const r = asked(); r.act('human', 'run_limits', { limits: { room: 1, agent: 1 } });
  r.ask(['Bolt']); const g = r.bind('Bolt');
  const first = r.wait('Bolt', g); assert.equal(first.status, 'offer'); r.act('Bolt', 'confirm', { generation: g, wakeId: first.wakeId });
  assert.deepEqual(r.act('human', 'run').used, { room: 1, agents: { p_bolt: 1 } }, 'a request from another agent is charged');
  const peer = r.ask(['Bolt'], 'another');
  assert.deepEqual(r.wait('Bolt', g), { hold: 'budget_room' });
  // The human writes while the budget is spent: that alone is offered, free; the agent's request stays held.
  const m = r.say('From the human', ['Bolt']);
  const human = r.wait('Bolt', g); assert.equal(human.status, 'offer'); assert.deepEqual(names(human.units), [`human_message:${m}`]);
  r.act('Bolt', 'confirm', { generation: g, wakeId: human.wakeId });
  assert.deepEqual(r.act('human', 'run').used, { room: 1, agents: { p_bolt: 1 } });
  assert.deepEqual(r.wait('Bolt', g), { hold: 'budget_room' });
  // Work the human asks for through a request is the human's too.
  const { itemId } = r.work('human', 'item_open', { itemType: 'task', title: 'From the human' });
  const task = r.work('human', 'request', { itemId, purpose: 'answer', to: ['Bolt'], text: 'Please do it' }).collabRequestId;
  const asked2 = r.wait('Bolt', g); assert.deepEqual(names(asked2.units), [`slot:${task}`]);
  r.act('Bolt', 'confirm', { generation: g, wakeId: asked2.wakeId });
  assert.deepEqual(r.act('human', 'run').used, { room: 1, agents: { p_bolt: 1 } });
  r.act('human', 'run_limits', { limits: { room: 2, agent: 2 } });
  assert.deepEqual(names(r.wait('Bolt', g).units), [`slot:${peer}`], 'raising the limit releases the agent work');
  validate(JSON.parse(JSON.stringify(r.session)));
});

test('the run view counts only charged offers and names who is held by which budget', () => {
  const r = asked(); r.act('human', 'run_limits', { limits: { agent: 1 } });
  const g = r.bind('Bolt'); r.bind('Cleo');
  r.say('hello', ['Bolt']); const free = r.wait('Bolt', g); r.act('Bolt', 'confirm', { generation: g, wakeId: free.wakeId });
  let view = r.act('human', 'run'); assert.deepEqual(view.used, { room: 0, agents: {} }, 'the human message spent nothing');
  r.ask(['Bolt']); const paid = r.wait('Bolt', g); r.act('Bolt', 'confirm', { generation: g, wakeId: paid.wakeId });
  r.ask(['Bolt'], 'more');
  view = r.act('human', 'run'); const held = (id: string) => view.bindings.find((x: any) => x.participantId === id).held;
  assert.deepEqual(view.used, { room: 1, agents: { p_bolt: 1 } });
  assert.equal(held('p_bolt'), 'budget_agent'); assert.equal(held('p_cleo'), null); assert.equal(held('p_astra'), null);
  r.act('human', 'run_limits', { limits: { agent: 2 } });
  view = r.act('human', 'run'); assert.equal(held('p_bolt'), null, 'released by Extend');
});

test('a store whose human-only offers go past the budget reloads; a forged charged one past it is refused', () => {
  const r = asked(); r.act('human', 'run_limits', { limits: { room: 1, agent: 1 } });
  r.ask(['Bolt']); const g = r.bind('Bolt'); const paid = r.wait('Bolt', g); r.act('Bolt', 'confirm', { generation: g, wakeId: paid.wakeId });
  for (let i = 0; i < 3; i++) { r.say(`from the human ${i}`, ['Bolt']); const free = r.wait('Bolt', g); assert.equal(free.status, 'offer'); r.act('Bolt', 'confirm', { generation: g, wakeId: free.wakeId }); }
  assert.equal(r.state().offers.length, 4);
  validate(JSON.parse(JSON.stringify(r.session)));   // what the hub runs on every load
  // The same history with one more offer charged for the peer's request is beyond the limit in force, and refused.
  const forged = JSON.parse(JSON.stringify(r.session)); const extra = { ...forged.delivery.offers[0], wakeId: 'wk_forged' };
  forged.delivery.offers.push(extra);
  assert.throws(() => validate(forged), /beyond the limit in force when it was prepared/);
});

test('at the offer storage cap no budget hold is reported, since raising a limit could not release it (GPT, 008-gpt)', () => {
  const saved = { ...CAPS };
  try {
    const r = asked(); r.act('human', 'run_limits', { limits: { agent: 1 } }); r.ask(['Bolt']); const g = r.bind('Bolt');
    const first = r.wait('Bolt', g); r.act('Bolt', 'confirm', { generation: g, wakeId: first.wakeId }); r.ask(['Bolt'], 'second');
    const held = () => r.act('human', 'run').bindings.find((x: any) => x.participantId === 'p_bolt').held;
    assert.equal(held(), 'budget_agent');
    CAPS.offers = 1;
    assert.deepEqual(r.wait('Bolt', g), { hold: 'storage' }, 'storage is decided before the budget');
    assert.equal(held(), null, 'and so the run view offers no Extend for it');
  } finally { Object.assign(CAPS, saved); }
});
