import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from '../core/client.ts';
import { startHub } from '../core/server.ts';

const root = resolve(import.meta.dirname, '..');
const fixture = join(import.meta.dirname, 'fixtures', 'v1');
const v1 = readFileSync(join(fixture, 'state.json.fixture'));
const fixtureCredentials = JSON.parse(readFileSync(join(fixture, 'credentials.json'), 'utf8'));

function store(t: { after(fn: () => void): void }, seed?: Buffer) {
  const data = mkdtempSync(join(tmpdir(), 'agentlink-retry-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  if (seed) writeFileSync(join(data, 'state.json'), seed, { mode: 0o600 });
  return { data, state: join(data, 'state.json'), admin: join(data, 'admin.json') };
}
// Starts an in-process hub that is closed when the test ends, however it ends: a failed assertion must not leave a
// listening server behind and hang the run.
async function up(t: { after(fn: () => unknown): void }, options: { dataDir: string; port: number; upgradeState?: boolean }) {
  const hub = await startHub(options); let closed = false;
  const close = async () => { if (!closed) { closed = true; await hub.close(); } };
  t.after(close);
  return { ...hub, close };
}
// A hub that starts when it should have refused is closed before the test fails, so the failure reports instead of hanging.
async function refusesToStart(options: { dataDir: string; port: number; upgradeState?: boolean }, name?: string) {
  let started: Awaited<ReturnType<typeof startHub>> | undefined;
  try { started = await startHub(options); } catch { return; }
  await started.close();
  assert.fail(`The hub started${name ? ` despite ${name}` : ''}`);
}
const outcome = (promise: Promise<any>) => promise.then(value => ({ value, code: 'ok' }), (error: any) => ({ value: undefined, code: error.code as string }));
// Every bearer token a hub has ever handed out is 32 random bytes in base64url. Hashes are hex and sealed parts
// have other lengths, so a standalone 43-character base64url string in the store is a credential in the clear.
const tokensIn = (text: string) => text.match(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g) ?? [];

async function hubProcess(data: string, ...flags: string[]) {
  const child = spawn(process.execPath, ['core/server.ts', '--data', data, '--port', '0', ...flags], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const ready = await new Promise<any>((ok, reject) => {
    let buffer = '';
    child.stdout.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { try { ok(JSON.parse(buffer.split('\n')[0])); } catch (error) { reject(error); } } });
    child.once('exit', () => reject(new Error(`Hub exited before startup: ${stderr}`)));
  });
  return { endpoint: ready.endpoint as string, notice: () => stderr, kill: async () => { if (child.exitCode !== null || child.signalCode !== null) return; const gone = once(child, 'exit'); child.kill('SIGKILL'); await gone; } };
}

// Room setup with fixed retry keys, returning exactly what each caller sent and received.
async function setUp(endpoint: string, adminPath: string) {
  const admin = { endpoint, token: JSON.parse(readFileSync(adminPath, 'utf8')).token as string };
  const createBody = { requestId: 'create', name: 'Sealed', workspace: tmpdir() };
  const owner = await request(admin, 'create', createBody);
  const inviteBody = { requestId: 'invite', name: 'Astra' };
  const invitation = await request(owner, 'invite', inviteBody);
  const joinBody = { requestId: 'join', token: invitation.token };
  const astra = await request({ endpoint, token: invitation.token }, 'join', joinBody);
  return { admin, createBody, owner, inviteBody, invitation, joinBody, astra };
}

test('a store written by the hub holds no bearer token, yet identical retries recover working credentials after SIGKILL', { timeout: 60_000 }, async t => {
  const s = store(t); let hub = await hubProcess(s.data); t.after(() => hub.kill());
  const first = await setUp(hub.endpoint, s.admin);
  await request(first.astra, 'send', { requestId: 'm', to: 'human', text: 'hello' });
  const issued = [first.owner.token, first.invitation.token, first.astra.token];
  const saved = readFileSync(s.state, 'utf8');
  for (const token of [...issued, first.admin.token]) assert.ok(!saved.includes(token), 'an issued or presented token is in the store');
  assert.deepEqual(tokensIn(saved), [], 'nothing shaped like a bearer token is in the store');
  assert.equal(JSON.parse(saved).version, 6);
  assert.equal((await request(first.astra, 'capabilities')).retryCredentials, 'sealed');
  assert.equal(hub.notice(), '', 'a sealed store prints no plaintext notice');

  await hub.kill(); hub = await hubProcess(s.data);
  const at = (credential: any) => ({ ...credential, endpoint: hub.endpoint });
  // The response to each of these was "lost"; the caller repeats exactly what it sent.
  const owner = await request(at(first.admin), 'create', first.createBody);
  const invitation = await request(at(first.owner), 'invite', first.inviteBody);
  const astra = await request({ endpoint: hub.endpoint, token: first.invitation.token }, 'join', first.joinBody);
  assert.deepEqual([owner.token, invitation.token, astra.token], issued);
  assert.deepEqual({ ...owner, endpoint: '' }, { ...first.owner, endpoint: '' }, 'the whole first result comes back, not only the token');
  assert.equal(invitation.invitationId, first.invitation.invitationId); assert.equal(astra.participantId, first.astra.participantId);
  // Recovered credentials are the real ones: they authenticate, and nothing was created twice.
  assert.equal((await request(at(astra), 'room')).self, first.astra.participantId);
  assert.deepEqual((await request(at(owner), 'room')).roster.map((p: any) => p.name), ['human', 'Astra']);
  assert.equal((await request(at(astra), 'history')).messages.length, 1);
  assert.deepEqual(tokensIn(readFileSync(s.state, 'utf8')), [], 'recovering a credential does not write it back');
  assert.equal((await outcome(request(at(first.owner), 'invite', { ...first.inviteBody, role: 'Changed' }))).code, 'request_conflict');
});

test('a sealed credential opens only for the token that was presented, and only in its own record', async t => {
  const s = store(t); let hub = await up(t, { dataDir: s.data, port: 0 });
  const first = await setUp(hub.endpoint, s.admin);
  const second = await request(first.owner, 'invite', { requestId: 'invite-2', name: 'Bolt' });
  await hub.close();

  // Someone who can edit the store moves Bolt's sealed invitation onto Astra's retry record.
  const tampered = JSON.parse(readFileSync(s.state, 'utf8'));
  const [a, b] = Object.keys(tampered.requests).filter(key => key.endsWith(':invite') || key.endsWith(':invite-2')).sort((x, y) => x.length - y.length);
  tampered.requests[a].sealed = tampered.requests[b].sealed;
  writeFileSync(s.state, JSON.stringify(tampered));
  hub = await up(t, { dataDir: s.data, port: 0 });
  const owner = { ...first.owner, endpoint: hub.endpoint };
  const swapped = await outcome(request(owner, 'invite', first.inviteBody));
  assert.equal(swapped.code, 'credential_unrecoverable'); assert.equal(swapped.value, undefined);
  assert.equal((await request(owner, 'invite', { requestId: 'invite-2', name: 'Bolt' })).token, second.token, 'the untouched record still opens');
  await hub.close();

  // The administrator file is lost, so the hub mints a new administrator token. The old create result was sealed
  // under the old one: the retry is refused rather than answered with someone else's owner credential.
  rmSync(s.admin);
  hub = await up(t, { dataDir: s.data, port: 0 });
  try {
    const newAdmin = { endpoint: hub.endpoint, token: JSON.parse(readFileSync(s.admin, 'utf8')).token };
    assert.notEqual(newAdmin.token, first.admin.token);
    assert.equal((await outcome(request(newAdmin, 'create', first.createBody))).code, 'credential_unrecoverable');
    assert.equal((await outcome(request({ ...first.admin, endpoint: hub.endpoint }, 'create', first.createBody))).code, 'invalid_token');
    assert.equal((await request({ ...first.owner, endpoint: hub.endpoint }, 'room')).name, 'Sealed', 'the owner credential itself is unaffected');
  } finally { await hub.close(); }
});

// What each caller of the fixture room originally sent and received, read from the version 1 store itself.
function fixtureCalls() {
  const state = JSON.parse(v1.toString('utf8')); const session = state.sessions[0];
  const result = (suffix: string) => state.requests[Object.keys(state.requests).find(key => key.endsWith(suffix))!].result;
  const calls = (name: string) => {
    const invited = result(`:invite-${name}`); const joined = result(`:join-${name}`);
    return { inviteBody: { requestId: `invite-${name}`, name, role: 'Peer', harness: 'cli' }, invitationToken: invited.token as string, invitationId: invited.invitationId as string,
      joinBody: { requestId: `join-${name}`, token: invited.token }, participantToken: joined.token as string, participantId: joined.participantId as string };
  };
  return { session, astra: calls('Astra'), bolt: calls('Bolt') };
}

// These tests recover credentials while the original invitations are valid.
// Freeze only Date at a point within that interval; the literal fixture and
// byte-for-byte backup assertions stay unchanged as the wall clock advances.
function duringFixtureInvitation(t: any) {
  const invitations = fixtureCalls().session.invitations;
  t.mock.timers.enable({ apis: ['Date'], now: Math.min(...invitations.map((i: any) => i.expiresAt)) - 1000 });
}

test('upgrading the version 1 fixture seals every credential, and lost invite and join responses are still recoverable', async t => {
  duringFixtureInvitation(t);
  const before = v1.toString('utf8');
  const exposed = [...new Set(tokensIn(before))];
  assert.ok(exposed.length >= 5, 'the fixture really does contain plaintext tokens');
  const calls = fixtureCalls();
  assert.equal(calls.astra.participantToken, fixtureCredentials.astra.token);

  const s = store(t, v1); let hub = await up(t, { dataDir: s.data, port: 0, upgradeState: true });
  const after = readFileSync(s.state, 'utf8');
  assert.deepEqual(tokensIn(after), []);
  for (const token of exposed) assert.ok(!after.includes(token));
  assert.equal(JSON.parse(after).version, 6);
  assert.deepEqual(readFileSync(join(s.data, 'state.v1.backup.json')), v1, 'the backup is the original file, plaintext included');
  await hub.close(); hub = await up(t, { dataDir: s.data, port: 0 });                   // recovery must survive a restart, not just the upgrade process
  const owner = { endpoint: hub.endpoint, token: fixtureCredentials.owner.token };
  for (const who of [calls.astra, calls.bolt]) {
    // The invite response was "lost" before the upgrade: the owner repeats it and gets the same invitation back.
    const invitation = await request(owner, 'invite', who.inviteBody);
    assert.equal(invitation.token, who.invitationToken); assert.equal(invitation.invitationId, who.invitationId);
    // The join response was "lost" before the upgrade: the invitee repeats it and gets the same credential, which works.
    const joined = await request({ endpoint: hub.endpoint, token: who.invitationToken }, 'join', who.joinBody);
    assert.equal(joined.token, who.participantToken);
    assert.equal((await request({ endpoint: hub.endpoint, token: joined.token }, 'room')).self, who.participantId);
  }
  assert.deepEqual((await request(owner, 'room')).roster.map((p: any) => p.name), ['human', 'Astra', 'Bolt'], 'nothing was created twice');
  assert.equal((await outcome(request(owner, 'invite', { requestId: 'invite-Astra', name: 'Mallory' }))).code, 'request_conflict');
  // The fixture has no administrator file, so the token that would seal its create result is truly absent.
  const admin = { endpoint: hub.endpoint, token: JSON.parse(readFileSync(s.admin, 'utf8')).token };
  const created = await outcome(request(admin, 'create', { requestId: 'create-room', name: 'Fixture room', workspace: calls.session.workspace, objective: 'v1 fixture' }));
  assert.equal(created.code, 'credential_unrecoverable'); assert.equal(created.value, undefined);
  assert.deepEqual(tokensIn(readFileSync(s.state, 'utf8')), [], 'recovering credentials writes none of them back');
});

test('a credential is removed on upgrade only when the token that would seal it is absent from the old store', async t => {
  duringFixtureInvitation(t);
  const calls = fixtureCalls(); const state = JSON.parse(v1.toString('utf8'));
  // Astra's invite record is gone from this old store, so nothing holds the invitation token her join was made with.
  delete state.requests[Object.keys(state.requests).find(key => key.endsWith(':invite-Astra'))!];
  // A different token sits where Bolt's invitation token was; it does not match the hash the hub authenticates by.
  state.requests[Object.keys(state.requests).find(key => key.endsWith(':invite-Bolt'))!].result.token = 'x'.repeat(43);
  const s = store(t, Buffer.from(JSON.stringify(state))); const hub = await up(t, { dataDir: s.data, port: 0, upgradeState: true });
  for (const who of [calls.astra, calls.bolt]) {
    const joined = await outcome(request({ endpoint: hub.endpoint, token: who.invitationToken }, 'join', who.joinBody));
    assert.equal(joined.code, 'credential_unrecoverable'); assert.equal(joined.value, undefined, 'a refusal, never a reply without its credential');
    assert.equal((await request({ endpoint: hub.endpoint, token: who.participantToken }, 'room')).self, who.participantId, 'the saved credential still works');
  }
  assert.deepEqual(tokensIn(readFileSync(s.state, 'utf8')), []);
});

test('upgrading a version 2 store reseals create, invite and join results and backs up the original', async t => {
  // A genuine version 2 store: the fixture's shape, then a room created, invited and joined on it without upgrading.
  const two = JSON.parse(v1.toString('utf8')); two.version = 2; for (const session of two.sessions) session.events = [];
  const s = store(t, Buffer.from(JSON.stringify(two)));
  let hub = await up(t, { dataDir: s.data, port: 0 });
  const first = await setUp(hub.endpoint, s.admin);
  assert.equal((await request(first.owner, 'capabilities')).retryCredentials, 'plaintext');
  assert.equal(hub.stateVersion, 2);
  await hub.close();
  const original = readFileSync(s.state);
  for (const token of [first.owner.token, first.invitation.token, first.astra.token]) assert.ok(original.includes(token), 'an un-upgraded version 2 store records credentials in the clear');

  hub = await up(t, { dataDir: s.data, port: 0, upgradeState: true });
  assert.equal(hub.stateVersion, 6);
  assert.deepEqual(readFileSync(join(s.data, 'state.v2.backup.json')), original);
  assert.equal(existsSync(join(s.data, 'state.v1.backup.json')), false);
  assert.deepEqual(tokensIn(readFileSync(s.state, 'utf8')), []);
  await hub.close(); hub = await up(t, { dataDir: s.data, port: 0 });
  const at = (credential: any) => ({ ...credential, endpoint: hub.endpoint });
  assert.equal((await request(at(first.admin), 'create', first.createBody)).token, first.owner.token);
  assert.equal((await request(at(first.owner), 'invite', first.inviteBody)).token, first.invitation.token);
  const rejoined = await request({ endpoint: hub.endpoint, token: first.invitation.token }, 'join', first.joinBody);
  assert.equal(rejoined.token, first.astra.token);
  assert.equal((await request(at(rejoined), 'room')).self, first.astra.participantId);
  await hub.close();
  // On a store that is already version 4 the flag changes nothing and writes no further backup.
  const sealed = readFileSync(s.state);
  hub = await up(t, { dataDir: s.data, port: 0, upgradeState: true }); await hub.close();
  assert.deepEqual(readFileSync(s.state), sealed); assert.equal(existsSync(join(s.data, 'state.v4.backup.json')), false);
});

test('an administrator file that exists without a usable token stops startup and is not replaced', async t => {
  for (const [name, content] of [['an empty object', '{}'], ['a null token', '{"token":null}'], ['a short token', '{"token":"abc"}'], ['a JSON null', 'null'], ['text that is not JSON', 'not json']] as const) {
    for (const upgradeState of [false, true]) {
      const s = store(t, v1); writeFileSync(s.admin, content);
      await refusesToStart({ dataDir: s.data, port: 0, upgradeState }, `${name}${upgradeState ? ' during upgrade' : ''}`);
      assert.equal(readFileSync(s.admin, 'utf8'), content, `${name}: the administrator file is left as found`);
      assert.deepEqual(readFileSync(s.state), v1, `${name}: the store is not upgraded or rewritten`);
      assert.equal(existsSync(join(s.data, 'state.v1.backup.json')), false);
      assert.equal(existsSync(join(s.data, 'hub.lock')), false, 'the failed start leaves no lock');
    }
  }
  // Absence is the one case where a token is minted.
  const s = store(t, v1); const hub = await up(t, { dataDir: s.data, port: 0 });
  assert.match(JSON.parse(readFileSync(s.admin, 'utf8')).token, /^[A-Za-z0-9_-]{43}$/);
});

test('an older store that is not upgraded keeps working, says its credentials are in plain text, and is not rewritten into the new form', { timeout: 30_000 }, async t => {
  const s = store(t, v1); const hub = await hubProcess(s.data); t.after(() => hub.kill());
  for (let waited = 0; !hub.notice() && waited < 2000; waited += 25) await new Promise(ok => setTimeout(ok, 25));
  assert.match(hub.notice(), /state version 1.*plain text.*--upgrade-state/s);
  const astra = { endpoint: hub.endpoint, token: fixtureCredentials.astra.token };
  assert.equal((await request(astra, 'capabilities')).retryCredentials, 'plaintext');
  await request(astra, 'send', { requestId: 'still-v1', to: 'human', text: 'hi' });
  const saved = JSON.parse(readFileSync(s.state, 'utf8'));
  assert.equal(saved.version, 1);
  assert.ok(Object.values(saved.requests).every((r: any) => r.sealed === undefined && r.unrecoverable === undefined));
});

test('a version 3 store with a plaintext credential, a malformed seal or a contradictory record does not start, and is left as found', async t => {
  const s = store(t); const hub = await up(t, { dataDir: s.data, port: 0 });
  const first = await setUp(hub.endpoint, s.admin);
  await request(first.astra, 'send', { requestId: 'm', to: 'human', text: 'an ordinary result' }); await hub.close();
  const legacy = JSON.parse(readFileSync(s.state, 'utf8')); legacy.version = 3;
  for (const session of legacy.sessions) delete session.delivery;
  const good = Buffer.from(JSON.stringify(legacy));
  const record = (state: any, suffix: string) => state.requests[Object.keys(state.requests).find(key => key.endsWith(suffix))!];
  const damage: [string, (state: any) => void][] = [
    ['a credential written back in the clear', state => { record(state, ':join').result.token = first.astra.token; }],
    ['a seal with an extra field', state => { record(state, ':invite').sealed.hint = 'x'; }],
    ['a seal with a truncated nonce', state => { record(state, ':invite').sealed.nonce = 'AAAA'; }],
    ['a record both sealed and marked removed', state => { record(state, ':create').unrecoverable = true; }],
    ['a removal marker that is not true', state => { const r = record(state, ':join'); delete r.sealed; r.unrecoverable = 'yes'; }],
    ['an unknown retry-record field', state => { record(state, ':join').token = first.astra.token; }],
    ['a create result with neither seal nor removal marker', state => { delete record(state, ':create').sealed; }],
    ['an invite result with neither seal nor removal marker', state => { delete record(state, ':invite').sealed; }],
    ['a join result with neither seal nor removal marker', state => { delete record(state, ':join').sealed; }],
    ['a seal on a result that issued no credential', state => { record(state, ':m').sealed = record(state, ':invite').sealed; }],
    ['a removal marker on a result that issued no credential', state => { record(state, ':m').unrecoverable = true; }],
  ];
  for (const [name, corrupt] of damage) {
    const state = JSON.parse(good.toString('utf8')); corrupt(state);
    const bytes = Buffer.from(JSON.stringify(state)); writeFileSync(s.state, bytes);
    await refusesToStart({ dataDir: s.data, port: 0 }, name);
    assert.deepEqual(readFileSync(s.state), bytes, name);
  }
  // Sealed fields do not belong in an older store either.
  const old = JSON.parse(v1.toString('utf8')); old.requests[Object.keys(old.requests)[0]].unrecoverable = true;
  const t2 = store(t, Buffer.from(JSON.stringify(old)));
  await refusesToStart({ dataDir: t2.data, port: 0 });
});
