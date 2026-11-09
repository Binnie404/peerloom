import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { PassThrough } from 'node:stream';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ownerStore, runShell } from '../core/shell.ts';
import { NativeFixture } from './helpers/codex-native-fixture.ts';
// The human's credential store (item 24) goes to a temporary home, never the real ~/.agentlink.
process.env.AGENTLINK_HOME = realpathSync(mkdtempSync(join(tmpdir(), 'agentlink-home-')));

// The console as the browser page sees it (item 17): the same room, run and agents the prompt shows, through the
// console's own web server. The hub is real and in this process; only the Codex app-server is stood in for.
const root = resolve(import.meta.dirname, '..'); const cliPath = join(root, 'core/cli.ts');
const until = async <T>(found: () => T | Promise<T>, what: string, ms = 10_000): Promise<NonNullable<T>> => { for (let waited = 0; waited < ms; waited += 25) { const value = await found(); if (value) return value as NonNullable<T>; await new Promise(ok => setTimeout(ok, 25)); } throw new Error(`Timed out waiting for ${what}`); };
const cli = (...args: string[]) => new Promise<number | null>(ok => { const child = spawn(process.execPath, [cliPath, ...args], { stdio: 'ignore' }); child.once('exit', code => ok(code)); });

function console_(t: { after(fn: () => unknown): void }, options: { dir?: string; tty?: boolean; now?: () => number; upgradeHubData?: (o: { dataDir: string; expectedDigest: string | null }) => any } = {}) {
  const dir = options.dir ?? realpathSync(mkdtempSync(join(tmpdir(), 'peerloom-shell-web-'))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Claude is the stream-JSON stand-in, which runs the real Peerloom CLI once a command is allowed.
  const claude = join(dir, 'claude-fixture'); writeFileSync(claude, `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'test/helpers/claude-fixture.ts')}' "$@"\n`); chmodSync(claude, 0o755);
  const ui = join(dir, 'ui-assets'); mkdirSync(ui, { recursive: true }); writeFileSync(join(ui, 'index.html'), '<!doctype html><title>room</title>'); writeFileSync(join(ui, 'app.js'), ''); writeFileSync(join(ui, 'styles.css'), '');
  const input = new PassThrough(); let text = ''; const fixtures: NativeFixture[] = []; const launched: string[] = [];
  const output = Object.assign(new PassThrough(), { isTTY: !!options.tty, columns: 100 }); output.on('data', chunk => { text += String(chunk); });
  const term = process.env.TERM; if (options.tty) process.env.TERM = 'xterm-256color';
  const done = runShell({ cwd: dir, input, output, uiDir: ui, claude, openTerminal: script => { launched.push(script); }, pollMs: 60, waitSeconds: 30, controlIntervalMs: 100, upgradeHubData: options.upgradeHubData as any, now: options.now,
    codexModels: async () => [{ model: 'gpt-fast', name: 'Fast', efforts: ['low', 'high'], isDefault: true }],
    codex: { probe: async () => ({ version: 'codex-cli fixture', digest: 'fixture', toolOutput: true as const }), native: () => { const fixture = new NativeFixture(); fixture.askApproval = true; fixtures.push(fixture);
      fixture.onWake = async params => { const wake = /wake ID (\S+);/.exec(params.toolOutput.output)![1]; const state = JSON.parse(readFileSync(join(dir, '.agentlink/shell.json'), 'utf8'));
        if (await cli('fetch', '--client', state.agents.Codex.credential, '--wake', wake) !== 0) throw new Error('fetch failed'); };
      return fixture; } } });
  if (term === undefined) delete process.env.TERM; else process.env.TERM = term;
  t.after(async () => { input.end(); await Promise.race([done.catch(() => {}), new Promise(ok => setTimeout(ok, 5000))]); });
  return { dir, input, done, fixtures, launched, get text() { return text; } };
}
async function page(c: ReturnType<typeof console_>) {
  const url = new URL((await until(() => /Page: (http:\/\/127\.0\.0\.1:\d+\/#k=\S+)/.exec(c.text), 'the page address'))[1]);
  const token = url.hash.slice('#k='.length); const port = Number(url.port);
  const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; json: any }>((ok, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; }); res.on('end', () => ok({ status: res.statusCode!, json: JSON.parse(text) })); });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body)); });
  const events: any[] = [];
  const stream = httpRequest({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` } }, res => {
    let buffer = ''; res.setEncoding('utf8'); res.on('data', chunk => { buffer += chunk; let at; while ((at = buffer.indexOf('\n\n')) !== -1) { const data = /^data: (.*)$/m.exec(buffer.slice(0, at)); buffer = buffer.slice(at + 2); if (data) events.push(JSON.parse(data[1])); } }); });
  stream.on('error', () => {}); stream.end();
  return { call, events, state: async () => (await call('GET', '/api/state')).json, close: () => stream.destroy() };
}

test('the page reads the room the console holds and acts on it as the prompt does', { timeout: 60_000 }, async t => {
  const c = console_(t); const p = await page(c); t.after(p.close);
  let state = await p.state();
  assert.equal(state.room, null); assert.equal(state.defaults.workspace, c.dir); assert.deepEqual(state.agents, []); assert.deepEqual(state.approvals, []);
  // A request that is not one of the page's own is refused for what it is, whatever its shape.
  for (const op of ['constructor', '__proto__', 'toString']) { const odd = await p.call('POST', '/api/run', { op }); assert.equal(odd.status, 400); assert.match(odd.json.error.message, /op is start, pause, resume, end or limits/); }
  // A refusal the prompt would print comes back to the page as an error with its message, not a crash.
  const early = await p.call('POST', '/api/run', { op: 'start' }); assert.equal(early.status, 400); assert.match(early.json.error.message, /no room in this folder/);

  // Two creations at once (GPT, 013-gpt): one room, one success, the other refused.
  const made = await Promise.all([1, 2].map(() => p.call('POST', '/api/room', { name: 'Web room', workspace: c.dir, objective: 'See it in a browser' })));
  assert.deepEqual(made.map(r => r.status).sort(), [200, 400]);
  state = await p.state(); assert.deepEqual(state.room, { name: 'Web room', workspace: c.dir, objective: 'See it in a browser' });
  assert.ok(existsSync(join(ownerStore(c.dir), 'owner.json'))); assert.ok(!existsSync(join(c.dir, '.agentlink/credentials/owner.json')), 'no owner credential in the workspace (item 24)');
  assert.ok(!ownerStore(c.dir).startsWith(c.dir));
  assert.equal((await p.call('POST', '/api/room', { name: 'Again', workspace: c.dir })).status, 400);
  await until(() => p.events.find(e => e.type === 'room' && e.name === 'Web room'), 'the room event');

  assert.deepEqual((await p.call('GET', '/api/models?kind=codex')).json.models.map((m: any) => m.model), ['gpt-fast']);
  assert.deepEqual((await p.call('GET', '/api/models?kind=claude')).json.models.map((m: any) => m.model), ['default', 'sonnet']);

  assert.equal((await p.call('POST', '/api/run', { op: 'start' })).status, 200);
  await until(() => p.events.find(e => e.type === 'run' && e.state === 'running' && e.limits.room === 120), 'the run event');

  // An owned Codex invited from the page: no window is opened for it, since the page shows what it does. Two invites
  // at once with one name, as a double click sends them, make one agent; "false" as text is not trust.
  const twice = await Promise.all([1, 2].map(() => p.call('POST', '/api/invite', { kind: 'codex', name: 'Codex', model: 'gpt-fast', effort: 'low', trusted: 'false' })));
  assert.deepEqual(twice.map(r => r.status).sort(), [200, 400]); assert.match(twice.find(r => r.status === 400)!.json.error.message, /already in this room/);
  const armed = await until(() => p.events.find(e => e.type === 'agent' && e.name === 'Codex' && e.armed === 'waiting'), 'Codex armed');
  assert.deepEqual({ ...armed, type: undefined }, { type: undefined, name: 'Codex', kind: 'codex', label: 'Codex', where: 'owned', model: 'gpt-fast', effort: 'low', trusted: false, session: 'open', armed: 'waiting', held: null, note: null, controls: { stop: true, relaunch: false, tell: true, settings: true }, state: 'listening' });
  assert.deepEqual(c.launched, []);
  await until(() => p.events.find(e => e.type === 'output' && e.agent === 'Codex' && /Armed: waiting for work/.test(e.text)), 'Codex activity on the page');

  // The human's message wakes Codex; its approval is answered from the page, and the exchange is on the page.
  assert.equal((await p.call('POST', '/api/send', { to: 'Codex', text: 'Please fetch your work' })).status, 200);
  await until(() => p.events.find(e => e.type === 'message' && e.from === 'human' && e.to.includes('Codex') && e.text === 'Please fetch your work'), 'the human message');
  const asked = await until(() => p.events.find(e => e.type === 'approval' && e.agent === 'Codex'), 'the approval');
  assert.equal(asked.kind, 'approval'); assert.equal(asked.method, 'item/commandExecution/requestApproval'); assert.equal(asked.params.command, 'node core/cli.ts fetch --client protected.json'); assert.ok(asked.lines.length);
  const held = (await p.state()).approvals; assert.equal(held.length, 1); assert.deepEqual(held[0].lines, asked.lines);
  assert.equal((await p.call('POST', '/api/approvals/99', { decision: 'accept' })).status, 400);
  assert.equal((await p.call('POST', `/api/approvals/${asked.id}`, { decision: 'accept' })).status, 200);
  await until(() => p.events.find(e => e.type === 'approval_done' && e.id === asked.id && e.how === 'approved'), 'the approval to be done');
  await until(() => c.fixtures[0].replies.length === 1, 'the approval to reach Codex'); assert.deepEqual(c.fixtures[0].replies[0].result, { decision: 'accept' });
  assert.deepEqual((await p.state()).approvals, []);
  // The terminal still says it all, for a human at the prompt.
  assert.match(c.text, /Codex needs approval \[0\]/);

  // Work the human gave at the prompt is on the page with what the page needs to show and accept it.
  c.input.write('/task\nCheck the build\nCodex\nRun the build and say if it passes\n');
  const task = await until(async () => (await p.state()).requests.find((r: any) => r.text === 'Run the build and say if it passes'), 'the task on the page');
  assert.deepEqual({ to: task.to, state: task.state, purpose: task.purpose, accepted: task.accepted, targetSuperseded: task.targetSuperseded, responses: task.responses }, { to: ['Codex'], state: 'open', purpose: 'answer', accepted: false, targetSuperseded: false, responses: [] });
  assert.match(task.id, /^rq_/);

  // A page action that the prompt answers only in words still tells the page what happened.
  // (Pausing the run closes an owned Codex's session by itself; it reopens on resume.)
  assert.equal((await p.call('POST', '/api/run', { op: 'pause' })).status, 200);
  await until(() => p.events.find(e => e.type === 'agent' && e.name === 'Codex' && e.session === 'closed'), 'Codex closed by the pause');
  assert.equal((await p.call('POST', '/api/agents/Codex/relaunch', {})).status, 200);
  await until(() => p.events.find(e => e.type === 'notice' && /Codex opens when the run is running/.test(e.text)), 'the relaunch notice');
  const since = (mark: number, found: (e: any) => boolean, what: string) => until(() => p.events.slice(mark).find(found), what);
  let mark = p.events.length;
  assert.equal((await p.call('POST', '/api/run', { op: 'resume' })).status, 200);
  await since(mark, e => e.type === 'agent' && e.name === 'Codex' && e.session === 'open', 'Codex open again on resume');
  mark = p.events.length;
  assert.equal((await p.call('POST', '/api/agents/Codex/stop', {})).status, 200);
  await since(mark, e => e.type === 'agent' && e.name === 'Codex' && e.session === 'closed', 'Codex stopped');
  assert.equal((await p.call('POST', '/api/agents/Nobody/stop', {})).status, 400);
  assert.equal((await p.call('POST', '/api/teleport', {})).status, 404);

  // The state the page reloads into is the same story the events told.
  state = await p.state();
  assert.ok(state.messages.some((m: any) => m.from === 'human' && m.text === 'Please fetch your work'));
  assert.ok(state.notices.some((n: any) => /Run 1 started/.test(n.text)));
  assert.equal(state.run.state, 'running'); assert.ok(state.eventId > 0);
  c.input.write('/quit\n'); c.input.write('y\n'); await c.done;
});

test('a room reopened at a terminal works from the page while the console still asks its startup question', { timeout: 60_000 }, async t => {
  const first = console_(t); const p1 = await page(first); t.after(p1.close);
  await p1.call('POST', '/api/room', { name: 'Again', workspace: first.dir }); await p1.call('POST', '/api/run', { op: 'start' });
  await p1.call('POST', '/api/invite', { kind: 'codex', name: 'Codex', trusted: false });
  await until(() => p1.events.find(e => e.type === 'agent' && e.name === 'Codex' && e.armed === 'waiting'), 'Codex armed'); p1.close();
  first.input.write('/quit\n'); first.input.write('y\n'); await first.done;
  // The terminal now waits at "Open the agents again?" and nobody answers it there.
  const second = console_(t, { dir: first.dir, tty: true }); const p2 = await page(second); t.after(p2.close);
  await until(() => /Open the agents again\?/.test(second.text), 'the startup question');
  assert.equal((await p2.call('POST', '/api/agents/Codex/relaunch', {})).status, 200);
  await until(() => p2.events.find(e => e.type === 'agent' && e.name === 'Codex' && e.armed === 'waiting'), 'Codex armed again');
  assert.equal((await p2.call('POST', '/api/send', { to: 'Codex', text: 'Work while the prompt asks' })).status, 200);
  await until(() => p2.events.find(e => e.type === 'approval' && e.agent === 'Codex'), 'the wake to reach Codex despite the waiting question');
  second.input.write('n\n'); second.input.write('/quit\n'); second.input.write('y\n'); await second.done;
});

test('an owned Claude is invited, approved and trusted from the page, and its answer is in the room', { timeout: 60_000 }, async t => {
  const c = console_(t); const p = await page(c); t.after(p.close);
  await p.call('POST', '/api/room', { name: 'Claude room', workspace: c.dir }); await p.call('POST', '/api/run', { op: 'start' });
  assert.deepEqual((await p.call('GET', '/api/models?kind=claude')).json.models.map((m: any) => m.model), ['default', 'sonnet']);
  assert.equal((await p.call('POST', '/api/invite', { kind: 'claude', name: 'Claude', model: 'sonnet', trusted: false })).status, 200);
  const armed = await until(() => p.events.find(e => e.type === 'agent' && e.name === 'Claude' && e.armed === 'waiting'), 'Claude armed');
  assert.equal(armed.where, 'owned'); assert.equal(armed.session, 'open'); assert.deepEqual(c.launched, []);
  assert.equal((await p.call('POST', '/api/send', { to: 'Claude', text: 'Are you there?' })).status, 200);
  for (const verb of ['fetch', 'reply']) {
    const asked = await until(() => p.events.find(e => e.type === 'approval' && e.agent === 'Claude' && e.params.command.includes(` ${verb} --client`)), `Claude's ${verb} to be asked`);
    assert.equal(asked.kind, 'approval'); assert.ok(asked.lines.some((line: string) => line.includes(`peerloom ${verb}`)), asked.lines.join('|'));
    assert.equal((await p.call('POST', `/api/approvals/${asked.id}`, { decision: 'accept' })).status, 200);
  }
  await until(() => p.events.find(e => e.type === 'message' && e.from === 'Claude' && e.to.includes('human') && e.text === "Fixture answer: it's done"), "Claude's answer in the room");
  // Trusted, its own room commands run unasked and are shown as what it ran.
  assert.equal((await p.call('POST', '/api/agents/Claude/trust', { trusted: true })).status, 200);
  await until(() => p.events.filter(e => e.type === 'agent' && e.name === 'Claude' && e.armed === 'waiting').length >= 2, 'Claude armed after the work');
  const mark = p.events.length; assert.equal((await p.call('POST', '/api/send', { to: 'Claude', text: 'Again, please' })).status, 200);
  await until(() => p.events.slice(mark).filter(e => e.type === 'message' && e.from === 'Claude').length === 1, 'the trusted answer');
  assert.equal(p.events.slice(mark).filter(e => e.type === 'approval').length, 0);
  assert.ok(p.events.slice(mark).some(e => e.type === 'output' && e.agent === 'Claude' && /^ran: peerloom reply/.test(e.text)));
  // Another tool than a shell command is an approval like any other on the page: approve or deny, nothing to fill in.
  assert.equal((await p.call('POST', '/api/agents/Claude/tell', { text: 'EDIT notes.txt' })).status, 200);
  const edit = await until(() => p.events.find(e => e.type === 'approval' && e.method === 'claude/toolApproval'), 'the edit approval');
  assert.equal(edit.kind, 'approval'); assert.ok(edit.lines.includes('Use Edit') && edit.lines.includes('file_path: notes.txt'), edit.lines.join('|'));
  assert.equal((await p.call('POST', `/api/approvals/${edit.id}`, { decision: 'decline' })).status, 200);
  await until(() => p.events.find(e => e.type === 'output' && e.agent === 'Claude' && /Not edited notes\.txt/.test(e.text)), 'the declined edit');
  assert.equal((await p.call('POST', '/api/agents/Claude/stop', {})).status, 200);
  await until(() => p.events.find(e => e.type === 'agent' && e.name === 'Claude' && e.session === 'closed'), 'Claude stopped');
  c.input.write('/quit\n'); await c.done;
});

