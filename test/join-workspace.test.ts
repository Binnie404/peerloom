import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliPath, console_, joinSkip, page, raw, repoRoot, until } from './helpers/join-testkit.ts';

// Codex's first integration finding (item 24): the page may put the room in one folder while the agent runs in another.
// The console derives its data directory from its own cwd, and the join client searches its own cwd ancestors, so today
// the approved flow can fail or find an unrelated ancestor `.agentlink`. The desired shape: the selected workspace is
// the agent's profile root, published by the backend, and the client keeps its claim state in its own writable
// workspace; an unrelated ancestor store is never used.
const binPath = join(repoRoot, 'bin', 'peerloom.mjs');
function spawnCaptured(args: string[], cwd: string) {
  const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = ''; child.stdout.on('data', d => { text += d; }); child.stderr.on('data', d => { text += d; });
  const exited = new Promise<number | null>(ok => child.once('exit', code => ok(code)));
  return { child, get text() { return text; }, exited };
}
const pairingCode = (text: string) => /([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(text)?.[1];

test('a room in a selected workspace lets an agent join, bind, listen and answer from its own separate folder', { skip: joinSkip, timeout: 120_000 }, async t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agentlink-workspace-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const consoleDir = join(base, 'console-folder'); const agentDir = join(base, 'project', 'agent-workspace');
  mkdirSync(consoleDir, { recursive: true }); mkdirSync(agentDir, { recursive: true });
  // An unrelated store in an ancestor must never be treated as this agent's room.
  mkdirSync(join(base, '.agentlink', 'agents'), { recursive: true, mode: 0o700 });
  const decoy = join(base, '.agentlink', 'agents', 'index.json');
  writeFileSync(decoy, JSON.stringify({ 'decy-1234': { name: 'Decoy', roomId: 's_otherroom', harness: 'dsh' } }), { mode: 0o600 });
  // Make the decoy store itself private so a client that does resolve it gets past the mode check.
  chmodSync(join(base, '.agentlink'), 0o700);
  const decoyBefore = readFileSync(decoy, 'utf8');

  const c = console_(t, { dir: consoleDir }); const p = await page(c); t.after(p.close);
  assert.equal((await p.call('POST', '/api/room', { name: 'Workspace room', workspace: agentDir })).status, 200);
  assert.equal((await p.call('POST', '/api/run', { op: 'start' })).status, 200);
  const made = (await p.call('POST', '/api/join-line', { harness: 'dsh' })).json;
  const url = /peerloom join (\S+) --harness/.exec(made.line)![1];
  // The agent session runs in the selected workspace, not the console's folder.
  const joinRun = spawnCaptured([binPath, 'join', url, '--harness', 'dsh'], agentDir);
  let code: string;
  try { code = await until(() => pairingCode(joinRun.text), 'the pairing code', 20_000); }
  catch { throw new Error(`the join printed no pairing code from the selected workspace:\n${joinRun.text}`); }
  const row = ((await p.state()).joins as any[]).find((j: any) => j.pairingCode === code);
  assert.ok(row, 'the claim is on the page');
  assert.equal((await p.call('POST', '/api/join-approve', { claimId: row.claimId })).status, 200);
  assert.equal(await joinRun.exited, 0, `the approved join must finish from the selected workspace:\n${joinRun.text}`);
  const agentId = /--as ([a-z]{2,6}-[a-z0-9]{4})/.exec(joinRun.text)?.[1];
  assert.ok(agentId, `the opening names the identity:\n${joinRun.text}`);
  // The profile is in the agent's own selected workspace, and the unrelated ancestor store is untouched.
  const credential = join(agentDir, '.agentlink', 'agents', agentId!, 'credential.json');
  assert.ok(existsSync(credential), `the profile is under the selected workspace: ${credential}`);
  assert.equal(readFileSync(decoy, 'utf8'), decoyBefore, 'an unrelated ancestor profile store is never used');
  assert.equal(existsSync(join(base, '.agentlink', 'agents', 'claims')), false, 'no claim state in the unrelated ancestor');
  // Its own short commands work from its own folder, and listening is the credential's wait.
  const agentCli = (args: string[]) => spawnCaptured([cliPath, ...args], agentDir);
  const binding = agentCli(['bind', '--as', agentId!, '--label', 'Separate workspace session']); const bound = await binding.exited;
  assert.equal(bound, 0, `bind succeeds from the selected workspace:\n${binding.text}`);
  // Listening, it gets the console's one welcome (the Verified round trip), answers it from its own folder, and is verified.
  const wakeOf = async (what: string) => { const wait = agentCli(['wait', '--as', agentId!, '--timeout', '60']); t.after(() => wait.child.kill('SIGKILL'));
    return until(() => /"wakeId":"([^"]+)"/.exec(wait.text)?.[1] ?? null, what, 40_000); };
  const answer = async (wake: string, text: string) => {
    const fetching = agentCli(['fetch', '--as', agentId!, '--wake', wake]); assert.equal(await fetching.exited, 0, 'fetch from the selected workspace');
    assert.equal(await agentCli(['reply', '--as', agentId!, '--wake', wake, '--text', text]).exited, 0, 'reply from the selected workspace'); return fetching.text; };
  assert.match(await answer(await wakeOf('the welcome'), 'ws-ok'), /Welcome to Workspace room/);
  const agentName = await until(async () => { const s = await p.state(); return s.messages.some((m: any) => m.text === 'ws-ok') && s.agents.find((a: any) => a.kind === 'dsh')?.name; }, 'the answer to the welcome', 30_000);
  // A human message then reaches it and it answers with a short command from the selected workspace.
  const next = wakeOf('the wake for the human message');
  await until(async () => (await p.state()).agents.find((a: any) => a.name === agentName)?.state === 'verified', 'verified while listening', 30_000);
  assert.equal((await p.call('POST', '/api/send', { text: 'Workspace gate: reply with exactly: ws-ok-2', to: agentName })).status, 200);
  await answer(await next, 'ws-ok-2');
  await until(async () => (await p.state()).messages.some((m: any) => m.text === 'ws-ok-2'), 'the second answer in the room', 30_000);
  c.input.write('/quit\n'); await c.done;
});

test('the approved claim answer names the room workspace so the client never searches its own ancestors', { skip: joinSkip, timeout: 90_000 }, async t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'peerloom-claim-workspace-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const consoleDir = join(base, 'console-folder'); const roomWorkspace = join(base, 'project', 'room-workspace');
  mkdirSync(consoleDir, { recursive: true }); mkdirSync(roomWorkspace, { recursive: true });
  const c = console_(t, { dir: consoleDir }); const p = await page(c); t.after(p.close);
  assert.equal((await p.call('POST', '/api/room', { name: 'Workspace answer room', workspace: roomWorkspace })).status, 200);
  const made = (await p.call('POST', '/api/join-line', { harness: 'dsh' })).json;
  const url = new URL(/peerloom join (\S+) --harness/.exec(made.line)![1]);
  const secret = 'claim-secret-' + 'w'.repeat(24);
  const claimed = await raw(p.port, p.host, 'POST', `${url.pathname}/claim`, { secret, harness: 'dsh', label: 'Claim answer session' });
  assert.equal(claimed.status, 200, claimed.text);
  assert.equal((await p.call('POST', '/api/join-approve', { claimId: claimed.json.claimId })).status, 200);
  // The answer the client polls names the workspace it must read and write, not the console's folder.
  const polled = await raw(p.port, p.host, 'POST', `${url.pathname}/poll`, { secret });
  assert.equal(polled.status, 200, polled.text);
  assert.equal(polled.json.state, 'approved');
  assert.equal(polled.json.workspace, roomWorkspace, 'the approved answer carries the room workspace');
  const agentId = polled.json.agentId as string;
  assert.ok(existsSync(join(roomWorkspace, '.agentlink', 'agents', agentId, 'credential.json')), 'the profile is under the room workspace');
  const saved = JSON.parse(readFileSync(join(consoleDir, '.agentlink', 'shell.json'), 'utf8'));
  assert.match(saved.agents['DeepSeek'].credential, new RegExp(`^${roomWorkspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\.agentlink/agents/`), 'shell.json records that credential path');
  c.input.write('/quit\n'); await c.done;
});
