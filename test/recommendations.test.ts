import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, read, validate, DomainError, parseProposal } from '../core/collab.ts';
import { startHub, inspectHubUpgrade, upgradeHubData } from '../core/server.ts';
import { request } from '../core/client.ts';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const payload = () => ({ v: 1, kind: 'gap', gap: 'Declined checkout is untested', outcome: 'Demonstrate recovery', evidence: ['checkout.ts'], why: 'Before release', payoff: 'Avoid abandoned checkouts', effort: 'small', impact: 'high', scope: 'Checkout recovery only', acceptance: ['A declined payment can be retried'] });
function fixture() {
  let serial = 0;
  const person = (name: string, kind = 'agent') => ({ id: `p_${name}`, name, kind, role: kind === 'human' ? 'owner' : 'Peer' });
  const session: any = { participants: [person('human', 'human'), person('Claude'), person('Codex'), person('Verifier')], events: [], messages: [] };
  const env = { now: () => '2026-10-25T19:30:00.000Z', id: (prefix: string) => `${prefix}_${++serial}` };
  const actor = (name: string) => session.participants.find((p: any) => p.name === name);
  const act = (name: string, op: string, body: any) => apply(session, actor(name), op, { requestId: `key-${++serial}`, ...body }, env) as any;
  const item = (itemId: string) => (read(session, actor('human'), 'item', { itemId }) as any).item;
  const suggest = () => { const result = act('Claude', 'suggest', { title: 'Exercise failed payment', payload: payload() }); return { ...result, target: { artifactId: result.artifactId, revision: result.revision, digest: result.digest } }; };
  const task = () => ({ outcome: payload().outcome, scope: payload().scope, acceptance: payload().acceptance });
  const adopt = (source: any, extra = {}) => act('human', 'adopt_suggestion', { itemId: source.itemId, target: source.target, assignee: 'Codex', task: task(), ...extra });
  return { session, env, act, item, suggest, task, adopt };
}
function refused(action: () => unknown, code: string) { assert.throws(action, (error: any) => error instanceof DomainError && error.code === code); }

test('suggest validates before publishing, records authenticated author and wakes nobody', () => {
  const r = fixture();
  refused(() => r.act('Claude', 'suggest', { title: 'Bad', payload: { ...payload(), author: 'human' } }), 'unknown_field');
  assert.equal(r.session.events.length, 0);
  const source = r.suggest();
  assert.deepEqual(r.session.events.map((e: any) => e.type), ['item_opened', 'revision_published']);
  assert.equal(r.item(source.itemId).ownerId, 'p_Claude');
  assert.equal(r.session.messages.length, 0);
  assert.deepEqual(parseProposal(JSON.stringify(payload())), { payload: payload(), error: null });
  assert.equal(parseProposal('{broken').payload, null);
  validate(r.session);
});

test('human can adopt an unreviewed proposal without claiming agreement; result and assignment survive replay', () => {
  const r = fixture(); const source = r.suggest(); const adopted = r.adopt(source);
  const view = r.item(source.itemId);
  assert.equal(view.closure.state, 'adopted');
  assert.equal(view.artifacts[0].revisions[0].status, 'unreviewed');
  assert.deepEqual(view.adoption.target, source.target);
  assert.equal(view.adoption.assigneeId, 'p_Codex');
  const task = r.item(adopted.taskItemId);
  assert.equal(task.ownerId, 'p_human');
  assert.deepEqual(task.requests[0].respondentIds, ['p_Codex']);
  assert.match(task.requests[0].text, /A declined payment can be retried/);
  assert.match(task.requests[0].text, new RegExp(source.artifactId));
  assert.equal(r.session.messages.length, 1);
  validate(r.session);
});

test('adoption retains dissent and withdraws only open review slots; late responses do not become positions', () => {
  const r = fixture(); const source = r.suggest();
  const review = r.act('Claude', 'request', { itemId: source.itemId, purpose: 'review', target: source.target, to: ['Codex', 'Verifier'], text: 'Review independently' });
  r.act('Codex', 'respond', { collabRequestId: review.collabRequestId, outcome: 'answered', verdict: 'changes_requested', target: source.target, text: 'Missing timeout coverage' });
  r.adopt(source);
  const request = r.item(source.itemId).requests[0];
  assert.equal(request.responses[0].verdict, 'changes_requested');
  assert.equal(request.responses[0].text, 'Missing timeout coverage');
  assert.equal(request.slots[1].state, 'withdrawn');
  refused(() => r.act('Verifier', 'respond', { collabRequestId: review.collabRequestId, outcome: 'answered', verdict: 'approve', target: source.target, text: 'Late' }), 'slot_closed');
  validate(r.session);
});