test('an owned Claude paused and at once resumed from the page comes back (GPT, 022-gpt)', { timeout: 60_000 }, async t => {
  const previous = process.env.CLAUDE_FIXTURE_EXIT_DELAY_MS; process.env.CLAUDE_FIXTURE_EXIT_DELAY_MS = '500';
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_FIXTURE_EXIT_DELAY_MS; else process.env.CLAUDE_FIXTURE_EXIT_DELAY_MS = previous; });
  const c = console_(t); const p = await page(c); t.after(p.close);
  await p.call('POST', '/api/room', { name: 'Pause room', workspace: c.dir }); await p.call('POST', '/api/run', { op: 'start' });
  await p.call('POST', '/api/invite', { kind: 'claude', name: 'Claude', trusted: true });
  await until(() => p.events.find(e => e.type === 'agent' && e.name === 'Claude' && e.armed === 'waiting'), 'Claude armed');
  assert.equal((await p.call('POST', '/api/run', { op: 'pause' })).status, 200);
  assert.equal((await p.call('POST', '/api/run', { op: 'resume' })).status, 200);
  const mark = p.events.length;
  await until(() => p.events.slice(mark).find(e => e.type === 'agent' && e.name === 'Claude' && e.session === 'open' && e.armed === 'waiting'), 'Claude open and armed after the resume');
  c.input.write('/quit\n'); c.input.write('y\n'); await c.done;
});

test('the page shows an owned Claude held by the budget, and Extend through the page releases it to the same session (item 19)', { timeout: 60_000 }, async t => {
  const c = console_(t); const p = await page(c); t.after(p.close);
  await p.call('POST', '/api/room', { name: 'Budget room', workspace: c.dir });
  await p.call('POST', '/api/run', { op: 'start', limits: { room: 20, agent: 1 } });
  await p.call('POST', '/api/invite', { kind: 'claude', name: 'Claude', trusted: true });
  await until(() => p.events.find(e => e.type === 'agent' && e.name === 'Claude' && e.armed === 'waiting'), 'Claude armed');
  // Another agent, invited at the prompt; its messages are what the budget counts.
  c.input.write('/invite claude\nPeer\nterminal\n\n\ny\n'); await until(() => existsSync(join(c.dir, '.agentlink/credentials/peer.json')), 'Peer invited');
  const peer = join(c.dir, '.agentlink/credentials/peer.json');
  const send = async (text: string) => assert.equal(await cli('send', '--client', peer, '--to', 'Claude', '--text', text), 0);
  await send('one'); await until(() => p.events.find(e => e.type === 'message' && e.from === 'Claude' && e.to.includes('Peer')), "Claude's first answer");
  await send('two');
  const held = await until(() => p.events.find(e => e.type === 'agent' && e.name === 'Claude' && e.held === 'budget_agent'), 'Claude held on the page');
  assert.equal(held.session, 'open', 'held, not stopped');
  assert.equal((await p.state()).agents.find((a: any) => a.name === 'Claude').held, 'budget_agent');
  // Extend from the page: the same session takes the held message and answers it.
  assert.equal((await p.call('POST', '/api/run', { op: 'limits', limits: { room: 20, agent: 2 } })).status, 200);
  await until(() => p.events.find(e => e.type === 'agent' && e.name === 'Claude' && e.held === null && e.armed === 'waiting' && p.events.indexOf(e) > p.events.indexOf(held)), 'released');
  await until(() => p.events.filter(e => e.type === 'message' && e.from === 'Claude' && e.to.includes('Peer')).length === 2, "Claude's second answer");
  c.input.write('/quit\ny\n'); await c.done;
});

