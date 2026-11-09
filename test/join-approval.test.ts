import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliPath, console_, joinBackend as joinModule, joinSkip, page, raw, runCli, until } from './helpers/join-testkit.ts';

// The item 24 slice B join matrix (plan.md, codex 001 §Acceptance): the console page, the /j route, a real hub, the
// profile store and a real CLI credential, end to end. The helper skips the group with one message while the join
// backend is not on the branch that runs it.
async function claimLine(p: Awaited<ReturnType<typeof page>>, options: { harness?: string; label?: string; secret?: string } = {}) {
  const made = (await p.call('POST', '/api/join-line', { harness: options.harness ?? 'fakeext' })).json;
  const url = new URL(/peerloom join (\S+) --harness/.exec(made.line)![1]);
  const ticket = url.pathname.split('/')[2]; const secret = options.secret ?? ('claim-secret-' + 'x'.repeat(24));
  const claimed = await raw(p.port, p.host, 'POST', `${url.pathname}/claim`, { secret, harness: options.harness ?? 'fakeext', label: options.label ?? 'Fake External session' });
  return { line: made.line, url, ticket, secret, claimed, claimId: claimed.json?.claimId as string, pairingCode: claimed.json?.pairingCode as string };
}

test('an approved join creates exactly one participant, profile and listening agent; a double press is one join', { skip: joinSkip, timeout: 90_000 }, async t => {
  const clock = { at: Date.parse('2026-10-29T10:00:00Z') };
  const c = console_(t, { now: () => clock.at }); const p = await page(c); t.after(p.close);
  await p.call('POST', '/api/room', { name: 'Join room', workspace: c.dir });
  const made = await claimLine(p);
  assert.equal(made.claimed.status, 200, made.claimed.text);
  assert.match(made.pairingCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const shown = await until(async () => { const s = await p.state(); return s.joins.length === 1 && s; }, 'the claim in Needs you');
  assert.deepEqual(shown.joins.map((j: any) => [j.claimId, j.label, j.harness, j.pairingCode, j.state]), [[made.claimId, 'Fake External session', 'fakeext', made.pairingCode, 'claimed']]);
  assert.ok(p.events.some(e => e.type === 'joins'));
  // Two presses at once: one participant, one profile, one record.
  const [first, second] = await Promise.all([p.call('POST', '/api/join-approve', { claimId: made.claimId }), p.call('POST', '/api/join-approve', { claimId: made.claimId })]);
  assert.equal(first.status, 200, JSON.stringify(first.json)); assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.equal(first.json.join.state, 'approved'); assert.equal(first.json.join.agentId, second.json.join.agentId);
  assert.equal(first.json.join.name, 'Fake');
  // The profile lives in the workspace, private, indexed, and its credential works at the hub.
  const agentId = first.json.join.agentId; const profile = join(c.dir, '.agentlink', 'agents', agentId);
  assert.equal(statSync(join(profile, 'credential.json')).mode & 0o777, 0o600);
  const credential = JSON.parse(readFileSync(join(profile, 'credential.json'), 'utf8'));
  assert.deepEqual(JSON.parse(readFileSync(join(c.dir, '.agentlink', 'agents', 'index.json'), 'utf8'))[agentId].name, 'Fake');
  const { request } = await import('../core/client.ts');
  const roster = (await request(credential, 'room')).roster as any[];
  assert.deepEqual(roster.filter(r => r.kind === 'agent').map(r => [r.name, r.harness]), [['Fake', 'fake-ext']]);
  // The console records the agent once, with its short id and the profile's credential path, and Needs you is clear.
  const saved = JSON.parse(readFileSync(join(c.dir, '.agentlink', 'shell.json'), 'utf8'));
  assert.deepEqual([saved.agents.Fake.agentId, saved.agents.Fake.external, saved.agents.Fake.participantId], [agentId, true, credential.participantId]);
  let state = await p.state(); assert.deepEqual(state.joins, []); assert.deepEqual(state.agents.map((a: any) => [a.name, a.state]), [['Fake', 'joined']]);
  // Exactly one agent, one profile, one journal entry.
  const peers = await until(async () => { const r = await request(credential, 'room'); const list = r.roster.filter((x: any) => x.kind === 'agent'); return list.length === 1 ? list : null; }, 'one agent');
  assert.equal(peers.length, 1);
  const journal = JSON.parse(readFileSync(join(c.dir, '.agentlink', 'joins.json'), 'utf8'));
  assert.deepEqual(Object.values(journal.entries).map((e: any) => e.state), ['approved']);
  // Listening is the profile credential's own armed wait; the page shows the state word, not a claim of success.
  assert.match(saved.agents.Fake.credential, /agents\/.+\/credential\.json$/);
  const binding = await runCli(['bind', '--client', join(profile, 'credential.json'), '--label', 'Fake External session']);
  assert.equal(binding.code, 0, binding.text);
  const wait = spawn(process.execPath, [cliPath, 'wait', '--client', join(profile, 'credential.json'), '--timeout', '8'], { stdio: 'ignore' });
  t.after(() => wait.kill('SIGKILL'));
  await until(async () => (await p.state()).agents.some((a: any) => a.name === 'Fake' && a.state === 'listening'), 'the agent listening', 10_000);
  wait.kill('SIGTERM'); state = await p.state();
  assert.equal(state.agents.find((a: any) => a.name === 'Fake').state, 'listening');
  c.input.write('/quit\n'); await c.done;
});

test('a refused claim creates no participant, a disabled harness and an expired ticket leave no claim, and a ticket is single-use', { skip: joinSkip, timeout: 90_000 }, async t => {
  const clock = { at: Date.parse('2026-10-29T10:00:00Z') };
  const c = console_(t, { now: () => clock.at }); const p = await page(c); t.after(p.close);
  await p.call('POST', '/api/room', { name: 'Refuse room', workspace: c.dir });
  // Refused before approval: the agent never joins.
  const refused = await claimLine(p);
  assert.equal((await p.call('POST', '/api/join-refuse', { claimId: refused.claimId })).json.join.state, 'refused');
  assert.deepEqual((await p.state()).agents, []); assert.deepEqual((await p.state()).joins, []);
  assert.equal((await raw(p.port, p.host, 'POST', `${refused.url.pathname}/poll`, { secret: refused.secret })).json.state, 'refused');
  // A harness the registry refuses is refused before a claim exists.
  const made = (await p.call('POST', '/api/join-line', {})).json;
  const url = new URL(/peerloom join (\S+) --harness HARNESS/.exec(made.line)![1]);
  const badHarness = await raw(p.port, p.host, 'POST', `${url.pathname}/claim`, { secret: 'claim-secret-' + 'y'.repeat(24), harness: 'gemini', label: 'Gemini' });
  assert.equal(badHarness.status, 400); assert.match(badHarness.json.error.message, /Gemini CLI/);
  assert.deepEqual((await p.state()).joins, []);
  // A claim not approved before the ticket expires disappears, and only its own claimant is told.
  const expiring = await claimLine(p);
  clock.at += joinModule.TICKET_MS + 1;
  assert.deepEqual((await p.state()).joins, []);
  assert.equal((await raw(p.port, p.host, 'POST', `${expiring.url.pathname}/poll`, { secret: expiring.secret })).json.state, 'expired');
  assert.equal((await raw(p.port, p.host, 'POST', `${expiring.url.pathname}/poll`, { secret: 'claim-secret-' + 'z'.repeat(24) })).status, 404);
  const expiredPress = await p.call('POST', '/api/join-approve', { claimId: expiring.claimId });
  assert.notEqual(expiredPress.status, 200); assert.match(JSON.stringify(expiredPress.json), /expired|no longer waiting/i);
  assert.deepEqual((await p.state()).agents, []);
  // One ticket, one claim: the same secret reruns, another is refused, and the old ticket is spent after approval.
  clock.at = Date.parse('2026-10-29T10:00:00Z');
  const single = await claimLine(p);
  const again = await raw(p.port, p.host, 'POST', `${single.url.pathname}/claim`, { secret: single.secret, harness: 'fakeext', label: 'Fake External session' });
  assert.equal(again.status, 200); assert.deepEqual([again.json.claimId, again.json.pairingCode], [single.claimId, single.pairingCode]);
  assert.equal((await raw(p.port, p.host, 'POST', `${single.url.pathname}/claim`, { secret: 'claim-secret-' + 'w'.repeat(24), harness: 'fakeext', label: 'Other' })).status, 409);
  assert.equal((await p.call('POST', '/api/join-approve', { claimId: single.claimId })).status, 200);
  // The same secret still recovers the same, approved claim; any other secret gets the conflict and no claim.
  const reused = await raw(p.port, p.host, 'POST', `${single.url.pathname}/claim`, { secret: single.secret, harness: 'fakeext', label: 'Fake External session' });
  assert.equal(reused.status, 200); assert.deepEqual([reused.json.claimId, reused.json.state], [single.claimId, 'approved']);
  assert.equal((await raw(p.port, p.host, 'POST', `${single.url.pathname}/claim`, { secret: 'claim-secret-' + 'v'.repeat(24), harness: 'fakeext', label: 'Other' })).status, 409);
  c.input.write('/quit\n'); await c.done;
});

test('an occupied name gets the next free one, and a profile write that fails surfaces without recording a join', { skip: joinSkip, timeout: 90_000 }, async t => {
  const c = console_(t); const p = await page(c); t.after(p.close);
  await p.call('POST', '/api/room', { name: 'Names room', workspace: c.dir });
  const invited = await p.call('POST', '/api/invite', { kind: 'fakeext', name: 'Fake' });
  assert.equal(invited.status, 200, JSON.stringify(invited.json));
  const taken = await claimLine(p, { label: 'Fake External session' });
  // Break the profile store the way a full disk or a missing directory does: a file where the agents directory belongs.
  const agents = join(c.dir, '.agentlink', 'agents');
  if (existsSync(agents)) rmSync(agents, { recursive: true, force: true });
  writeFileSync(agents, 'not a directory');
  const failed = await p.call('POST', '/api/join-approve', { claimId: taken.claimId });
  assert.notEqual(failed.status, 200); assert.match(JSON.stringify(failed.json), /profile|directory|agent/i);
  let state = await p.state();
  assert.deepEqual(state.joins.map((j: any) => j.state), ['approving'], 'the interrupted approval stays visible');
  assert.deepEqual(state.agents.map((a: any) => a.name), ['Fake'], 'no half-recorded agent');
  // Repair it and press again: the same identity finishes, with the next free name because Fake is taken.
  rmSync(agents); mkdirSync(agents, { recursive: true, mode: 0o700 });
  const done = await p.call('POST', '/api/join-approve', { claimId: taken.claimId });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.join.name, 'Fake2');
  assert.equal(done.json.join.state, 'approved');
  assert.ok(existsSync(join(agents, done.json.join.agentId, 'credential.json')));
  state = await p.state(); assert.deepEqual(state.joins, []);
  assert.deepEqual(state.agents.map((a: any) => a.name).sort(), ['Fake', 'Fake2']);
  c.input.write('/quit\n'); await c.done;
});

