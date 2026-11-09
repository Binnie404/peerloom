import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from '../core/client.ts';

// The pull-delivery commands through real processes: one hub, and the CLI exactly as an agent or the human runs it.
const root = resolve(import.meta.dirname, '..');

type Exit = { code: number; out: any; text: string; err: string };
function cliProcess(args: string[]) {
  const child = spawn(process.execPath, ['core/cli.ts', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = ''; let err = ''; child.stdout.on('data', chunk => { text += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  const done: Promise<Exit> = once(child, 'exit').then(([code]) => { let out: any; try { out = JSON.parse(text); } catch { out = undefined; } return { code: code as number, out, text, err }; });
  return { done, running: () => child.exitCode === null && child.signalCode === null, kill: () => child.kill('SIGKILL') };
}
const cli = (...args: string[]) => cliProcess(args).done;
const until = async (condition: () => Promise<boolean> | boolean, what: string) => { for (let waited = 0; waited < 8000; waited += 40) { if (await condition()) return; await new Promise(ok => setTimeout(ok, 40)); } assert.fail(`Timed out waiting for ${what}`); };

async function world(t: { after(fn: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'peerloom-delivery-cli-'));
  const child = spawn(process.execPath, ['core/server.ts', '--data', join(dir, 'hub'), '--port', '0'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) { const gone = once(child, 'exit'); child.kill('SIGKILL'); await gone; } };
  t.after(async () => { await stop(); rmSync(dir, { recursive: true, force: true }); });
  const ready = await new Promise<any>((ok, reject) => {
    let buffer = '';
    child.stdout.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { try { ok(JSON.parse(buffer.split('\n')[0])); } catch (error) { reject(error); } } });
    child.once('exit', () => reject(new Error(`Hub exited before startup: ${stderr}`)));
  });
  const file = (name: string) => join(dir, `${name}.json`);
  const ok = async (...args: string[]) => { const r = await cli(...args); assert.equal(r.code, 0, `${args.slice(0, 3).join(' ')} failed: ${r.text}${r.err}`); return r.out; };
  await ok('create', '--admin-file', ready.adminFile, '--name', 'Delivery', '--workspace', dir, '--out', file('owner'));
  for (const name of ['Astra', 'Bolt']) { await ok('invite', '--client', file('owner'), '--name', name, '--out', file(`${name}-invite`)); await ok('join', '--invite', file(`${name}-invite`), '--out', file(name)); }
  const auth = (name: string) => JSON.parse(readFileSync(file(name), 'utf8'));
  // An agent's view of the room, through the CLI only.
  const agent = (name: string) => ({
    file: file(name),
    run: (command: string, ...args: string[]) => cli(command, '--client', file(name), ...args),
    ok: (command: string, ...args: string[]) => ok(command, '--client', file(name), ...args),
    start: (command: string, ...args: string[]) => cliProcess([command, '--client', file(name), ...args]),
  });
  const armed = async (name: string) => (await request(auth('owner'), 'run')).bindings.find((b: any) => b.participantId === auth(name).participantId).armed;
  const shutdown = async () => { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; };
  return { dir, file, auth, stop, shutdown, owner: agent('owner'), astra: agent('Astra'), bolt: agent('Bolt'), armed };
}
// Astra opens an item with one revision and asks Bolt to review it.
async function proposal(w: Awaited<ReturnType<typeof world>>, text = 'Please review') {
  const item = await w.astra.ok('item-open', '--type', 'decision', '--title', 'Plan');
  const p = await w.astra.ok('publish', '--item', item.itemId, '--text', 'R1');
  const target = ['--artifact', p.artifactId, '--revision', '1', '--digest', p.digest];
  const asked = await w.astra.ok('request', '--item', item.itemId, '--purpose', 'review', '--to', 'Bolt', ...target, '--text', text);
  return { item, target, asked };
}

test('wait prints a pointer and nothing a peer wrote; fetch brings the text with its sender and confirms intake once', { timeout: 60_000 }, async t => {
  const w = await world(t); await w.owner.ok('run-start'); await w.bolt.ok('bind', '--label', 'bolt test');
  const { asked } = await proposal(w, 'MARKER-7f3a please review this');
  const waited = await w.bolt.run('wait', '--timeout', '5');
  assert.equal(waited.code, 0);
  assert.ok(!waited.text.includes('MARKER-7f3a') && !waited.err.includes('MARKER-7f3a'), 'no peer text in the wake output');
  assert.deepEqual(Object.keys(waited.out).sort(), ['more', 'status', 'units', 'wakeId']);
  assert.deepEqual(waited.out.units, [{ kind: 'slot', id: asked.collabRequestId }]);
  // Not confirmed yet: a second wait is told the wake is pending instead of being handed it again; only an explicit
  // recovery of that same attempt prints the pointer once more. The offer was charged once.
  const again = await w.bolt.run('wait', '--timeout', '5');
  assert.equal(again.code, 1); assert.equal(again.out.error, 'wake_pending'); assert.ok(again.out.message.includes(`fetch --wake ${waited.out.wakeId}`));
  assert.equal((await w.bolt.ok('wait', '--timeout', '5', '--recover', 'true')).wakeId, waited.out.wakeId);
  assert.equal((await w.owner.ok('run')).used.room, 1);
  const fetched = await w.bolt.ok('fetch', '--wake', waited.out.wakeId);
  assert.equal(fetched.units[0].view.text, 'MARKER-7f3a please review this');
  assert.deepEqual(fetched.units[0].sender, { id: w.auth('Astra').participantId, name: 'Astra', kind: 'agent', role: '' }, 'the sender shown is the authenticated requester');
  assert.equal(fetched.units[0].current, true);
  assert.equal((await w.bolt.ok('fetch', '--wake', waited.out.wakeId)).confirmedAt, fetched.confirmedAt, 'fetching twice confirms once');
  // Intake is confirmed; the review is still owed.
  assert.equal((await w.bolt.run('wait', '--timeout', '1')).code, 3);
  assert.equal((await w.bolt.ok('owed')).requests.length, 1);
});

test('graceful shutdown ends a held wait as closing, without spending a quiet allowance or an offer', { timeout: 30_000 }, async t => {
  const w = await world(t); await w.owner.ok('run-start'); await w.bolt.ok('bind', '--label', 'shutdown test');
  const waited = w.bolt.start('wait', '--timeout', '60'); t.after(() => waited.kill());
  await until(async () => await w.armed('Bolt') === 'waiting', 'the held wait');
  const statePath = join(w.dir, 'hub/state.json');
  const before = JSON.parse(readFileSync(statePath, 'utf8')).sessions[0].delivery;
  await w.shutdown();
  const ended = await waited.done;
  assert.equal(ended.code, 8, ended.text + ended.err); assert.deepEqual(ended.out, { status: 'closing' });
  assert.equal(ended.err, ''); assert.equal(existsSync(`${w.bolt.file}.wait.json`), false);
  const after = JSON.parse(readFileSync(statePath, 'utf8')).sessions[0].delivery;
  assert.deepEqual(after.empties, before.empties); assert.equal(after.offers.length, before.offers.length);
});

test('a new wait receiving hub_closing has the same closing result and does not retain a recovery record', { timeout: 30_000 }, async t => {
  const w = await world(t); await w.bolt.ok('bind', '--label', 'closing refusal test');
  const closing = await stub(t, { status: 503, body: { error: { code: 'hub_closing', message: 'The hub is shutting down' } } });
  const ended = await w.bolt.run('wait', '--timeout', '60', '--endpoint', closing.endpoint);
  assert.equal(ended.code, 8, ended.text + ended.err); assert.deepEqual(ended.out, { status: 'closing' });
  assert.equal(ended.err, ''); assert.equal(existsSync(`${w.bolt.file}.wait.json`), false);
});

test('two agents complete propose, review and accept, each told only by its own wait', { timeout: 90_000 }, async t => {
  const w = await world(t); await w.owner.ok('run-start');
  await w.astra.ok('bind', '--label', 'astra'); await w.bolt.ok('bind', '--label', 'bolt');
  // Both arm first. Nothing has happened, so both waits are held.
  const boltWait = w.bolt.start('wait', '--timeout', '60'); const astraWait = w.astra.start('wait', '--timeout', '60');
  await until(async () => await w.armed('Bolt') === 'waiting' && await w.armed('Astra') === 'waiting', 'both agents to be armed');
  const { target, asked } = await proposal(w);
  // Bolt's wait ends because a slot opened for Bolt. Astra's own request does not end Astra's wait.
  const woken = await boltWait.done;
  assert.equal(woken.code, 0); assert.deepEqual(woken.out.units.map((u: any) => u.kind), ['slot']);
  assert.ok(astraWait.running(), 'the requester is still waiting');
  await w.bolt.ok('fetch', '--wake', woken.out.wakeId);
  const response = await w.bolt.ok('respond', '--request', asked.collabRequestId, '--outcome', 'answered', '--verdict', 'approve', ...target, '--text', 'Approved');
  // Now Astra's wait ends, for the response.
  const told = await astraWait.done;
  assert.equal(told.code, 0); assert.deepEqual(told.out.units, [{ kind: 'response', id: response.responseId }]);
  const views = await w.astra.ok('fetch', '--wake', told.out.wakeId);
  assert.equal(views.units[0].view.response.verdict, 'approve');
  await w.astra.ok('accept', '--request', asked.collabRequestId, '--responses', response.responseId);
  // Nothing further is owed to either, and accepting woke nobody.
  assert.equal((await w.bolt.run('wait', '--timeout', '1')).code, 3); assert.equal((await w.astra.run('wait', '--timeout', '1')).code, 3);
  const run = await w.owner.ok('run');
  assert.equal(run.used.room, 2); assert.deepEqual(Object.values(run.used.agents), [1, 1]);
});

test('exit codes tell an agent whether it may wait again', { timeout: 90_000 }, async t => {
  const w = await world(t);
  const unbound = await w.bolt.run('wait', '--timeout', '1');
  assert.equal(unbound.code, 1); assert.equal(unbound.out.error, 'no_binding'); assert.match(unbound.out.message, /No binding saved/);
  await w.bolt.ok('bind', '--label', 'first');
  // Not started: held, then a timeout that says why.
  const idle = await w.bolt.run('wait', '--timeout', '1');
  assert.equal(idle.code, 3); assert.deepEqual(idle.out, { status: 'timeout', held: 'not_running' });
  await w.owner.ok('run-start', '--empty-waits', '3');
  assert.deepEqual((await w.bolt.run('wait', '--timeout', '1')).out, { status: 'timeout', held: 'none' });
  // Another session binds the same identity while a wait is held: the held wait ends with 4.
  const held = w.bolt.start('wait', '--timeout', '60');
  await until(async () => await w.armed('Bolt') === 'waiting', 'the wait to be held');
  const old = join(w.dir, 'old-binding.json'); copyFileSync(`${w.bolt.file}.binding.json`, old);
  await w.bolt.ok('bind', '--label', 'second');
  const superseded = await held.done;
  assert.equal(superseded.code, 4); assert.deepEqual(superseded.out, { status: 'superseded' });
  // The first session, still holding its old generation, is told the same thing on its next try.
  const mine = readFileSync(`${w.bolt.file}.binding.json`); copyFileSync(old, `${w.bolt.file}.binding.json`);
  const stale = await w.bolt.run('wait', '--timeout', '1');
  assert.equal(stale.code, 4); assert.deepEqual(stale.out, { status: 'stale_binding' });
  writeFileSync(`${w.bolt.file}.binding.json`, mine);
  // The allowance is 3 per run. Start wiped the count from before it; one empty return has been spent since, and the
  // superseded and stale ones cost nothing. Two more, then disarmed.
  assert.equal((await w.bolt.run('wait', '--timeout', '1')).code, 3);
  assert.equal((await w.bolt.run('wait', '--timeout', '1')).code, 3);
  const disarmed = await w.bolt.run('wait', '--timeout', '30');
  assert.equal(disarmed.code, 5); assert.deepEqual(disarmed.out, { status: 'disarmed' });
  await w.bolt.ok('bind', '--label', 'third');
  assert.equal((await w.bolt.run('wait', '--timeout', '30')).code, 5, 'binding again does not re-arm');
  assert.notEqual((await w.bolt.run('run-rearm', '--participant', 'Bolt')).code, 0, 'an agent cannot re-arm itself');
  await w.owner.ok('run-rearm', '--participant', 'Bolt');
  assert.equal((await w.bolt.run('wait', '--timeout', '1')).code, 3);
  // Nothing in any of that output tells the model to rebind or restart.
  for (const r of [idle, superseded, stale, disarmed]) assert.doesNotMatch(r.text + r.err, /rebind|bind again|run-start|restart|retry/i);
  // One credential holds one wait: a second while the first is held is refused here, before any call. From a copy of
  // the credential, which shares no lock, it is the hub that refuses, with exit 6, after one attempt.
  const first = w.bolt.start('wait', '--timeout', '60');
  await until(async () => await w.armed('Bolt') === 'waiting', 'the wait to be held');
  const second = await w.bolt.run('wait', '--timeout', '60');
  assert.equal(second.code, 1); assert.equal(second.out.error, 'wait_running');
  const copy = join(w.dir, 'bolt-copy.json'); copyFileSync(w.bolt.file, copy); copyFileSync(`${w.bolt.file}.binding.json`, `${copy}.binding.json`);
  const refusedCall = await cli('wait', '--client', copy, '--timeout', '60');
  assert.equal(refusedCall.code, 6); assert.equal(refusedCall.out.error, 'already_waiting');
  assert.equal(await w.armed('Bolt'), 'waiting', 'neither refused call disturbed the held one');
  // A wait that is killed leaves its lock and its record behind. Once the hub has let go of its hold, nothing was
  // offered to it, so the next wait simply runs. A lock that names no process is never taken over.
  first.kill(); await first.done; await until(async () => await w.armed('Bolt') !== 'waiting', 'the hub to release the killed wait');
  assert.match(readFileSync(`${w.bolt.file}.wait.lock`, 'utf8'), /^\d+$/);
  assert.equal((await w.bolt.run('wait', '--timeout', '1')).code, 3);
  for (const broken of ['', 'not-a-pid', '0']) {
    writeFileSync(`${w.bolt.file}.wait.lock`, broken); const closed = await w.bolt.run('wait', '--timeout', '1');
    assert.equal(closed.code, 1, JSON.stringify(broken)); assert.equal(closed.out.error, 'wait_running'); assert.equal(readFileSync(`${w.bolt.file}.wait.lock`, 'utf8'), broken);
  }
  rmSync(`${w.bolt.file}.wait.lock`);
  // Taking over a dead owner's lock is itself done by one wait at a time. Six waits started together against a lock
  // left by a process that is gone: none fails for any reason but the lock, at least one gets through, and the lock
  // and its guard are gone afterwards. A guard that names no provably dead process refuses, and is left alone.
  const dead = await new Promise<number>(ok => { const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }); child.on('exit', () => ok(child.pid!)); });
  writeFileSync(`${w.bolt.file}.wait.lock`, String(dead));
  const racing = await Promise.all(Array.from({ length: 6 }, () => w.bolt.run('wait', '--timeout', '1')));
  assert.ok(racing.some(r => r.code === 3), 'one wait took the lock over and ran'); assert.deepEqual(racing.filter(r => r.code !== 3).map(r => [r.code, r.out.error]).filter(([code, error]) => !(code === 1 && error === 'wait_running') && !(code === 6 && error === 'already_waiting')), []);
  assert.deepEqual([existsSync(`${w.bolt.file}.wait.lock`), existsSync(`${w.bolt.file}.wait.lock.reclaim`)], [false, false]);
  writeFileSync(`${w.bolt.file}.wait.lock`, String(dead)); writeFileSync(`${w.bolt.file}.wait.lock.reclaim`, '');
  const guarded = await w.bolt.run('wait', '--timeout', '1'); assert.equal(guarded.code, 1); assert.equal(guarded.out.error, 'wait_running'); assert.match(guarded.out.message, /takeover guard/);
  writeFileSync(`${w.bolt.file}.wait.lock.reclaim`, String(dead));
  const abandoned = await w.bolt.run('wait', '--timeout', '1'); assert.equal(abandoned.code, 1); assert.match(abandoned.out.message, /A wait died while taking over the lock/); assert.equal(readFileSync(`${w.bolt.file}.wait.lock`, 'utf8'), String(dead));
  rmSync(`${w.bolt.file}.wait.lock`); rmSync(`${w.bolt.file}.wait.lock.reclaim`);
  const noSuchWake = await w.bolt.run('fetch', '--wake', 'wk_missing');
  assert.equal(noSuchWake.code, 6); assert.equal(noSuchWake.out.error, 'unknown_wake');
  // The hub goes away: one attempt, exit 7, and the output says it was the transport and not a refusal.
  await w.stop();
  const began = Date.now(); const gone = await w.bolt.run('wait', '--timeout', '30');
  assert.equal(gone.code, 7); assert.deepEqual([gone.out.status, gone.out.error, gone.out.transport], ['error', 'hub_unreachable', 'refused']); assert.ok(Date.now() - began < 5000, 'no retry loop');
  assert.equal((await w.bolt.run('fetch', '--wake', 'wk_x')).code, 7);
});

