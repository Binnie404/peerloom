import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { console_, joinBackend as joinModule, joinSkip, page, raw, shell, until } from './helpers/join-testkit.ts';

// Codex's second integration finding (item 24), as fixed in opus fa86873: a stuck approval shows {note, retry}. Retry
// carries on with the same keys and identity under a fresh window; Refuse works from reconcile and keeps the record;
// an approval whose recovery returned a different hub participant cannot be retried.
const TICKET = /alj_[A-Za-z0-9_-]{32}/;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

async function stalled(t: any, options: { stuck?: 'participant' } = {}) {
  const clock = { at: Date.parse('2026-10-29T10:00:00Z') };
  const first = console_(t, { now: () => clock.at }); const p = await page(first); t.after(p.close);
  assert.equal((await p.call('POST', '/api/room', { name: 'Reconcile room', workspace: first.dir })).status, 200);
  const made = (await p.call('POST', '/api/join-line', { harness: 'dsh' })).json;
  const url = /peerloom join (\S+) --harness/.exec(made.line)![1]; const ticket = TICKET.exec(url)![0];
  const claim = await raw(p.port, p.host, 'POST', `${new URL(url).pathname}/claim`, { secret: 'claim-secret-' + 'r'.repeat(24), harness: 'dsh', label: 'Stalled session' });
  assert.equal(claim.status, 200, claim.text); const claimId = claim.json.claimId as string;
  p.close(); first.input.write('/quit\n'); await first.done;
  const journalPath = join(first.dir, '.agentlink', 'joins.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')); const entry = journal.entries[sha(ticket)];
  assert.ok(entry, 'the ticket is in the journal by hash');
  entry.state = options.stuck ? 'reconcile' : 'approving';
  entry.approval = { startedAt: clock.at - joinModule.RECOVERY_MS - 60_000, name: 'Stale', agentId: 'stale-abcd',
    ...(options.stuck === 'participant' ? { stuck: 'participant', participantId: 'p_previous' } : {}) };
  writeFileSync(journalPath, JSON.stringify(journal), { mode: 0o600 });
  const second = console_(t, { dir: first.dir, now: () => clock.at }); const q = await page(second); t.after(q.close);
  const row = await until(async () => (await q.state()).joins.find((j: any) => j.claimId === claimId && j.state === 'reconcile'), 'the stalled approval on the page', 20_000);
  return { first, second, q, journalPath, claimId, key: sha(ticket), row };
}
const journalEntry = (path: string, key: string) => JSON.parse(readFileSync(path, 'utf8')).entries[key];

test('a stuck approval can be retried to the same identity, and only Retry creates it', { skip: joinSkip, timeout: 120_000 }, async t => {
  const s = await stalled(t);
  assert.equal(s.row.retry, true, 'the page is told the approval may be retried');
  assert.match(String(s.row.note ?? ''), /retry|refuse/i);
  const retried = await s.q.call('POST', '/api/join-approve', { claimId: s.claimId, retry: true });
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  assert.deepEqual([retried.json.join.state, retried.json.join.name, retried.json.join.agentId], ['approved', 'Stale', 'stale-abcd']);
  await until(async () => (await s.q.state()).joins.length === 0, 'the retried join leaving Needs you');
  // Same identity: the journal keeps it, the profile is under the room workspace, and one participant exists.
  const after = journalEntry(s.journalPath, s.key);
  assert.deepEqual([after.state, after.approval.name, after.approval.agentId, after.approval.stuck], ['approved', 'Stale', 'stale-abcd', undefined]);
  assert.ok(existsSync(join(s.second.dir, '.agentlink', 'agents', 'stale-abcd', 'credential.json')), 'the profile is under the room workspace');
  const state = await s.q.state();
  assert.deepEqual(state.agents.map((a: any) => [a.name, a.agentId]), [['Stale', 'stale-abcd']]);
  assert.equal(state.agents[0].state, 'joined');
  const { request } = await import('../core/client.ts');
  const owner = JSON.parse(readFileSync(join(shell.ownerStore(s.second.dir), 'owner.json'), 'utf8'));
  assert.deepEqual((await request(owner, 'room')).roster.filter((r: any) => r.kind === 'agent').map((r: any) => r.name), ['Stale']);
  s.second.input.write('/quit\n'); await s.second.done;
});

test('a stuck approval can be refused from the page, keeping its evidence and creating nobody', { skip: joinSkip, timeout: 120_000 }, async t => {
  const s = await stalled(t);
  const refused = await s.q.call('POST', '/api/join-refuse', { claimId: s.claimId });
  assert.equal(refused.status, 200, JSON.stringify(refused.json));
  assert.deepEqual(refused.json.join.kept, { name: 'Stale', agentId: 'stale-abcd', participantId: null });
  await until(async () => (await s.q.state()).joins.length === 0, 'the reconciled join leaving Needs you');
  const after = journalEntry(s.journalPath, s.key);
  assert.deepEqual([after.state, after.approval.name, after.approval.agentId], ['refused', 'Stale', 'stale-abcd'], 'the partial evidence is kept');
  let state = await s.q.state();
  assert.deepEqual(state.agents, [], 'a refused stuck approval creates no agent');
  const { request } = await import('../core/client.ts');
  const owner = JSON.parse(readFileSync(join(shell.ownerStore(s.second.dir), 'owner.json'), 'utf8'));
  assert.deepEqual((await request(owner, 'room')).roster.filter((r: any) => r.kind === 'agent'), [], 'and no hub participant');
  // A new line is a deliberate new identity; the stalled record is never replaced.
  const fresh = (await s.q.call('POST', '/api/join-line', { harness: 'dsh' })).json;
  const freshClaim = await raw(s.q.port, s.q.host, 'POST', `${new URL(/peerloom join (\S+) --harness/.exec(fresh.line)![1]).pathname}/claim`, { secret: 'claim-secret-' + 's'.repeat(24), harness: 'dsh', label: 'Fresh session' });
  assert.equal((await s.q.call('POST', '/api/join-approve', { claimId: freshClaim.json.claimId })).status, 200);
  state = await s.q.state();
  assert.equal(state.agents.length, 1); assert.notEqual(state.agents[0].agentId, 'stale-abcd');
  assert.deepEqual([journalEntry(s.journalPath, s.key).approval.name, journalEntry(s.journalPath, s.key).approval.agentId], ['Stale', 'stale-abcd'], 'the old evidence is untouched');
  s.second.input.write('/quit\n'); await s.second.done;
});

test('an approval the hub answered with a different participant cannot be retried, but can be refused', { skip: joinSkip, timeout: 120_000 }, async t => {
  const s = await stalled(t, { stuck: 'participant' });
  assert.equal(s.row.retry, false, 'the page is not offered a retry that would mismatch');
  assert.match(String(s.row.note ?? ''), /different participant/i);
  const retry = await s.q.call('POST', '/api/join-approve', { claimId: s.claimId, retry: true });
  assert.notEqual(retry.status, 200, 'the server refuses the retry');
  assert.match(JSON.stringify(retry.json), /reconcile|participant|stuck/i);
  const refused = await s.q.call('POST', '/api/join-refuse', { claimId: s.claimId });
  assert.equal(refused.status, 200, JSON.stringify(refused.json));
  assert.deepEqual(refused.json.join.kept, { name: 'Stale', agentId: 'stale-abcd', participantId: 'p_previous' });
  const after = journalEntry(s.journalPath, s.key);
  assert.deepEqual([after.state, after.approval.agentId, after.approval.participantId], ['refused', 'stale-abcd', 'p_previous']);
  s.second.input.write('/quit\n'); await s.second.done;
});
