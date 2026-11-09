// Black-box contract tests: real HTTP hub and CLI processes, independent of
// the reducer. All credentials and snapshots are disposable test data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { credential, request, type Credential } from '../core/client.ts';
import { startHub } from '../core/server.ts';

const root = resolve(import.meta.dirname, '..');
const exec = promisify(execFile);
async function cli(command: string, path: string, ...args: string[]) {
  const { stdout } = await exec(process.execPath, ['core/cli.ts', command, '--client', path, ...args], { cwd: root, timeout: 15_000 });
  return JSON.parse(stdout);
}
async function processHub(data: string, port = 0) {
  const child = spawn(process.execPath, ['core/server.ts', '--data', data, '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk; });
  const ready = await new Promise<any>((ok, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Hub startup timed out: ${stderr}`)); }, 8000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Hub exited at startup: ${stderr}`)); });
    child.stdout!.on('data', chunk => {
      buffer += chunk;
      if (buffer.includes('\n')) { clearTimeout(timer); try { ok(JSON.parse(buffer.split('\n')[0])); } catch (error) { reject(error); } }
    });
  });
  return { ...ready, child, stop: async (signal: NodeJS.Signals = 'SIGTERM') => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const stopped = once(child, 'exit'); child.kill(signal); await stopped;
  } };
}
async function world() {
  const directory = mkdtempSync(join(tmpdir(), 'peerloom-collab-contract-'));
  const data = join(directory, 'data');
  let hub = await processHub(data);
  const ownerPath = join(directory, 'owner.json');
  const { stdout } = await exec(process.execPath, ['core/cli.ts', 'create', '--admin-file', hub.adminFile, '--name', 'Contract room', '--workspace', root, '--objective', 'Review exact evidence', '--out', ownerPath, '--key', 'create'], { cwd: root, timeout: 15_000 });
  assert.equal(JSON.parse(stdout).token, undefined);
  const owner = credential(ownerPath);
  const agents: Record<string, { path: string; auth: Credential }> = {};
  for (const name of ['A', 'B', 'C']) {
    const invitationPath = join(directory, `${name}-invite.json`); const path = join(directory, `${name}.json`);
    await cli('invite', ownerPath, '--name', name, '--out', invitationPath, '--key', `invite-${name}`);
    await exec(process.execPath, ['core/cli.ts', 'join', '--invite', invitationPath, '--out', path, '--key', `join-${name}`], { cwd: root, timeout: 15_000 });
    agents[name] = { path, auth: credential(path) };
  }
  return {
    directory, data, ownerPath, owner, ...agents,
    admin: () => credential(hub.adminFile),
    snapshot: () => JSON.parse(readFileSync(join(data, 'state.json'), 'utf8')),
    restart: async () => {
      const port = Number(new URL(hub.endpoint).port);
      await hub.stop('SIGKILL'); hub = await processHub(data, port);
    },
    close: async () => { await hub.stop(); rmSync(directory, { recursive: true, force: true }); },
  };
}
const target = (r: any) => ({ artifactId: r.artifactId, revision: r.revision, digest: r.digest });
const refusal = (code: string, status?: number) => (error: any) => error.code === code && (status === undefined || error.status === status);
const outcomes = (results: PromiseSettledResult<any>[]) => ({ ok: results.filter(r => r.status === 'fulfilled'), errors: results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason) });

test('CLI rejects unknown collaboration flags and displays untrusted labels without terminal controls', async t => {
  const w = await world(); t.after(w.close);
  await assert.rejects(cli('item-open', w.A.path, '--type', 'decision', '--title', 'Bad flag', '--owner', 'someone'), (error: any) => error.code === 1 && /does not take --owner/.test(JSON.parse(error.stdout).message));
  assert.equal((await cli('items', w.A.path)).items.length, 0, 'unknown flag must fail before creating an item');
  const title = 'Title\u001b[2J\nforged row\u202e';
  const opened = await cli('item-open', w.A.path, '--type', 'decision', '--title', title);
  assert.equal((await cli('item', w.A.path, '--item', opened.itemId)).item.title, title, 'source and JSON retain the original text');
  const { stdout } = await exec(process.execPath, ['core/cli.ts', 'board', '--client', w.A.path], { cwd: root, timeout: 15_000 });
  assert.ok(!stdout.includes('\u001b') && !stdout.includes('\u202e'), 'board cannot emit screen-clear or direction-override characters');
  assert.ok(stdout.includes('Title\\u001b[2J\\nforged row\\u202e'), 'controls must be visibly escaped on a single line');
  assert.ok(!stdout.includes('\nforged row'), 'title cannot create another board row');
});