test('What next asks the chosen leads once per press, and the page follows each lead from owed to answered or declined (item 21)', { timeout: 60_000 }, async t => {
  const c = console_(t); const p = await page(c); t.after(p.close);
  await p.call('POST', '/api/room', { name: 'Next room', workspace: c.dir }); await p.call('POST', '/api/run', { op: 'start' });
  for (const name of ['Ada', 'Bo']) { c.input.write(`/invite claude\n${name}\nterminal\n\n\ny\n`); await until(() => existsSync(join(c.dir, `.agentlink/credentials/${name.toLowerCase()}.json`)), `${name} invited`); }
  const cred = (name: string) => join(c.dir, `.agentlink/credentials/${name.toLowerCase()}.json`); const owner = JSON.parse(readFileSync(join(ownerStore(c.dir), 'owner.json'), 'utf8'));
  // Nobody is connected, so a press with no leads named asks nobody and says why.
  // Each agent says why it cannot take work, so the page never implies a closed one will (R3 section 4.5).
  assert.deepEqual((await p.state()).agents.map((a: any) => [a.name, a.note]), [['Ada', 'Its session is closed: relaunch it to give it work.'], ['Bo', 'Its session is closed: relaunch it to give it work.']]);
  const none = await p.call('POST', '/api/what_next', {}); assert.equal(none.status, 400); assert.match(none.json.error.message, /No agent is connected/);
  // Leads named: one item, one request; the same press again (the page's requestId) asks nobody twice.
  const asked = await p.call('POST', '/api/what_next', { leads: ['Ada', 'bo'], requestId: 'press-1' }); assert.equal(asked.status, 200, JSON.stringify(asked.json));
  assert.deepEqual(await p.call('POST', '/api/what_next', { leads: ['Ada', 'bo'], requestId: 'press-1' }), asked);
  const { request } = await import('../core/client.ts');
  const items = (await request(owner, 'items')).items; assert.equal(items.length, 1); assert.equal(items[0].itemType, 'discussion'); assert.equal(items[0].itemId, asked.json.itemId);
  const [made] = (await request(owner, 'requests', { filter: 'item', itemId: asked.json.itemId })).requests;
  assert.equal(made.purpose, 'answer'); assert.equal(made.collabRequestId, asked.json.collabRequestId);
  for (const words of [/read-only/, /change nothing/, /at most three/, /suggest/, /respond/, /none is a valid answer/i, /map --client YOUR_CREDENTIAL_FILE/, /Do not edit the map in this assessment/, /update the map in the same turn/i]) assert.match(made.text, words);
  // The request carries the whole suggest command and a proposal the hub accepts: a session resumed from before item 21
  // never saw the opening that teaches it, and the room's project need not be this one (GPT, 018-gpt).
  const { parseProposal } = await import('../core/collab.ts');
  const shown = /node (\S+) suggest --client YOUR_CREDENTIAL_FILE --title '[^']+' --text '(\{[^']+\})'/.exec(made.text); assert.ok(shown, made.text);
  assert.equal(shown[1], realpathSync(cliPath)); assert.equal(parseProposal(shown[2]).error, null); assert.ok(made.text.includes('\\u0027'));
  let next = (await until(async () => (await p.state()).whatNext?.length && (await p.state()).whatNext, 'What next in the snapshot'))[0];
  assert.equal(next.itemId, asked.json.itemId); assert.equal(typeof next.at, 'string');
  assert.deepEqual(next.leads, [{ name: 'Ada', state: 'owed', suggestionIds: [] }, { name: 'Bo', state: 'owed', suggestionIds: [] }]);
  // Ada answers naming the suggestion she posted (and one that is not hers); Bo declines.
  const run = (who: string, ...args: string[]) => new Promise<string>((ok, reject) => { const child = spawn(process.execPath, [cliPath, ...args, '--client', cred(who)]); let out = ''; child.stdout.on('data', d => { out += d; }); child.once('exit', code => code === 0 ? ok(out) : reject(new Error(out))); });
  const hers = JSON.parse(await run('Ada', 'item-open', '--type', 'suggestion', '--title', 'Retry sends')).itemId;
  const his = JSON.parse(await run('Bo', 'item-open', '--type', 'suggestion', '--title', 'Not Ada\'s')).itemId;
  await run('Ada', 'respond', '--request', made.collabRequestId, '--outcome', 'answered', '--text', `Posted ${hers}; see also ${his}.`);
  await run('Bo', 'respond', '--request', made.collabRequestId, '--outcome', 'declined', '--text', 'Nothing worth doing.');
  await until(() => p.events.find(e => e.type === 'recommendations'), 'the page told to refresh');
  next = (await until(async () => { const s = await p.state(); return s.whatNext[0].leads.every((l: any) => l.state !== 'owed') && s; }, 'both leads settled')).whatNext[0];
  assert.deepEqual(next.leads, [{ name: 'Ada', state: 'answered', suggestionIds: [hers] }, { name: 'Bo', state: 'declined', suggestionIds: [] }]);
  // The prompt has the same command.
  c.input.write('/what-next Bo\n'); await until(() => /Asked Bo what to do next/.test(c.text), 'the prompt\'s What next');
  assert.equal((await until(async () => { const s = await p.state(); return s.whatNext.length === 2 && s; }, 'a second What next')).whatNext[1].leads[0].name, 'Bo');
  c.input.write('/quit\n'); await c.done;
});

test('a suggestion is a card the human can ask about, dismiss or adopt, with dissent kept and a missing host said (item 21)', { timeout: 60_000 }, async t => {
  const c = console_(t); const p = await page(c); t.after(p.close);
  await p.call('POST', '/api/room', { name: 'Card room', workspace: c.dir }); await p.call('POST', '/api/run', { op: 'start' });
  for (const name of ['Ada', 'Bo']) { c.input.write(`/invite claude\n${name}\nterminal\n\n\ny\n`); await until(() => existsSync(join(c.dir, `.agentlink/credentials/${name.toLowerCase()}.json`)), `${name} invited`); }
  const cred = (name: string) => join(c.dir, `.agentlink/credentials/${name.toLowerCase()}.json`);
  const run = (who: string, ...args: string[]) => new Promise<any>((ok, reject) => { const child = spawn(process.execPath, [cliPath, ...args, '--client', cred(who)]); let out = ''; child.stdout.on('data', d => { out += d; }); child.once('exit', code => code === 0 ? ok(JSON.parse(out)) : reject(new Error(out))); });
  const proposal = { v: 1, kind: 'gap', gap: 'Failed sends are lost', outcome: 'A failed send is retried once', evidence: ['core/client.ts:41'], why: 'Lost work', payoff: 'Nothing lost', effort: 'small', impact: 'high', scope: 'core/client.ts only', acceptance: ['A test shows one retry'] };
  const posted = await run('Ada', 'suggest', '--title', 'Retry sends', '--text', JSON.stringify(proposal));
  const odd = (await run('Bo', 'item-open', '--type', 'suggestion', '--title', 'Loose idea')).itemId; await run('Bo', 'publish', '--item', odd, '--text', 'just make it faster');
  const cards = async () => (await p.state()).recommendations as any[];
  const of = async (itemId: string) => (await cards()).find(r => r.itemId === itemId);
  const ada = await until(() => of(posted.itemId), 'the card');
  const target = { artifactId: posted.artifactId, revision: 1, digest: posted.digest };
  assert.deepEqual({ ...ada, at: undefined }, { itemId: posted.itemId, title: 'Retry sends', author: 'Ada', at: undefined, target, payload: proposal, payloadError: null, rawText: null, positions: [], disposition: 'open' });
  // A proposal that is not one stays readable, as text, and says why it cannot be acted on.
  const loose = await until(async () => (await of(odd))?.target && of(odd), 'the malformed card, published'); assert.equal(loose.payload, null); assert.equal(loose.rawText, 'just make it faster'); assert.equal(typeof loose.payloadError, 'string'); assert.equal(loose.author, 'Bo');
  // Ask: never the author, never a revision that is not the latest, and once per press.
  assert.match((await p.call('POST', `/api/suggestions/${posted.itemId}/ask`, { lead: 'Ada', target })).json.error.message, /Ada wrote this suggestion/);
  const stale = await p.call('POST', `/api/suggestions/${posted.itemId}/ask`, { lead: 'Bo', target: { ...target, revision: 2 } }); assert.equal(stale.status, 409); assert.equal(stale.json.error.code, 'stale_revision');
  const asked = await p.call('POST', `/api/suggestions/${posted.itemId}/ask`, { lead: 'bo', target, requestId: 'ask-1' }); assert.equal(asked.status, 200, JSON.stringify(asked.json));
  assert.deepEqual(await p.call('POST', `/api/suggestions/${posted.itemId}/ask`, { lead: 'bo', target, requestId: 'ask-1' }), asked);
  assert.deepEqual((await until(async () => (await of(posted.itemId)).positions.length && of(posted.itemId), 'the asked position')).positions, [{ from: 'Bo', state: 'requested', text: '' }]);
  await run('Bo', 'respond', '--request', asked.json.collabRequestId, '--outcome', 'answered', '--verdict', 'changes_requested', '--artifact', target.artifactId, '--revision', '1', '--digest', target.digest, '--text', 'Too broad');
  assert.deepEqual((await until(async () => (await of(posted.itemId)).positions[0].state !== 'requested' && of(posted.itemId), 'Bo\'s position')).positions, [{ from: 'Bo', state: 'changes_requested', text: 'Too broad' }]);
  // Adopt over Bo's objection: one task for Bo, the same on a retried press; Bo's closed session is said, not hidden.
  const task = { outcome: proposal.outcome, scope: proposal.scope, acceptance: proposal.acceptance };
  const adopted = await p.call('POST', `/api/suggestions/${posted.itemId}/adopt`, { target, assignee: 'Bo', task, requestId: 'adopt-1' }); assert.equal(adopted.status, 200, JSON.stringify(adopted.json));
  assert.equal(adopted.json.assignee, 'Bo'); assert.equal(adopted.json.note, 'Its session is closed: relaunch it to give it work.'); assert.equal(adopted.json.held, null);
  assert.deepEqual(await p.call('POST', `/api/suggestions/${posted.itemId}/adopt`, { target, assignee: 'Bo', task, requestId: 'adopt-1' }), adopted);
  const done = await until(async () => { const card = await of(posted.itemId); return card.disposition === 'adopted' && card; }, 'the adopted card');
  assert.deepEqual({ ...done.adoption, at: undefined }, { taskItemId: adopted.json.taskItemId, collabRequestId: adopted.json.collabRequestId, assignee: 'Bo', target, at: undefined, assignment: 'owed' });
  assert.deepEqual(done.positions, [{ from: 'Bo', state: 'changes_requested', text: 'Too broad' }], 'dissent stays visible');
  // Dismiss: the human's, said as such, once; a position still owed on it is withdrawn, so nobody is woken to review it.
  const loosePosition = await p.call('POST', `/api/suggestions/${odd}/ask`, { lead: 'Ada', target: loose.target }); assert.equal(loosePosition.status, 200);
  const aPoll = () => new Promise(ok => setTimeout(ok, 200));
  // A reason too long for the hub is refused before anything is withdrawn (GPT, 016-gpt).
  const long = await p.call('POST', `/api/suggestions/${odd}/dismiss`, { reason: 'x'.repeat(1001) }); assert.equal(long.status, 400); assert.match(long.json.error.message, /at most 1,000 characters/);
  await aPoll(); assert.deepEqual((await of(odd)).positions, [{ from: 'Ada', state: 'requested', text: '' }]); assert.equal((await of(odd)).disposition, 'open');
  assert.equal((await p.call('POST', `/api/suggestions/${odd}/dismiss`, { reason: 'Not a proposal', requestId: 'd-1' })).status, 200);
  assert.deepEqual((await of(odd)).positions, [{ from: 'Ada', state: 'withdrawn', text: '' }]);
  assert.deepEqual((await run('Ada', 'owed')).requests, []);
  assert.deepEqual({ ...(await of(odd)).dismissal, at: undefined }, { by: 'human', reason: 'Not a proposal', at: undefined }); assert.equal((await of(odd)).disposition, 'dismissed');
  // The same press again, after a reply that never arrived, is answered as the first was (GPT, 010-gpt); another is refused.
  assert.deepEqual(await p.call('POST', `/api/suggestions/${odd}/dismiss`, { reason: 'Not a proposal', requestId: 'd-1' }), { status: 200, json: { ok: true, itemId: odd, disposition: 'dismissed' } });
  assert.match((await p.call('POST', `/api/suggestions/${odd}/dismiss`, { reason: 'Again' })).json.error.message, /already dismissed/);
  assert.match((await p.call('POST', '/api/suggestions/it_nothing/dismiss', { reason: 'x' })).json.error.message, /no suggestion it_nothing/);
  const state = await p.state(); assert.equal(state.storeVersion, 6); assert.deepEqual(state.upgrade, { needed: false });
  c.input.write('/quit\n'); await c.done;
});

test('a version 4 room is upgraded from the page: refused while an agent asks or the data changed, then backed up, reopened and its agent back (item 21)', { timeout: 90_000 }, async t => {
  const first = console_(t); const p1 = await page(first); t.after(p1.close);
  await p1.call('POST', '/api/room', { name: 'Old room', workspace: first.dir }); await p1.call('POST', '/api/run', { op: 'start' });
  await p1.call('POST', '/api/invite', { kind: 'claude', name: 'Claude', trusted: true });
  await until(() => p1.events.find(e => e.type === 'agent' && e.name === 'Claude' && e.armed === 'waiting'), 'Claude armed'); p1.close();
  const claudeCred = join(first.dir, '.agentlink/credentials/claude.json');
  const posted = await new Promise<any>((ok, reject) => { const child = spawn(process.execPath, [cliPath, 'suggest', '--client', claudeCred, '--title', 'Old idea', '--text', JSON.stringify({ v: 1, kind: 'idea', gap: 'g', outcome: 'o', evidence: [], why: 'w', payoff: 'p', effort: 'small', impact: 'low', scope: 's', acceptance: ['a'] })]);
    let out = ''; child.stdout.on('data', d => { out += d; }); child.once('exit', code => code === 0 ? ok(JSON.parse(out)) : reject(new Error(out))); });
  first.input.write('/quit\n'); first.input.write('y\n'); await first.done;
  const statePath = join(first.dir, '.agentlink/state.json'); const state = JSON.parse(readFileSync(statePath, 'utf8')); state.version = 4; for (const room of state.sessions) delete room.marks; writeFileSync(statePath, JSON.stringify(state, null, 2));
  const session = JSON.parse(readFileSync(`${claudeCred}.claude-host.json`, 'utf8')).sessionId;
  const second = console_(t, { dir: first.dir, tty: true }); const p = await page(second); t.after(p.close);
  await until(() => /Open the agents again\?/.test(second.text), 'the startup question'); second.input.write('y\n');
  await until(() => p.events.find(e => e.type === 'agent' && e.name === 'Claude' && e.armed === 'waiting'), 'Claude armed on the old store');
  let now = await p.state(); assert.equal(now.storeVersion, 4); assert.deepEqual(now.upgrade, { needed: true });
  const target = { artifactId: posted.artifactId, revision: 1, digest: posted.digest }; const task = { outcome: 'o', scope: 's', acceptance: ['a'] };
  const early = await p.call('POST', `/api/suggestions/${posted.itemId}/adopt`, { target, assignee: 'Claude', task }); assert.equal(early.status, 409); assert.equal(early.json.error.code, 'upgrade_required');
  // The preview names the data, its rooms, the backup and who is restarted; nothing is changed by it.
  const { preview } = (await p.call('POST', '/api/upgrade', { confirm: false })).json;
  assert.equal(preview.needed, true); assert.equal(preview.fromVersion, 4); assert.equal(preview.toVersion, 6); assert.deepEqual(preview.rooms.map((r: any) => r.name), ['Old room']);
  assert.equal(preview.statePath, statePath); assert.equal(preview.backupPath, join(first.dir, '.agentlink/state.v4.backup.json')); assert.deepEqual(preview.restarts, ['Claude']); assert.deepEqual(preview.interrupts, []);
  // An agent waiting for the human's answer is never answered or cut off to make way.
  assert.equal((await p.call('POST', '/api/agents/Claude/tell', { text: 'EDIT notes.txt' })).status, 200);
  const edit = await until(() => p.events.find(e => e.type === 'approval' && e.method === 'claude/toolApproval'), 'the edit approval');
  const busy = await p.call('POST', '/api/upgrade', { confirm: true, expectedDigest: preview.sourceDigest }); assert.equal(busy.status, 400); assert.match(busy.json.error.message, /Claude is waiting for your answer/);
  assert.equal((await p.call('POST', `/api/approvals/${edit.id}`, { decision: 'decline' })).status, 200);
  await until(() => p.events.find(e => e.type === 'output' && e.agent === 'Claude' && /Not edited notes\.txt/.test(e.text)), 'the declined edit');
  const changed = await p.call('POST', '/api/upgrade', { confirm: true, expectedDigest: '0'.repeat(64) }); assert.equal(changed.status, 409); assert.equal(changed.json.error.code, 'upgrade_changed');
  const version = () => JSON.parse(readFileSync(statePath, 'utf8')).version; const backup = join(first.dir, '.agentlink/state.v4.backup.json');
  assert.equal(version(), 4, 'a refused upgrade changes nothing'); assert.equal(existsSync(backup), false);
  const mark = p.events.length;
  // Until its turn is over, Claude is not cut off either.
  const done = await until(async () => { const r = await p.call('POST', '/api/upgrade', { confirm: true, expectedDigest: preview.sourceDigest, requestId: 'up-1' }); return r.status === 400 && /Claude is in the middle of a turn/.test(r.json.error.message) ? null : r; }, 'the upgrade once the turn is over');
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.fromVersion, 4); assert.equal(done.json.toVersion, 6); assert.equal(done.json.backupPath, backup); assert.equal(JSON.parse(readFileSync(backup, 'utf8')).version, 4); assert.equal(version(), 6); assert.deepEqual(done.json.restarted, ['Claude']);
  assert.deepEqual(await p.call('POST', '/api/upgrade', { confirm: true, expectedDigest: preview.sourceDigest, requestId: 'up-1' }), done, 'a retried confirmation is answered, not repeated');
  now = await p.state(); assert.equal(now.storeVersion, 6); assert.deepEqual(now.upgrade, { needed: false }); assert.equal(now.run.state, 'running');
  await until(() => p.events.slice(mark).find(e => e.type === 'agent' && e.name === 'Claude' && e.session === 'open' && e.armed === 'waiting'), 'Claude back and armed');
  assert.equal(JSON.parse(readFileSync(`${claudeCred}.claude-host.json`, 'utf8')).sessionId, session, 'the same Claude session');
  assert.equal((await p.call('POST', `/api/suggestions/${posted.itemId}/adopt`, { target, assignee: 'Claude', task })).status, 200);
  second.input.write('/quit\n'); second.input.write('y\n'); await second.done;
});

test('the prompt says when the data is old, and /upgrade shows what it does, asks, and upgrades (item 21)', { timeout: 60_000 }, async t => {
  const first = console_(t); const p1 = await page(first); t.after(p1.close);
  await p1.call('POST', '/api/room', { name: 'Prompt room', workspace: first.dir }); p1.close(); first.input.write('/quit\n'); await first.done;
  const statePath = join(first.dir, '.agentlink/state.json'); const state = JSON.parse(readFileSync(statePath, 'utf8')); state.version = 4; for (const room of state.sessions) delete room.marks; writeFileSync(statePath, JSON.stringify(state));
  const second = console_(t, { dir: first.dir });
  await until(() => /This room's data is version 4: suggestions can be adopted, and reactions, receipts and posts work once it is upgraded\. \/upgrade shows what that does\./.test(second.text), 'the hint');
  // A backup already there is never overwritten: the upgrade does not happen, and the room is open again on its data.
  const backup = join(first.dir, '.agentlink/state.v4.backup.json'); writeFileSync(backup, 'kept');
  second.input.write('/upgrade\ny\n'); await until(() => /The upgrade did not happen: State upgrade refused: state\.v4\.backup\.json already exists; preserve it and reconcile before retrying\. The data is as it was, and the room is open again\./.test(second.text), 'the refusal');
  assert.equal(readFileSync(backup, 'utf8'), 'kept'); assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).version, 4);
  second.input.write('/status\n'); await until(() => /Prompt room.* · run \d+ /.test(second.text), 'the hub answering again'); rmSync(backup);
  second.input.write('/upgrade\n'); await until(() => second.text.split('Back up and upgrade now?').length === 3, 'the question again');
  assert.match(second.text, /This upgrades \.agentlink\/state\.json from version 4 to 6, for the room "Prompt room"\. The data as it is now is kept at \.agentlink\/state\.v4\.backup\.json\./);
  second.input.write('y\n'); await until(() => /Workspace data upgraded from version 4 to 6/.test(second.text), 'the upgrade');
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).version, 6);
  second.input.write('/upgrade\n'); await until(() => /The workspace data is version 6; there is nothing to upgrade\./.test(second.text), 'nothing more to do');
  second.input.write('/quit\n'); await second.done;
});

