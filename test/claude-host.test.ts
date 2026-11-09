import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startHub } from '../core/server.ts';
import { request, saveCredential } from '../core/client.ts';
import { ClaudeHost, claudeModels, ownedClaudeOpening, type ClaudeHostOptions } from '../core/claude-host.ts';
import { agentlinkCall } from '../core/shell-agents.ts';

// The owned Claude host (item 17): peerloom runs Claude Code headless, holds its waits so that a quiet room costs no
// model turn, and puts every permission request to the human. The hub is real; Claude is the stream-JSON stand-in
// in helpers/claude-fixture.ts, which runs the real Peerloom CLI once a command is allowed.
const root = resolve(import.meta.dirname, '..'); const cli = realpathSync(join(root, 'core/cli.ts'));
const until = async <T>(found: () => T | Promise<T>, what: string, ms = 10_000): Promise<NonNullable<T>> => { for (let waited = 0; waited < ms; waited += 20) { const value = await found(); if (value) return value as NonNullable<T>; await new Promise(ok => setTimeout(ok, 20)); } throw new Error(`Timed out waiting for ${what}`); };
const alive = (pid: number | undefined) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

async function world(t: any) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'peerloom-claude-host-'))); const hub = await startHub({ dataDir: join(dir, 'hub'), port: 0 });
  const admin = JSON.parse(readFileSync(hub.adminPath, 'utf8')); let serial = 0;
  const owner = await request(admin, 'create', { requestId: 'room', name: 'Runtime', workspace: dir });
  const invite = await request(owner, 'invite', { requestId: 'invite', name: 'Claude', harness: 'claude-code' });
  const client = await request(invite, 'join', { requestId: 'join', token: invite.token }); const path = join(dir, 'claude.json'); saveCredential(path, client);
  await request(owner, 'run_start', { requestId: 'start', limits: { room: 20, agent: 10, emptyWaits: 50 } });
  const log = join(dir, 'fixture.jsonl'); writeFileSync(log, '');
  const claude = join(dir, 'claude'); writeFileSync(claude, `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'test/helpers/claude-fixture.ts')}' "$@"\n`); chmodSync(claude, 0o755);
  const hosts: ClaudeHost[] = []; const events: any[] = [];
  const launch = async (extra: Partial<ClaudeHostOptions> = {}) => {
    const host = new ClaudeHost({ clientPath: path, participant: 'Claude', room: 'Runtime', cwd: dir, cliPath: cli, claude, waitSeconds: 1, environment: { ...process.env, CLAUDE_FIXTURE_LOG: log }, onEvent: event => events.push(event), ...extra });
    hosts.push(host); await host.start(); return host;
  };
  t.after(async () => { for (const host of hosts) await host.halt('Stopped by human'); await hub.close(); rmSync(dir, { recursive: true, force: true }); });
  const logged = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { dir, path, owner, claude, events, launch, logged, send: (text: string) => request(owner, 'send', { requestId: `send-${++serial}`, to: 'Claude', text }) };
}

test('the opening names this credential in a form the trusted-command check accepts, and never asks Claude to wait', () => {
  const text = ownedClaudeOpening('Claude', 'My room', '/w/c.json', '/a/core/cli.ts');
  assert.match(text, /^You are participant Claude in the Peerloom room "My room"/); assert.match(text, /never run bind or wait yourself/); assert.match(text, /Reply now with the single word Ready/);
  for (const verb of ['fetch', 'reply', 'send', 'ack']) assert.match(text, new RegExp(`node /a/core/cli\\.ts ${verb} --client /w/c\\.json`));
  // The reply it teaches is one the console allows by itself for a trusted agent: one command, its own credential.
  const reply = /^\s*(node \S+ reply .*)$/m.exec(text)![1].replace('WAKE_ID', 'wk_1');
  assert.deepEqual(agentlinkCall(reply, { cli: '/a/core/cli.ts', clientPath: '/w/c.json', self: 'Claude', names: {} })?.warnings, []);
  assert.doesNotMatch(text, /<<|run_in_background/);
});

