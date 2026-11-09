import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { startHub } from '../core/server.ts';
import { credential, request } from '../core/client.ts';
import { MAP_FILE, MAP_MAX_BYTES, mapDigest } from '../core/map.ts';
import { prepareMapEdit, commitMapEdit } from '../core/map-store.ts';

async function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'agentlink-map-hub-')); const workspace = join(root, 'project'); const dataDir = join(root, 'hub'); mkdirSync(workspace);
  let hub = await startHub({ dataDir, port: 0 });
  t.after(async () => { await hub.close(); rmSync(root, { recursive: true, force: true }); });
  const owner = await request(credential(hub.adminPath), 'create', { requestId: 'room', name: 'Map room', workspace });
  const auth = () => ({ ...owner, endpoint: hub.endpoint });
  return { root, workspace, dataDir, path: join(workspace, MAP_FILE), owner, auth,
    stop: () => hub.close(), restart: async () => { hub = await startHub({ dataDir, port: 0 }); },
    call: (op: string, body = {}) => request(auth(), op, body),
    agent: async (name: string) => {
      const invited = await request(auth(), 'invite', { requestId: `invite-${name}`, name });
      const joined = await request(auth(), 'join', { requestId: `join-${name}`, token: invited.token }); return { ...joined, endpoint: hub.endpoint };
    } };
}

test('map room verbs authenticate participants, serialize edits, preserve hand-written lines and persist keyed results', async t => {
  const f = await fixture(t); const a = await f.agent('Claude'); const b = await f.agent('Codex');
  assert.ok((await f.call('capabilities')).operations.includes('map_edit'));
  await assert.rejects(request({ ...f.auth(), token: 'invalid' }, 'map'), { code: 'invalid_token' });
  const empty = await f.call('map'); assert.equal(empty.exists, false); assert.equal(empty.digest, mapDigest(''));
  writeFileSync(f.path, '# Human note\r\nthis is an error line\r\n'); chmodSync(f.path, 0o600);
  const before = await f.call('map'); assert.equal(before.errors[0].line, 2);
  const body = { requestId: 'first', base: before.digest, add: ['node ui | Browser | ui | ui/', 'node hub | Hub | service | core/server.ts', 'flow ui -> hub | sends actions'] };
  const first = await request(a, 'map_edit', body); assert.deepEqual(first.added, ['ui', 'hub', 'ui->hub']);
  assert.equal(statSync(f.path).mode & 0o777, 0o600, 'atomic replacement preserves existing map permissions');
  assert.equal((await f.call('map')).mtimeMs, statSync(f.path).mtimeMs, 'source-check baseline keeps sub-millisecond stat precision');
  assert.ok(readFileSync(f.path, 'utf8').startsWith('# Human note\r\nthis is an error line\r\n'));
  const edits = await Promise.all(Array.from({ length: 12 }, (_, i) => request(i % 2 ? a : b, 'map_edit', { requestId: `parallel-${i}`, add: [`node n${i} | Part ${i} | component`] })));
  assert.equal(new Set(edits.map(e => e.digest)).size, 12);
  const map = await f.call('map'); assert.equal(map.nodes.length, 14); assert.equal(map.errors.length, 1);
  assert.ok(['Claude', 'Codex'].includes(map.lastEdit.by)); assert.equal(map.lastEdit.digest, map.digest);
  assert.deepEqual(await request(a, 'map_edit', body), first, 'retries are receipts, not another edit');
  await assert.rejects(request(a, 'map_edit', { ...body, add: ['node extra | Changed request | doc'] }), { code: 'request_conflict' });
  const rewire = await request(b, 'map_edit', { requestId: 'rewire', remove: ['ui->hub'], add: ['flow hub -> ui | live events'] });
  assert.deepEqual(rewire.removed, ['ui->hub']); assert.deepEqual(rewire.added, ['hub->ui']);
  await f.stop(); await f.restart();
  assert.equal((await f.call('map')).nodes.length, 14);
  assert.deepEqual(await request({ ...a, endpoint: f.auth().endpoint }, 'map_edit', body), first);
  assert.equal((await f.call('map')).lastEdit, null, 'author metadata is explicitly since startup');
});

test('refused map edits preserve all bytes, including malformed lines and CRLF', async t => {
  const f = await fixture(t);
  const original = '# note\r\nnode a | A | ui\r\nnode b | B | service\r\nflow a -> b | calls\r\nflow a -> b | watches\r\nmalformed\r\n'; writeFileSync(f.path, original);
  const cases = [
    ['duplicate_id', { add: ['node a | Duplicate | doc'] }],
    ['unknown_id', { remove: ['missing'] }],
    ['dangling_flow', { remove: ['a'] }],
    ['dangling_flow', { add: ['flow a -> absent | no target'] }],
    ['ambiguous_id', { remove: ['a->b'] }],
    ['invalid_line', { add: ['node bad | bad | ui | ../secret'] }],
    ['invalid_line', { add: ['node one | One | ui\nnode two | Two | ui'] }],
    ['map_changed', { base: '0'.repeat(64), add: ['node c | C | doc'] }],
    ['unknown_field', { add: ['node c | C | doc'], sender: 'human' }],
    ['invalid_field', { add: 'not an array' }],
    ['empty_edit', {}],
  ] as const;
  for (const [code, edit] of cases) {
    await assert.rejects(f.call('map_edit', { requestId: `refuse-${code}`, ...edit }), { code });
    assert.equal(readFileSync(f.path, 'utf8'), original);
  }
  const changed = await f.call('map_edit', { requestId: 'replace', remove: ['a->b|calls', 'b'], add: ['node b | New B | data'] });
  assert.deepEqual(changed.removed, ['a->b|calls', 'b']); assert.equal((await f.call('map')).errors[0].text, 'malformed');
});