test('an upgrade that fails after changing the data says what the data now is, not that it is as it was (GPT, 011-gpt)', { timeout: 60_000 }, async t => {
  const first = console_(t); const p1 = await page(first); t.after(p1.close);
  await p1.call('POST', '/api/room', { name: 'Half room', workspace: first.dir }); p1.close(); first.input.write('/quit\n'); await first.done;
  const statePath = join(first.dir, '.agentlink/state.json'); const state = JSON.parse(readFileSync(statePath, 'utf8')); state.version = 4; for (const room of state.sessions) delete room.marks; writeFileSync(statePath, JSON.stringify(state));
  // A stand-in for a failure after the replace: the file is already the new version when the error comes.
  const second = console_(t, { dir: first.dir, upgradeHubData: () => { writeFileSync(statePath, JSON.stringify({ ...state, version: 6, sessions: state.sessions.map((room: any) => ({ ...room, marks: [] })) })); throw new Error('directory sync failed'); } });
  const p = await page(second); t.after(p.close);
  const { preview } = (await p.call('POST', '/api/upgrade', { confirm: false })).json;
  const failed = await p.call('POST', '/api/upgrade', { confirm: true, expectedDigest: preview.sourceDigest });
  assert.equal(failed.status, 400); assert.equal(failed.json.error.message, 'The upgrade stopped with an error: directory sync failed. The data now reads as version 6. Check it before relaunching any agent.');
  assert.equal((await p.state()).storeVersion, 6);
  second.input.write('/quit\n'); await second.done;
});

test('an idle Codex is stopped for an upgrade and comes back on its thread; a busy one is left to finish (GPT, 011-gpt)', { timeout: 60_000 }, async t => {
  const first = console_(t); const p1 = await page(first); t.after(p1.close);
  await p1.call('POST', '/api/room', { name: 'Codex room', workspace: first.dir }); await p1.call('POST', '/api/run', { op: 'start' });
  await p1.call('POST', '/api/invite', { kind: 'codex', name: 'Codex', trusted: false });
  await until(() => p1.events.find(e => e.type === 'agent' && e.name === 'Codex' && e.armed === 'waiting'), 'Codex armed'); p1.close();
  first.input.write('/quit\n'); first.input.write('y\n'); await first.done;
  const statePath = join(first.dir, '.agentlink/state.json'); const state = JSON.parse(readFileSync(statePath, 'utf8')); state.version = 4; for (const room of state.sessions) delete room.marks; writeFileSync(statePath, JSON.stringify(state));
  const hostFile = join(first.dir, '.agentlink/credentials/codex.json.codex-adapter.json'); const thread = JSON.parse(readFileSync(hostFile, 'utf8')).threadId;
  const second = console_(t, { dir: first.dir, tty: true }); const p = await page(second); t.after(p.close);
  await until(() => /Open the agents again\?/.test(second.text), 'the startup question'); second.input.write('y\n');
  await until(() => p.events.find(e => e.type === 'agent' && e.name === 'Codex' && e.armed === 'waiting'), 'Codex armed again');
  const { preview } = (await p.call('POST', '/api/upgrade', { confirm: false })).json; assert.deepEqual(preview.restarts, ['Codex']);
  // In a human turn it is busy: refused, and left running.
  const codex = second.fixtures.at(-1)!; codex.holdHuman = true; assert.equal((await p.call('POST', '/api/agents/Codex/tell', { text: 'Think' })).status, 200);
  await until(() => codex.active, 'the human turn');
  const refused = await p.call('POST', '/api/upgrade', { confirm: true, expectedDigest: preview.sourceDigest });
  assert.equal(refused.json.error.message, 'Codex is in the middle of a turn: let it finish, or stop it, then upgrade.'); assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).version, 4);
  codex.complete('completed', 'Thought'); const mark = p.events.length;
  const done = await until(async () => { const r = await p.call('POST', '/api/upgrade', { confirm: true, expectedDigest: preview.sourceDigest }); return r.status === 400 && /middle of a turn/.test(r.json.error.message) ? null : r; }, 'the upgrade once idle');
  assert.equal(done.status, 200, JSON.stringify(done.json)); assert.deepEqual(done.json.restarted, ['Codex']);
  await until(() => p.events.slice(mark).find(e => e.type === 'agent' && e.name === 'Codex' && e.session === 'open' && e.armed === 'waiting'), 'Codex back and armed');
  assert.equal(JSON.parse(readFileSync(hostFile, 'utf8')).threadId, thread, 'the same Codex thread');
  second.input.write('/quit\n'); second.input.write('y\n'); await second.done;
});

