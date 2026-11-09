import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { joinService, RECOVERY_MS, TICKET_MS, OPEN_TICKETS, type Effects } from '../core/join.ts';

// The join service alone (item 24): tickets, claims, the pairing code and the approval journal, on a frozen clock.
// The hub, the profile writer and the console's record are stand-ins that count what they were asked.
const secret = (n: number) => `claim-secret-${String(n).padStart(24, '0')}`;
function setup(t: { after(fn: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'agentlink-join-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clock = { at: Date.parse('2026-10-29T10:00:00Z') }; const path = join(dir, 'joins.json');
  const open = () => joinService(path, { now: () => clock.at });
  const hub = { invites: new Map<string, any>(), joins: new Map<string, any>(), calls: [] as string[], failAt: '' as string };
  const effects: Effects = {
    chooseName: w => w.name ?? 'Ext', agentId: (harness, seed) => `${harness.slice(0, 4)}-${seed.slice(0, 4)}`,
    invite: async o => { hub.calls.push(`invite ${o.key}`); if (hub.failAt === 'invite') throw new Error('hub down'); if (!hub.invites.has(o.key)) hub.invites.set(o.key, { token: `tok-${hub.invites.size}`, ttl: o.ttlSeconds }); return hub.invites.get(o.key); },
    join: async o => { hub.calls.push(`join ${o.key}`); if (hub.failAt === 'join') throw new Error('hub down'); if (!hub.joins.has(o.key)) hub.joins.set(o.key, { participantId: `p_${hub.joins.size}`, token: 'secret' }); return hub.joins.get(o.key); },
    writeProfile: o => { hub.calls.push(`profile ${o.id}`); if (hub.failAt === 'profile') throw new Error('disk full'); },
    record: o => { hub.calls.push(`record ${o.name} ${o.participantId}`); },
  };
  return { dir, path, clock, open, hub, effects };
}
const ok = () => null;

test('a ticket allows one claim; the same secret gets the same pairing code, another gets a conflict, and only hashes are kept', async t => {
  const s = setup(t); const join = s.open();
  const { ticket } = join.issue();
  assert.match(ticket, /^alj_[A-Za-z0-9_-]{32}$/);
  const first = join.claim(ticket, { secret: secret(1), harness: 'dsh', label: 'DeepSeek Harness' }, ok);
  assert.match(first.pairingCode, /^[B-DF-HJ-NP-TV-XZ2-9]{4}-[B-DF-HJ-NP-TV-XZ2-9]{4}$/); assert.equal(first.state, 'awaiting_approval');
  assert.deepEqual(join.claim(ticket, { secret: secret(1), harness: 'dsh', label: 'x' }, ok), first);
  assert.throws(() => join.claim(ticket, { secret: secret(2), harness: 'dsh', label: 'x' }, ok), (e: any) => e.code === 'claimed' && e.status === 409);
  assert.throws(() => join.poll(ticket, secret(2)), (e: any) => e.code === 'invalid');
  assert.equal(join.poll(ticket, secret(1)).pairingCode, first.pairingCode);
  const stored = readFileSync(s.path, 'utf8');
  assert.ok(!stored.includes(ticket) && !stored.includes(secret(1)), 'neither the ticket nor the claim secret is stored');
  assert.equal(statSync(s.path).mode & 0o777, 0o600);
  assert.deepEqual(join.pending().map(p => [p.label, p.harness, p.pairingCode]), [['DeepSeek Harness', 'dsh', first.pairingCode]]);
});

test('unknown, malformed, expired and revoked tickets all get the same answer', async t => {
  const s = setup(t); const join = s.open();
  const expired = join.issue().ticket; const revoked = join.issue(); const live = join.issue().ticket;
  join.revoke(revoked.ticketId);
  s.clock.at += TICKET_MS - 1; assert.equal(join.claim(live, { secret: secret(1), harness: 'dsh', label: 'x' }, ok).state, 'awaiting_approval');
  s.clock.at += 1;
  const messages = new Set<string>();
  for (const ticket of [expired, revoked.ticket, `alj_${'A'.repeat(32)}`, 'alj_short', 42, undefined])
    assert.throws(() => join.claim(ticket, { secret: secret(3), harness: 'dsh', label: 'x' }, ok), (e: any) => { messages.add(`${e.code} ${e.status} ${e.message}`); return true; });
  assert.equal(messages.size, 1); assert.match([...messages][0], /^invalid 404 /);
  // A claim not approved in time expires with its ticket; only its own claimant is told so.
  assert.equal(join.poll(live, secret(1)).state, 'expired');
  assert.throws(() => join.poll(live, secret(2)), (e: any) => e.code === 'invalid');
  assert.deepEqual(join.pending(), []);
});

test('a harness the registry refuses, or one other than the ticket names, is refused before the claim is made', async t => {
  const s = setup(t); const join = s.open();
  const any = join.issue().ticket; const forDsh = join.issue({ harness: 'dsh' }).ticket;
  assert.throws(() => join.claim(any, { secret: secret(1), harness: 'gemini', label: 'x' }, () => 'Gemini CLI cannot be invited yet'), /Gemini CLI cannot be invited yet/);
  assert.throws(() => join.claim(forDsh, { secret: secret(1), harness: 'kimi', label: 'x' }, ok), /This line is for dsh/);
  assert.throws(() => join.claim(any, { secret: 'short', harness: 'dsh', label: 'x' }, ok), (e: any) => e.code === 'secret');
  assert.equal(join.claim(any, { secret: secret(1), harness: 'dsh', label: 'x' }, ok).state, 'awaiting_approval');
});

test('two approvals at once make one participant and one profile; a later press returns the same', async t => {
  const s = setup(t); const join = s.open();
  const { ticket } = join.issue({ name: 'Deep' }); const { claimId } = join.claim(ticket, { secret: secret(1), harness: 'dsh', label: 'DSH' }, ok);
  const [a, b] = await Promise.all([join.approve(claimId, s.effects), join.approve(claimId, s.effects)]);
  assert.deepEqual(a, b); assert.equal(a.state, 'approved'); assert.equal(a.name, 'Deep');
  assert.equal((await join.approve(claimId, s.effects)).agentId, a.agentId);
  assert.equal(s.hub.calls.filter(c => c.startsWith('record')).length, 1); assert.equal(s.hub.joins.size, 1);
  assert.equal([...s.hub.invites.values()][0].ttl, 2 * 60 * 60);
  assert.equal(join.poll(ticket, secret(1)).agentId, a.agentId);
  assert.deepEqual(join.pending(), []);
});

test('an approval that stops at any step carries on to the same identity after a restart, within the recovery window', async t => {
  for (const step of ['invite', 'join', 'profile']) {
    const s = setup(t); let join = s.open();
    const { ticket } = join.issue(); const { claimId } = join.claim(ticket, { secret: secret(1), harness: 'dsh', label: 'x' }, ok);
    s.hub.failAt = step; await assert.rejects(join.approve(claimId, s.effects));
    s.hub.failAt = ''; join = s.open();
    assert.deepEqual(join.unfinished(), [claimId], step);
    assert.equal(join.pending()[0].state, 'approving');
    const done = await join.approve(claimId, s.effects); assert.equal(done.state, 'approved', step);
    assert.equal(s.hub.joins.size, 1, `${step}: one participant`); assert.equal(s.hub.invites.size, 1, `${step}: one invite`);
    assert.ok(s.hub.calls.filter(c => c.startsWith('invite')).every(c => c === s.hub.calls[0]), `${step}: the same invite key every time`);
  }
});

test('past the recovery window an unfinished approval waits for the human and makes no new identity', async t => {
  const s = setup(t); let join = s.open();
  const { ticket } = join.issue(); const { claimId } = join.claim(ticket, { secret: secret(1), harness: 'dsh', label: 'x' }, ok);
  s.hub.failAt = 'join'; await assert.rejects(join.approve(claimId, s.effects));
  s.hub.failAt = ''; s.clock.at += RECOVERY_MS + 1; join = s.open();
  await assert.rejects(join.approve(claimId, s.effects), (e: any) => e.code === 'reconcile');
  assert.equal(s.hub.joins.size, 0); assert.equal(join.pending()[0].state, 'reconcile');
  assert.throws(() => join.approve(claimId, s.effects), (e: any) => e.code === 'reconcile');
});

test('a stuck approval is for the human to settle: Retry carries on with the same keys and identity, Refuse ends it and keeps the record (Codex, seq 55)', async t => {
  const stuck = async () => {
    const s = setup(t); let join = s.open();
    const { ticket } = join.issue(); const { claimId } = join.claim(ticket, { secret: secret(1), harness: 'dsh', label: 'x' }, ok);
    s.hub.failAt = 'profile'; await assert.rejects(join.approve(claimId, s.effects));
    s.hub.failAt = ''; s.clock.at += RECOVERY_MS + 1; join = s.open();
    await assert.rejects(join.approve(claimId, s.effects), (e: any) => e.code === 'reconcile' && /Retry carries on with the same identity/.test(e.message));
    assert.deepEqual([join.pending()[0].state, join.pending()[0].retry], ['reconcile', true]); assert.match(join.pending()[0].note!, /Refuse ends it and keeps the record/);
    return { s, join, ticket, claimId };
  };
  // Retry: the same invite and join keys, the participant the journal recorded, no second one.
  const a = await stuck(); const agentBefore = a.join.entries()[Object.keys(a.join.entries())[0]].approval!.agentId;
  const retried = await a.join.approve(a.claimId, a.s.effects, { retry: true });
  assert.equal(retried.state, 'approved'); assert.equal(retried.agentId, agentBefore); assert.equal(a.s.hub.joins.size, 1); assert.equal(a.s.hub.invites.size, 1);
  // Refuse: ends it, says what the hub had already made, and keeps that in the journal.
  const b = await stuck();
  const refused: any = b.join.refuse(b.claimId);
  assert.equal(refused.state, 'refused'); assert.equal(refused.kept.participantId, 'p_0'); assert.match(refused.kept.agentId, /^dsh-/);
  assert.equal(b.join.entries()[Object.keys(b.join.entries())[0]].approval!.participantId, 'p_0');
  assert.deepEqual(b.join.pending(), []); assert.throws(() => b.join.approve(b.claimId, b.s.effects, { retry: true }), (e: any) => e.code === 'state');
});

test('an approval the hub answered with a different participant cannot be retried, only refused', async t => {
  const s = setup(t); const join = s.open();
  const { ticket } = join.issue(); const { claimId } = join.claim(ticket, { secret: secret(1), harness: 'dsh', label: 'x' }, ok);
  s.hub.failAt = 'profile'; await assert.rejects(join.approve(claimId, s.effects));
  s.hub.failAt = ''; s.hub.joins.clear(); s.hub.joins.set([...s.hub.invites.keys()][0].replace('invite', 'join'), { participantId: 'p_other', token: 't' });
  await assert.rejects(join.approve(claimId, s.effects), (e: any) => e.code === 'reconcile' && /different participant/.test(e.message));
  assert.equal(join.pending()[0].retry, false);
  assert.throws(() => join.approve(claimId, s.effects, { retry: true }), (e: any) => e.code === 'reconcile');
  assert.equal(join.refuse(claimId).state, 'refused');
});

test('a refused claim makes nobody and uses up the ticket; refusing twice is the same answer', async t => {
  const s = setup(t); const join = s.open();
  const { ticket } = join.issue(); const { claimId } = join.claim(ticket, { secret: secret(1), harness: 'dsh', label: 'x' }, ok);
  assert.equal(join.refuse(claimId).state, 'refused'); assert.equal(join.refuse(claimId).state, 'refused');
  assert.throws(() => join.approve(claimId, s.effects), (e: any) => e.code === 'state');
  assert.equal(join.poll(ticket, secret(1)).state, 'refused');
  assert.deepEqual(s.hub.calls, []); assert.deepEqual(join.pending(), []);
});

test('there is a limit on join lines waiting at once', async t => {
  const s = setup(t); const join = s.open();
  for (let n = 0; n < OPEN_TICKETS; n += 1) join.issue();
  assert.throws(() => join.issue(), (e: any) => e.code === 'full' && e.status === 429);
  s.clock.at += TICKET_MS; assert.ok(join.issue().ticket);
});