test('an owned Claude says Ready once, is armed, and a quiet room re-arms without a model turn', async t => {
  const w = await world(t); const host = await w.launch();
  await until(() => w.events.filter(e => e.event === 'armed').length >= 3, 'three waits, two of them quiet', 15_000);
  const turns = w.logged().filter(e => e.turn !== undefined);
  assert.equal(turns.length, 1); assert.match(turns[0].turn, /^You are participant Claude/);
  const started = w.logged().find(e => e.args)!.args as string[];
  for (const flag of ['--input-format', '--output-format', '--permission-prompt-tool', '--session-id']) assert.ok(started.includes(flag), flag);
  assert.equal(started[started.indexOf('--permission-prompt-tool') + 1], 'stdio'); assert.equal(started[started.indexOf('--permission-mode') + 1], 'manual');
  assert.ok(w.events.find(e => e.event === 'bound')); assert.ok(alive(host.pid));
  assert.equal(JSON.parse(readFileSync(`${w.path}.claude-host.json`, 'utf8')).sessionId, started[started.indexOf('--session-id') + 1]);
});

test('work for it is fetched and answered only after the human allows each command', async t => {
  const w = await world(t); const host = await w.launch(); await until(() => w.events.find(e => e.event === 'armed'), 'armed');
  await w.send('Please confirm');
  const fetch = await until(() => w.events.find(e => e.event === 'native_request' && /fetch --client/.test(e.params.command)), 'the fetch to be asked');
  assert.equal(fetch.method, 'item/commandExecution/requestApproval'); assert.ok(w.events.find(e => e.event === 'offered'));
  assert.ok(w.events.find(e => e.event === 'turn_started' && e.purpose === 'wake'));
  assert.equal(w.logged().filter(e => e.permission).length, 0, 'nothing ran before the human answered');
  host.reply(fetch.id, { decision: 'accept' });
  const reply = await until(() => w.events.find(e => e.event === 'native_request' && /reply --client/.test(e.params.command)), 'the reply to be asked');
  assert.throws(() => host.reply(fetch.id, { decision: 'accept' }), /no longer waiting/);
  assert.throws(() => host.reply(reply.id, { decision: 'maybe' }), /accept or decline/);
  host.reply(reply.id, { decision: 'accept' });
  // Each shell command reached the host because its hook said "ask" (probe P3); none ran on the CLI's own say-so.
  assert.deepEqual(w.logged().find(e => e.hooks)?.hooks, { PreToolUse: [{ matcher: '', hookCallbackIds: ['agentlink_shell'] }] });
  await until(() => w.logged().filter(e => e.permission).length === 2, 'both commands answered');
  assert.deepEqual(w.logged().filter(e => e.hook).map(e => [e.hook, e.decision]), [['Bash', 'ask'], ['Bash', 'ask']]);
  assert.equal(w.logged().filter(e => e.unasked).length, 0);
  const inbox = await until(async () => (await request(w.owner, 'inbox')).messages.find((m: any) => m.sender.name === 'Claude'), 'the answer in the human inbox');
  assert.equal(inbox.text, "Fixture answer: it's done");
  await until(() => w.events.find(e => e.event === 'turn_completed' && e.purpose === 'wake'), 'the wake turn to end');
  assert.ok(w.events.find(e => e.event === 'command_completed' && /fetch/.test(e.command) && e.exitCode === 0));
  await until(() => w.events.filter(e => e.event === 'armed').length >= 2, 're-armed after the work');
  // A human turn typed straight into the session is answered there.
  await host.submit('How are you?'); await until(() => w.events.find(e => e.event === 'agent_message' && e.text === 'Heard: How are you?'), 'the direct answer');
  // A tool that is not a shell command is put to the human by name and input, and answered the same way (GPT, 015-gpt).
  void host.submit('EDIT notes.txt');
  const edit = await until(() => w.events.find(e => e.event === 'native_request' && e.method === 'claude/toolApproval'), 'the edit to be asked');
  assert.deepEqual(edit.params, { tool: 'Edit', input: { file_path: 'notes.txt', old_string: 'a', new_string: 'b' }, reason: 'Edit notes.txt' });
  host.reply(edit.id, { decision: 'accept' });
  await until(() => w.events.find(e => e.event === 'agent_message' && e.text === 'Edited notes.txt'), 'the edit to be made');
  assert.deepEqual(w.logged().find(e => e.permission === 'Edit notes.txt')?.updatedInput, { file_path: 'notes.txt', old_string: 'a', new_string: 'b' });
  assert.deepEqual(w.logged().filter(e => e.hook === 'Edit').map(e => e.decision), [null], 'an edit is left to the CLI, which asks');
});