test('a page upgrade waits for a console command still under way, and the console takes no command while one runs (GPT, 015-gpt)', { timeout: 60_000 }, async t => {
  const first = console_(t); const p1 = await page(first); t.after(p1.close);
  await p1.call('POST', '/api/room', { name: 'Both room', workspace: first.dir }); p1.close(); first.input.write('/quit\n'); await first.done;
  const statePath = join(first.dir, '.agentlink/state.json'); const state = JSON.parse(readFileSync(statePath, 'utf8')); state.version = 4; for (const room of state.sessions) delete room.marks; writeFileSync(statePath, JSON.stringify(state));
  const { upgradeHubData } = await import('../core/server.ts');
  // While the page's upgrade runs, a command typed at the console arrives.
  const second: ReturnType<typeof console_> = console_(t, { dir: first.dir, upgradeHubData: o => { second.input.write('/invite claude\n'); return upgradeHubData(o); } });
  const p = await page(second); t.after(p.close);
  // A console command waiting at one of its questions: the page's upgrade is refused and changes nothing.
  second.input.write('/invite claude\n'); await until(() => /Name/.test(second.text), 'the invite question');
  const { preview } = (await p.call('POST', '/api/upgrade', { confirm: false })).json;
  const refused = await p.call('POST', '/api/upgrade', { confirm: true, expectedDigest: preview.sourceDigest });
  assert.equal(refused.json.error.message, 'A command at the console is still under way (it may be asking something there): finish it first, then upgrade.'); assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).version, 4);
  second.input.write('Ada\nterminal\n\n\ny\n'); await until(() => existsSync(join(first.dir, '.agentlink/credentials/ada.json')), 'Ada invited');
  const done = await until(async () => { const r = await p.call('POST', '/api/upgrade', { confirm: true, expectedDigest: (await p.call('POST', '/api/upgrade', { confirm: false })).json.preview.sourceDigest }); return r.status === 400 && /still under way/.test(r.json.error.message) ? null : r; }, 'the upgrade');
  assert.equal(done.status, 200, JSON.stringify(done.json));
  await until(() => /peerloom is upgrading its data; try again in a moment\./.test(second.text), 'the console refusing the command typed during the upgrade');
  assert.equal(existsSync(join(first.dir, '.agentlink/credentials/claude.json')), false, 'no invite was started under the upgrade');
  second.input.write('/quit\n'); await second.done;
});

test('a deleted room takes its What next and cards with it: the next room starts with none (GPT, 017-gpt)', { timeout: 60_000 }, async t => {
  const c = console_(t); const p = await page(c); t.after(p.close);
  await p.call('POST', '/api/room', { name: 'Old', workspace: c.dir });
  c.input.write('/invite claude\nAda\nterminal\n\n\ny\n'); await until(() => existsSync(join(c.dir, '.agentlink/credentials/ada.json')), 'Ada invited');
  const ada = join(c.dir, '.agentlink/credentials/ada.json');
  await new Promise<void>((ok, reject) => { const child = spawn(process.execPath, [cliPath, 'suggest', '--client', ada, '--title', 'Old idea', '--text', JSON.stringify({ v: 1, kind: 'idea', gap: 'g', outcome: 'o', evidence: [], why: 'w', payoff: 'p', effort: 'small', impact: 'low', scope: 's', acceptance: ['a'] })]); child.once('exit', code => code === 0 ? ok() : reject(new Error(String(code)))); });
  assert.equal((await p.call('POST', '/api/what_next', { leads: ['Ada'] })).status, 200);
  const old = await until(async () => { const s = await p.state(); return s.recommendations.length && s.whatNext.length && s; }, 'the old room\'s card and What next');
  c.input.write('/delete-room\nOld\n'); await until(() => /Room deleted/.test(c.text), 'the room deleted');
  assert.deepEqual([(await p.state()).recommendations, (await p.state()).whatNext], [[], []], 'nothing of the old room, even before a poll');
  await p.call('POST', '/api/room', { name: 'New', workspace: c.dir }); await new Promise(ok => setTimeout(ok, 300));
  const now = await p.state(); assert.deepEqual([now.recommendations, now.whatNext], [[], []]);
  assert.ok(!JSON.stringify(now).includes(old.recommendations[0].itemId));
  c.input.write('/quit\n'); await c.done;
});

test('making a room writes the map template into its workspace only when there is no map there yet (item 22)', { timeout: 60_000 }, async t => {
  const { MAP_FILE, MAP_TEMPLATE } = await import('../core/map.ts');
  const c = console_(t); const p = await page(c); t.after(p.close);
  await p.call('POST', '/api/room', { name: 'Map room', workspace: c.dir });
  assert.equal(readFileSync(join(c.dir, MAP_FILE), 'utf8'), MAP_TEMPLATE); assert.match(c.text, /Project map: agentlink-map\.txt/);
  c.input.write('/delete-room\nMap room\n'); await until(() => /Room deleted/.test(c.text), 'the room deleted');
  writeFileSync(join(c.dir, MAP_FILE), 'node mine | Mine | doc\n');
  await p.call('POST', '/api/room', { name: 'Map room 2', workspace: c.dir });
  assert.equal(readFileSync(join(c.dir, MAP_FILE), 'utf8'), 'node mine | Mine | doc\n', 'a map already there is the human\'s');
  c.input.write('/quit\n'); await c.done;
});

