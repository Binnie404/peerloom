import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub } from '../core/server.ts';
import { credential, request } from '../core/client.ts';

async function room(t: { after(fn: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'peerloom-mail-ergonomics-'));
  const hub = await startHub({ dataDir: dir, port: 0 });
  t.after(async () => { await hub.close(); rmSync(dir, { recursive: true, force: true }); });
  let serial = 0;
  const mutate = (auth: any, op: string, body: any) => request(auth, op, { requestId: `mail-${++serial}`, ...body });
  const human = await mutate(credential(join(dir, 'admin.json')), 'create', { name: 'Mail ergonomics', workspace: dir });
  const agents: any[] = [];
  for (const name of ['A', 'B']) {
    const invite = await mutate(human, 'invite', { name });
    agents.push(await mutate(invite, 'join', { token: invite.token }));
  }
  return { human, a: agents[0], b: agents[1], mutate, snapshot: () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) };
}

test('self-only sends are refused; mixed recipients omit self and retain the other participant', async t => {
  const w = await room(t);
  for (const to of ['a', w.a.participantId, ['A', w.a.participantId]]) {
    await assert.rejects(w.mutate(w.a, 'send', { to, text: 'Self' }), (e: any) => e.code === 'no_recipients');
  }
  assert.equal(w.snapshot().sessions[0].messages.length, 0);
  const sent = await w.mutate(w.a, 'send', { to: ['A', 'B'], text: 'Other' });
  assert.deepEqual(sent.message.recipientIds, [w.b.participantId]);
});

test('seen guards only newer addressed messages in the replied-to thread and preserves exact send retries', async t => {
  const w = await room(t);
  const first = (await w.mutate(w.a, 'send', { to: 'B', text: 'Question' })).message;
  const unseen = (await w.mutate(w.a, 'send', { to: 'B', replyTo: first.id, text: 'Correction' })).message;
  const before = w.snapshot();
  const body = { requestId: 'guarded-reply', to: 'A', replyTo: first.id, seen: first.sequence, text: 'Answer' };
  await assert.rejects(request(w.b, 'send', body), (e: any) => e.code === 'thread_moved');
  assert.deepEqual(w.snapshot(), before, 'a refused reply writes neither a message nor a retry result');
  const accepted = await request(w.b, 'send', { ...body, seen: unseen.sequence });
  await w.mutate(w.a, 'send', { to: 'B', replyTo: first.id, text: 'Later' });
  assert.deepEqual(await request(w.b, 'send', { ...body, seen: unseen.sequence }), accepted, 'a committed send replays before the guard');
  // An unrelated thread and a reply addressed to somebody else do not move B's thread.
  const latest = w.snapshot().sessions[0].messages.length;
  await w.mutate(w.a, 'send', { to: 'B', text: 'Other thread' });
  await w.mutate(w.human, 'send', { to: 'A', replyTo: first.id, text: 'Private to A' });
  await w.mutate(w.b, 'send', { to: 'A', replyTo: first.id, seen: latest, text: 'Thread still current for B' });
  for (const seen of [-1, 1.5, 999, '1']) await assert.rejects(w.mutate(w.b, 'send', { to: 'A', replyTo: first.id, seen, text: 'Invalid' }), (e: any) => e.code === 'invalid_cursor');
  await assert.rejects(w.mutate(w.b, 'send', { to: 'A', seen: 0, text: 'No thread' }), (e: any) => e.code === 'reply_required');
});