test('a refused command is not run, and stopping ends the Claude process and its wait', async t => {
  const w = await world(t); const host = await w.launch(); await until(() => w.events.find(e => e.event === 'armed'), 'armed');
  await w.send('Try it');
  const fetch = await until(() => w.events.find(e => e.event === 'native_request'), 'the fetch to be asked');
  host.reply(fetch.id, { decision: 'decline' });
  await until(() => w.events.find(e => e.event === 'turn_completed' && e.purpose === 'wake'), 'the wake turn to end');
  assert.deepEqual(w.logged().filter(e => e.permission).map(e => e.behavior), ['deny']);
  const pid = host.pid; assert.ok(alive(pid));
  await host.halt('Stopped by human');
  assert.equal(alive(pid), false); assert.equal(alive(host.waitPid), false);
  assert.equal((await host.finished).reason, 'Stopped by human'); assert.ok(w.events.find(e => e.event === 'stopped' && e.reason === 'Stopped by human'));
});

test('a relaunch resumes the same Claude session without a second opening', async t => {
  const w = await world(t); const first = await w.launch(); await until(() => w.events.find(e => e.event === 'armed'), 'armed');
  const session = JSON.parse(readFileSync(`${w.path}.claude-host.json`, 'utf8')).sessionId; await first.halt('Stopped by human');
  const second = await w.launch({ resume: true }); await until(() => w.events.filter(e => e.event === 'armed').length >= 2, 'armed again');
  const runs = w.logged().filter(e => e.args); const again = runs.at(-1)!.args as string[];
  assert.equal(again[again.indexOf('--resume') + 1], session); assert.ok(!again.includes('--session-id'));
  assert.equal(w.logged().filter(e => e.turn !== undefined).length, 1); assert.ok(w.events.find(e => e.event === 'thread' && e.resumed && e.threadId === session));
  assert.ok(alive(second.pid));
});

test('Claude Code lists its own models, with no model run', async t => {
  const w = await world(t);
  const models = await claudeModels(w.claude, w.dir, { ...process.env, CLAUDE_FIXTURE_LOG: join(w.dir, 'fixture.jsonl') });
  assert.deepEqual(models, [{ model: 'default', name: 'Default (recommended)', efforts: ['low', 'high'], isDefault: true }, { model: 'sonnet', name: 'Sonnet', efforts: ['low', 'medium', 'high'], isDefault: false }]);
  assert.equal(w.logged().filter(e => e.turn !== undefined).length, 0); assert.ok(!existsSync(`${w.path}.claude-host.json`));
});

test('a Claude Code that cannot start settles at once and leaves no session behind', async t => {
  const w = await world(t); const began = Date.now();
  const host = await w.launch({ claude: join(w.dir, 'no-such-claude') });
  assert.ok(Date.now() - began < 5000, `start settled after ${Date.now() - began} ms`);
  assert.match((await host.finished).reason, /could not start/); assert.ok(!existsSync(`${w.path}.claude-host.json`));
});

test('stopping during a slow initialize starts nothing and leaves nothing to resume (GPT, 020-gpt)', async t => {
  const w = await world(t); const env = { ...process.env, CLAUDE_FIXTURE_LOG: join(w.dir, 'fixture.jsonl'), CLAUDE_FIXTURE_INIT_DELAY_MS: '600', CLAUDE_FIXTURE_EXIT_DELAY_MS: '1200' };
  const host = new ClaudeHost({ clientPath: w.path, participant: 'Claude', room: 'Runtime', cwd: w.dir, cliPath: cli, claude: w.claude, waitSeconds: 1, environment: env, onEvent: event => w.events.push(event) });
  // The late initialize answer arrives while the stop is under way, as in GPT's probe.
  const began = Date.now(); const started = host.start(); await until(() => w.logged().find(e => e.hooks), 'the initialize request');
  await host.halt('Stopped by human'); await started; assert.ok(Date.now() - began < 5000, `start settled after ${Date.now() - began} ms`);
  await new Promise(ok => setTimeout(ok, 800));
  assert.deepEqual(w.events.filter(e => ['thread', 'bound', 'turn_started', 'armed'].includes(e.event)), []);
  assert.ok(!existsSync(`${w.path}.claude-host.json`)); assert.equal(w.logged().filter(e => e.turn !== undefined).length, 0);
  // A later launch is a fresh session, not a resume of the half-started one.
  const next = await w.launch({ resume: true }); await until(() => w.events.find(e => e.event === 'armed'), 'armed');
  const args = w.logged().filter(e => e.args).at(-1)!.args as string[]; assert.ok(args.includes('--session-id') && !args.includes('--resume'));
  assert.ok(alive(next.pid));
});

