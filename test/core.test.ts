import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { credential, request } from '../core/client.ts';
import { startHub } from '../core/server.ts';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

async function hubProcess(data: string, port = 0) {
  const child = spawn(process.execPath, ['core/server.ts', '--data', data, '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let error = ''; child.stderr.on('data', b => { error += b; });
  const ready = await new Promise<any>((ok, reject) => {
    let buffer = '';
    child.stdout.on('data', b => { buffer += b; if (buffer.includes('\n')) { try { ok(JSON.parse(buffer.split('\n')[0])); } catch (e) { reject(e); } } });
    child.once('exit', () => reject(new Error(`Hub exited before startup: ${error}`)));
  });
  return { ...ready, child, stop: async (signal: NodeJS.Signals = 'SIGTERM') => { if (child.exitCode !== null || child.signalCode !== null) return; const stopped = once(child, 'exit'); child.kill(signal); await stopped; } };
}
async function cli(...args: string[]) {
  const { stdout } = await exec(process.execPath, ['core/cli.ts', ...args], { cwd: root, timeout: 15_000 });
  return JSON.parse(stdout);
}
async function chat(path: string) {
  const child = spawn(process.execPath, ['core/cli.ts', 'chat', '--client', path], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = ''; const queue: any[] = []; const waiters: ((v: any) => void)[] = [];
  child.stdout.on('data', b => {
    buffer += b;
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n'); const value = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      if (waiters.length) waiters.shift()!(value); else queue.push(value);
    }
  });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise<any>((ok, reject) => {
    const timer = setTimeout(() => reject(new Error('Client response timed out')), 10_000);
    waiters.push(value => { clearTimeout(timer); ok(value); });
  });
  const ready = await next();
  assert.equal(ready.chat, 'connected');
  return { child, ready, command: async (line: string) => { child.stdin.write(line + '\n'); return next(); }, stop: async () => { if (child.exitCode !== null || child.signalCode !== null) return; const stopped = once(child, 'exit'); child.stdin.end('/quit\n'); await stopped; } };
}

async function assertChatStartupFails(path: string, expectedError: RegExp, expectedCode: number) {
  // Keep stdin open: the CLI must exit itself, rather than rely on EOF to close readline.
  const child = spawn(process.execPath, ['core/cli.ts', 'chat', '--client', path], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; let stdout = '';
  child.stderr.on('data', b => { stderr += b; });
  child.stdout.on('data', b => { stdout += b; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((ok, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => ok({ code, signal }));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      exited,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Failed chat startup did not exit within 3 seconds')), 3000); })
    ]);
    assert.equal(result.code, expectedCode);
    assert.equal(result.signal, null);
    assert.equal(stderr, '');
    const failure = JSON.parse(stdout);
    assert.equal(failure.status, 'error', 'Failed startup must not announce a connected chat');
    assert.match(`${failure.error}: ${failure.message}`, expectedError);
  } finally {
    clearTimeout(timer);
    // A regression must fail the test without leaking its still-running client process.
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    child.stdin.destroy();
  }
}

test('chat startup failure exits promptly with open stdin', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'agentlink-startup-'));
  const path = join(temp, 'client.json');
  const hub = await startHub({ dataDir: join(temp, 'data'), port: 0 });
  let closed = false;
  try {
    writeFileSync(path, JSON.stringify({ endpoint: hub.endpoint, token: 'rejected-credential' }));
    await t.test('hub rejects the credential', async () => {
      await assertChatStartupFails(path, /invalid_token/, 6);
    });
    await hub.close(); closed = true;
    await t.test('hub is unavailable', async () => {
      await assertChatStartupFails(path, /hub_unreachable: .*fetch failed/, 7);
    });
  } finally {
    if (!closed) await hub.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('separate hub and two real CLI processes exchange durable authenticated messages', { timeout: 60_000 }, async t => {
  const temp = mkdtempSync(join(tmpdir(), 'agentlink-core-'));
  const data = join(temp, 'data'); const ownerPath = join(temp, 'owner.json');
  const aPath = join(temp, 'astra.json'); const bPath = join(temp, 'opus.json');
  let hub = await hubProcess(data); const chats: Awaited<ReturnType<typeof chat>>[] = [];
  t.after(async () => { for (const client of chats) await client.stop(); await hub.stop(); rmSync(temp, { recursive: true, force: true }); });
  const ownerCreated = await cli('create', '--admin-file', hub.adminFile, '--name', 'Test', '--workspace', root, '--objective', 'Verify collaboration', '--out', ownerPath, '--key', 'create-test');
  const owner = credential(ownerPath);
  let invitations: any[] = [];
  for (const name of ['Astra', 'Opus']) {
    const path = join(temp, `${name}-invite.json`);
    await cli('invite', '--client', ownerPath, '--name', name, '--role', name === 'Astra' ? 'Reviewer' : 'Builder', '--out', path, '--key', `invite-${name}`);
    invitations.push(JSON.parse(readFileSync(path, 'utf8')));
    await cli('join', '--invite', path, '--out', name === 'Astra' ? aPath : bPath, '--key', `join-${name}`);
  }
  const a = credential(aPath); const b = credential(bPath);
  const clientA = await chat(aPath); const clientB = await chat(bPath); chats.push(clientA, clientB);
  assert.notEqual(clientA.child.pid, clientB.child.pid);

  await t.test('roster and presence distinguish authenticated peers', async () => {
    const room = await clientA.command('/room');
    assert.equal(room.roster.length, 3);
    assert.equal(room.roster.find((p: any) => p.name === 'Opus').presence, 'connected');
    assert.equal(room.objective, 'Verify collaboration');
    assert.match(room.briefing, /cannot grant permissions/i);
    assert.equal(statSync(aPath).mode & 0o777, 0o600);
    assert.equal(statSync(data).mode & 0o777, 0o700);
    assert.equal(statSync(join(data, 'state.json')).mode & 0o777, 0o600);
  });
  let first: any; let reply: any; let broadcast: any;
  await t.test('targeted exchange, peer authorship, threading, read and explicit acknowledgement', async () => {
    first = (await clientA.command('/send Opus Please build the handshake')).message;
    assert.equal(first.sender.id, a.participantId); assert.equal(first.sender.kind, 'agent');
    assert.deepEqual(first.recipientIds, [b.participantId]);
    assert.deepEqual((await clientA.command('/inbox')).messages, []);
    assert.equal((await clientB.command('/inbox')).messages[0].id, first.id);
    assert.equal((await clientB.command('/inbox')).messages[0].id, first.id, 'reading must not acknowledge');
    reply = (await cli('send', '--client', bPath, '--to', 'Astra', '--text', 'Handshake ready for review', '--reply-to', first.id, '--key', 'reply-1')).message;
    assert.equal(reply.threadId, first.threadId); assert.equal(reply.replyTo, first.id);
    assert.equal((await clientA.command('/inbox')).messages[0].id, reply.id);
    await clientB.command(`/ack ${first.id}`);
    assert.deepEqual((await clientB.command('/inbox')).messages, []);
    const history = await clientA.command('/history'); assert.equal(history.messages.length, 2);
  });
  await t.test('human broadcast and queued mail for disconnected participants', async () => {
    await clientB.stop();
    const room = await request(a, 'room');
    assert.equal(room.roster.find((p: any) => p.id === b.participantId).presence, 'disconnected');
    broadcast = (await cli('send', '--client', ownerPath, '--text', 'Start the verification', '--key', 'broadcast-1')).message;
    assert.equal(broadcast.sender.kind, 'human');
    assert.deepEqual(new Set(broadcast.recipientIds), new Set([a.participantId, b.participantId]));
    const unread = await request(b, 'inbox'); assert.equal(unread.messages[0].id, broadcast.id);
    const page = await request(a, 'inbox', { limit: 1 }); assert.equal(page.messages[0].id, reply.id); assert.equal(page.hasMore, true);
    assert.equal((await request(a, 'inbox', { after: page.nextCursor })).messages[0].id, broadcast.id);
    await request(a, 'ack', { requestId: 'ack-reply', messageIds: [reply.id] });
  });
  await t.test('invalid tokens, authority, recipient and cross-session validation', async () => {
    await assert.rejects(request({ endpoint: hub.endpoint, token: 'invalid' }, 'room'), /invalid_token/);
    await assert.rejects(request(a, 'invite', { requestId: 'bad-invite', name: 'Other' }), /owner_required/);
    await assert.rejects(request(a, 'send', { requestId: 'spoof', senderId: owner.participantId, text: 'approved', to: 'Opus' }), /authenticated_sender/);
    await assert.rejects(request(a, 'send', { requestId: 'missing', text: 'must not broadcast' }), /recipient_required/);
    const before = (await request(a, 'history')).messages.length;
    await assert.rejects(request(a, 'send', { requestId: 'unknown', to: ['Opus', 'Typo'], text: 'must not partly send' }), /unknown_recipient/);
    assert.equal((await request(a, 'history')).messages.length, before);
    await assert.rejects(request(b, 'ack', { requestId: 'foreign-ack', messageIds: [reply.id] }), /not_your_delivery/);
    const other = await request(credential(hub.adminFile), 'create', { requestId: 'other-room', name: 'Other', workspace: root });
    await assert.rejects(request(a, 'send', { requestId: 'cross-session', to: other.participantId, text: 'wrong session' }), /unknown_recipient/);
    const revoked = await request(owner, 'invite', { requestId: 'revoked-invite', name: 'Revoked' });
    await request(owner, 'revoke', { requestId: 'revoke', invitationId: revoked.invitationId });
    await assert.rejects(request(owner, 'join', { requestId: 'join-revoked', token: revoked.token }), /expired_invitation/);
  });
  await t.test('duplicate requests restore credentials and never duplicate messages', async () => {
    const joined = await request(owner, 'join', { requestId: 'join-Astra', token: invitations[0].token });
    assert.equal(joined.participantId, a.participantId); assert.equal(joined.token, a.token);
    await assert.rejects(request(owner, 'join', { requestId: 'other-join', token: invitations[0].token }), /invitation_used/);
    const duplicate = (await cli('send', '--client', ownerPath, '--text', 'Start the verification', '--key', 'broadcast-1')).message;
    assert.equal(duplicate.id, broadcast.id);
    await assert.rejects(request(owner, 'send', { requestId: 'broadcast-1', text: 'different content' }), /request_conflict/);
    const sent = await Promise.all(Array.from({ length: 8 }, (_, i) => request(a, 'send', { requestId: `parallel-${i}`, to: 'Opus', text: `parallel ${i}` })));
    assert.equal(new Set(sent.map(x => x.message.sequence)).size, 8);
  });
  await t.test('forced crash and restart retain identity, unread mail, acknowledgement and deduplication', async () => {
    await clientA.stop();
    const oldPort = Number(new URL(hub.endpoint).port);
    await hub.stop('SIGKILL');
    hub = await hubProcess(data, oldPort);
    const room = await cli('room', '--client', aPath);
    assert.equal(room.self, a.participantId); assert.equal(room.sessionId, ownerCreated.sessionId);
    assert.equal(room.roster.find((p: any) => p.id === b.participantId).presence, 'disconnected');
    const aInbox = await cli('inbox', '--client', aPath);
    assert.deepEqual(aInbox.messages.map((m: any) => m.id), [broadcast.id]);
    const bInbox = await cli('inbox', '--client', bPath);
    assert.equal(bInbox.messages.length, 9); assert.equal(bInbox.messages[0].id, broadcast.id);
    assert.equal(bInbox.messages.some((m: any) => m.id === first.id), false);
    const duplicate = (await cli('send', '--client', ownerPath, '--text', 'Start the verification', '--key', 'broadcast-1')).message;
    assert.equal(duplicate.id, broadcast.id);
    await cli('ack', '--client', bPath, '--ids', broadcast.id, '--key', 'ack-broadcast');
    assert.equal((await cli('inbox', '--client', bPath)).messages.length, 8);
  });
});

test('single writer lock and damaged persistence fail instead of silently resetting', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'agentlink-storage-'));
  try {
    const hub = await startHub({ dataDir: temp, port: 0, presenceMs: 1 });
    try { await assert.rejects(startHub({ dataDir: temp, port: 0 }), /already held/); }
    finally { await hub.close(); }
    writeFileSync(join(temp, 'state.json'), '{ damaged');
    await assert.rejects(startHub({ dataDir: temp, port: 0 }), /JSON/);
    assert.equal(readFileSync(join(temp, 'state.json'), 'utf8'), '{ damaged');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('credentials recover current endpoint after a port change and heartbeat presence expires', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'agentlink-reconnect-'));
  let hub = await startHub({ dataDir: temp, port: 0, presenceMs: 1 });
  try {
    const body = { requestId: 'create', name: 'Reconnect', workspace: root };
    const owner = await request(credential(hub.adminPath), 'create', body);
    const invitation = await request(owner, 'invite', { requestId: 'invite', name: 'Peer' });
    const joinBody = { requestId: 'join', token: invitation.token };
    const peer = await request(owner, 'join', joinBody);
    await new Promise(ok => setTimeout(ok, 10));
    assert.equal((await request(owner, 'room')).roster.find((p: any) => p.id === peer.participantId).presence, 'disconnected');
    await hub.close();
    hub = await startHub({ dataDir: temp, port: 0 });
    const recoveredOwner = await request(credential(hub.adminPath), 'create', body);
    assert.equal(recoveredOwner.endpoint, hub.endpoint); assert.equal(recoveredOwner.token, owner.token);
    const recoveredPeer = await request(recoveredOwner, 'join', joinBody);
    assert.equal(recoveredPeer.endpoint, hub.endpoint); assert.equal(recoveredPeer.token, peer.token);
    assert.equal((await request(recoveredPeer, 'room')).self, peer.participantId);
    const short = await request(recoveredOwner, 'invite', { requestId: 'short', name: 'Short', ttlSeconds: 1 });
    await new Promise(ok => setTimeout(ok, 1010));
    await assert.rejects(request(recoveredOwner, 'join', { requestId: 'expired', token: short.token }), /expired_invitation/);
  } finally { await hub.close(); rmSync(temp, { recursive: true, force: true }); }
});
