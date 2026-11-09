import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request, saveCredential } from '../core/client.ts';
import { NativeAdapter } from '../core/codex-adapter.ts';
import { NativeFixture } from './helpers/codex-native-fixture.ts';

const root = resolve(import.meta.dirname, '..'); const execute = promisify(execFile);
const until = async (fn: () => any, label: string, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise(done => setTimeout(done, 10)); } assert.fail(`Timed out: ${label}`); };
async function world(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'agentlink-reconnect-'));
  let child: ReturnType<typeof spawn>; let endpoint = ''; let serial = 0;
  async function launch() {
    const port = endpoint ? new URL(endpoint).port : '0';
    child = spawn(process.execPath, ['core/server.ts', '--data', join(dir, 'hub'), '--port', port], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; child.stderr!.on('data', b => { err += b; });
    await new Promise<void>((done, reject) => { child.stdout!.on('data', b => { out += b; if (out.includes('\n')) { endpoint = JSON.parse(out.split('\n')[0]).endpoint; done(); } }); child.once('exit', () => reject(new Error(`Hub startup failed: ${err}`))); child.once('error', reject); });
  }
  async function kill() { if (child.exitCode !== null || child.signalCode !== null) return; const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; }
  await launch();
  const admin = JSON.parse(readFileSync(join(dir, 'hub/admin.json'), 'utf8'));
  const owner = await request(admin, 'create', { requestId: 'create', name: 'Reconnect', workspace: dir });
  const invite = await request(owner, 'invite', { requestId: 'invite', name: 'Codex' });
  const agent = await request(invite, 'join', { requestId: 'join', token: invite.token });
  const path = join(dir, 'agent.json'); saveCredential(path, agent);
  const mutate = (op: string, body: any = {}) => request(owner, op, { requestId: `reconnect-${++serial}`, ...body }, 5000);
  await mutate('run_start', { limits: { room: 4, agent: 4 } });
  const events: any[] = []; const peer = new NativeFixture();
  peer.onWake = async params => {
    const wake = /wake ID (\S+);/.exec(params.toolOutput.output)![1];
    await execute(process.execPath, ['core/cli.ts', 'fetch', '--client', path, '--wake', wake], { cwd: root });
    await execute(process.execPath, ['core/cli.ts', 'reply', '--client', path, '--wake', wake, '--text', 'Recovered'], { cwd: root });
  };
  const adapter = new NativeAdapter({ clientPath: path, participant: 'Codex', room: 'Reconnect', cwd: dir, cliPath: join(root, 'core/cli.ts'), waitSeconds: 30, controlIntervalMs: 100, onEvent: e => events.push(e) });
  t.after(async () => { await adapter.halt('Test cleanup', true); await kill(); rmSync(dir, { recursive: true, force: true }); });
  await adapter.start({ probe: async () => ({ version: 'fixture', digest: 'fixture', toolOutput: true }), native: () => peer });
  await until(async () => (await request(owner, 'run', {}, 5000)).bindings[0].armed === 'waiting', 'held wait');
  return { kill, restart: launch, owner, agent, path, events, peer, adapter, mutate, run: () => request(owner, 'run', {}, 5000) };
}

test('a killed hub recovers the same binding and native session, then dispatches one new offer', async t => {
  const w = await world(t); await w.kill();
  await until(() => w.events.some(e => e.event === 'hub_reconnecting'), 'bounded reconnect notice');
  await w.restart(); await w.mutate('send', { to: 'Codex', text: 'Work after restart' });
  await until(async () => (await request(w.owner, 'inbox', {}, 5000)).messages.some((m: any) => m.text === 'Recovered'), 'recovered answer');
  assert.equal((await w.run()).bindings[0].generation, 1);
  assert.equal((await w.run()).used.room, 0, 'a recovered human message is free against the peer budget');
  assert.equal((await w.run()).caps.offers.used, 1, 'the actual offer was persisted once');
  assert.equal(w.peer.calls.filter(c => c.method === 'thread/start').length, 1);
  assert.equal(w.peer.calls.filter(c => c.method === 'turn/start').length, 2);
});

test('Pause/Resume during hub recovery fences the old wait and starts no wake turn', async t => {
  const w = await world(t); await w.kill();
  await until(() => w.events.some(e => e.event === 'hub_reconnecting'), 'recovery notice');
  await w.restart(); await w.mutate('run_pause'); await w.mutate('run_resume');
  await w.mutate('send', { to: 'Codex', text: 'Must remain owed' });
  const result = await w.adapter.finished;
  assert.match(result.reason, /controls changed/);
  assert.equal(w.peer.calls.filter(c => c.method === 'turn/start').length, 1);
  assert.equal((await w.run()).used.room, 0);
});

test('an unavailable hub exhausts bounded recovery without rebind or model inference', async t => {
  const w = await world(t); await w.kill();
  const result = await w.adapter.finished;
  assert.match(result.reason, /hub|wait/i);
  assert.ok(w.events.some(e => e.event === 'hub_reconnecting' && e.attempt === 3));
  assert.ok(w.events.filter(e => e.event === 'hub_reconnecting').every(e => e.attempt <= 3));
  assert.equal(w.peer.calls.filter(c => c.method === 'turn/start').length, 1);
  assert.equal(w.events.filter(e => e.event === 'bound').length, 1);
});
