import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// `core/profiles.ts` is Codex's module for item 24 (log/005-opus.md: profileDir, readProfile, writeProfile, resolveAs).
// While the module is not on this branch the group is skipped rather than failing the rest of the suite; the guard is
// removed before this slice is reviewed.
const profiles: any = await import('../core/profiles.ts').then(module => module, () => null);
const skip = profiles ? false : 'core/profiles.ts has not landed on this branch yet';
const id = 'dsh-3k9q';
const credential = (n = 1) => ({ endpoint: 'http://127.0.0.1:1234', sessionId: 's_room', participantId: `p_agent_${n}`, token: `${n}`.repeat(43) });
const mode = (path: string) => statSync(path).mode & 0o777;

function world(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'agentlink-profiles-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, data: join(dir, '.agentlink') };
}
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

test('a profile is one directory per identity with a 0600 credential and an index entry', { skip }, t => {
  const { data } = world(t);
  const dir = profiles.profileDir(data, id);
  assert.equal(dir, join(data, 'agents', id), 'the profile lives under agents/<id> in the room data directory');

  profiles.writeProfile(data, { id, name: 'DeepSeek', harness: 'dsh', credential: credential(1) });
  const record = profiles.readProfile(data, id);
  assert.equal(record.id, id);
  assert.equal(record.name, 'DeepSeek');
  assert.equal(record.harness, 'dsh');
  const canonical = realpathSync(dir);
  assert.equal(record.credentialPath, join(canonical, 'credential.json'));
  assert.equal(record.stateDir, canonical, 'binding, wait and lock resolve to the same directory as the credential');
  assert.equal(mode(dir), 0o700, 'the profile directory is private to its owner');
  assert.ok(existsSync(record.credentialPath));
  assert.equal(mode(record.credentialPath), 0o600, 'the credential is private to its owner');
  assert.equal(json(record.credentialPath).token, credential(1).token, 'the credential is stored byte-for-byte');

  // A second identity merges into the same index instead of replacing it, and the index names the room and harness.
  profiles.writeProfile(data, { id: 'claude-7k2q', name: 'Claude', harness: 'claude-code', credential: credential(2) });
  const index = json(join(data, 'agents', 'index.json'));
  assert.deepEqual(Object.keys(index).sort(), [id, 'claude-7k2q'].sort());
  assert.equal(index[id].name, 'DeepSeek');
  assert.equal(index[id].harness, 'dsh');
  assert.equal(typeof index[id].roomId, 'string', 'the index records which room the profile joined');
  assert.equal(index['claude-7k2q'].name, 'Claude');
  assert.equal(mode(join(data, 'agents', 'index.json')) & 0o077, 0, 'the index is not world- or group-readable');
  // No half-written temporary file is left beside the credential or the index.
  assert.deepEqual(readdirSync(join(data, 'agents')).filter(name => /\.tmp$/.test(name)), []);
});

test('a second profile for the same id is refused instead of replacing the identity', { skip }, t => {
  const { data } = world(t);
  profiles.writeProfile(data, { id, name: 'DeepSeek', harness: 'dsh', credential: credential() });
  const before = readFileSync(profiles.profileDir(data, id) + '/credential.json', 'utf8');
  assert.throws(() => profiles.writeProfile(data, { id, name: 'Impostor', harness: 'dsh', credential: credential() }), (error: any) => error?.code === 'profile_collision' || /different profile|exist|already|collision|refus/i.test(String(error?.message ?? '')));
  assert.equal(readFileSync(profiles.profileDir(data, id) + '/credential.json', 'utf8'), before, 'the first credential is untouched');
  assert.equal(json(join(data, 'agents', 'index.json'))[id].name, 'DeepSeek');
});