test('the page shows the project map, checks it only when asked or when it changes after a check, and asks a lead to update it (item 22)', { timeout: 60_000 }, async t => {
  const { MAP_FILE } = await import('../core/map.ts'); const { utimesSync } = await import('node:fs');
  const c = console_(t); const p = await page(c); t.after(p.close);
  mkdirSync(join(c.dir, 'core')); writeFileSync(join(c.dir, 'core/server.ts'), 'x'); writeFileSync(join(c.dir, 'core/cli.ts'), 'x'); utimesSync(join(c.dir, 'core/server.ts'), 1000, 1000);
  await p.call('POST', '/api/room', { name: 'Map page', workspace: c.dir }); await p.call('POST', '/api/run', { op: 'start' });
  c.input.write('/invite claude\nAda\nterminal\n\n\ny\n'); await until(() => existsSync(join(c.dir, '.agentlink/credentials/ada.json')), 'Ada invited');
  const ada = join(c.dir, '.agentlink/credentials/ada.json');
  const run = (...args: string[]) => new Promise<any>((ok, reject) => { const child = spawn(process.execPath, [cliPath, ...args, '--client', ada]); let out = ''; child.stdout.on('data', d => { out += d; }); child.once('exit', code => code === 0 ? ok(JSON.parse(out)) : reject(new Error(out))); });
  let map = (await until(async () => (await p.state()).map?.exists && (await p.state()).map, 'the template map')).map ?? (await p.state()).map;
  assert.deepEqual([map.nodes, map.flows, map.errors, map.check.state, map.update, map.outside, map.updatedBy], [[], [], [], 'unchecked', null, false, null]);
  // A hand edit before any agent's edit is still one made outside Peerloom (GPT, 012-gpt).
  writeFileSync(join(c.dir, MAP_FILE), readFileSync(join(c.dir, MAP_FILE), 'utf8') + '# my note\n');
  assert.deepEqual((await until(async () => { const m = (await p.state()).map; return m.outside && m; }, 'the early hand edit')).updatedBy, null);
  // An agent's edit shows with its author; nothing is checked until the page asks.
  await run('map-edit', '--text', 'add node hub | Hub | service | core/server.ts\nadd node cli | CLI | component | core/cli.ts\nadd flow cli -> hub | requests');
  map = (await until(async () => { const s = await p.state(); return s.map.nodes.length === 2 && s; }, 'the edit on the page')).map;
  assert.deepEqual([map.updatedBy, map.outside, map.flows.map((f: any) => f.id), map.check.state], ['Ada', false, ['cli->hub'], 'unchecked']);
  assert.ok(p.events.some(e => e.type === 'map'));
  // The author is whoever the hub authenticated: a peer the console did not invite by its own name, the owner as human.
  const { request } = await import('../core/client.ts'); const owner = JSON.parse(readFileSync(join(ownerStore(c.dir), 'owner.json'), 'utf8'));
  const invited = await request(owner, 'invite', { requestId: 'pat', name: 'Pat' }); const pat = await request({ endpoint: owner.endpoint, token: invited.token }, 'join', { requestId: 'pat-join', token: invited.token });
  await request(pat, 'map_edit', { requestId: 'pat-1', add: ['node notes | Notes | doc'] });
  assert.equal(await until(async () => { const m = (await p.state()).map; return m.nodes.length === 3 && m.updatedBy; }, 'Pat\'s edit'), 'Pat');
  await request(owner, 'map_edit', { requestId: 'own-1', remove: ['notes'] });
  assert.equal(await until(async () => { const m = (await p.state()).map; return m.nodes.length === 2 && m.updatedBy; }, 'the owner\'s edit'), 'human');
  const opened = await p.call('POST', '/api/map/check', {}); assert.equal(opened.status, 200); assert.ok(['checking', 'done'].includes(opened.json.map.check.state));
  map = (await until(async () => { const s = await p.state(); return s.map.check.state === 'done' && s; }, 'the check')).map;
  assert.equal(map.check.forDigest, map.digest); assert.equal(map.check.forMtimeMs, map.mtimeMs); assert.equal(typeof map.mtimeMs, 'number'); assert.equal(map.check.result, 'complete');
  // The same bytes written again move the baseline the check compares against, so the map is checked again (GPT, 018-gpt).
  const { utimesSync: touch } = await import('node:fs'); const later = (Date.now() + 5000) / 1000; touch(join(c.dir, MAP_FILE), later, later);
  map = (await until(async () => { const s = await p.state(); return s.map.check.state === 'done' && s.map.mtimeMs !== map.mtimeMs && s.map.check.forMtimeMs === s.map.mtimeMs && s; }, 'the recheck on a touch')).map;
  assert.deepEqual([map.check.sources.hub.state, map.check.sources.cli.state], ['present', 'present']);
  assert.deepEqual(map.check.coverage.byArea.find((a: any) => a.area === 'core'), { area: 'core', files: 2, uncited: 0 }, 'the fixture\'s own files are elsewhere in this folder');
  // A hand edit changes the digest: it is said to be outside Peerloom, its bad line is reported, and the map is checked again.
  writeFileSync(join(c.dir, MAP_FILE), readFileSync(join(c.dir, MAP_FILE), 'utf8') + 'node gone | Gone | data | core/deleted.ts\nnot a line\n');
  map = (await until(async () => { const s = await p.state(); return s.map.check.state === 'done' && s.map.check.forDigest === s.map.digest && s.map.errors.length && s; }, 'the recheck')).map;
  assert.deepEqual([map.outside, map.errors.map((e: any) => e.reason.slice(0, 9)), map.check.sources.gone.state], [true, ['a line is'], 'missing']);
  // Update map: one keyed request to the lead, followed to its answer.
  const asked = await p.call('POST', '/api/map/update', { lead: 'ada', requestId: 'u-1' }); assert.equal(asked.status, 200); assert.equal(asked.json.lead, 'Ada');
  assert.deepEqual(await p.call('POST', '/api/map/update', { lead: 'ada', requestId: 'u-1' }), asked);
  const owed = (await run('owed')).requests.find((r: any) => r.collabRequestId === asked.json.collabRequestId);
  for (const words of [/only with map-edit/, /map-edit --client YOUR_CREDENTIAL_FILE --add 'node cli/, /respond --outcome answered/]) assert.match(owed.text, words);
  assert.equal((await until(async () => (await p.state()).map.update, 'the update request')).lead, 'Ada');
  // Each request the human made carries its item's title, so the page need not show the long request text first.
  assert.equal((await p.state()).requests.find((r: any) => r.id === asked.json.collabRequestId)?.title, 'Update the project map');
  await run('respond', '--request', asked.json.collabRequestId, '--outcome', 'answered', '--text', 'Removed gone; nothing else changed.');
  assert.deepEqual(await until(async () => { const u = (await p.state()).map.update; return u.state === 'answered' && [u.state, u.text]; }, 'the answer'), ['answered', 'Removed gone; nothing else changed.']);
  c.input.write('/map\n'); await until(() => /Project map agentlink-map\.txt · 3 nodes, 1 flow/.test(c.text) && /line \d+ a line is/.test(c.text), 'the prompt\'s /map');
  c.input.write('/delete-room\nMap page\n'); await until(() => /Room deleted/.test(c.text), 'deleted'); assert.equal((await p.state()).map, null);
  c.input.write('/quit\n'); await c.done;
});

test('an external harness joins from the page or the prompt, is shown and addressed, and is never hosted, stopped or told (item 23)', { timeout: 60_000 }, async t => {
  const { registerHarness, harnessOf } = await import('../core/harnesses.ts'); const { linkText } = await import('../core/shell.ts');
  if (!harnessOf('fakeext')) registerHarness({ id: 'fakeext', label: 'Fake External', hubName: 'fake-ext', routes: ['external'], wake: { external: 'self-arming' }, approvals: 'none', detect: { bin: '', version: [] }, probe: { date: '2026-10-26T00:00:00.000Z', version: 'test', ok: true, evidence: ['a test descriptor'] } });
  const c = console_(t); const p = await page(c); t.after(p.close);
  await p.call('POST', '/api/room', { name: 'Ext room', workspace: c.dir }); await p.call('POST', '/api/run', { op: 'start' });
  let state = await p.state();
  assert.deepEqual(state.harnesses.find((h: any) => h.id === 'fakeext'), { id: 'fakeext', label: 'Fake External', routes: ['external'], enabled: true, reason: null, source: 'built-in' });
  assert.equal(state.harnesses.find((h: any) => h.id === 'gemini').enabled, false);
  // Not every harness can be invited: an unprobed one says why; an unknown one is refused.
  assert.match((await p.call('POST', '/api/invite', { kind: 'gemini', name: 'Gem' })).json.error.message, /Gemini CLI cannot be invited yet: route unprobed/);
  assert.match((await p.call('POST', '/api/invite', { kind: 'nope', name: 'N' })).json.error.message, /There is no harness called nope/);
  const invited = await p.call('POST', '/api/invite', { kind: 'fakeext', name: 'Ext' }); assert.equal(invited.status, 200, JSON.stringify(invited.json));
  assert.match(invited.json.next, /link --room \S+ Ext/);
  const { request } = await import('../core/client.ts'); const owner = JSON.parse(readFileSync(join(ownerStore(c.dir), 'owner.json'), 'utf8'));
  assert.equal((await request(owner, 'room')).roster.find((r: any) => r.name === 'Ext').harness, 'fake-ext');
  const entry = (s: any) => s.agents.find((a: any) => a.name === 'Ext');
  assert.deepEqual({ ...entry(await p.state()), note: undefined }, { name: 'Ext', kind: 'fakeext', label: 'Fake External', where: 'external', model: null, effort: null, trusted: false, session: 'closed', armed: 'unknown', held: null, note: undefined, controls: { stop: false, relaunch: false, tell: false, settings: false }, state: 'joined' });
  assert.match(entry(await p.state()).note, /It runs in its own session/);
  // Its opening, from the same link command the app route uses: bind, a background wait, fetch, answer, re-arm, and stop on refusals.
  const opening = linkText(join(c.dir, '.agentlink'), 'Ext');
  for (const words of [/bind --client \S*ext\.json/, /wait --client \S*ext\.json --timeout 3300/, /your tool's own background mode \(for example run_in_background\)\. Do not add "&", nohup or a redirect: only that mode brings you back in a new turn when it ends/, /fetch --client \S*ext\.json --wake WAKE_ID/, /reply --client/, /A message that needs no answer is acknowledged with: node \S+ ack --client \S*ext\.json --ids MESSAGE_ID/, /suggest --client/, /map-edit --client/, /Exit 5 .*\/reoffer/, /approvals are your own harness's/]) assert.match(opening, words);
  // A harness the console would have to host, but has no host class for, is refused, not invited as external (DeepSeek, 008).
  if (!harnessOf('fakehost')) registerHarness({ id: 'fakehost', label: 'Fake Hosted', hubName: 'fake-hosted', routes: ['owned'], wake: { owned: 'hosted' }, host: 'claude', approvals: 'relay', detect: { bin: '', version: [] }, probe: { date: '2026-10-26T00:00:00.000Z', version: 'test', ok: true, evidence: ['a test descriptor'] } });
  assert.match((await p.call('POST', '/api/invite', { kind: 'fakehost', name: 'Host' })).json.error.message, /Fake Hosted runs only where peerloom hosts it, and peerloom has no host for it yet/);
  // link's refusals name the route the agent was invited for.
  assert.throws(() => linkText(join(c.dir, '.agentlink'), 'Nobody'), /Nobody is not invited to join from its own session or an app\. Invited: Ext/);
  // It arms by itself; then it is open, and a message reaches it like any agent's.
  const cred = join(c.dir, '.agentlink/credentials/ext.json');
  assert.equal(await cli('bind', '--client', cred, '--label', 'Ext test'), 0);
  const waiting = spawn(process.execPath, [cliPath, 'wait', '--client', cred, '--timeout', '30'], { stdio: 'ignore' }); t.after(() => waiting.kill());
  await until(async () => entry(await p.state()).session === 'open', 'Ext armed'); assert.equal(entry(await p.state()).note, null);
  assert.equal((await p.call('POST', '/api/send', { to: 'Ext', text: 'Hello Ext' })).status, 200);
  await until(() => waiting.exitCode === 0, 'the wait offered work');
  // Never hosted: stop, relaunch and a direct message are refused with the reason.
  for (const verb of ['stop', 'relaunch', 'tell']) assert.match((await p.call('POST', `/api/agents/Ext/${verb}`, { text: 'x' })).json.error.message, /Ext runs in its own session/, verb);
  // The prompt invites the same way, with no questions.
  c.input.write('/invite fakeext Ext2\n'); await until(() => /Ext2 is invited\. In its own session, have it run:/.test(c.text), 'the prompt invite');
  state = await p.state(); assert.equal(entry({ agents: state.agents.map((a: any) => a.name === 'Ext2' ? { ...a, name: 'Ext' } : { ...a, name: '' }) }).where, 'external');
  c.input.write('/quit\n'); await c.done;
});

test('DeepSeek Harness, played by the fake external harness, joins from the page and answers the room with no console special case (item 23)', { timeout: 60_000 }, async t => {
  const c = console_(t); const p = await page(c); t.after(p.close);
  await p.call('POST', '/api/room', { name: 'DSH room', workspace: c.dir }); await p.call('POST', '/api/run', { op: 'start' });
  assert.equal((await p.state()).harnesses.find((h: any) => h.id === 'dsh').enabled, true);
  const invited = await p.call('POST', '/api/invite', { kind: 'dsh', name: 'DeepSeek' }); assert.equal(invited.status, 200, JSON.stringify(invited.json));
  const log = join(c.dir, 'fake.jsonl');
  const fake = spawn(process.execPath, [join(root, 'test/helpers/fake-harness.ts')], { env: { ...process.env, FAKE_HARNESS_CLIENT: join(c.dir, '.agentlink/credentials/deepseek.json'), FAKE_HARNESS_LOG: log, FAKE_HARNESS_WAITS: '1', FAKE_HARNESS_TIMEOUT: '30', FAKE_HARNESS_REPLY: 'DeepSeek here.' }, stdio: 'ignore' });
  t.after(() => fake.kill());
  const open = await until(async () => { const a = (await p.state()).agents.find((x: any) => x.name === 'DeepSeek'); return a.session === 'open' && a; }, 'DeepSeek armed');
  assert.deepEqual([open.label, open.where, open.controls], ['DeepSeek Harness', 'external', { stop: false, relaunch: false, tell: false, settings: false }]);
  assert.equal((await p.call('POST', '/api/send', { text: 'Who is there?' })).status, 200);
  await until(() => p.events.find(e => e.type === 'message' && e.from === 'DeepSeek' && e.text === 'DeepSeek here.' && e.to.includes('human')), 'its answer in the room');
  await until(() => fake.exitCode === 0, 'the fake harness done');
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l).step), ['start', 'bind', 'wait', 'fetch', 'reply', 'done']);
  c.input.write('/quit\n'); await c.done;
});