test('an approval the console stopped in the middle carries on to the same identity on the next start', { skip: joinSkip, timeout: 90_000 }, async t => {
  const first = console_(t); const p = await page(first); t.after(p.close);
  await p.call('POST', '/api/room', { name: 'Recover room', workspace: first.dir });
  const claimed = await claimLine(p, { label: 'Recovered session' });
  assert.equal(claimed.claimed.status, 200);
  p.close(); first.input.write('/quit\n'); await first.done;
  // The journal as a crash between choosing the identity and calling the hub leaves it.
  const path = join(first.dir, '.agentlink', 'joins.json'); const journal = JSON.parse(readFileSync(path, 'utf8'));
  const hash = createHash('sha256').update(claimed.ticket).digest('hex');
  const entry = journal.entries[hash]; assert.ok(entry, 'the ticket is in the journal by hash');
  entry.state = 'approving'; entry.approval = { startedAt: Date.now(), name: 'Fake', agentId: 'fake-abcd' };
  writeFileSync(path, JSON.stringify(journal), { mode: 0o600 });
  // The next console finishes it on its own, before the page is asked anything.
  const second = console_(t, { dir: first.dir }); const q = await page(second); t.after(q.close);
  const state = await until(async () => { const s = await q.state(); return s.agents.some((a: any) => a.name === 'Fake') && s; }, 'the recovered join', 20_000);
  assert.deepEqual(state.agents.map((a: any) => [a.name, a.state]), [['Fake', 'joined']]);
  const saved = JSON.parse(readFileSync(join(second.dir, '.agentlink', 'shell.json'), 'utf8'));
  assert.deepEqual([saved.agents.Fake.agentId, saved.agents.Fake.external], ['fake-abcd', true], 'the journal identity is the one recorded');
  assert.ok(existsSync(join(second.dir, '.agentlink', 'agents', 'fake-abcd', 'credential.json')));
  assert.deepEqual(JSON.parse(readFileSync(join(second.dir, '.agentlink', 'joins.json'), 'utf8')).entries[hash].state, 'approved');
  second.input.write('/quit\n'); await second.done;
});

