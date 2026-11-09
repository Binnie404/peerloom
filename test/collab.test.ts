import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { apply, read, project, validate, DomainError, OPERATIONS } from '../core/collab.ts';

// A session as the hub holds it, with deterministic IDs and clock so outcomes can be compared exactly.
function room() {
  let n = 0; let tick = 0;
  const person = (name: string, kind = 'agent') => ({ id: `p_${name.toLowerCase()}`, name, kind, role: kind === 'human' ? 'owner' : 'Peer', harness: 'cli', status: '', ack: [] as string[] });
  const session: any = { id: 's_1', participants: [person('human', 'human'), person('Astra'), person('Bolt'), person('Cleo')], messages: [], events: [] };
  const env = { now: () => new Date(Date.UTC(2026, 9, 7, 12, 0, tick++)).toISOString(), id: (prefix: string) => `${prefix}_${++n}` };
  const as = (name: string) => session.participants.find((p: any) => p.name === name);
  const act = (name: string, op: string, body: any = {}): any => OPERATIONS[op].mutating ? apply(session, as(name), op, { requestId: `k${++n}`, ...body }, env) : read(session, as(name), op, body);
  const item = (itemId: string) => act('human', 'item', { itemId }).item;
  const owed = (name: string) => act(name, 'requests', { filter: 'owed_by_me' }).requests.map((r: any) => r.collabRequestId);
  return { session, env, act, item, owed, as };
}
function refused(action: () => unknown, code: string, status?: number) {
  assert.throws(action, (error: any) => { assert.ok(error instanceof DomainError, `expected a DomainError, got ${error}`); assert.equal(error.code, code); if (status) assert.equal(error.status, status); return true; });
}
// Opens an item with one artifact at R1 by Astra and returns what a caller would have learned from receipts.
function drafted(r = room()) {
  const { itemId } = r.act('Astra', 'item_open', { itemType: 'decision', title: 'Plan' });
  const p = r.act('Astra', 'publish', { itemId, text: 'R1 text' });
  const target = { artifactId: p.artifactId, revision: p.revision, digest: p.digest };
  const review = (to: string[], policy?: string, t = target) => r.act('Astra', 'request', { itemId, purpose: 'review', to, text: 'Please review', target: t, ...(policy ? { policy } : {}) }).collabRequestId as string;
  const answer = (who: string, collabRequestId: string, verdict: string, t: any = target) => r.act(who, 'respond', { collabRequestId, outcome: 'answered', verdict, target: t, text: `${who}: ${verdict}` }).responseId as string;
  const head = () => r.item(itemId).artifacts[0].revisions.at(-1);
  return { ...r, itemId, artifactId: p.artifactId as string, target, review, answer, head };
}

test('receipt, an ordinary reply and a status note leave a request owed; only a correlated response settles it', () => {
  const r = drafted(); const q = r.review(['Bolt']);
  assert.deepEqual(r.owed('Bolt'), [q]);
  const mail = r.session.messages.at(-1);
  r.as('Bolt').ack.push(mail.id);                                                    // what the hub's ack does
  r.session.messages.push({ id: 'm_plain', sequence: 2, sender: { id: 'p_bolt' }, recipientIds: ['p_astra'], text: 'Looks fine to me, approved!', createdAt: 'x', replyTo: mail.id, threadId: mail.threadId });
  r.as('Bolt').status = 'Review done';
  assert.deepEqual(r.owed('Bolt'), [q]);
  assert.equal(r.head().status, 'in_review');
  r.answer('Bolt', q, 'approve');
  assert.deepEqual(r.owed('Bolt'), []);
  assert.equal(r.item(r.itemId).requests[0].state, 'settled');
});

test('a response is not agreement: the revision is agreed only after the requester accepts an approving review', () => {
  const r = drafted(); const q = r.review(['Bolt']); const rs = r.answer('Bolt', q, 'approve');
  assert.equal(r.head().status, 'in_review');
  assert.deepEqual(r.act('Astra', 'requests', { filter: 'owed_to_me' }).requests.map((x: any) => x.collabRequestId), [q]);
  r.act('Astra', 'accept', { collabRequestId: q, responseIds: [rs] });
  const view = r.item(r.itemId).requests[0];
  assert.equal(view.state, 'accepted'); assert.equal(view.result, 'passed');
  assert.equal(r.head().status, 'agreed');
  assert.deepEqual(r.head().passedReviews, [{ collabRequestId: q, policy: 'all', respondentIds: ['p_bolt'], responseIds: [rs] }]);
  assert.deepEqual(r.act('Astra', 'requests', { filter: 'owed_to_me' }).requests, []);
});