test('map file containment, special files, UTF-8 and byte bounds fail safely', async t => {
  const f = await fixture(t); const external = join(f.root, 'outside.txt'); writeFileSync(external, 'private'); symlinkSync(external, f.path);
  await assert.rejects(f.call('map'), { code: 'map_unsafe' });
  await assert.rejects(f.call('map_edit', { requestId: 'symlink', add: ['node a | A | ui'] }), { code: 'map_unsafe' });
  assert.equal(readFileSync(external, 'utf8'), 'private'); rmSync(f.path);
  mkdirSync(f.path); await assert.rejects(f.call('map'), { code: 'map_unsafe' }); rmSync(f.path, { recursive: true });
  writeFileSync(f.path, Buffer.from([0xc3, 0x28])); await assert.rejects(f.call('map'), { code: 'map_unsafe' });
  writeFileSync(f.path, 'x'.repeat(MAP_MAX_BYTES + 1)); await assert.rejects(f.call('map'), { code: 'map_too_large' });
  await assert.rejects(f.call('map_edit', { requestId: 'oversized', add: ['node a | A | ui'] }), { code: 'map_too_large' });
  rmSync(f.path); writeFileSync(f.path, 'node a | A | ui\n'); assert.equal((await f.call('map')).nodes.length, 1, 'a refusal does not poison the hub');
  const alias = join(f.root, 'alias'); symlinkSync(f.workspace, alias);
  const room = await request(credential(join(f.dataDir, 'admin.json')), 'create', { requestId: 'alias-room', name: 'Alias', workspace: alias });
  await assert.rejects(request({ ...room, endpoint: f.auth().endpoint }, 'map'), { code: 'map_unsafe' });
});

const canonical = (v: any): string => JSON.stringify(v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, JSON.parse(canonical(v[k]))])) : Array.isArray(v) ? v.map(x => JSON.parse(canonical(x))) : v);
test('an interrupted map rename is recovered to the same durable keyed receipt without repeating or overwriting it', async t => {
  const f = await fixture(t); const body = { requestId: 'interrupted', add: ['node a | A | component'] };
  await f.stop();
  const prepared = prepareMapEdit(f.workspace, body); const fingerprint = createHash('sha256').update(canonical({ op: 'map_edit', body })).digest('hex');
  assert.throws(() => commitMapEdit(f.dataDir, f.workspace, f.owner.sessionId, `${f.owner.participantId}:${body.requestId}`, fingerprint, prepared, () => { throw new Error('simulated snapshot failure'); }), /snapshot failure/);
  assert.equal(readFileSync(f.path, 'utf8'), prepared.text); assert.ok(existsSync(join(f.dataDir, 'map-edit.pending.json')));
  await f.restart(); assert.deepEqual(await f.call('map_edit', body), prepared.result);
  assert.equal(existsSync(join(f.dataDir, 'map-edit.pending.json')), false);
  writeFileSync(f.path, '# Human changed it later\n');
  assert.deepEqual(await f.call('map_edit', body), prepared.result); assert.equal(readFileSync(f.path, 'utf8'), '# Human changed it later\n');
});

test('a conflicting hand edit during interrupted map recovery is preserved and blocks recovery explicitly', async t => {
  const f = await fixture(t); await f.stop();
  const prepared = prepareMapEdit(f.workspace, { add: ['node a | A | ui'] });
  assert.throws(() => commitMapEdit(f.dataDir, f.workspace, f.owner.sessionId, `${f.owner.participantId}:interrupted`, 'a'.repeat(64), prepared, () => { throw new Error('simulated failure'); }));
  writeFileSync(f.path, '# This human edit must survive\n');
  await assert.rejects(f.restart(), /Pending map edit needs recovery.*project file changed/);
  assert.equal(readFileSync(f.path, 'utf8'), '# This human edit must survive\n'); assert.ok(existsSync(join(f.dataDir, 'map-edit.pending.json')));
});

test('recovery discards an unrenamed intent and its named temp, or preserves a later hand edit after a saved receipt', async t => {
  const f = await fixture(t); await f.stop();
  const body = { requestId: 'recover-before-rename', add: ['node a | A | ui'] }; const prepared = prepareMapEdit(f.workspace, body);
  const fingerprint = createHash('sha256').update(canonical({ op: 'map_edit', body })).digest('hex');
  assert.throws(() => commitMapEdit(f.dataDir, f.workspace, f.owner.sessionId, `${f.owner.participantId}:${body.requestId}`, fingerprint, prepared, () => { throw new Error('interrupted'); }));
  const intentPath = join(f.dataDir, 'map-edit.pending.json'); const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  // Recreate the durable point just before rename: only the intent and its named temporary exist.
  rmSync(f.path); writeFileSync(join(f.workspace, intent.temporary), prepared.text);
  await f.restart(); assert.equal(existsSync(f.path), false); assert.equal(existsSync(join(f.workspace, intent.temporary)), false);
  assert.equal(existsSync(intentPath), false); assert.deepEqual(await f.call('map_edit', body), prepared.result);
  await f.stop();
  // Recreate a crash after receipt save but before journal removal; an intervening hand edit must survive.
  writeFileSync(intentPath, JSON.stringify(intent)); writeFileSync(f.path, '# Later human edit\n');
  await f.restart(); assert.equal(readFileSync(f.path, 'utf8'), '# Later human edit\n');
  assert.deepEqual(await f.call('map_edit', body), prepared.result); assert.equal(existsSync(intentPath), false);
});