test('identical fresh-key adoption returns one outcome while changed confirmed intent conflicts', () => {
  const r = fixture(); const source = r.suggest(); const first = r.adopt(source);
  const count = r.session.events.length;
  assert.deepEqual(r.adopt(source), first);
  assert.equal(r.session.events.length, count);
  refused(() => r.adopt(source, { assignee: 'Verifier' }), 'adoption_conflict');
  refused(() => r.adopt(source, { task: { ...r.task(), outcome: 'Different work' } }), 'adoption_conflict');
  assert.equal(r.session.messages.length, 1);
});

test('invalid actor, target, assignee and task cannot leave partial adoption records', () => {
  const r = fixture(); const source = r.suggest();
  const body = { itemId: source.itemId, target: source.target, assignee: 'Codex', task: r.task() };
  const before = JSON.stringify(r.session);
  refused(() => r.act('Claude', 'adopt_suggestion', body), 'human_required');
  refused(() => r.adopt(source, { assignee: 'human' }), 'agent_required');
  refused(() => r.adopt(source, { task: { ...r.task(), acceptance: [] } }), 'invalid_field');
  refused(() => r.adopt(source, { target: { ...source.target, digest: '0'.repeat(64) } }), 'stale_revision');
  assert.equal(JSON.stringify(r.session), before);
  r.act('Claude', 'publish', { itemId: source.itemId, artifactId: source.artifactId, baseRevision: 1, text: JSON.stringify({ ...payload(), why: 'Updated evidence' }) });
  refused(() => r.adopt(source), 'stale_revision');
});

test('non-review work must be settled explicitly before adoption, without orphaning a new task', () => {
  const r = fixture(); const source = r.suggest();
  r.act('human', 'request', { itemId: source.itemId, purpose: 'answer', to: ['Claude'], text: 'Clarify the scope first' });
  const before = JSON.stringify(r.session);
  refused(() => r.adopt(source), 'open_requests');
  assert.equal(JSON.stringify(r.session), before);
});

test('adoption replay rejects forged authority, mismatched assignment and changed intent digest', () => {
  for (const field of ['by', 'assigneeId', 'taskDigest']) {
    const r = fixture(); r.adopt(r.suggest());
    const adopted = r.session.events.find((e: any) => e.type === 'suggestion_adopted');
    adopted[field] = field === 'taskDigest' ? '0'.repeat(64) : 'p_Verifier';
    assert.throws(() => validate(r.session), /invalid/);
  }
});