test('an agent\'s question to the human is in Needs you and answered from the page once, and the run shows its capacity (item 24, slice A)', { timeout: 60_000 }, async t => {
  const { registerHarness, harnessOf } = await import('../core/harnesses.ts');
  if (!harnessOf('fakeext')) registerHarness({ id: 'fakeext', label: 'Fake External', hubName: 'fake-ext', routes: ['external'], wake: { external: 'self-arming' }, approvals: 'none', detect: { bin: '', version: [] }, probe: { date: '2026-10-26T00:00:00.000Z', version: 'test', ok: true, evidence: ['a test descriptor'] } });
  const c = console_(t); const p = await page(c); t.after(p.close);
  await p.call('POST', '/api/room', { name: 'Ask room', workspace: c.dir }); await p.call('POST', '/api/run', { op: 'start' });
  assert.equal((await p.call('POST', '/api/invite', { kind: 'fakeext', name: 'Ext' })).status, 200);
  let state = await p.state();
  assert.deepEqual(state.needsYou, { questions: [], reviews: [] });
  assert.deepEqual(state.run.capacity.offers, { used: 0, cap: 2000 }); assert.equal(state.run.capacity.grants.cap, 500); assert.equal(state.run.capacity.controls.cap, 1000);
  const { request } = await import('../core/client.ts');
  const ext = JSON.parse(readFileSync(join(c.dir, '.agentlink/credentials/ext.json'), 'utf8')); const owner = JSON.parse(readFileSync(join(ownerStore(c.dir), 'owner.json'), 'utf8'));
  const item = await request(ext, 'item_open', { requestId: 'i1', itemType: 'decision', title: 'Which port?' });
  // Two questions at once are two cards, each answered on its own.
  const q1 = await request(ext, 'request', { requestId: 'q1', itemId: item.itemId, purpose: 'decision', to: [owner.participantId], text: 'Port 8080 or 9090?' });
  const q2 = await request(ext, 'request', { requestId: 'q2', itemId: item.itemId, purpose: 'answer', to: [owner.participantId], text: 'May I add a test file?' });
  // A review needs a verdict on an exact revision: it is listed apart, and the answer form refuses it (Codex, seq 39).
  const artifact = await request(ext, 'publish', { requestId: 'a1', itemId: item.itemId, text: 'R1' });
  const review = await request(ext, 'request', { requestId: 'r1', itemId: item.itemId, purpose: 'review', to: [owner.participantId], text: 'Review R1', target: { artifactId: artifact.artifactId, revision: artifact.revision, digest: artifact.digest } });
  state = await until(async () => { const s = await p.state(); return s.needsYou.questions.length === 2 && s.needsYou.questions.every((q: any) => q.item) && s; }, 'both questions in Needs you, with their item');
  assert.deepEqual(state.needsYou.questions.map((q: any) => [q.id, q.from, q.item, q.purpose, q.text]),
    [[q1.collabRequestId, 'Ext', 'Which port?', 'decision', 'Port 8080 or 9090?'], [q2.collabRequestId, 'Ext', 'Which port?', 'answer', 'May I add a test file?']]);
  assert.ok(p.events.some(e => e.type === 'questions'));
  assert.deepEqual(state.needsYou.reviews.map((r: any) => [r.id, r.from, r.purpose, r.target?.artifactId]), [[review.collabRequestId, 'Ext', 'review', artifact.artifactId]]);
  assert.match((await p.call('POST', '/api/answer', { requestId: review.collabRequestId, text: 'looks fine' })).json.error.message, /That is a review/);
  // A refusal for a missing answer; then one answer, pressed twice with the same key, makes one response.
  assert.match((await p.call('POST', '/api/answer', { requestId: q1.collabRequestId, text: ' ' })).json.error.message, /An answer is required/);
  assert.match((await p.call('POST', '/api/answer', { requestId: q1.collabRequestId, outcome: 'maybe', text: 'x' })).json.error.message, /outcome is answered or declined/);
  const press = { requestId: q1.collabRequestId, outcome: 'answered', text: '9090', key: 'answer-q1' };
  const [a, b] = [await p.call('POST', '/api/answer', press), await p.call('POST', '/api/answer', press)];
  assert.equal(a.status, 200, JSON.stringify(a.json)); assert.equal(b.status, 200, JSON.stringify(b.json));
  assert.equal(a.json.response.responseId, b.json.response.responseId);
  assert.equal((await p.call('POST', '/api/answer', { requestId: q2.collabRequestId, outcome: 'declined', text: 'Not yet' })).status, 200);
  await until(async () => (await p.state()).needsYou.questions.length === 0, 'both answered questions leave Needs you');
  const asked = ((await request(ext, 'requests', { filter: 'owed_to_me' })).requests as any[]).filter(r => r.purpose !== 'review');
  assert.deepEqual(asked.map(r => [r.collabRequestId, r.responses.length, r.responses[0].outcome, r.responses[0].text]), [[q1.collabRequestId, 1, 'answered', '9090'], [q2.collabRequestId, 1, 'declined', 'Not yet']]);
  c.input.write('/quit\n'); await c.done;
});

test('a room made before item 24 has its owner credential moved out of the workspace once, and keeps working (PRIORITIES 1)', { timeout: 60_000 }, async t => {
  const first = console_(t); const p = await page(first); t.after(p.close);
  await p.call('POST', '/api/room', { name: 'Old room', workspace: first.dir });
  const stored = join(ownerStore(first.dir), 'owner.json'); const legacy = join(first.dir, '.agentlink/credentials/owner.json');
  first.input.write('/quit\n'); await first.done; p.close();
  // Put it back where an older peerloom kept it.
  writeFileSync(legacy, readFileSync(stored)); rmSync(stored);
  const storedAdmin = join(ownerStore(first.dir), 'admin.json'); const legacyAdmin = join(first.dir, '.agentlink/admin.json');
  assert.ok(existsSync(storedAdmin)); assert.ok(!existsSync(legacyAdmin), 'the hub administrator credential is not in the workspace either');
  writeFileSync(legacyAdmin, readFileSync(storedAdmin)); rmSync(storedAdmin);
  const again = console_(t, { dir: first.dir }); const q = await page(again); t.after(q.close);
  await until(() => again.text.includes('Your credential moved out of the workspace'), 'the move is said');
  assert.ok(existsSync(stored)); assert.ok(!existsSync(legacy)); assert.ok(existsSync(storedAdmin)); assert.ok(!existsSync(legacyAdmin));
  assert.equal(JSON.parse(readFileSync(join(ownerStore(first.dir), 'room.json'), 'utf8')).dataDir, join(first.dir, '.agentlink'));
  assert.equal((await q.state()).room.name, 'Old room');
  assert.equal((await q.call('POST', '/api/run', { op: 'start' })).status, 200);
  again.input.write('/quit\n'); await again.done;
});