test('resolving cannot hide another artifact objection or pending review behind the named agreed artifact', async t => {
  const w = await world(); t.after(w.close);
  const item = await cli('item-open', w.A.path, '--type', 'decision', '--title', 'Several artifacts', '--key', 'open');
  const primary = await cli('publish', w.A.path, '--item', item.itemId, '--text', 'Primary proposal', '--key', 'primary');
  const supporting = await cli('publish', w.C.path, '--item', item.itemId, '--text', 'Supporting evidence', '--key', 'supporting');
  const review = async (artifact: any, label: string) => cli('request', w.A.path, '--item', item.itemId, '--purpose', 'review', '--to', 'B', '--artifact', artifact.artifactId, '--revision', '1', '--digest', artifact.digest, '--text', label, '--key', label);
  const respond = async (r: any, artifact: any, verdict: string, label: string) => cli('respond', w.B.path, '--request', r.collabRequestId, '--outcome', 'answered', '--verdict', verdict, '--artifact', artifact.artifactId, '--revision', '1', '--digest', artifact.digest, '--text', label, '--key', label);
  const accept = async (r: any, response: any, label: string) => cli('accept', w.A.path, '--request', r.collabRequestId, '--responses', response.responseId, '--key', label);
  const r1 = await review(primary, 'review-primary');
  await accept(r1, await respond(r1, primary, 'approve', 'approve-primary'), 'accept-primary');
  const r2 = await review(supporting, 'review-supporting');
  const supportApproval = await respond(r2, supporting, 'approve', 'support-pending-acceptance');
  const close = (requestId: string) => request(w.A.auth, 'item_close', { requestId, itemId: item.itemId, state: 'resolved', reason: 'Completed review', agreed: target(primary) });
  const events = w.snapshot().sessions[0].events.length;
  await assert.rejects(close('close-pending'), refusal('not_agreed', 409));
  assert.equal(w.snapshot().sessions[0].events.length, events, 'refused closure must record nothing');
  await accept(r2, supportApproval, 'accept-support-approval');
  const objected = await review(supporting, 'review-objected-evidence');
  await accept(objected, await respond(objected, supporting, 'changes_requested', 'object-supporting'), 'accept-objection');
  await assert.rejects(close('close-objection'), refusal('not_agreed', 409));
  const r3 = await review(supporting, 'review-corrected-evidence');
  await accept(r3, await respond(r3, supporting, 'approve', 'approve-supporting'), 'accept-supporting');
  const historical = await cli('publish', w.C.path, '--item', item.itemId, '--text', 'Unreviewed supporting record', '--key', 'historical');
  await w.restart();
  await close('close-reviewed');
  const final = (await cli('item', w.A.path, '--item', item.itemId)).item;
  assert.equal(final.state, 'resolved');
  assert.equal(final.requests.find((r: any) => r.collabRequestId === objected.collabRequestId).result, 'not_passed', 'earlier negative review remains visible');
  assert.equal(final.artifacts.find((a: any) => a.artifactId === supporting.artifactId).revisions[0].objections[0].standing, 'superseded');
  assert.equal(final.artifacts.find((a: any) => a.artifactId === historical.artifactId).revisions[0].status, 'unreviewed', 'item resolution does not manufacture blanket approval');
});