async function live(t: any) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agentlink-recommendations-'));
  let hub = await startHub({ dataDir, port: 0 });
  t.after(async () => { await hub.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const admin = JSON.parse(readFileSync(hub.adminPath, 'utf8'));
  const owner = await request(admin, 'create', { requestId: 'create', name: 'Recommendations', workspace: dataDir });
  const invite = await request(owner, 'invite', { requestId: 'invite', name: 'Codex', harness: 'codex', role: 'Peer' });
  const agent = await request({ endpoint: hub.endpoint }, 'join', { requestId: 'join', token: invite.token });
  const call = (who: any, op: string, body = {}) => request({ ...who, endpoint: hub.endpoint }, op, body);
  const restart = async () => { await hub.close(); hub = await startHub({ dataDir, port: 0 }); };
  const close = () => hub.close();
  return { dataDir, owner, agent, call, close, restart };
}

test('HTTP adoption is durable and idempotent across competing keys, restart and rejected actor/body changes', async t => {
  const r = await live(t);
  const source = await r.call(r.agent, 'suggest', { requestId: 'suggest', title: 'Recovery', payload: payload() });
  const target = { artifactId: source.artifactId, revision: source.revision, digest: source.digest };
  const body = { itemId: source.itemId, target, assignee: 'Codex', task: { outcome: payload().outcome, scope: payload().scope, acceptance: payload().acceptance } };
  await assert.rejects(r.call(r.agent, 'adopt_suggestion', { requestId: 'no-authority', ...body }), (e: any) => e.code === 'human_required');
  const outcomes = await Promise.all(['a', 'b'].map(requestId => r.call(r.owner, 'adopt_suggestion', { requestId, ...body })));
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.deepEqual(await r.call(r.owner, 'adopt_suggestion', { requestId: 'a', ...body }), outcomes[0]);
  await assert.rejects(r.call(r.owner, 'adopt_suggestion', { requestId: 'a', ...body, task: { ...body.task, outcome: 'Changed' } }), (e: any) => e.code === 'request_conflict');
  await r.restart();
  assert.deepEqual(await r.call(r.owner, 'adopt_suggestion', { requestId: 'after-restart', ...body }), outcomes[0]);
  const items = (await r.call(r.owner, 'items')).items;
  assert.equal(items.filter((i: any) => i.itemType === 'task').length, 1);
  const view = (await r.call(r.owner, 'item', { itemId: source.itemId })).item;
  assert.equal(view.closure.state, 'adopted');
  assert.equal(view.adoption.taskItemId, outcomes[0].taskItemId);
});

test('v4 upgrade is explicit, locked, preview-bound and preserves delivery, pending work and retry records', async t => {
  const r = await live(t);
  await r.call(r.agent, 'bind', { requestId: 'bind', label: 'migration fixture' });
  await r.call(r.owner, 'run_start', { requestId: 'run' });
  await r.call(r.owner, 'send', { requestId: 'queued', to: 'Codex', text: 'Keep this queued work' });
  const source = await r.call(r.agent, 'suggest', { requestId: 'proposal', title: 'Recovery', payload: payload() });
  const target = { artifactId: source.artifactId, revision: source.revision, digest: source.digest };
  await r.close();
  const statePath = join(r.dataDir, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8')); state.version = 4; for (const s of state.sessions) delete s.marks;
  const original = Buffer.from(JSON.stringify(state, null, 2)); writeFileSync(statePath, original);
  await r.restart();
  assert.equal((await r.call(r.owner, 'capabilities')).adoption, false);
  await assert.rejects(r.call(r.owner, 'adopt_suggestion', { requestId: 'requires-upgrade', itemId: source.itemId, target, assignee: 'Codex', task: { outcome: 'Test', scope: 'Only recovery', acceptance: ['Works'] } }), (e: any) => e.code === 'upgrade_required');
  const preview = inspectHubUpgrade({ dataDir: r.dataDir });
  assert.equal(preview.fromVersion, 4); assert.equal(preview.rooms[0].name, 'Recommendations');
  assert.throws(() => upgradeHubData({ dataDir: r.dataDir, expectedDigest: preview.sourceDigest }), /already held/);
  await r.close();
  assert.throws(() => upgradeHubData({ dataDir: r.dataDir, expectedDigest: '0'.repeat(64) }), /changed after the preview/);
  assert.deepEqual(readFileSync(statePath), original);
  const upgraded = upgradeHubData({ dataDir: r.dataDir, expectedDigest: preview.sourceDigest });
  assert.equal(upgraded.fromVersion, 4); assert.equal(upgraded.toVersion, 6); assert.equal(upgraded.needed, false);
  assert.deepEqual(readFileSync(upgraded.backupPath!), original);
  const after = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.deepEqual(after.sessions, state.sessions.map((s: any) => ({ ...s, marks: [] })));
  assert.deepEqual(after.requests, state.requests);
  assert.equal(existsSync(join(r.dataDir, 'hub.lock')), false);
  await r.restart();
  assert.equal((await r.call(r.owner, 'capabilities')).adoption, true);
  assert.equal((await r.call(r.owner, 'run')).state, 'running');
  assert.equal((await r.call(r.agent, 'inbox')).messages.at(-1).text, 'Keep this queued work');
});

test('a failed adoption save exposes no task, assignment or adoption after recovery', async t => {
  const r = await live(t);
  const source = await r.call(r.agent, 'suggest', { requestId: 'suggest', title: 'Recovery', payload: payload() });
  const statePath = join(r.dataDir, 'state.json'); const before = readFileSync(statePath);
  // Failure occurs before rename, after the whole compound operation was staged in memory.
  mkdirSync(`${statePath}.tmp`);
  await assert.rejects(r.call(r.owner, 'adopt_suggestion', { requestId: 'save-fails', itemId: source.itemId, target: { artifactId: source.artifactId, revision: source.revision, digest: source.digest }, assignee: 'Codex', task: { outcome: 'Verify recovery', scope: 'Checkout', acceptance: ['Works'] } }), (e: any) => e.code === 'internal_error');
  assert.deepEqual(readFileSync(statePath), before);
  await r.close(); rmSync(`${statePath}.tmp`, { recursive: true }); await r.restart();
  assert.equal((await r.call(r.owner, 'items')).items.filter((i: any) => i.itemType === 'task').length, 0);
  assert.equal((await r.call(r.owner, 'item', { itemId: source.itemId })).item.state, 'open');
  assert.equal((await r.call(r.agent, 'requests', { filter: 'owed_by_me' })).requests.length, 0);
});