test('the /j boundary answers only the command form and never leaks a ticket, a claim or a room', { skip: joinSkip, timeout: 60_000 }, async t => {
  const c = console_(t); const p = await page(c); t.after(p.close);
  await p.call('POST', '/api/room', { name: 'Boundary room', workspace: c.dir });
  const made = (await p.call('POST', '/api/join-line', { harness: 'fakeext' })).json;
  const url = new URL(/peerloom join (\S+) --harness/.exec(made.line)![1]); const ticket = url.pathname.split('/')[2];
  const path = url.pathname;
  // GET is plain text, cache-free, unreferable, and the same for a real and a made-up ticket.
  const help = await raw(p.port, p.host, 'GET', path); const other = await raw(p.port, p.host, 'GET', `/j/alj_${'A'.repeat(32)}`);
  assert.equal(help.status, 200); assert.match(String(help.headers['content-type']), /^text\/plain/);
  assert.deepEqual([help.headers['cache-control'], help.headers['referrer-policy'], help.headers['x-frame-options']], ['no-store', 'no-referrer', 'DENY']);
  assert.equal(help.text.replace(ticket, 'T'), other.text.replace(`alj_${'A'.repeat(32)}`, 'T'));
  assert.ok(!help.text.includes('Boundary room') && !help.text.includes(c.dir));
  // A change is refused from a web page, from another site, as a non-JSON body, and with the wrong Host.
  const body = { secret: 'claim-secret-' + 'q'.repeat(24), harness: 'fakeext', label: 'Fake External session' };
  assert.equal((await raw(p.port, p.host, 'POST', `${path}/claim`, body, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await raw(p.port, p.host, 'POST', `${path}/claim`, body, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await raw(p.port, p.host, 'POST', `${path}/claim`, 'secret=x', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await raw(p.port, p.host, 'POST', `${path}/claim`, '{not json')).status, 400);
  assert.equal((await raw(p.port, p.host, 'POST', `${path}/claim`, body, { host: 'localhost:1' })).status, 403);
  assert.equal((await raw(p.port, p.host, 'GET', `${path}/claim`)).status, 405);
  // One uniform answer for an unknown ticket, and no CORS header on any answer.
  const unknown = await raw(p.port, p.host, 'POST', `/j/alj_${'B'.repeat(32)}/claim`, body);
  assert.equal(unknown.status, 404); assert.deepEqual(Object.keys(unknown.json.error).sort(), ['code', 'message']);
  assert.equal(unknown.json.error.code, 'invalid'); assert.equal(unknown.headers['access-control-allow-origin'], undefined);
  // A real claim answers with the code, never with a room, a credential or the secret; the journal keeps only hashes.
  const claimed = await raw(p.port, p.host, 'POST', `${path}/claim`, body);
  assert.equal(claimed.status, 200);
  assert.ok(!claimed.text.includes(body.secret) && !claimed.text.includes('Boundary room') && !claimed.text.includes(c.dir));
  const journal = readFileSync(join(c.dir, '.agentlink', 'joins.json'), 'utf8');
  assert.ok(!journal.includes(ticket) && !journal.includes(body.secret));
  assert.ok(!c.text.includes(body.secret));
  c.input.write('/quit\n'); await c.done;
});
