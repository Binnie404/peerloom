import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub } from '../core/server.ts';
import { credential, request } from '../core/client.ts';
import { validate } from '../core/delivery.ts';

async function room(t: { after(fn: () => unknown): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'peerloom-keyed-waits-'));
  let hub = await startHub({ dataDir: directory, port: 0 });
  let serial = 0;
  const auth = (who: any) => ({ ...who, endpoint: hub.endpoint });
  const call = (who: any, op: string, body: any = {}) => request(auth(who), op, body, 12_000);
  const mutate = (who: any, op: string, body: any = {}) => call(who, op, { requestId: `keyed-${++serial}`, ...body });
  const human = await mutate(credential(hub.adminPath), 'create', { name: 'Keyed waits', workspace: directory });
  const invite = await mutate(human, 'invite', { name: 'Agent' });
  const agent = await mutate(invite, 'join', { token: invite.token });
  const { generation } = await mutate(agent, 'bind', { label: 'Keyed client' });
  await mutate(human, 'run_start', { limits: { room: 8, agent: 8 } });
  t.after(async () => { await hub.close(); rmSync(directory, { recursive: true, force: true }); });
  return { human, agent, generation, call, mutate,
    wait: (attemptId?: string) => call(agent, 'wait', { generation, timeoutSeconds: 1, ...(attemptId === undefined ? {} : { attemptId }) }),
    snapshot: () => JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')).sessions[0],
    restart: async () => { await hub.close(); hub = await startHub({ dataDir: directory, port: 0 }); },
  };
}

test('two distinct wait attempts cannot receive the same pending offer; identical recovery charges once across restart', async t => {
  const w = await room(t);
  const invitation = await w.mutate(w.human, 'invite', { name: 'Peer' });
  const peer = await w.mutate(invitation, 'join', { token: invitation.token });
  await w.mutate(peer, 'send', { to: 'Agent', text: 'One unit of peer work' });
  const results = await Promise.allSettled([w.wait('alpha'), w.wait('beta')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const denied = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal(denied.reason.code, 'already_waiting');
  const winner = results[0].status === 'fulfilled' ? 'alpha' : 'beta';
  const offered = (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
  assert.equal(w.snapshot().delivery.offers.length, 1);
  await assert.rejects(w.wait(), (e: any) => e.code === 'already_waiting', 'an unkeyed caller cannot steal a keyed offer');
  assert.deepEqual(await w.wait(winner), offered);
  await w.restart();
  assert.deepEqual(await w.wait(winner), offered);
  assert.equal((await w.call(w.human, 'run')).used.room, 1);
  assert.deepEqual((await w.call(w.human, 'run')).bindings[0].pending, { wakeId: offered.wakeId, attemptId: winner });
  const fetched = await w.call(w.agent, 'fetch', { generation: w.generation, wakeId: offered.wakeId });
  assert.equal(fetched.attemptId, winner);
  await w.mutate(w.agent, 'confirm', { generation: w.generation, wakeId: offered.wakeId });
  assert.equal((await w.call(w.human, 'run')).bindings[0].pending, null);
  await w.mutate(peer, 'send', { to: 'Agent', text: 'Later work must need a fresh attempt' });
  await assert.rejects(w.wait(winner), (e: any) => e.code === 'attempt_finished');
  assert.equal((await w.call(w.human, 'run')).used.room, 1);
  const next = await w.wait('fresh'); assert.notEqual(next.wakeId, offered.wakeId);
  assert.equal((await w.call(w.human, 'run')).used.room, 2);
});

test('a keyed held wait preserves its identity when work arrives and refuses a second binding waiter', async t => {
  const w = await room(t); const held = w.wait('held-attempt');
  for (let i = 0; i < 100; i++) {
    if ((await w.call(w.human, 'run')).bindings[0].armed === 'waiting') break;
    await new Promise(ok => setTimeout(ok, 10));
  }
  assert.equal((await w.call(w.human, 'run')).bindings[0].armed, 'waiting');
  await assert.rejects(w.wait('other'), (e: any) => e.code === 'already_waiting');
  await w.mutate(w.human, 'send', { to: 'Agent', text: 'Release the held wait' });
  const offer = await held;
  assert.equal(w.snapshot().delivery.offers[0].attemptId, 'held-attempt');
  assert.deepEqual(await w.wait('held-attempt'), offer);
});

test('old unkeyed offers remain recoverable; invalid and duplicated persisted attempt identities are refused', async t => {
  const w = await room(t);
  for (const attemptId of ['', ' ', 'x'.repeat(201), 1]) {
    await assert.rejects(w.call(w.agent, 'wait', { generation: w.generation, timeoutSeconds: 1, attemptId }), (e: any) => e.code === 'invalid_field');
  }
  await w.mutate(w.human, 'send', { to: 'Agent', text: 'Legacy pending unit' });
  const legacy = await w.wait(); await w.restart();
  assert.deepEqual(await w.wait('new-client'), legacy);
  assert.equal(w.snapshot().delivery.offers[0].attemptId, undefined);
  await w.mutate(w.agent, 'confirm', { generation: w.generation, wakeId: legacy.wakeId });
  await w.mutate(w.human, 'send', { to: 'Agent', text: 'Keyed unit' });
  const keyed = await w.wait('keyed');
  await w.mutate(w.agent, 'confirm', { generation: w.generation, wakeId: keyed.wakeId });
  const snapshot = w.snapshot(); validate(snapshot);
  snapshot.delivery.offers[0].attemptId = 'keyed';
  assert.throws(() => validate(snapshot), /reused wait attempt/);
});