test('superseded settled reviews remain evidence without offering impossible acceptance, while open duties remain actionable', async t => {
  const w = await world(); t.after(w.close);
  const item = await cli('item-open', w.A.path, '--type', 'decision', '--title', 'Stale completed review', '--key', 'open');
  const artifact = await cli('publish', w.A.path, '--item', item.itemId, '--text', 'R1', '--key', 'r1');
  const review = await cli('request', w.A.path, '--item', item.itemId, '--purpose', 'review', '--to', 'B', '--artifact', artifact.artifactId, '--revision', '1', '--digest', artifact.digest, '--text', 'Review R1', '--key', 'review');
  const response = await cli('respond', w.B.path, '--request', review.collabRequestId, '--outcome', 'answered', '--verdict', 'approve', '--artifact', artifact.artifactId, '--revision', '1', '--digest', artifact.digest, '--text', 'Approve R1', '--key', 'response');
  assert.equal((await cli('awaiting', w.A.path)).requests.length, 1, 'current settled response still needs acceptance');
  const open = await cli('request', w.A.path, '--item', item.itemId, '--purpose', 'review', '--to', 'C', '--artifact', artifact.artifactId, '--revision', '1', '--digest', artifact.digest, '--text', 'A second review still owed', '--key', 'open-review');
  await cli('publish', w.A.path, '--item', item.itemId, '--artifact', artifact.artifactId, '--base', '1', '--text', 'R2', '--key', 'r2');
  await w.restart();
  const awaiting = (await cli('awaiting', w.A.path)).requests;
  assert.deepEqual(awaiting.map((r: any) => r.collabRequestId), [open.collabRequestId], 'only the open superseded request is actionable');
  assert.equal((await cli('owed', w.C.path)).requests[0].collabRequestId, open.collabRequestId, 'publishing cannot silently cancel an open duty');
  const old = (await cli('item', w.A.path, '--item', item.itemId)).item.requests.find((r: any) => r.collabRequestId === review.collabRequestId);
  assert.equal(old.state, 'settled'); assert.equal(old.targetSuperseded, true); assert.equal(old.responses[0].responseId, response.responseId);
  await assert.rejects(request(w.A.auth, 'accept', { requestId: 'stale-accept', collabRequestId: review.collabRequestId, responseIds: [response.responseId] }), refusal('target_superseded', 409));
  const { stdout } = await exec(process.execPath, ['core/cli.ts', 'board', '--client', w.A.path], { cwd: root, timeout: 15_000 });
  assert.ok(stdout.includes(`${review.collabRequestId} review`) && stdout.includes('[revision superseded]'), 'the historical request is visible under its item');
  assert.ok(!stdout.includes(`accept with --responses ${response.responseId}`), 'board must not suggest a forbidden action');
  await cli('withdraw', w.A.path, '--request', open.collabRequestId, '--reason', 'Review the new revision instead', '--key', 'withdraw-old');
  assert.equal((await cli('awaiting', w.A.path)).requests.length, 0);
  assert.equal((await cli('owed', w.C.path)).requests.length, 0);
});