test('a new revision inherits nothing: R1 keeps its review as history and R2 starts unreviewed', () => {
  const r = drafted(); const q = r.review(['Bolt']); const rs = r.answer('Bolt', q, 'approve');
  r.act('Astra', 'accept', { collabRequestId: q, responseIds: [rs] });
  const p2 = r.act('Astra', 'publish', { itemId: r.itemId, artifactId: r.artifactId, baseRevision: 1, text: 'R2 text' });
  const [r1, r2] = r.item(r.itemId).artifacts[0].revisions;
  assert.equal(r1.superseded, true); assert.equal(r1.status, undefined); assert.equal(r1.passedReviews.length, 1);
  assert.equal(r2.status, 'unreviewed'); assert.deepEqual(r2.passedReviews, []);
  refused(() => r.act('Astra', 'item_close', { itemId: r.itemId, state: 'resolved', reason: 'done', agreed: r.target }), 'not_agreed', 409);
  refused(() => r.act('Astra', 'item_close', { itemId: r.itemId, state: 'resolved', reason: 'done', agreed: { artifactId: r.artifactId, revision: 2, digest: p2.digest } }), 'not_agreed');
  refused(() => r.review(['Bolt']), 'stale_revision', 409);                           // still naming R1
  const t2 = { artifactId: r.artifactId, revision: 2, digest: p2.digest };
  const q2 = r.review(['Bolt'], undefined, t2);
  refused(() => r.answer('Bolt', q2, 'approve', r.target), 'target_mismatch', 409);  // approving R1 against a request about R2
  refused(() => r.answer('Bolt', q2, 'approve', { ...t2, digest: r.target.digest }), 'target_mismatch');
  const rs2 = r.answer('Bolt', q2, 'approve', t2);
  r.act('Astra', 'accept', { collabRequestId: q2, responseIds: [rs2] });
  r.act('Astra', 'item_close', { itemId: r.itemId, state: 'resolved', reason: 'agreed at R2', agreed: t2 });
  assert.deepEqual(r.item(r.itemId).closure.agreed, t2);
});

