// The fake external harness through a real hub and the real CLI: bind, arm, wake, fetch, reply. This is the external
// route without a console and without a native CLI; the console's own conformance test uses the same helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const cli = (...args: string[]) => new Promise<{ code: number | null; out: any; text: string; err: string }>(ok => {
  const child = spawn(process.execPath, ['core/cli.ts', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = ''; let err = ''; child.stdout.on('data', c => { text += c; }); child.stderr.on('data', c => { err += c; });
  child.once('exit', code => { let out: any; try { out = JSON.parse(text); } catch { out = undefined; } ok({ code, out, text, err }); });
});
const ok = async (...args: string[]) => { const r = await cli(...args); assert.equal(r.code, 0, `${args.slice(0, 3).join(' ')} failed: ${r.text}${r.err}`); return r.out; };
const until = async (condition: () => Promise<boolean>, what: string, ms = 15_000) => {
  for (let waited = 0; waited < ms; waited += 50) { if (await condition()) return; await new Promise(ok => setTimeout(ok, 50)); }
  assert.fail(`Timed out waiting for ${what}`);
};

test('the fake external harness binds, receives a broadcast, fetches and replies', { timeout: 60_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'peerloom-fake-harness-'));
  const hub = spawn(process.execPath, ['core/server.ts', '--data', join(dir, 'hub'), '--port', '0'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; hub.stderr.on('data', c => { stderr += c; });
  t.after(async () => { if (hub.exitCode === null && hub.signalCode === null) { const gone = once(hub, 'exit'); hub.kill('SIGKILL'); await gone; } rmSync(dir, { recursive: true, force: true }); });
  const ready = await new Promise<any>((ok, reject) => {
    let buffer = ''; hub.stdout.on('data', c => { buffer += c; if (buffer.includes('\n')) { try { ok(JSON.parse(buffer.split('\n')[0])); } catch (error) { reject(error); } } });
    hub.once('exit', () => reject(new Error(`hub exited before startup: ${stderr}`)));
  });

  const file = (name: string) => join(dir, `${name}.json`);
  await ok('create', '--admin-file', ready.adminFile, '--name', 'Fake harness room', '--workspace', dir, '--out', file('owner'));
  await ok('invite', '--client', file('owner'), '--name', 'DeepSeek', '--role', 'Builder', '--harness', 'dsh', '--out', file('invite'));
  await ok('join', '--invite', file('invite'), '--out', file('deepseek'));
  const participantId = JSON.parse(readFileSync(file('deepseek'), 'utf8')).participantId;
  await ok('run-start', '--client', file('owner'));

  const logPath = join(dir, 'fake.jsonl');
  const fake = spawn(process.execPath, ['test/helpers/fake-harness.ts'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAKE_HARNESS_CLIENT: file('deepseek'), FAKE_HARNESS_LOG: logPath, FAKE_HARNESS_WAITS: '1', FAKE_HARNESS_TIMEOUT: '15', FAKE_HARNESS_REPLY: 'The fake harness is here: MARKER-DSH-1' },
  });
  let fakeErr = ''; fake.stderr.on('data', c => { fakeErr += c; });

  const armed = async () => {
    const run = await ok('run', '--client', file('owner'));
    return (run.bindings ?? []).some((binding: any) => binding.participantId === participantId && binding.armed === 'waiting');
  };
  await until(armed, 'the fake harness to arm its wait');
  await ok('send', '--client', file('owner'), '--text', 'MARKER-HELLO-1: please answer');

  const [code] = await once(fake, 'exit');
  assert.equal(code, 0, `the fake harness exited ${code}: ${fakeErr}`);
  const steps = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(steps.map((step: any) => step.step).filter((step: string) => step !== 'start' && step !== 'done'), ['bind', 'wait', 'fetch', 'reply']);
  assert.equal(steps.find((step: any) => step.step === 'bind').code, 0);
  assert.equal(steps.find((step: any) => step.step === 'reply').code, 0);
  const history = await ok('history', '--client', file('owner'), '--limit', '20');
  const reply = (history.messages ?? []).find((message: any) => message.text === 'The fake harness is here: MARKER-DSH-1');
  assert.ok(reply, 'the reply reached the room');
  assert.equal(reply.sender.name, 'DeepSeek');
  assert.equal(reply.sender.kind, 'agent');
});