test('real CLI review flow distinguishes receipt, verdict, acceptance and revisions across SIGKILL', { timeout: 90_000 }, async t => {
  const w = await world(); t.after(w.close);
  const a = w.A.auth; const b = w.B.auth;
  const caps = await cli('capabilities', w.A.path);
  assert.equal(caps.stateVersion, 6); assert.equal(caps.collaboration, true);
  for (const op of ['item_open', 'publish', 'request', 'respond', 'accept', 'withdraw', 'item_close', 'requests', 'item', 'items', 'revision']) assert.ok(caps.operations.includes(op));
  assert.equal(new Set(caps.operations).size, caps.operations.length);
  const item = await cli('item-open', w.ownerPath, '--type', 'decision', '--title', 'Evidence review', '--key', 'item');
  let artifact: any;
  async function checkpoint() {
    const queries = [
      ['item', { itemId: item.itemId }, a], ['requests', { filter: 'owed_by_me' }, b],
      ['requests', { filter: 'owed_to_me' }, a], ['history', {}, a], ['capabilities', {}, a],
      ...(artifact ? [['revision', { artifactId: artifact.artifactId, revision: artifact.revision }, a]] : []),
    ] as [string, any, Credential][];
    const before = await Promise.all(queries.map(([op, body, auth]) => request(auth, op, body)));
    const stored = w.snapshot();
    await w.restart();
    assert.deepEqual(w.snapshot(), stored, 'restart must not silently rewrite collaboration state');
    const after = await Promise.all(queries.map(([op, body, auth]) => request(auth, op, body)));
    assert.deepEqual(after, before, 'all read projections survive a forced process crash');
  }
  await checkpoint();
  // --file carries option-shaped and Unicode text verbatim; the digest is over
  // stored UTF-8 content, not a mutable workspace-path claim.
  const source = '--help\nA proposal with café and 🧪 evidence.\n'; const file = join(w.directory, 'proposal.md');
  writeFileSync(file, source);
  artifact = await cli('publish', w.A.path, '--item', item.itemId, '--file', file, '--key', 'r1');
  assert.equal(artifact.digest, createHash('sha256').update(source).digest('hex'));
  assert.equal(artifact.contentSize, Buffer.byteLength(source));
  writeFileSync(file, 'A changed workspace file is not the stored revision.');
  assert.equal((await cli('revision', w.B.path, '--artifact', artifact.artifactId, '--revision', '1')).revision.contentInline, source);
  await checkpoint();
  const review = await cli('request', w.A.path, '--item', item.itemId, '--purpose', 'review', '--to', 'B', '--artifact', artifact.artifactId, '--revision', '1', '--digest', artifact.digest, '--text', 'Review the immutable proposal', '--key', 'review1');
  assert.equal((await cli('owed', w.B.path)).requests[0].collabRequestId, review.collabRequestId);
  await checkpoint();
  await cli('ack', w.B.path, '--ids', review.messageId, '--key', 'receipt');
  assert.equal((await cli('inbox', w.B.path)).messages.length, 0);
  assert.equal((await cli('owed', w.B.path)).requests.length, 1, 'receipt must not satisfy the request');
  await checkpoint();
  await cli('send', w.B.path, '--to', 'A', '--reply-to', review.messageId, '--text', 'Status: still investigating', '--key', 'status-reply');
  assert.equal((await cli('owed', w.B.path)).requests.length, 1, 'a generic reply must not satisfy review');
  await checkpoint();
  const response = await cli('respond', w.B.path, '--request', review.collabRequestId, '--outcome', 'answered', '--verdict', 'approve', '--artifact', artifact.artifactId, '--revision', '1', '--digest', artifact.digest, '--text', 'The evidence supports this proposal', '--key', 'response');
  assert.equal((await cli('owed', w.B.path)).requests.length, 0);
  assert.equal((await cli('awaiting', w.A.path)).requests[0].state, 'settled');
  assert.equal((await cli('item', w.A.path, '--item', item.itemId)).item.artifacts[0].revisions[0].status, 'in_review');
  await checkpoint();
  await cli('accept', w.A.path, '--request', review.collabRequestId, '--responses', response.responseId, '--key', 'accept1');
  const accepted = (await cli('item', w.A.path, '--item', item.itemId)).item;
  assert.equal(accepted.artifacts[0].revisions[0].status, 'agreed');
  assert.equal(accepted.requests[0].result, 'passed');
  await checkpoint();
  artifact = await cli('publish', w.A.path, '--item', item.itemId, '--artifact', artifact.artifactId, '--base', '1', '--text', 'Revision two needs a new review.', '--key', 'r2');
  const updated = (await cli('item', w.B.path, '--item', item.itemId)).item;
  assert.equal(updated.artifacts[0].revisions[0].superseded, true);
  assert.equal(updated.artifacts[0].revisions[0].passedReviews.length, 1);
  assert.equal(updated.artifacts[0].revisions[1].status, 'unreviewed');
  assert.equal(updated.artifacts[0].revisions[1].passedReviews.length, 0);
  await checkpoint();
  const review2 = await request(a, 'request', { requestId: 'review2', itemId: item.itemId, purpose: 'review', to: ['B'], target: target(artifact), text: 'Review R2' });
  await assert.rejects(request(b, 'respond', { requestId: 'wrong-revision', collabRequestId: review2.collabRequestId, outcome: 'answered', verdict: 'approve', target: { ...target(artifact), revision: 1 }, text: 'Wrong evidence' }), refusal('target_mismatch', 409));
  await assert.rejects(request(w.owner, 'accept', { requestId: 'human-cannot-impersonate', collabRequestId: review2.collabRequestId, responseIds: [response.responseId] }), refusal('not_requester', 403));
  const changes = await request(b, 'respond', { requestId: 'changes', collabRequestId: review2.collabRequestId, outcome: 'answered', verdict: 'changes_requested', target: target(artifact), text: 'R2 needs stronger evidence' });
  await request(a, 'accept', { requestId: 'accept-changes', collabRequestId: review2.collabRequestId, responseIds: [changes.responseId] });
  let view = (await request(a, 'item', { itemId: item.itemId })).item;
  assert.equal(view.artifacts[0].revisions[1].status, 'changes_requested');
  assert.equal(view.requests[1].result, 'not_passed', 'acceptance of a negative review is not artifact agreement');
  await checkpoint();
  const newReview = await request(a, 'request', { requestId: 'rereview', itemId: item.itemId, purpose: 'review', to: ['B'], target: target(artifact), text: 'Recheck this same immutable version' });
  const approval = await request(b, 'respond', { requestId: 'new-approval', collabRequestId: newReview.collabRequestId, outcome: 'answered', verdict: 'approve', target: target(artifact), text: 'The concern is resolved by the accompanying evidence' });
  await request(a, 'accept', { requestId: 'accept-rereview', collabRequestId: newReview.collabRequestId, responseIds: [approval.responseId] });
  view = (await request(a, 'item', { itemId: item.itemId })).item;
  assert.equal(view.artifacts[0].revisions[1].status, 'agreed');
  assert.equal(view.artifacts[0].revisions[1].objections[0].standing, 'superseded');
  await assert.rejects(request(a, 'item_close', { requestId: 'not-item-owner', itemId: item.itemId, state: 'resolved', reason: 'Cannot resolve as another owner', agreed: target(artifact) }), refusal('not_owner', 403));
  await request(w.owner, 'item_close', { requestId: 'close-reviewed', itemId: item.itemId, state: 'resolved', reason: 'Review criterion met at R2', agreed: target(artifact) });
  await checkpoint();
  const { stdout: board } = await exec(process.execPath, ['core/cli.ts', 'board', '--client', w.A.path], { cwd: root, timeout: 15_000 });
  assert.match(board, /agreed/); assert.match(board, /resolved/);
  for (const auth of [a, b, w.C.auth, w.owner]) assert.equal(board.includes(auth.token), false, 'board must not expose credentials');
});