test('an identical repeat is idempotent while a changed credential is refused', { skip }, t => {
  const { data } = world(t);
  const first = profiles.writeProfile(data, { id, name: 'DeepSeek', harness: 'dsh', credential: credential(1) });
  const again = profiles.writeProfile(data, { id, name: 'DeepSeek', harness: 'dsh', credential: credential(1) });
  assert.deepEqual(again, first, 'a retried approval recovers the same profile without a second identity');
  assert.throws(() => profiles.writeProfile(data, { id, name: 'DeepSeek', harness: 'dsh', credential: { ...credential(), token: 'u'.repeat(43) } }), 'a different credential under the same id is refused');
  assert.equal(json(join(data, 'agents', 'index.json'))[id].name, 'DeepSeek');
});

test('one participant has one canonical profile: another id for the same credential is refused', { skip }, t => {
  const { data } = world(t);
  profiles.writeProfile(data, { id, name: 'DeepSeek', harness: 'dsh', credential: credential(1) });
  assert.throws(() => profiles.writeProfile(data, { id: 'codex-4m8v', name: 'Codex', harness: 'codex', credential: credential(1) }),
    (error: any) => error?.code === 'profile_collision' && /canonical|already|participant/i.test(String(error?.message ?? '')));
  assert.deepEqual(Object.keys(json(join(data, 'agents', 'index.json'))), [id], 'no second profile was indexed');
});

test('an invalid id or a symlinked profile path is refused rather than written through', { skip }, t => {
  const { data } = world(t);
  for (const bad of ['Bad/../id', 'dsh-3k9q/../other', '../escape', '', 'DSH-3K9Q']) {
    assert.throws(() => profiles.writeProfile(data, { id: bad, name: 'Bad', harness: 'dsh', credential: credential() }), `refuses ${JSON.stringify(bad)}`);
  }
  for (const name of ['human', 'owner', 'all']) assert.throws(() => profiles.writeProfile(data, { id: 'dsh-9z9z', name, harness: 'dsh', credential: credential() }), `refuses the reserved name ${name}`);
  // A symlink where the profile directory belongs must not direct the credential write somewhere else.
  const elsewhere = join(data, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  mkdirSync(join(data, 'agents'), { recursive: true });
  symlinkSync(elsewhere, join(data, 'agents', id));
  assert.throws(() => profiles.writeProfile(data, { id, name: 'DeepSeek', harness: 'dsh', credential: credential() }));
  assert.equal(existsSync(join(elsewhere, 'credential.json')), false, 'nothing was written through the link');
  assert.equal(existsSync(join(data, 'agents', id)), true, 'the link was left as it was');
});

test('resolveAs walks up from a working directory to the room index', { skip }, t => {
  const { dir, data } = world(t);
  profiles.writeProfile(data, { id, name: 'DeepSeek', harness: 'dsh', credential: credential() });
  const nested = join(dir, 'project', 'packages', 'app');
  mkdirSync(nested, { recursive: true });
  const before = process.cwd();
  try {
    process.chdir(nested);
    const found = profiles.resolveAs(id);
    assert.equal(found.id, id);
    assert.equal(realpathSync(found.credentialPath), realpathSync(join(data, 'agents', id, 'credential.json')));
    assert.throws(() => profiles.resolveAs('zzzz-0000'), 'an id outside the index is refused');
  } finally { process.chdir(before); }
});

test('the index and credential stay readable after an interrupted-looking write', { skip }, t => {
  const { data } = world(t);
  profiles.writeProfile(data, { id, name: 'DeepSeek', harness: 'dsh', credential: credential() });
  const index = join(data, 'agents', 'index.json');
  profiles.writeProfile(data, { id: 'codex-4m8v', name: 'Codex', harness: 'codex', credential: credential(2) });
  // The index parses as one whole object after two writes; a partially written one would have thrown above.
  assert.deepEqual(Object.keys(json(index)).sort(), [id, 'codex-4m8v'].sort());
  // A damaged index is reported, never silently replaced by an empty one that forgets the first identity.
  writeFileSync(index, '{not json');
  assert.throws(() => profiles.writeProfile(data, { id: 'claude-7k2q', name: 'Claude', harness: 'claude-code', credential: credential() }), /index|json|read/i);
  assert.equal(readFileSync(index, 'utf8'), '{not json', 'the damaged index is left for a human to inspect');
});