test('the hub computes digest and size from the content it stores', () => {
  const r = room(); const { itemId } = r.act('Astra', 'item_open', { itemType: 'research', title: 'Unicode' });
  const content = 'naïve — 測試 ✓';
  const p = r.act('Astra', 'publish', { itemId, text: content });
  assert.equal(p.digest, createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex'));
  assert.equal(p.contentSize, Buffer.from(content, 'utf8').length);
  const stored = r.act('Bolt', 'revision', { artifactId: p.artifactId, revision: 1 }).revision;
  assert.equal(stored.contentInline, content); assert.equal(stored.contentDigest, p.digest); assert.equal(stored.superseded, false);
  refused(() => r.act('Astra', 'publish', { itemId, text: content, digest: 'f'.repeat(64) }), 'unknown_field', 400);  // a caller cannot supply one
  refused(() => r.act('Bolt', 'revision', { artifactId: p.artifactId, revision: 2 }), 'unknown_revision', 404);
});

test('authority comes from the actor: respondents respond, the requester accepts, the human may withdraw but not accept', () => {
  const r = drafted(); const q = r.review(['Bolt']);
  refused(() => r.answer('Cleo', q, 'approve'), 'not_respondent', 403);
  refused(() => r.answer('Astra', q, 'approve'), 'not_respondent', 403);
  refused(() => r.review(['Astra']), 'self_request', 400);
  refused(() => r.act('Cleo', 'withdraw', { collabRequestId: q, reason: 'no' }), 'not_requester', 403);
  refused(() => r.act('Bolt', 'publish', { itemId: r.itemId, artifactId: r.artifactId, baseRevision: 1, text: 'hijack' }), 'not_author', 403);
  refused(() => r.act('Bolt', 'item_close', { itemId: r.itemId, state: 'dropped', reason: 'no' }), 'not_owner', 403);
  const rs = r.answer('Bolt', q, 'approve');
  refused(() => r.act('Bolt', 'accept', { collabRequestId: q, responseIds: [rs] }), 'not_requester', 403);
  refused(() => r.act('human', 'accept', { collabRequestId: q, responseIds: [rs] }), 'not_requester', 403);
  // A decision asked of the human can be answered only with the human's credential.
  const d = r.act('Astra', 'request', { itemId: r.itemId, purpose: 'decision', to: ['human'], text: 'Ship it?' }).collabRequestId;
  refused(() => r.act('Bolt', 'respond', { collabRequestId: d, outcome: 'answered', text: 'Yes, the human said so' }), 'not_respondent', 403);
  assert.deepEqual(r.owed('human'), [d]);
  r.act('human', 'withdraw', { collabRequestId: d, reason: 'Not needed' });            // human may withdraw another's request
  assert.equal(r.item(r.itemId).requests[1].state, 'withdrawn');
});

test('policy any: the first answer wins and releases the others; a decline does not', () => {
  const r = drafted(); const q = r.review(['Bolt', 'Cleo'], 'any');
  r.act('Bolt', 'respond', { collabRequestId: q, outcome: 'declined', target: r.target, text: 'No time' });
  assert.deepEqual(r.owed('Cleo'), [q]);
  const rs = r.answer('Cleo', q, 'approve');
  const view = r.item(r.itemId).requests[0];
  assert.deepEqual(view.slots, [{ respondentId: 'p_bolt', state: 'declined' }, { respondentId: 'p_cleo', state: 'responded' }]);
  r.act('Astra', 'accept', { collabRequestId: q, responseIds: [rs] });
  assert.equal(r.item(r.itemId).requests[0].result, 'passed');

  const s = drafted(); const q2 = s.review(['Bolt', 'Cleo'], 'any'); s.answer('Bolt', q2, 'changes_requested');
  assert.deepEqual(s.owed('Cleo'), []);
  assert.throws(() => s.answer('Cleo', q2, 'approve'), (e: any) => e.code === 'slot_closed' && e.detail.slot === 'withdrawn');
  assert.deepEqual(s.item(s.itemId).requests[0].slots.map((x: any) => x.state), ['responded', 'withdrawn']);
});

test('policy all: one objection means not passed, and acceptance of it agrees nothing', () => {
  const r = drafted(); const q = r.review(['Bolt', 'Cleo']);
  const a = r.answer('Bolt', q, 'approve');
  refused(() => r.act('Astra', 'accept', { collabRequestId: q, responseIds: [a] }), 'slots_open', 409);
  const b = r.answer('Cleo', q, 'changes_requested');
  refused(() => r.act('Astra', 'accept', { collabRequestId: q, responseIds: [a] }), 'response_set', 409);
  r.act('Astra', 'accept', { collabRequestId: q, responseIds: [b, a] });
  const view = r.item(r.itemId).requests[0];
  assert.equal(view.state, 'accepted'); assert.equal(view.result, 'not_passed');
  assert.equal(r.head().status, 'changes_requested'); assert.deepEqual(r.head().passedReviews, []);
  refused(() => r.act('Astra', 'accept', { collabRequestId: q, responseIds: [a, b] }), 'already_accepted', 409);
});

test('dissent stays visible: a passed review does not hide another reviewer\'s standing objection', () => {
  const r = drafted();
  const q1 = r.review(['Bolt']); r.act('Astra', 'accept', { collabRequestId: q1, responseIds: [r.answer('Bolt', q1, 'approve')] });
  assert.equal(r.head().status, 'agreed');
  const q2 = r.review(['Cleo']);
  assert.equal(r.head().status, 'in_review');                                         // a newer request is not hidden either
  const objection = r.answer('Cleo', q2, 'changes_requested');
  r.act('Astra', 'accept', { collabRequestId: q2, responseIds: [objection] });
  assert.equal(r.head().status, 'changes_requested'); assert.equal(r.head().passedReviews.length, 1);
  assert.deepEqual(r.head().objections.map((o: any) => [o.respondentId, o.standing]), [['p_cleo', 'current']]);
  // Bolt approving again changes nothing about Cleo's objection.
  const q3 = r.review(['Bolt']); r.act('Astra', 'accept', { collabRequestId: q3, responseIds: [r.answer('Bolt', q3, 'approve')] });
  assert.equal(r.head().status, 'changes_requested');
  refused(() => r.act('Astra', 'item_close', { itemId: r.itemId, state: 'resolved', reason: 'done', agreed: r.target }), 'not_agreed');
  // Only Cleo's own later approval of this revision retires it.
  const q4 = r.review(['Cleo']); r.act('Astra', 'accept', { collabRequestId: q4, responseIds: [r.answer('Cleo', q4, 'approve')] });
  assert.equal(r.head().objections[0].standing, 'superseded'); assert.equal(r.head().status, 'agreed');
  r.act('Astra', 'item_close', { itemId: r.itemId, state: 'resolved', reason: 'done', agreed: r.target });
});

test('a decline answers the duty to respond without supplying a result', () => {
  const r = drafted(); const q = r.review(['Bolt']);
  refused(() => r.act('Bolt', 'respond', { collabRequestId: q, outcome: 'declined', verdict: 'approve', target: r.target, text: 'no' }), 'verdict_forbidden', 400);
  r.act('Bolt', 'respond', { collabRequestId: q, outcome: 'declined', target: r.target, text: 'Not my area' });
  assert.deepEqual(r.owed('Bolt'), []);
  assert.equal(r.item(r.itemId).requests[0].state, 'settled');
  refused(() => r.act('Astra', 'accept', { collabRequestId: q, responseIds: ['rs_x'] }), 'no_result', 409);
  assert.equal(r.head().status, 'unreviewed'); assert.deepEqual(r.head().pendingReviews, []);
  refused(() => r.act('Bolt', 'respond', { collabRequestId: q, outcome: 'answered', verdict: 'approve', target: r.target, text: 'changed my mind' }), 'slot_closed', 409);
});

test('withdrawal releases only open slots, all or nothing, and never erases a response', () => {
  const r = drafted(); const q = r.review(['Bolt', 'Cleo']); const rs = r.answer('Bolt', q, 'approve');
  const before = JSON.stringify(r.session);
  refused(() => r.act('Astra', 'withdraw', { collabRequestId: q, respondents: ['Bolt', 'Cleo'], reason: 'x' }), 'slot_closed', 409);
  refused(() => r.act('Astra', 'withdraw', { collabRequestId: q, respondents: ['human'], reason: 'x' }), 'invalid_field', 400);
  refused(() => r.act('Astra', 'withdraw', { collabRequestId: q, respondents: ['Cleo', 'cleo'], reason: 'x' }), 'invalid_field', 400);
  assert.equal(JSON.stringify(r.session), before);
  assert.deepEqual(r.act('Astra', 'withdraw', { collabRequestId: q, reason: 'Cleo is away' }).respondentIds, ['p_cleo']);
  const view = r.item(r.itemId).requests[0];
  assert.deepEqual(view.slots.map((s: any) => s.state), ['responded', 'withdrawn']); assert.equal(view.responses.length, 1);
  refused(() => r.answer('Cleo', q, 'approve'), 'slot_closed');
  refused(() => r.act('Astra', 'withdraw', { collabRequestId: q, reason: 'again' }), 'slot_closed', 409);
  r.act('Astra', 'accept', { collabRequestId: q, responseIds: [rs] });
  assert.equal(r.item(r.itemId).requests[0].result, 'not_passed');                    // all was asked; all did not approve
  refused(() => r.act('Astra', 'withdraw', { collabRequestId: q, reason: 'late' }), 'request_accepted', 409);
});

test('publishing while a review is owed flags it superseded and leaves it owed; its answer cannot be accepted', () => {
  const r = drafted(); const q = r.review(['Bolt']);
  r.act('Astra', 'publish', { itemId: r.itemId, artifactId: r.artifactId, baseRevision: 1, text: 'R2' });
  assert.deepEqual(r.owed('Bolt'), [q]);
  assert.equal(r.act('Bolt', 'requests', { filter: 'owed_by_me' }).requests[0].targetSuperseded, true);
  const rs = r.answer('Bolt', q, 'approve');                                          // true of R1, and recorded there
  refused(() => r.act('Astra', 'accept', { collabRequestId: q, responseIds: [rs] }), 'target_superseded', 409);
  const [r1, r2] = r.item(r.itemId).artifacts[0].revisions;
  assert.deepEqual(r1.passedReviews, []); assert.equal(r2.status, 'unreviewed');
});

test('closure: resolving needs every slot closed and a named agreed revision; dropping keeps debts visible', () => {
  const r = drafted(); const q = r.review(['Bolt']);
  refused(() => r.act('Astra', 'item_close', { itemId: r.itemId, state: 'resolved', reason: 'done', agreed: r.target }), 'open_requests', 409);
  refused(() => r.act('Astra', 'item_close', { itemId: r.itemId, state: 'dropped', reason: 'no', agreed: r.target }), 'agreed_forbidden', 400);
  r.act('human', 'item_close', { itemId: r.itemId, state: 'dropped', reason: 'Changed direction' });
  assert.equal(r.item(r.itemId).state, 'dropped');
  assert.equal(r.act('Bolt', 'requests', { filter: 'owed_by_me' }).requests[0].itemClosed, 'dropped');
  refused(() => r.act('Astra', 'publish', { itemId: r.itemId, artifactId: r.artifactId, baseRevision: 1, text: 'R2' }), 'item_closed', 409);
  refused(() => r.review(['Cleo']), 'item_closed', 409);
  refused(() => r.act('Astra', 'item_close', { itemId: r.itemId, state: 'dropped', reason: 'again' }), 'item_closed', 409);
  r.answer('Bolt', q, 'approve');                                                     // an outstanding reply can still be given
  assert.deepEqual(r.owed('Bolt'), []);

  const s = drafted();
  refused(() => s.act('Astra', 'item_close', { itemId: s.itemId, state: 'resolved', reason: 'done' }), 'agreed_required', 400);
  const bare = s.act('Cleo', 'item_open', { itemType: 'question', title: 'No artifact', externalRefs: [{ provider: 'beads', ref: 'bd-42' }] }).itemId;
  s.act('Cleo', 'item_close', { itemId: bare, state: 'resolved', reason: 'Answered in chat' });
  assert.deepEqual(s.item(bare).externalRefs, [{ provider: 'beads', ref: 'bd-42' }]);
  assert.deepEqual(s.act('Bolt', 'items').items.map((i: any) => [i.title, i.state, i.openSlots]), [['Plan', 'open', 0], ['No artifact', 'resolved', 0]]);
});

test('request and response carry their Message; other purposes take no target or verdict', () => {
  const r = drafted();
  const asked = r.act('Astra', 'request', { itemId: r.itemId, purpose: 'review', to: ['bolt', 'p_cleo'], text: 'Review please', target: r.target });
  const mail = r.session.messages.find((m: any) => m.id === asked.messageId);
  assert.deepEqual([mail.sender.id, mail.recipientIds, mail.text, mail.messageKind, mail.collab, mail.threadId, mail.sequence], ['p_astra', ['p_bolt', 'p_cleo'], 'Review please', 'request', { collabRequestId: asked.collabRequestId }, mail.id, 1]);
  const given = r.act('Bolt', 'respond', { collabRequestId: asked.collabRequestId, outcome: 'answered', verdict: 'approve', target: r.target, text: 'Fine' });
  const reply = r.session.messages.find((m: any) => m.id === given.messageId);
  assert.deepEqual([reply.recipientIds, reply.replyTo, reply.threadId, reply.messageKind, reply.collab.responseId], [['p_astra'], mail.id, mail.id, 'response', given.responseId]);
  refused(() => r.act('Astra', 'request', { itemId: r.itemId, purpose: 'answer', to: ['Bolt'], text: '?', target: r.target }), 'target_forbidden', 400);
  refused(() => r.act('Astra', 'request', { itemId: r.itemId, purpose: 'review', to: ['Bolt'], text: '?' }), 'target_required', 400);
  const q = r.act('Astra', 'request', { itemId: r.itemId, purpose: 'answer', to: ['Bolt'], text: 'Which port?' }).collabRequestId;
  refused(() => r.act('Bolt', 'respond', { collabRequestId: q, outcome: 'answered', verdict: 'approve', text: '4317' }), 'verdict_forbidden', 400);
  refused(() => r.act('Bolt', 'respond', { collabRequestId: q, outcome: 'answered', target: r.target, text: '4317' }), 'target_forbidden', 400);
  const rs = r.act('Bolt', 'respond', { collabRequestId: q, outcome: 'answered', text: '4317' }).responseId;
  r.act('Astra', 'accept', { collabRequestId: q, responseIds: [rs] });
  const view = r.act('Astra', 'requests', { filter: 'item', itemId: r.itemId }).requests.find((x: any) => x.collabRequestId === q);
  assert.equal(view.state, 'accepted'); assert.equal(view.result, undefined);
});

test('malformed and unsupported input is refused by name and records nothing', () => {
  const r = drafted(); const before = JSON.stringify(r.session);
  const base = { itemId: r.itemId, purpose: 'review', to: ['Bolt'], text: 'x', target: r.target };
  const cases: [string, any, string][] = [
    ['request', { ...base, priority: 'high' }, 'unknown_field'],
    ['request', { ...base, target: { ...r.target, path: 'notes.md' } }, 'unknown_field'],
    ['request', { ...base, purpose: 'approve' }, 'invalid_field'],
    ['request', { ...base, policy: 'most' }, 'invalid_field'],
    ['request', { ...base, to: [] }, 'invalid_field'],
    ['request', { ...base, to: 'Bolt' }, 'invalid_field'],
    ['request', { ...base, to: Array(21).fill('Bolt') }, 'invalid_field'],
    ['request', { ...base, to: ['Bolt', 'p_bolt'] }, 'duplicate_recipient'],
    ['request', { ...base, to: ['Nobody'] }, 'unknown_recipient'],
    ['request', { ...base, target: { ...r.target, digest: 'ABC' } }, 'invalid_field'],
    ['request', { ...base, target: { ...r.target, revision: 0 } }, 'invalid_field'],
    ['request', { ...base, target: { ...r.target, artifactId: 'ar_other' } }, 'unknown_artifact'],
    ['request', { ...base, itemId: 'it_missing' }, 'unknown_item'],
    ['request', { ...base, text: 'x'.repeat(32001) }, 'invalid_field'],
    ['request', { ...base, text: '   ' }, 'invalid_field'],
    ['publish', { itemId: r.itemId, artifactId: r.artifactId, text: 'no base' }, 'invalid_field'],
    ['publish', { itemId: r.itemId, baseRevision: 1, text: 'no artifact' }, 'invalid_field'],
    ['publish', { itemId: r.itemId, artifactId: r.artifactId, baseRevision: 5, text: 'ahead' }, 'stale_revision'],
    ['item_open', { itemType: 'epic', title: 'T' }, 'invalid_field'],
    ['item_open', { itemType: 'task', title: 'T', ownerId: 'p_bolt' }, 'unknown_field'],
    ['item_open', { itemType: 'task', title: 'T', externalRefs: [{ provider: 'beads', ref: 'bd-1', blocks: true }] }, 'unknown_field'],
    ['item_open', { itemType: 'task', title: 'T', externalRefs: Array(11).fill({ provider: 'p', ref: 'r' }) }, 'invalid_field'],
    ['respond', { collabRequestId: 'rq_missing', outcome: 'answered', text: 'x' }, 'unknown_request'],
    ['respond', { collabRequestId: r.itemId, outcome: 'answered', text: 'x' }, 'invalid_field'],
    ['accept', { collabRequestId: 'rq_1', responseIds: ['rs_1', 'rs_1'] }, 'invalid_field'],
    ['item_close', { itemId: r.itemId, state: 'done', reason: 'x' }, 'invalid_field'],
  ];
  for (const [op, body, code] of cases) refused(() => r.act('Astra', op, body), code);
  refused(() => read(r.session, r.as('Astra'), 'requests', { filter: 'item' }), 'invalid_field', 400);
  refused(() => read(r.session, r.as('Astra'), 'requests', { filter: 'owed_by_me', itemId: r.itemId }), 'invalid_field', 400);
  refused(() => read(r.session, r.as('Astra'), 'items', { limit: 5 }), 'unknown_field', 400);
  refused(() => read(r.session, r.as('Astra'), 'publish', {}), 'not_found', 404);
  refused(() => apply(r.session, r.as('Astra'), 'items', { requestId: 'k' }, r.env), 'not_found', 404);
  refused(() => apply(r.session, r.as('Astra'), 'item_open', { itemType: 'task', title: 'T' }, r.env), 'invalid_field', 400);   // no requestId
  assert.equal(JSON.stringify(r.session), before);
});

test('conflicting mutations have exactly one winner in either order', () => {
  const orders = (first: (r: any) => void, second: (r: any) => void, check: (r: any, winner: 'first' | 'second') => void) => {
    for (const winner of ['first', 'second'] as const) {
      const r = drafted(); r.q = r.review(['Bolt']);
      const [win, lose] = winner === 'first' ? [first, second] : [second, first];
      win(r); const before = r.session.events.length;
      assert.throws(() => lose(r), DomainError);
      assert.equal(r.session.events.length, before, 'the loser left no event');
      check(r, winner);
    }
  };
  orders(r => r.answer('Bolt', r.q, 'approve'), r => r.act('Astra', 'withdraw', { collabRequestId: r.q, reason: 'x' }),
    (r, w) => assert.equal(r.item(r.itemId).requests[0].slots[0].state, w === 'first' ? 'responded' : 'withdrawn'));
  orders(r => r.act('Astra', 'publish', { itemId: r.itemId, artifactId: r.artifactId, baseRevision: 1, text: 'left' }), r => r.act('Astra', 'publish', { itemId: r.itemId, artifactId: r.artifactId, baseRevision: 1, text: 'right' }),
    (r, w) => { const a = r.item(r.itemId).artifacts[0]; assert.equal(a.latestRevision, 2); assert.equal(r.act('Bolt', 'revision', { artifactId: r.artifactId, revision: 2 }).revision.contentInline, w === 'first' ? 'left' : 'right'); });
  // Accept racing a new revision: R2 is never agreed whichever lands first.
  for (const acceptFirst of [true, false]) {
    const r = drafted(); const q = r.review(['Bolt']); const rs = r.answer('Bolt', q, 'approve');
    const accept = () => r.act('Astra', 'accept', { collabRequestId: q, responseIds: [rs] });
    const publish = () => r.act('Astra', 'publish', { itemId: r.itemId, artifactId: r.artifactId, baseRevision: 1, text: 'R2' });
    if (acceptFirst) { accept(); publish(); } else { publish(); refused(accept, 'target_superseded'); }
    const [r1, r2] = r.item(r.itemId).artifacts[0].revisions;
    assert.equal(r2.status, 'unreviewed'); assert.equal(r1.passedReviews.length, acceptFirst ? 1 : 0);
  }
});

test('one room cannot read or change another room\'s records', () => {
  const a = drafted(); const q = a.review(['Bolt']); const b = room();
  refused(() => b.act('Bolt', 'item', { itemId: a.itemId }), 'unknown_item', 404);
  refused(() => b.act('Bolt', 'revision', { artifactId: a.artifactId, revision: 1 }), 'unknown_revision', 404);
  refused(() => b.act('Bolt', 'respond', { collabRequestId: q, outcome: 'answered', verdict: 'approve', target: a.target, text: 'x' }), 'unknown_request', 404);
  refused(() => b.act('Astra', 'publish', { itemId: a.itemId, text: 'x' }), 'unknown_item', 404);
  refused(() => b.act('human', 'withdraw', { collabRequestId: q, reason: 'x' }), 'unknown_request', 404);
  assert.deepEqual(b.session.events, []); assert.deepEqual(b.act('Bolt', 'items').items, []);
  // An artifact cannot be reached through a different item of the same room either.
  const other = a.act('Cleo', 'item_open', { itemType: 'task', title: 'Other' }).itemId;
  refused(() => a.act('Astra', 'publish', { itemId: other, artifactId: a.artifactId, baseRevision: 1, text: 'x' }), 'unknown_artifact', 404);
  refused(() => a.act('Cleo', 'request', { itemId: other, purpose: 'review', to: ['Bolt'], text: 'x', target: a.target }), 'unknown_artifact', 404);
});

test('resolving an item is refused while any of its artifacts has a current objection or a pending review', () => {
  const r = drafted();
  const q1 = r.review(['Bolt']); r.act('Astra', 'accept', { collabRequestId: q1, responseIds: [r.answer('Bolt', q1, 'approve')] });
  const resolve = () => r.act('Astra', 'item_close', { itemId: r.itemId, state: 'resolved', reason: 'done', agreed: r.target });
  const second = r.act('Astra', 'publish', { itemId: r.itemId, text: 'Appendix' });
  const t2 = { artifactId: second.artifactId, revision: 1, digest: second.digest };
  // A second artifact under review blocks: first because a response is owed, then because an answer awaits acceptance.
  const q2 = r.review(['Cleo'], undefined, t2);
  refused(resolve, 'open_requests', 409);
  const approval = r.answer('Cleo', q2, 'approve', t2);
  assert.throws(resolve, (e: any) => e.code === 'not_agreed' && e.detail.unsettled.length === 1 && e.detail.unsettled[0].artifactId === second.artifactId && e.detail.unsettled[0].status === 'in_review');
  r.act('Astra', 'accept', { collabRequestId: q2, responseIds: [approval] });
  // Bolt objects to the same artifact. Accepting that response does not retire the objection, so the item stays open.
  const q3 = r.review(['Bolt'], undefined, t2);
  r.act('Astra', 'accept', { collabRequestId: q3, responseIds: [r.answer('Bolt', q3, 'changes_requested', t2)] });
  assert.throws(resolve, (e: any) => e.code === 'not_agreed' && e.detail.unsettled[0].status === 'changes_requested');
  assert.equal(r.item(r.itemId).state, 'open');
  // Replacing the objected artifact leaves an unreviewed one, which is visible but does not block.
  r.act('Astra', 'publish', { itemId: r.itemId, artifactId: second.artifactId, baseRevision: 1, text: 'Appendix, reworked' });
  resolve();
  const view = r.item(r.itemId);
  assert.equal(view.state, 'resolved');
  assert.deepEqual(view.artifacts.map((a: any) => a.revisions.at(-1).status), ['agreed', 'unreviewed']);
  validate(JSON.parse(JSON.stringify(r.session)));
  // Dropping never needed agreement.
  const s = drafted(); const q = s.review(['Bolt']); s.act('Astra', 'accept', { collabRequestId: q, responseIds: [s.answer('Bolt', q, 'changes_requested')] });
  s.act('Astra', 'item_close', { itemId: s.itemId, state: 'dropped', reason: 'Abandoned' });
});

test('owed_to_me lists only what the requester can still act on', () => {
  const r = drafted(); const waiting = () => r.act('Astra', 'requests', { filter: 'owed_to_me' }).requests.map((x: any) => x.collabRequestId);
  const answeredThenSuperseded = r.review(['Bolt']); const stillOpen = r.review(['Cleo']);
  const rs = r.answer('Bolt', answeredThenSuperseded, 'changes_requested');
  assert.deepEqual(waiting(), [answeredThenSuperseded, stillOpen]);
  r.act('Astra', 'publish', { itemId: r.itemId, artifactId: r.artifactId, baseRevision: 1, text: 'R2' });
  // Neither action is possible on the answered one any more, so it is not presented as waiting.
  refused(() => r.act('Astra', 'accept', { collabRequestId: answeredThenSuperseded, responseIds: [rs] }), 'target_superseded');
  refused(() => r.act('Astra', 'withdraw', { collabRequestId: answeredThenSuperseded, reason: 'x' }), 'slot_closed');
  assert.deepEqual(waiting(), [stillOpen]);
  // The open one is still owed by Cleo and still the requester's to withdraw.
  assert.deepEqual(r.owed('Cleo'), [stillOpen]);
  // Nothing was removed from the record: the item and the old revision still show the objection.
  const views = r.act('Astra', 'requests', { filter: 'item', itemId: r.itemId }).requests;
  assert.deepEqual(views.map((x: any) => [x.collabRequestId, x.state, x.targetSuperseded]), [[answeredThenSuperseded, 'settled', true], [stillOpen, 'open', true]]);
  assert.equal(r.item(r.itemId).artifacts[0].revisions[0].objections[0].responseId, rs);
  r.act('Astra', 'withdraw', { collabRequestId: stillOpen, reason: 'Superseded by R2' });
  assert.deepEqual(waiting(), []);
  // A settled request that is not superseded, or has no target at all, still waits for acceptance.
  const q = r.act('Astra', 'request', { itemId: r.itemId, purpose: 'answer', to: ['Bolt'], text: '?' }).collabRequestId;
  r.act('Bolt', 'respond', { collabRequestId: q, outcome: 'answered', text: 'yes' });
  assert.deepEqual(waiting(), [q]);
});

// A full history used by the persistence tests below.
function history() {
  const r = drafted(); const q = r.review(['Bolt', 'Cleo']);
  const a = r.answer('Bolt', q, 'approve'); r.act('Astra', 'withdraw', { collabRequestId: q, respondents: ['Cleo'], reason: 'away' });
  r.act('Astra', 'accept', { collabRequestId: q, responseIds: [a] });
  const p2 = r.act('Astra', 'publish', { itemId: r.itemId, artifactId: r.artifactId, baseRevision: 1, text: 'R2' });
  const t2 = { artifactId: r.artifactId, revision: 2, digest: p2.digest };
  const q2 = r.review(['Bolt'], 'any', t2); const b = r.answer('Bolt', q2, 'approve', t2);
  r.act('Astra', 'accept', { collabRequestId: q2, responseIds: [b] });
  r.act('Astra', 'item_close', { itemId: r.itemId, state: 'resolved', reason: 'agreed', agreed: t2 });
  return r;
}

test('every derived fact survives serialization, because none of it is stored', () => {
  const r = history(); const before = project(r.session);
  const reloaded = JSON.parse(JSON.stringify(r.session));
  validate(reloaded);
  assert.deepEqual(project(reloaded), before);
  assert.equal(before.items[0].artifacts[0].revisions[1].status, 'agreed');
  for (const e of r.session.events) for (const field of ['state', 'status', 'slots', 'result']) if (e.type !== 'item_closed') assert.equal(e[field], undefined, `${e.type} must not store ${field}`);
});

test('validate refuses persisted state that the rules could not have produced', () => {
  const damage: [string, (s: any) => void, RegExp][] = [
    ['a verdict on a decline', s => { s.events.find((e: any) => e.type === 'response_given').outcome = 'declined'; }, /verdict_forbidden/],
    ['an acceptance by someone else', s => { s.events.find((e: any) => e.type === 'request_accepted').by = 'p_bolt'; }, /not_requester/],
    ['an acceptance naming a different response', s => { s.events.find((e: any) => e.type === 'request_accepted').responseIds = ['rs_999']; }, /response_set/],
    ['content that no longer matches its digest', s => { s.events.find((e: any) => e.type === 'revision_published').contentInline = 'edited'; }, /digest_mismatch/],
    ['a response from a non-respondent', s => { s.events.find((e: any) => e.type === 'response_given').by = 'p_human'; }, /not_respondent|message_mismatch/],
    ['a missing event', s => { s.events.splice(2, 1); }, /seq_gap/],
    ['reordered events', s => { [s.events[1], s.events[2]] = [s.events[2], s.events[1]]; }, /seq_gap/],
    ['a derived field stored on an event', s => { s.events[2].state = 'accepted'; }, /unknown_field/],
    ['an unknown event type', s => { s.events[0].type = 'item_reopened'; }, /invalid_event/],
    ['an actor outside the room', s => { s.events[0].by = 'p_stranger'; }, /unknown_participant/],
    ['a request whose Message is gone', s => { s.messages.splice(0, 1); }, /message_mismatch/],
    ['a request Message sent to someone else', s => { s.messages[0].recipientIds = ['p_human']; }, /message_mismatch/],
    ['a response Message with different words', s => { s.messages[1].text = 'approve, honest'; }, /message_mismatch/],
    ['a collaboration Message with no event', s => { s.messages.push({ ...s.messages[0], id: 'm_forged' }); }, /no event accounts for/],
    ['a resolution of a revision that was never agreed', s => { s.events.at(-1).agreed.revision = 1; }, /not_agreed/],
    ['a second closure', s => { s.events.push({ ...s.events.at(-1), seq: s.events.length + 1 }); }, /item_closed/],
    ['events that are not an array', s => { s.events = {}; }, /no events array/],
  ];
  for (const [name, corrupt, expected] of damage) {
    const s = JSON.parse(JSON.stringify(history().session)); corrupt(s); const snapshot = JSON.stringify(s);
    assert.throws(() => validate(s), expected, name);
    assert.equal(JSON.stringify(s), snapshot, `${name}: validate must not repair or alter state`);
  }
});

test('a store that predates collaboration is refused, not silently given records', () => {
  const r = room(); delete r.session.events;
  refused(() => r.act('Astra', 'item_open', { itemType: 'task', title: 'T' }), 'upgrade_required', 409);
  refused(() => r.act('Astra', 'items'), 'upgrade_required', 409);
  assert.equal(r.session.events, undefined);
});