test('concurrent lifecycle calls have atomic outcomes and actor-scoped retries', { timeout: 60_000 }, async t => {
  const w = await world(); t.after(w.close);
  const a = w.A.auth; const b = w.B.auth; const c = w.C.auth;
  const item = await request(a, 'item_open', { requestId: 'item', itemType: 'research', title: 'Race evidence' });
  let n = 0;
  const ask = (policy = 'all') => request(a, 'request', { requestId: `ask-${n++}`, itemId: item.itemId, purpose: 'answer', to: ['B', 'C'], policy, text: 'Supply evidence' });
  const answer = (auth: Credential, rq: any, key: string) => request(auth, 'respond', { requestId: key, collabRequestId: rq.collabRequestId, outcome: 'answered', text: 'Correlated evidence' });
  const any = await ask('any');
  const before = w.snapshot().sessions[0].events.length;
  const race = outcomes(await Promise.allSettled([answer(b, any, 'same-key'), answer(c, any, 'same-key')]));
  assert.equal(race.ok.length, 1); assert.equal(race.errors.length, 1); assert.equal(race.errors[0].code, 'slot_closed');
  assert.equal(w.snapshot().sessions[0].events.length, before + 1);
  const anyView = (await request(a, 'requests', { filter: 'item', itemId: item.itemId })).requests.find((r: any) => r.collabRequestId === any.collabRequestId);
  assert.deepEqual(anyView.slots.map((s: any) => s.state).sort(), ['responded', 'withdrawn']);

  const all = await ask();
  const both = await Promise.all([answer(b, all, 'shared-key-all'), answer(c, all, 'shared-key-all')]);
  assert.notEqual(both[0].responseId, both[1].responseId, 'different actors can use the same retry key');
  const receipt = await request(a, 'accept', { requestId: 'accept-all', collabRequestId: all.collabRequestId, responseIds: both.map(r => r.responseId) });
  assert.equal(receipt.collabRequestId, all.collabRequestId);

  const late = await ask(); const first = await answer(b, late, 'first');
  const lateResults = await Promise.allSettled([
    request(a, 'accept', { requestId: 'accept-too-early', collabRequestId: late.collabRequestId, responseIds: [first.responseId] }),
    answer(c, late, 'late'),
  ]);
  assert.equal(lateResults[0].status, 'rejected');
  assert.ok(['slots_open', 'response_set'].includes((lateResults[0] as PromiseRejectedResult).reason.code));
  assert.equal(lateResults[1].status, 'fulfilled');

  const slot = await request(a, 'request', { requestId: 'slot-race', itemId: item.itemId, purpose: 'answer', to: ['B'], text: 'Race withdrawal' });
  const slotRace = outcomes(await Promise.allSettled([
    answer(b, slot, 'respond-race'),
    request(a, 'withdraw', { requestId: 'withdraw-race', collabRequestId: slot.collabRequestId, reason: 'Cancelled' }),
  ]));
  assert.equal(slotRace.ok.length, 1); assert.equal(slotRace.errors[0].code, 'slot_closed');

  let artifact = await request(a, 'publish', { requestId: 'artifact', itemId: item.itemId, text: 'R1' });
  const publishRace = outcomes(await Promise.allSettled(['X', 'Y'].map(text => request(a, 'publish', { requestId: `publish-${text}`, itemId: item.itemId, artifactId: artifact.artifactId, baseRevision: 1, text }))));
  assert.equal(publishRace.ok.length, 1); assert.equal(publishRace.errors[0].code, 'stale_revision');
  artifact = (publishRace.ok[0] as PromiseFulfilledResult<any>).value;
  const review = await request(a, 'request', { requestId: 'review-race', itemId: item.itemId, purpose: 'review', to: ['B'], target: target(artifact), text: 'Review current' });
  const approved = await request(b, 'respond', { requestId: 'approve-race', collabRequestId: review.collabRequestId, outcome: 'answered', verdict: 'approve', target: target(artifact), text: 'Approved' });
  const acceptPublish = await Promise.allSettled([
    request(a, 'accept', { requestId: 'accept-vs-publish', collabRequestId: review.collabRequestId, responseIds: [approved.responseId] }),
    request(a, 'publish', { requestId: 'publish-vs-accept', itemId: item.itemId, artifactId: artifact.artifactId, baseRevision: artifact.revision, text: 'A new version' }),
  ]);
  assert.equal(acceptPublish[1].status, 'fulfilled');
  if (acceptPublish[0].status === 'rejected') assert.equal(acceptPublish[0].reason.code, 'target_superseded');
  const artifactView = (await request(a, 'item', { itemId: item.itemId })).item.artifacts[0];
  assert.equal(artifactView.revisions.at(-1).status, 'unreviewed');
  assert.equal(artifactView.revisions.at(-1).passedReviews.length, 0);

  const duplicateBody = { requestId: 'concurrent-identical', itemType: 'question', title: 'Exactly one record' };
  const eventCount = w.snapshot().sessions[0].events.length;
  const duplicates = await Promise.all(Array.from({ length: 6 }, () => request(a, 'item_open', duplicateBody)));
  for (const result of duplicates) assert.deepEqual(result, duplicates[0]);
  assert.equal(w.snapshot().sessions[0].events.length, eventCount + 1);
  await assert.rejects(request(a, 'item_open', { ...duplicateBody, title: 'Changed' }), refusal('request_conflict', 409));
  await w.restart();
  assert.deepEqual(await request(a, 'item_open', duplicateBody), duplicates[0], 'retry receipt is the immutable original after restart');

  const partial = await ask(); await answer(b, partial, 'partial-first');
  await assert.rejects(request(a, 'withdraw', { requestId: 'mixed-withdraw', collabRequestId: partial.collabRequestId, respondents: ['B', 'C'], reason: 'Cannot partly commit' }), refusal('slot_closed', 409));
  assert.ok((await request(c, 'requests', { filter: 'owed_by_me' })).requests.some((r: any) => r.collabRequestId === partial.collabRequestId));
  await request(a, 'item_close', { requestId: 'drop', itemId: item.itemId, state: 'dropped', reason: 'End substantive work, preserve response duty' });
  const owed = (await request(c, 'requests', { filter: 'owed_by_me' })).requests.find((r: any) => r.collabRequestId === partial.collabRequestId);
  assert.equal(owed.itemClosed, 'dropped');
  await assert.rejects(request(a, 'publish', { requestId: 'after-close', itemId: item.itemId, text: 'New work' }), refusal('item_closed', 409));
  await assert.rejects(ask(), refusal('item_closed', 409));
  await answer(c, partial, 'reply-after-drop');
});