test('a spent budget holds the Claude host waiting, and raising the limit releases it with no relaunch (item 19)', async t => {
  const w = await world(t);
  // Another agent, whose messages are what the budget counts.
  const invited = await request(w.owner, 'invite', { requestId: 'invite-peer', name: 'Peer', harness: 'cli' });
  const peer = await request(invited, 'join', { requestId: 'join-peer', token: invited.token });
  await request(w.owner, 'run_limits', { requestId: 'tight', limits: { agent: 1 } });
  const host = await w.launch(); await until(() => w.events.find(e => e.event === 'armed'), 'armed');
  const say = (text: string, key: string) => request(peer, 'send', { requestId: key, to: 'Claude', text });
  const answer = async (from: number) => { for (const verb of ['fetch', 'reply']) { const ask = await until(() => w.events.slice(from).find(e => e.event === 'native_request' && e.params.command.includes(` ${verb} --client`)), verb); host.reply(ask.id, { decision: 'accept' }); } };
  await say('one', 'p1'); await answer(0);
  await until(() => w.events.find(e => e.event === 'turn_completed' && e.purpose === 'wake'), 'the first wake answered');
  // The second message is held: the host keeps waiting through several held timeouts and does not stop.
  await say('two', 'p2'); const mark = w.events.length;
  await until(() => w.events.slice(mark).filter(e => e.event === 'armed').length >= 3, 'still waiting while held', 15_000);
  assert.equal(w.events.find(e => e.event === 'stopped'), undefined); assert.equal(w.events.slice(mark).find(e => e.event === 'offered'), undefined);
  // Extend: the next wait is offered the held message, in the same session.
  await request(w.owner, 'run_limits', { requestId: 'extend', limits: { agent: 2 } });
  await until(() => w.events.slice(mark).find(e => e.event === 'offered'), 'the held work offered after Extend');
  await answer(mark); await until(() => w.events.slice(mark).find(e => e.event === 'turn_completed' && e.purpose === 'wake'), 'the second wake answered');
  assert.equal(w.events.filter(e => e.event === 'thread').length, 1, 'no relaunch');
});

test('busy says a turn or a question is under way, and a halt in the same step as that check lets no new turn start (GPT, 011-gpt)', async t => {
  const w = await world(t); let host!: ClaudeHost; let atOffer: boolean | undefined;
  host = await w.launch({ onEvent: event => { w.events.push(event); if (event.event === 'offered') { atOffer = host.busy; void host.halt('Upgrading'); } } });
  await until(() => w.events.find(e => e.event === 'armed'), 'armed'); assert.equal(host.busy, false);
  const turn = host.submit('EDIT notes.txt'); assert.equal(host.busy, true, 'from the moment the turn is given');
  const edit = await until(() => w.events.find(e => e.event === 'native_request'), 'the edit to be asked'); assert.equal(host.busy, true);
  host.reply(edit.id, { decision: 'decline' }); await turn; assert.equal(host.busy, false);
  // An offer arrives while idle; the check and the halt happen together, and no wake turn follows.
  await w.send('Again');
  const stopped = await until(() => w.events.find(e => e.event === 'stopped'), 'stopped'); assert.equal(stopped.reason, 'Upgrading'); assert.equal(atOffer, false);
  assert.equal(w.events.filter(e => e.event === 'turn_started' && e.purpose === 'wake').length, 0, 'no turn for the offer');
});