test('the held wait does not go through fetch, whose own 300-second limit no caller deadline can lift', { timeout: 60_000 }, async t => {
  const w = await world(t); await w.owner.ok('run-start'); await w.bolt.ok('bind', '--label', 'no fetch');
  // With fetch removed from the process, the wait still works and an ordinary command does not: they use different transports.
  const preload = join(w.dir, 'no-fetch.mjs'); writeFileSync(preload, 'globalThis.fetch = () => { throw new Error("fetch was called"); };\n');
  const run = (...args: string[]) => new Promise<Exit>(ok => {
    const child = spawn(process.execPath, ['--import', preload, 'core/cli.ts', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; let err = ''; child.stdout.on('data', c => { text += c; }); child.stderr.on('data', c => { err += c; });
    child.on('exit', code => { let out: any; try { out = JSON.parse(text); } catch { out = undefined; } ok({ code: code as number, out, text, err }); });
  });
  const waited = await run('wait', '--client', w.bolt.file, '--timeout', '1');
  assert.equal(waited.code, 3, waited.text + waited.err); assert.deepEqual(waited.out, { status: 'timeout', held: 'none' });
  const ordinary = await run('room', '--client', w.bolt.file);
  assert.equal(ordinary.code, 7); assert.equal(ordinary.out.error, 'hub_unreachable'); assert.match(ordinary.out.message, /fetch was called/);
});

// A local endpoint that counts what it is sent and either never answers or always refuses.
async function stub(t: { after(fn: () => unknown): void }, answer?: { status: number; body: unknown }) {
  const hits: string[] = [];
  const server = createServer((req, res) => { hits.push(req.url ?? ''); req.resume(); if (answer) { res.writeHead(answer.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(answer.body)); } });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { endpoint: `http://127.0.0.1:${(server.address() as any).port}`, hits };
}

test('a default wait is held its full 55 seconds, while an ordinary command gives up at 10 and nothing is retried', { timeout: 120_000, skip: process.env.AGENTLINK_SLOW_TESTS ? false : 'holds a real wait for 55 seconds; run npm run test:all' }, async t => {
  const w = await world(t); await w.owner.ok('run-start'); await w.bolt.ok('bind', '--label', 'slow');
  const silent = await stub(t); const refusing = await stub(t, { status: 409, body: { error: { code: 'run_state', message: 'refused for the test' } } });
  // One credential file holds one wait, so the two waits sent elsewhere each get a copy of the credential and binding.
  const copyOf = (name: string) => { const path = join(w.dir, `bolt-${name}.json`); copyFileSync(w.bolt.file, path); copyFileSync(`${w.bolt.file}.binding.json`, `${path}.binding.json`); return path; };
  const began = Date.now();
  const [waited, ordinary, refusedWait, silentWait] = await Promise.all([
    w.bolt.run('wait').then(r => ({ ...r, ms: Date.now() - began })),                                  // no --timeout: the 55-second default
    w.bolt.run('room', '--endpoint', silent.endpoint).then(r => ({ ...r, ms: Date.now() - began })),    // an ordinary read against an endpoint that never answers
    cli('wait', '--client', copyOf('refused'), '--timeout', '30', '--endpoint', refusing.endpoint),
    cli('wait', '--client', copyOf('silent'), '--timeout', '2', '--endpoint', silent.endpoint).then(r => ({ ...r, ms: Date.now() - began })),
  ]);
  assert.equal(waited.code, 3, waited.text + waited.err); assert.deepEqual(waited.out, { status: 'timeout', held: 'none' });
  assert.ok(waited.ms >= 55_000 && waited.ms < 64_000, `held ${waited.ms} ms`);
  assert.equal(ordinary.code, 7); assert.equal(ordinary.out.transport, 'timeout');
  assert.ok(ordinary.ms >= 9_500 && ordinary.ms < 14_000, `an ordinary command gave up after ${ordinary.ms} ms`);
  // A refused wait: exit 6, exactly one request sent.
  assert.equal(refusedWait.code, 6); assert.equal(refusedWait.out.error, 'run_state');
  assert.deepEqual(refusing.hits, ['/v1/wait']);
  // A wait the endpoint never answers is abandoned at its own deadline (timeout plus ten seconds), also without a second try.
  assert.equal(silentWait.code, 7); assert.equal(silentWait.out.transport, 'timeout'); assert.ok(silentWait.ms >= 11_500 && silentWait.ms < 17_000, `abandoned after ${silentWait.ms} ms`);
  assert.deepEqual(silent.hits.sort(), ['/v1/room', '/v1/wait']);
});

test('the run belongs to the human; the board says who is armed without guessing', { timeout: 60_000 }, async t => {
  const w = await world(t);
  for (const command of ['run-start', 'run-pause', 'run-resume', 'run-end']) { const r = await w.bolt.run(command); assert.equal(r.code, 6, command); assert.equal(r.out.error, 'owner_required'); }
  assert.equal((await w.bolt.run('run-limits', '--room', '500')).out.error, 'owner_required');
  assert.equal((await w.bolt.ok('run')).state, 'idle', 'anyone may read the run');
  const started = await w.owner.ok('run-start', '--room', '7', '--agent', '3');
  assert.deepEqual(started.limits, { room: 7, agent: 3, emptyWaits: 30 });
  await w.bolt.ok('bind', '--label', 'bolt desk');
  const held = w.bolt.start('wait', '--timeout', '60'); t.after(() => held.kill());
  await until(async () => await w.armed('Bolt') === 'waiting', 'the wait to be held');
  const board = (await cli('board', '--client', w.file('owner'))).text;
  assert.match(board, /Run 1: running\. Offers used 0 of 7\./);
  assert.match(board, /Bolt: Waiting armed — bolt desk; offers 0 of 3; empty returns 0 of 30/);
  assert.match(board, /Astra: Binding unknown; offers 0 of 3/);
  // Pausing ends nothing that is held; it stops new offers. The proposal below reaches nobody until resume.
  await w.owner.ok('run-pause');
  await proposal(w);
  await new Promise(ok => setTimeout(ok, 400));
  assert.ok(held.running(), 'a paused room hands out nothing');
  await w.owner.ok('run-resume');
  assert.equal((await held.done).code, 0);
  assert.match((await cli('board', '--client', w.file('owner'))).text, /Bolt: Not armed — bolt desk; offers 1 of 3/);
  assert.equal((await w.owner.ok('run-end')).state, 'ended');
});

test('the delivery commands refuse flags they do not use', { timeout: 30_000 }, async t => {
  const w = await world(t);
  const stray: [string, string[]][] = [['bind', ['--label', 'x', '--native-session', 'abc']], ['wait', ['--after', '5']], ['fetch', ['--wake', 'wk_x', '--confirm', 'no']], ['run', ['--verbose', 'yes']], ['run-start', ['--budget', '9']], ['run-rearm', ['--participant', 'Bolt', '--all', 'yes']]];
  for (const [command, args] of stray) {
    const r = await cli(command, '--client', w.file('owner'), ...args);
    assert.equal(r.code, 1, command); assert.match(r.out.message, new RegExp(`${command} does not take --${args.at(-2)!.slice(2)}`));
  }
  assert.equal((await request(w.auth('owner'), 'run')).state, 'idle', 'nothing reached the hub');
});

test('reply answers the wake\'s message and acknowledges it in one call, once', { timeout: 60_000 }, async t => {
  const w = await world(t); await w.owner.ok('run-start'); await w.bolt.ok('bind', '--label', 'bolt replies');
  const asked = (await w.owner.ok('send', '--to', 'Bolt', '--text', 'Which port?')).message;
  const wake = (await w.bolt.ok('wait', '--timeout', '5')).wakeId;
  const answer = join(w.dir, 'answer.txt'); writeFileSync(answer, 'Port 4317, as the "README" says.\n');
  // Not before it has been read.
  const early = await w.bolt.run('reply', '--wake', wake, '--text-file', answer);
  assert.equal(early.code, 1); assert.equal(early.out.error, 'not_fetched');
  await w.bolt.ok('fetch', '--wake', wake);
  const replied = await w.bolt.ok('reply', '--wake', wake, '--text-file', answer);
  assert.deepEqual([replied.status, replied.to, replied.replyTo, replied.acknowledged], ['replied', [w.auth('owner').participantId], asked.id, [asked.id]]);
  const history = (await w.owner.ok('history')).messages;
  assert.deepEqual(history.map((m: any) => [m.sender.name, m.text, m.replyTo ?? null, m.threadId]), [['human', 'Which port?', null, asked.id], ['Bolt', 'Port 4317, as the "README" says.', asked.id, asked.id]]);
  assert.deepEqual((await w.bolt.ok('inbox')).messages, [], 'the answered message is acknowledged');
  // The same call again, as after a lost answer, sends nothing new; different text is a new message.
  assert.equal((await w.bolt.ok('reply', '--wake', wake, '--text-file', answer)).messageId, replied.messageId);
  assert.equal((await w.owner.ok('history')).messages.length, 2);
  assert.notEqual((await w.bolt.ok('reply', '--wake', wake, '--text', 'And 4318 for the second hub.')).messageId, replied.messageId);
  assert.equal((await w.bolt.run('wait', '--timeout', '1')).code, 3, 'nothing is owed after the reply');
});

test('reply names its recipient only when the wake does not, and leaves requests to respond', { timeout: 60_000 }, async t => {
  const w = await world(t); await w.owner.ok('run-start'); await w.bolt.ok('bind', '--label', 'bolt replies');
  // A wake that holds only a request has no message to answer.
  await proposal(w);
  const review = (await w.bolt.ok('wait', '--timeout', '5')).wakeId; await w.bolt.ok('fetch', '--wake', review);
  const none = await w.bolt.run('reply', '--wake', review, '--text', 'Looks fine');
  assert.equal(none.code, 1); assert.equal(none.out.error, 'no_message');
  assert.equal((await w.bolt.ok('owed')).requests.length, 1, 'the review is still owed');
  // One wake with mail from the human and from Astra: the recipient must be said, and the reply threads under that sender's message.
  const fromHuman = (await w.owner.ok('send', '--to', 'Bolt', '--text', 'Status?')).message; const fromAstra = (await w.astra.ok('send', '--to', 'Bolt', '--text', 'Can you take the tests?')).message;
  const wake = (await w.bolt.ok('wait', '--timeout', '5')).wakeId; await w.bolt.ok('fetch', '--wake', wake);
  const unsaid = await w.bolt.run('reply', '--wake', wake, '--text', 'Yes');
  assert.equal(unsaid.code, 1); assert.equal(unsaid.out.error, 'recipient_required'); assert.match(unsaid.out.message, /human and Astra/);
  const elsewhere = await w.bolt.run('reply', '--wake', wake, '--to', 'Astra,Bolt', '--text', 'Yes');
  assert.equal(elsewhere.code, 1); assert.equal(elsewhere.out.error, 'not_in_wake');
  const unread = async () => (await w.bolt.ok('inbox')).messages.filter((m: any) => !m.messageKind).map((m: any) => m.id);
  const toAstra = await w.bolt.ok('reply', '--wake', wake, '--to', 'astra', '--text', 'Yes, I take the tests.');
  assert.deepEqual([toAstra.to, toAstra.replyTo, toAstra.acknowledged], [[w.auth('Astra').participantId], fromAstra.id, [fromAstra.id]]);
  assert.deepEqual(await unread(), [fromHuman.id], 'the message the reply did not answer is still owed');
  // A second answer from the same wake, to the other sender, is its own message with its own acknowledgement.
  const toHuman = await w.bolt.ok('reply', '--wake', wake, '--to', 'human', '--text', 'Reviewing; tests next.');
  assert.deepEqual([toHuman.replyTo, toHuman.acknowledged], [fromHuman.id, [fromHuman.id]]); assert.deepEqual(await unread(), []);
  // Someone else's wake is unknown, as it is to fetch.
  await w.astra.ok('bind', '--label', 'astra');
  const foreign = await w.astra.run('reply', '--wake', wake, '--text', 'x');
  assert.equal(foreign.code, 6); assert.equal(foreign.out.error, 'unknown_wake'); assert.equal((await w.owner.ok('history')).messages.filter((m: any) => !m.messageKind).length, 4);
});

test('reply is refused when the thread has moved on, and shows what arrived', { timeout: 60_000 }, async t => {
  const w = await world(t); await w.owner.ok('run-start'); await w.bolt.ok('bind', '--label', 'bolt replies');
  const first = (await w.owner.ok('send', '--to', 'Bolt', '--text', 'Use port 4317.')).message;
  const wake = (await w.bolt.ok('wait', '--timeout', '5')).wakeId; await w.bolt.ok('fetch', '--wake', wake);
  // While Bolt writes its answer the human corrects himself in the same thread.
  const second = (await w.owner.ok('send', '--to', 'Bolt', '--reply-to', first.id, '--text', 'Sorry: 4318.')).message;
  const crossed = await w.bolt.run('reply', '--wake', wake, '--text', 'Done, on 4317.');
  assert.equal(crossed.code, 6); assert.equal(crossed.out.error, 'thread_moved');
  assert.deepEqual(crossed.out.detail.messages.map((m: any) => [m.id, m.text]), [[second.id, 'Sorry: 4318.']]);
  assert.equal((await w.owner.ok('history')).messages.length, 2, 'the crossed reply was not sent');
  assert.equal((await w.bolt.ok('inbox')).messages.length, 2, 'and nothing was acknowledged');
  // Having read the correction in that refusal, Bolt may answer the first message all the same by saying how far it has read.
  const informed = await w.bolt.ok('reply', '--wake', wake, '--seen', String(second.sequence), '--text', 'Seen the correction; 4317 is already closed.');
  assert.deepEqual([informed.replyTo, informed.acknowledged], [first.id, [first.id]]);
  // The correction arrives as its own wake; answering that one goes through.
  const next = (await w.bolt.ok('wait', '--timeout', '5')).wakeId; await w.bolt.ok('fetch', '--wake', next);
  const replied = await w.bolt.ok('reply', '--wake', next, '--text', 'Done, on 4318.');
  assert.deepEqual([replied.replyTo, replied.acknowledged], [second.id, [second.id]]);
  // A plain send may ask for the same check, and is not checked unless it does.
  const guarded = await w.astra.run('send', '--to', 'human', '--reply-to', first.id, '--seen', 'x', '--text', 'hm');
  assert.equal(guarded.code, 1); assert.match(guarded.out.message, /--seen must be a whole number/);
});

test('an offer prepared for a wait that died is given only to that attempt, and only when recovery is asked for', { timeout: 60_000 }, async t => {
  const w = await world(t); await w.owner.ok('run-start'); await w.bolt.ok('bind', '--label', 'bolt recovers');
  const record = `${w.bolt.file}.wait.json`; const generation = JSON.parse(readFileSync(`${w.bolt.file}.binding.json`, 'utf8')).generation;
  assert.equal((await w.bolt.run('wait', '--recover', 'true')).out.error, 'nothing_to_recover'); assert.match((await w.bolt.run('wait', '--recover', 'yes')).out.message, /--recover takes exactly: true/);
  // The state a wait leaves when the hub prepared its offer and the answer never arrived: its record, and no pointer.
  await w.owner.ok('send', '--to', 'Bolt', '--text', 'Are you there?');
  writeFileSync(record, JSON.stringify({ generation, attemptId: 'attempt-lost' }));
  const lost = await request(w.auth('Bolt'), 'wait', { generation, timeoutSeconds: 1, attemptId: 'attempt-lost' });
  assert.equal(lost.status, 'offer');
  // A fresh wait does not take that offer over, and says what to run; nothing is charged twice.
  const fresh = await w.bolt.run('wait', '--timeout', '1');
  assert.equal(fresh.code, 1); assert.equal(fresh.out.error, 'wait_unfinished'); assert.match(fresh.out.message, /wait --recover true/);
  const recovered = await w.bolt.ok('wait', '--timeout', '1', '--recover', 'true');
  // The human's message spends nothing (item 19); recovering it charges nothing either.
  assert.equal(recovered.wakeId, lost.wakeId); assert.equal((await w.owner.ok('run')).used.room, 0);
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), { generation, attemptId: 'attempt-lost', wakeId: lost.wakeId });
  // Fetching finishes the attempt: the record goes, and the next wait is a new one with a new identity.
  await w.bolt.ok('fetch', '--wake', lost.wakeId); assert.equal((await w.bolt.run('wait', '--timeout', '1')).code, 3);
  assert.equal((await w.bolt.run('wait', '--timeout', '1', '--recover', 'true')).out.error, 'nothing_to_recover');
  // While the hub still holds a wait whose process is gone, a fresh wait leaves the saved attempt alone and asks for
  // recovery; and a recovery that is told another wait is held keeps its key, because that hold can still be offered work.
  writeFileSync(record, JSON.stringify({ generation, attemptId: 'attempt-orphan' }));
  const orphan = request(w.auth('Bolt'), 'wait', { generation, timeoutSeconds: 20, attemptId: 'attempt-held-elsewhere' }, 30_000);
  await until(async () => await w.armed('Bolt') === 'waiting', 'the orphaned hold');
  const blocked = await w.bolt.run('wait', '--timeout', '1');
  assert.equal(blocked.code, 1); assert.equal(blocked.out.error, 'wait_unfinished'); assert.equal(JSON.parse(readFileSync(record, 'utf8')).attemptId, 'attempt-orphan');
  const refusedRecovery = await w.bolt.run('wait', '--timeout', '1', '--recover', 'true');
  assert.equal(refusedRecovery.code, 6); assert.equal(refusedRecovery.out.error, 'already_waiting'); assert.equal(JSON.parse(readFileSync(record, 'utf8')).attemptId, 'attempt-orphan');
  await w.owner.ok('send', '--to', 'Bolt', '--text', 'For the held wait'); await w.bolt.ok('fetch', '--wake', (await orphan).wakeId); rmSync(record, { force: true });
  // A record whose offer the hub has since closed is not an obstacle either: a new bind closes it, and the old record is replaced.
  await w.owner.ok('send', '--to', 'Bolt', '--text', 'And now?');
  const offered = await w.bolt.ok('wait', '--timeout', '5'); await w.bolt.ok('bind', '--label', 'bolt again');
  const after = await w.bolt.ok('wait', '--timeout', '5'); assert.notEqual(after.wakeId, offered.wakeId);
});