test('strict fields, ownership, declines and cross-session relationships cannot manufacture acceptance', { timeout: 60_000 }, async t => {
  const w = await world(); t.after(w.close); const a = w.A.auth; const b = w.B.auth;
  const item = await request(a, 'item_open', { requestId: 'item', itemType: 'decision', title: 'Boundary' });
  const artifact = await request(a, 'publish', { requestId: 'artifact', itemId: item.itemId, text: 'The evidence' });
  const review = await request(a, 'request', { requestId: 'review', itemId: item.itemId, purpose: 'review', to: ['B'], target: target(artifact), text: 'Review' });
  const count = w.snapshot().sessions[0].events.length;
  await assert.rejects(request(a, 'respond', { requestId: 'self-review', collabRequestId: review.collabRequestId, outcome: 'answered', verdict: 'approve', target: target(artifact), text: 'Spoofing the reviewer' }), refusal('not_respondent', 403));
  await assert.rejects(request(b, 'respond', { requestId: 'spoof-by', collabRequestId: review.collabRequestId, outcome: 'answered', verdict: 'approve', target: target(artifact), text: 'Spoofing human', by: w.owner.participantId }), refusal('unknown_field', 400));
  await assert.rejects(request(a, 'send', { requestId: 'semantic-send', to: 'B', text: 'This is not a typed request', messageKind: 'review_request', itemId: item.itemId }), refusal('unknown_field', 400));
  await assert.rejects(request(a, 'request', { requestId: 'unknown-target-key', itemId: item.itemId, purpose: 'review', to: ['B'], target: { ...target(artifact), mutablePath: '/tmp/file' }, text: 'Unsupported field' }), refusal('unknown_field', 400));
  await assert.rejects(request(a, 'item_open', { requestId: 'unknown-ref-key', itemType: 'task', title: 'Opaque ref', externalRefs: [{ provider: 'beads', ref: 'bd-a', grantOwner: true }] }), refusal('unknown_field', 400));
  await assert.rejects(request(a, 'request', { requestId: 'duplicate-to', itemId: item.itemId, purpose: 'answer', to: ['B', w.B.auth.participantId], text: 'Duplicate identity' }), refusal('duplicate_recipient', 400));
  assert.equal(w.snapshot().sessions[0].events.length, count);
  assert.equal((await request(a, 'heartbeat')).self, a.participantId, 'domain refusal must not poison the store');
  const declined = await request(b, 'respond', { requestId: 'decline', collabRequestId: review.collabRequestId, outcome: 'declined', target: target(artifact), text: 'Unable to review' });
  await assert.rejects(request(a, 'accept', { requestId: 'no-result', collabRequestId: review.collabRequestId, responseIds: [declined.responseId] }), refusal('no_result', 409));
  const view = (await request(a, 'item', { itemId: item.itemId })).item;
  assert.equal(view.artifacts[0].revisions[0].pendingReviews.length, 0);
  assert.equal(view.artifacts[0].revisions[0].status, 'unreviewed');

  const otherItem = await request(b, 'item_open', { requestId: 'other-item', itemType: 'research', title: 'Another item' });
  await assert.rejects(request(b, 'request', { requestId: 'wrong-item-target', itemId: otherItem.itemId, purpose: 'review', to: ['A'], target: target(artifact), text: 'Wrong relationship' }), refusal('unknown_artifact', 404));
  const other = await request(w.admin(), 'create', { requestId: 'another-room', name: 'Other room', workspace: root });
  for (const [op, body] of [
    ['item', { itemId: item.itemId }], ['revision', { artifactId: artifact.artifactId, revision: 1 }],
    ['requests', { filter: 'item', itemId: item.itemId }],
    ['publish', { requestId: 'foreign-publish', itemId: item.itemId, text: 'Foreign data' }],
    ['respond', { requestId: 'foreign-response', collabRequestId: review.collabRequestId, outcome: 'answered', verdict: 'approve', target: target(artifact), text: 'Foreign actor' }],
  ] as [string, any][]) await assert.rejects(request(other, op, body), (error: any) => error.status === 404);
  assert.equal((await request(other, 'items')).items.length, 0);

  const humanRequest = await request(a, 'request', { requestId: 'ask-human', itemId: item.itemId, purpose: 'decision', to: ['human'], text: 'Choose the criterion' });
  await assert.rejects(request(b, 'respond', { requestId: 'answer-for-human', collabRequestId: humanRequest.collabRequestId, outcome: 'answered', text: 'Pretending to be human' }), refusal('not_respondent', 403));
  await request(w.owner, 'withdraw', { requestId: 'human-withdraw', collabRequestId: humanRequest.collabRequestId, reason: 'Owner withdraws the pending question' });
  assert.equal((await request(w.owner, 'requests', { filter: 'owed_by_me' })).requests.length, 0);
});