test('a join line is made on the page; the /j route answers only the peerloom command, the same for every ticket, and a claim shows its pairing code to approve or refuse (item 24, slice B)', { timeout: 60_000 }, async t => {
  const { registerHarness, harnessOf } = await import('../core/harnesses.ts');
  if (!harnessOf('fakeext')) registerHarness({ id: 'fakeext', label: 'Fake External', hubName: 'fake-ext', routes: ['external'], wake: { external: 'self-arming' }, approvals: 'none', detect: { bin: '', version: [] }, probe: { date: '2026-10-26T00:00:00.000Z', version: 'test', ok: true, evidence: ['a test descriptor'] } });
  const c = console_(t); const p = await page(c); t.after(p.close);
  assert.match((await p.call('POST', '/api/join-line', {})).json.error.message, /Make the room first/);
  await p.call('POST', '/api/room', { name: 'Join room', workspace: c.dir });
  assert.match((await p.call('POST', '/api/join-line', { harness: 'gemini' })).json.error.message, /Gemini CLI cannot be invited yet/);
  const made = (await p.call('POST', '/api/join-line', {})).json;
  const url = new URL(/peerloom join (\S+) --harness HARNESS/.exec(made.line)![1]); const ticket = url.pathname.split('/')[2];
  assert.equal(url.host.split(':')[0], '127.0.0.1'); assert.match(made.paste, /You are done only when you are listening for messages/); assert.match(made.paste, /fakeext/);
  // The agent's side, with no page token and none of the page's headers.
  const raw = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; text: string; headers: any }>((ok, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: Number(url.port), method, path, headers: { host: url.host, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', d => { text += d; }); res.on('end', () => ok({ status: res.statusCode!, text, headers: res.headers })); });
    req.on('error', reject); req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)); });
  // GET is the same text for a real ticket and a made-up one, and names no room.
  const help = await raw('GET', url.pathname); const other = await raw('GET', `/j/alj_${'Z'.repeat(32)}`);
  assert.equal(help.status, 200); assert.match(help.headers['content-type'], /^text\/plain/); assert.equal(help.headers['referrer-policy'], 'no-referrer'); assert.equal(help.headers['cache-control'], 'no-store');
  assert.equal(help.text.replace(ticket, 'T'), other.text.replace(`alj_${'Z'.repeat(32)}`, 'T')); assert.ok(!help.text.includes('Join room'));
  // A change is refused from a web page, from another site, as anything but JSON, when too large, or with the wrong Host.
  const claimBody = { secret: 's'.repeat(40), harness: 'fakeext', label: 'Fake External session' };
  assert.equal((await raw('POST', `${url.pathname}/claim`, claimBody, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await raw('POST', `${url.pathname}/claim`, claimBody, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await raw('POST', `${url.pathname}/claim`, 'secret=x', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await raw('POST', `${url.pathname}/claim`, { ...claimBody, label: 'x'.repeat(5000) })).status, 413);
  assert.equal((await raw('POST', `${url.pathname}/claim`, claimBody, { host: 'localhost:1' })).status, 403);
  assert.equal((await raw('GET', `${url.pathname}/claim`)).status, 405);
  // A made-up ticket gets the uniform answer; the real one makes a claim.
  const bogus = await raw('POST', `/j/alj_${'Z'.repeat(32)}/claim`, claimBody); assert.equal(bogus.status, 404); assert.equal(JSON.parse(bogus.text).error.code, 'invalid');
  const claimed = await raw('POST', `${url.pathname}/claim`, claimBody); assert.equal(claimed.status, 200, claimed.text);
  const { pairingCode, claimId } = JSON.parse(claimed.text); assert.match(pairingCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(!claimed.text.includes('Join room'));
  let state = await until(async () => { const s = await p.state(); return s.joins.length === 1 && s; }, 'the claim on the page');
  assert.deepEqual(state.joins.map((j: any) => [j.claimId, j.label, j.harness, j.pairingCode, j.state]), [[claimId, 'Fake External session', 'fakeext', pairingCode, 'claimed']]);
  assert.ok(p.events.some(e => e.type === 'joins'));
  const polled = await raw('POST', `${url.pathname}/poll`, { secret: claimBody.secret }); assert.equal(JSON.parse(polled.text).state, 'awaiting_approval');
  assert.equal((await raw('POST', `${url.pathname}/claim`, { ...claimBody, secret: 't'.repeat(40) })).status, 409);
  // Refused: nobody joins, and the line is used up.
  assert.equal((await p.call('POST', '/api/join-refuse', { claimId })).json.join.state, 'refused');
  assert.equal(JSON.parse((await raw('POST', `${url.pathname}/poll`, { secret: claimBody.secret })).text).state, 'refused');
  state = await p.state(); assert.deepEqual(state.joins, []); assert.deepEqual(state.agents, []);
  const { request } = await import('../core/client.ts'); const owner = JSON.parse(readFileSync(join(ownerStore(c.dir), 'owner.json'), 'utf8'));
  assert.deepEqual((await request(owner, 'room')).roster.map((r: any) => r.name), ['human']);
  // Neither the ticket nor the claim secret is in the journal or the console's output.
  const journal = readFileSync(join(c.dir, '.agentlink/joins.json'), 'utf8'); assert.ok(!journal.includes(ticket) && !journal.includes(claimBody.secret));
  assert.ok(!c.text.includes(claimBody.secret));
  c.input.write('/quit\n'); await c.done;
});

test('a pasted agent, once approved and listening, gets one welcome and is verified by its first answer (item 24, slice B)', { timeout: 60_000 }, async t => {
  const c = console_(t); const p = await page(c); t.after(p.close);
  await p.call('POST', '/api/room', { name: 'Verify room', workspace: c.dir }); await p.call('POST', '/api/run', { op: 'start' });
  const url = new URL(/peerloom join (\S+) --harness/.exec((await p.call('POST', '/api/join-line', { harness: 'dsh' })).json.line)![1]);
  const post = (path: string, body: unknown) => new Promise<any>((ok, reject) => { const req = httpRequest({ host: '127.0.0.1', port: Number(url.port), method: 'POST', path, headers: { host: url.host, 'content-type': 'application/json' } }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', d => { text += d; }); res.on('end', () => ok(JSON.parse(text))); }); req.on('error', reject); req.end(JSON.stringify(body)); });
  const { claimId } = await post(`${url.pathname}/claim`, { secret: 'v'.repeat(40), harness: 'dsh', label: 'DSH test' });
  const approved = (await p.call('POST', '/api/join-approve', { claimId })).json.join; assert.equal(approved.state, 'approved');
  const entry = async () => (await p.state()).agents.find((a: any) => a.name === approved.name);
  assert.equal((await entry()).state, 'joined');
  const cred = join(c.dir, '.agentlink/agents', approved.agentId, 'credential.json');
  assert.equal(await cli('bind', '--client', cred, '--label', 'DSH test'), 0);
  const wait = () => new Promise<string>(ok => { const child = spawn(process.execPath, [cliPath, 'wait', '--client', cred, '--timeout', '20'], { stdio: ['ignore', 'pipe', 'ignore'] }); let out = ''; child.stdout.on('data', d => { out += d; }); t.after(() => child.kill()); child.once('exit', () => ok(out)); });
  const woken = wait();
  // Listening: the welcome goes out once, and wakes it.
  const wake = JSON.parse(await woken).wakeId;
  const fetched = await new Promise<any>(ok => { const child = spawn(process.execPath, [cliPath, 'fetch', '--client', cred, '--wake', wake], { stdio: ['ignore', 'pipe', 'ignore'] }); let out = ''; child.stdout.on('data', d => { out += d; }); child.once('exit', () => ok(JSON.parse(out))); });
  assert.match(fetched.units[0].view.text, /^Welcome to Verify room\. Reply with one line/);
  assert.equal(await cli('reply', '--client', cred, '--wake', wake, '--text', 'I can hear the room.'), 0);
  await until(() => JSON.parse(readFileSync(join(c.dir, '.agentlink/shell.json'), 'utf8')).agents[approved.name].verify === 'done', 'verified after its answer');
  assert.equal(JSON.parse(readFileSync(join(c.dir, '.agentlink/shell.json'), 'utf8')).agents[approved.name].verify, 'done');
  // Listening again, it shows as verified, and no second welcome is sent.
  const again = wait(); await until(async () => (await entry()).state === 'verified', 'verified while listening');
  const welcomes = (await p.state()).messages.filter((m: any) => /^Welcome to Verify room/.test(m.text)); assert.equal(welcomes.length, 1);
  assert.match(c.text, /is verified: it answered in the room/);
  c.input.write('/quit\n'); await c.done; await again;
});

test('a pasted agent profile goes in the room workspace, which the approval names; a stuck approval is retried or refused from the page (Codex, seq 55)', { timeout: 60_000 }, async t => {
  const clock = { at: Date.now() }; const c = console_(t, { now: () => clock.at }); const p = await page(c); t.after(p.close);
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'agentlink-workspace-'))); t.after(() => rmSync(workspace, { recursive: true, force: true }));
  await p.call('POST', '/api/room', { name: 'Elsewhere', workspace }); await p.call('POST', '/api/run', { op: 'start' });
  const line = async () => new URL(/peerloom join (\S+) --harness/.exec((await p.call('POST', '/api/join-line', { harness: 'dsh' })).json.line)![1]);
  const post = (url: URL, path: string, body: unknown) => new Promise<any>((ok, reject) => { const req = httpRequest({ host: '127.0.0.1', port: Number(url.port), method: 'POST', path, headers: { host: url.host, 'content-type': 'application/json' } }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', d => { text += d; }); res.on('end', () => ok(JSON.parse(text))); }); req.on('error', reject); req.end(JSON.stringify(body)); });
  const first = await line(); const { claimId } = await post(first, `${first.pathname}/claim`, { secret: 'w'.repeat(40), harness: 'dsh', label: 'A' });
  const done = (await p.call('POST', '/api/join-approve', { claimId })).json.join;
  assert.ok(existsSync(join(workspace, '.agentlink/agents', done.agentId, 'credential.json')), 'in the room workspace');
  assert.ok(!existsSync(join(c.dir, '.agentlink/agents', done.agentId)), 'not in the console folder');
  assert.equal((await post(first, `${first.pathname}/poll`, { secret: 'w'.repeat(40) })).workspace, workspace);
  assert.equal(JSON.parse(readFileSync(join(c.dir, '.agentlink/shell.json'), 'utf8')).agents[done.name].credential, join(workspace, '.agentlink/agents', done.agentId, 'credential.json'));
  // A profile that cannot be written leaves the approval part done; past its window the page says so and offers Retry.
  const second = await line(); const claim2 = (await post(second, `${second.pathname}/claim`, { secret: 'x'.repeat(40), harness: 'dsh', label: 'B' })).claimId;
  const agents = join(workspace, '.agentlink/agents'); const saved = `${agents}.kept`; const { renameSync } = await import('node:fs');
  renameSync(agents, saved); writeFileSync(agents, 'not a directory');
  assert.notEqual((await p.call('POST', '/api/join-approve', { claimId: claim2 })).status, 200);
  assert.equal((await p.state()).joins.find((j: any) => j.claimId === claim2).state, 'approving');
  clock.at += 61 * 60_000;
  const late = await p.call('POST', '/api/join-approve', { claimId: claim2 }); assert.equal(late.status, 409); assert.match(late.json.error.message, /Retry carries on with the same identity/);
  const stuck = (await p.state()).joins.find((j: any) => j.claimId === claim2); assert.deepEqual([stuck.state, stuck.retry], ['reconcile', true]);
  rmSync(agents); renameSync(saved, agents);
  const retried = (await p.call('POST', '/api/join-approve', { claimId: claim2, retry: true })).json; assert.equal(retried.join.state, 'approved', JSON.stringify(retried));
  assert.ok(existsSync(join(agents, retried.join.agentId, 'credential.json')));
  const { request } = await import('../core/client.ts'); const owner = JSON.parse(readFileSync(join(ownerStore(c.dir), 'owner.json'), 'utf8'));
  assert.equal((await request(owner, 'room')).roster.filter((r: any) => r.harness === 'dsh').length, 2, 'two agents, no extra participant from the retry');
  c.input.write('/quit\n'); await c.done;
});

test('the page shows per-recipient receipts, reactions and working lines, and sends posts, no-reply mail and @mentions that wake only who they name (item 24, slice C)', { timeout: 60_000 }, async t => {
  const { registerHarness, harnessOf } = await import('../core/harnesses.ts');
  if (!harnessOf('fakeext')) registerHarness({ id: 'fakeext', label: 'Fake External', hubName: 'fake-ext', routes: ['external'], wake: { external: 'self-arming' }, approvals: 'none', detect: { bin: '', version: [] }, probe: { date: '2026-10-26T00:00:00.000Z', version: 'test', ok: true, evidence: ['a test descriptor'] } });
  const c = console_(t); const p = await page(c); t.after(p.close);
  await p.call('POST', '/api/room', { name: 'Quiet room', workspace: c.dir }); await p.call('POST', '/api/run', { op: 'start' });
  for (const name of ['Ann', 'Bob', 'Cid']) assert.equal((await p.call('POST', '/api/invite', { kind: 'fakeext', name })).status, 200);
  const cred = (name: string) => join(c.dir, `.agentlink/credentials/${name.toLowerCase()}.json`);
  const { request } = await import('../core/client.ts'); const as = (name: string) => JSON.parse(readFileSync(cred(name), 'utf8'));
  // @mentions: two named agents get it, the third does not.
  assert.equal((await p.call('POST', '/api/send', { text: 'Ann and Bob, look', to: ['Ann', 'Bob'], noReply: true, key: 'm1' })).status, 200);
  assert.match((await p.call('POST', '/api/send', { text: 'x', post: true, noReply: true })).json.error.message, /A post never asks for a reply/);
  assert.equal((await p.call('POST', '/api/send', { text: 'FYI: the build is green', post: true })).status, 200);
  let state = await until(async () => { const s = await p.state(); return s.messages.length === 2 && s; }, 'both messages on the page');
  const [mail, post] = state.messages;
  assert.deepEqual([mail.kind, mail.noReply, mail.to, post.kind, post.to.length], ['mail', true, ['Ann', 'Bob'], 'post', 3]);
  assert.match(mail.id, /^m_/); assert.equal(mail.threadId, mail.id);
  await until(async () => (await p.state()).messages[0].receipts.length === 2, 'receipts for the mail');
  assert.deepEqual((await p.state()).messages[0].receipts, [{ to: 'Ann', state: 'stored' }, { to: 'Bob', state: 'stored' }]);
  // Cid was not named and the post wakes nobody: Cid has nothing to be woken for.
  assert.equal((await request(as('Cid'), 'inbox')).messages.filter((m: any) => m.messageKind === undefined).length, 0);
  // Ann acknowledges and reacts; Bob says he is working on it. The page follows, and nobody is woken by any of it.
  const offersBefore = (await p.state()).run.capacity.offers.used;
  await request(as('Ann'), 'ack', { requestId: 'a1', messageIds: [mail.id] });
  await request(as('Ann'), 'react', { requestId: 'r1', messageId: mail.id, emoji: '👍' });
  await request(as('Bob'), 'activity', { requestId: 'w1', state: 'working', messageId: mail.id, text: 'checking the build' });
  state = await until(async () => { const s = await p.state(); return s.messages[0].reactions.length === 1 && s.activity.length === 1 && s; }, 'the reaction and the working line');
  assert.deepEqual(state.messages[0].receipts, [{ to: 'Ann', state: 'acknowledged' }, { to: 'Bob', state: 'stored' }]);
  assert.deepEqual(state.messages[0].reactions, [{ by: 'Ann', emoji: '👍' }]);
  assert.deepEqual(state.activity.map((a: any) => [a.name, a.state, a.messageId, a.text]), [['Bob', 'working', mail.id, 'checking the build']]);
  assert.ok(p.events.some(e => e.type === 'receipts' && e.updates.some((u: any) => u.id === mail.id))); assert.ok(p.events.some(e => e.type === 'activity'));
  assert.equal(state.run.capacity.offers.used, offersBefore, 'receipts, reactions and activity make no offers');
  // The human reacts too, once, and can take it back.
  const once = { messageId: mail.id, emoji: '✅', key: 'h1' };
  assert.equal((await p.call('POST', '/api/react', once)).json.reaction.changed, true); assert.equal((await p.call('POST', '/api/react', once)).json.reaction.changed, true);
  await until(async () => (await p.state()).messages[0].reactions.length === 2, 'the human reaction');
  assert.equal((await p.call('POST', '/api/react', { messageId: mail.id, emoji: '✅', on: false })).json.reaction.on, false);
  await until(async () => (await p.state()).messages[0].reactions.length === 1, 'the human reaction removed');
  assert.match((await p.call('POST', '/api/react', { messageId: mail.id, emoji: '💩' })).json.error.message, /emoji is one of/);
  await request(as('Bob'), 'activity', { requestId: 'w2', state: 'done' });
  await until(async () => (await p.state()).activity.length === 0, 'done clears the working line');
  c.input.write('/quit\n'); await c.done;
});

test('a Cursor join line writes a /agentlink command into the room workspace and is pasted as /agentlink URL; deleting the room takes the command (item 25)', { timeout: 60_000 }, async t => {
  const { cursorCommand } = await import('../core/shell-agents.ts');
  const c = console_(t); const p = await page(c); t.after(p.close);
  await p.call('POST', '/api/room', { name: 'Cursor room', workspace: c.dir });
  const command = join(c.dir, '.cursor/commands/agentlink.md');
  // Another harness's line writes nothing for Cursor.
  await p.call('POST', '/api/join-line', { harness: 'dsh' }); assert.equal(existsSync(command), false);
  const made = (await p.call('POST', '/api/join-line', { harness: 'cursor' })).json;
  assert.match(made.paste, /^\/agentlink http:\/\/127\.0\.0\.1:\d+\/j\/alj_[A-Za-z0-9_-]{32}$/);
  assert.match(made.line, /--harness cursor$/);
  const text = readFileSync(command, 'utf8'); assert.equal(text, cursorCommand());
  for (const words of [/peerloom join URL --harness cursor --name Cursor/, /pairing code/, /run the exact same command again/, /background option, not "&"/, /Do not look for credentials/]) assert.match(text, words);
  assert.ok(!/alj_[A-Za-z0-9_-]{32}/.test(text), 'the command holds no ticket');
  c.input.write('/delete-room\nCursor room\n');
  await until(() => /Room deleted/.test(c.text), 'the room deleted'); assert.equal(existsSync(command), false);
  c.input.write('/quit\n'); await c.done;
});