test('restart rejects corrupted identity, event and message evidence without changing the saved bytes', { timeout: 45_000 }, async t => {
  const w = await world(); t.after(w.close);
  const item = await request(w.A.auth, 'item_open', { requestId: 'item', itemType: 'research', title: 'Integrity' });
  const artifact = await request(w.A.auth, 'publish', { requestId: 'revision', itemId: item.itemId, text: 'Immutable evidence' });
  const rq = await request(w.A.auth, 'request', { requestId: 'ask', itemId: item.itemId, purpose: 'review', to: ['B'], target: target(artifact), text: 'Review evidence' });
  const valid = w.snapshot();
  const variants: [string, (state: any) => void][] = [
    ['future-version', s => { s.version = 999; }],
    ['missing-events', s => { delete s.sessions[0].events; }],
    ['forged-owner', s => { s.sessions[0].participants[0].kind = 'agent'; }],
    ['duplicate-identity', s => { s.sessions[0].participants[2].tokenHash = s.sessions[0].participants[1].tokenHash; }],
    ['sequence-gap', s => { s.sessions[0].events[0].seq = 9; }],
    ['event-content-tamper', s => { s.sessions[0].events[1].contentInline = 'Changed after review'; }],
    ['missing-message', s => { s.sessions[0].messages = []; }],
    ['wrong-message-text', s => { s.sessions[0].messages[0].text = 'A different request'; }],
    ['unknown-collab-key', s => { s.sessions[0].messages[0].collab.grantOwner = true; }],
    ['wrong-event-actor', s => { s.sessions[0].events[2].by = w.B.auth.participantId; }],
    ['unknown-event-field', s => { s.sessions[0].events[0].permissionGranted = true; }],
    ['orphan-collab-message', s => { const m = structuredClone(s.sessions[0].messages[0]); m.id = `m_${randomUUID()}`; m.sequence = 2; m.threadId = m.id; m.collab.collabRequestId = `rq_${randomUUID()}`; s.sessions[0].messages.push(m); }],
    ['invalid-ack', s => { s.sessions[0].participants[1].ack.push(rq.messageId); }],
  ];
  for (const [name, mutate] of variants) {
    const data = join(w.directory, `corrupt-${name}`); mkdirSync(data);
    const snapshot = structuredClone(valid); mutate(snapshot);
    const path = join(data, 'state.json'); const bytes = JSON.stringify(snapshot); writeFileSync(path, bytes);
    await assert.rejects(startHub({ dataDir: data, port: 0 }), undefined, name);
    assert.equal(readFileSync(path, 'utf8'), bytes, `${name}: invalid evidence must remain available for recovery`);
  }
});

test('state upgrade refuses invalid UTF-8 without changing or backing up the damaged bytes', async t => {
  const data = mkdtempSync(join(tmpdir(), 'peerloom-invalid-utf8-')); t.after(() => rmSync(data, { recursive: true, force: true }));
  const path = join(data, 'state.json');
  const bytes = Buffer.concat([Buffer.from('{"version":1,"sessions":[],"requests":{"admin:bad'), Buffer.from([0xff]), Buffer.from('":{"fingerprint":"0000000000000000000000000000000000000000000000000000000000000000","result":{}}}}')]);
  writeFileSync(path, bytes);
  await assert.rejects(startHub({ dataDir: data, port: 0, upgradeState: true }));
  assert.deepEqual(readFileSync(path), bytes);
  await assert.rejects(import('node:fs/promises').then(fs => fs.stat(join(data, 'state.v1.backup.json'))), (error: any) => error.code === 'ENOENT');
});
