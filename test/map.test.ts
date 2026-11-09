import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP_TEMPLATE, MapEditError, editMap, parseMap } from '../core/map.ts';

const refused = (fn: () => unknown, code: string) => assert.throws(fn, (error: any) => error instanceof MapEditError && error.code === code, code);

test('a map file is read line by line: nodes, flows, comments, and every other line kept as an error with its reason', () => {
  const text = [
    '# Project map',
    '',
    'node hub | Hub | service | core/server.ts, core/collab.ts',
    'node web|Browser page|ui|ui/',
    'node notes | Notes | doc',
    'flow web -> hub | actions and live updates',
    'flow web -> ghost | to nowhere',
    'node hub | Again | service',
    'node Bad Id | x | component',
    'node odd | Odd | gizmo',
    'node esc | Has \u001b escape | component',
    'node far | Far | data | ../outside, /etc/passwd',
    'node priv | Private | data | .agentlink/credentials',
    'something else',
  ].join('\n');
  const map = parseMap(text);
  assert.deepEqual(map.nodes.map(n => [n.id, n.label, n.kind, n.paths, n.line]), [
    ['hub', 'Hub', 'service', ['core/server.ts', 'core/collab.ts'], 3], ['web', 'Browser page', 'ui', ['ui/'], 4], ['notes', 'Notes', 'doc', [], 5]]);
  assert.deepEqual(map.flows.map(f => [f.id, f.from, f.to, f.label, f.line]), [['web->hub', 'web', 'hub', 'actions and live updates', 6]]);
  assert.deepEqual(map.errors.map(e => [e.line, e.reason]), [
    [7, 'flow to a node that is not in the map: ghost'],
    [8, 'node ID hub is already used on line 3'],
    [9, 'a node ID is lower-case letters, digits, ".", "_" or "-", starting with a letter or digit, at most 64'],
    [10, 'kind is one of component, service, data, ui, process, external, doc'],
    [11, 'a label is 1 to 120 characters, with no "|" and no control characters'],
    [12, 'a path is relative to the workspace and stays inside it: ../outside'],
    [13, 'a path may not point into .agentlink or .git: .agentlink/credentials'],
    [14, 'a line is "node ID | Label | kind | paths" or "flow FROM -> TO | label"'],
  ]);
  assert.equal(map.errors[0].text, 'flow web -> ghost | to nowhere');
  // The template parses to nothing at all: every line of it is a comment.
  assert.deepEqual(parseMap(MAP_TEMPLATE), { nodes: [], flows: [], errors: [] });
  assert.match(MAP_TEMPLATE, /node ID \| Label \| kind \| path, path/);
});

test('an edit removes then adds by ID, writes added lines in one form, and keeps every other line as it was', () => {
  const before = '# Mine\r\nnode hub | Hub | service | core/server.ts\r\nnot a map line\r\nnode web | Page | ui\r\nflow web -> hub | calls\r\n';
  const edited = editMap(before, { remove: ['web->hub'], add: ['node   cli|CLI|component|core/cli.ts ,  docs/', 'flow cli -> hub | requests', 'flow web -> hub | actions'] });
  assert.equal(edited.text, '# Mine\r\nnode hub | Hub | service | core/server.ts\r\nnot a map line\r\nnode web | Page | ui\r\nnode cli | CLI | component | core/cli.ts, docs/\r\nflow cli -> hub | requests\r\nflow web -> hub | actions\r\n');
  assert.deepEqual([edited.added, edited.removed], [['cli', 'cli->hub', 'web->hub'], ['web->hub']]);
  // Replacing a node is removing and adding it in one edit; its flows stay.
  const replaced = editMap(edited.text, { remove: ['hub'], add: ['node hub | Hub server | service | core/server.ts'] });
  assert.equal(parseMap(replaced.text).nodes.find(n => n.id === 'hub')!.label, 'Hub server');
  assert.equal(parseMap(replaced.text).flows.length, 2);
  // An empty or absent file gets the added lines after the template's header.
  const fresh = editMap('', { add: ['node a | A | component'] }); assert.ok(fresh.text.startsWith(MAP_TEMPLATE)); assert.ok(fresh.text.endsWith('node a | A | component\n'));
});

test('an edit that would leave the map wrong is refused whole, with a code saying why', () => {
  const text = 'node a | A | component\nnode b | B | component\nflow a -> b | one\nflow a -> b | two\nbroken line\n';
  refused(() => editMap(text, { add: ['node a | Again | component'] }), 'duplicate_id');
  refused(() => editMap(text, { add: ['node c | C | component', 'node c | C2 | component'] }), 'duplicate_id');
  refused(() => editMap(text, { add: ['flow a -> b | one'] }), 'duplicate_id');
  refused(() => editMap(text, { remove: ['zzz'] }), 'unknown_id');
  refused(() => editMap(text, { remove: ['a->b'] }), 'ambiguous_id');
  assert.deepEqual(editMap(text, { remove: ['a->b|two'] }).removed, ['a->b|two']);
  refused(() => editMap(text, { remove: ['b'] }), 'dangling_flow');
  assert.deepEqual(editMap(text, { remove: ['b', 'a->b|one', 'a->b|two'] }).removed, ['b', 'a->b|one', 'a->b|two']);
  refused(() => editMap(text, { add: ['flow a -> c | to nowhere'] }), 'dangling_flow');
  refused(() => editMap(text, { add: ['node d | D | gizmo'] }), 'invalid_line');
  refused(() => editMap(text, { add: ['# a comment'] }), 'invalid_line');
  refused(() => editMap(text, { add: ['node e | E | component\nnode f | F | component'] }), 'invalid_line');
  refused(() => editMap(text, {}), 'empty_edit');
  // Size: at most 256 KiB and 2,000 entries.
  const many = Array.from({ length: 2000 }, (_, i) => `node n${i} | N | component`).join('\n');
  refused(() => editMap(many, { add: ['node one-more | N | component'] }), 'map_too_large');
  refused(() => editMap(`# ${'x'.repeat(256 * 1024)}`, { add: ['node a | A | component'] }), 'map_too_large');
  // The broken line is still there after an edit elsewhere, and still reported.
  const after = editMap(text, { add: ['node c | C | component'] }); assert.ok(after.text.includes('broken line\n')); assert.equal(parseMap(after.text).errors.length, 1);
});

test('the check says per node whether its cited paths are present, missing or changed since the map was written, and counts uncited files by area', async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync, rmSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path'); const { checkMap } = await import('../core/map.ts');
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'agentlink-map-'))); const outside = realpathSync(mkdtempSync(join(tmpdir(), 'agentlink-map-out-')));
  t.after(() => { rmSync(ws, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  const file = (path: string, at = 1000) => { mkdirSync(join(ws, path, '..'), { recursive: true }); writeFileSync(join(ws, path), 'x'); utimesSync(join(ws, path), at, at); };
  for (const path of ['core/server.ts', 'core/cli.ts', 'core/extra.ts', 'ui/app.js', 'README.md', 'docs/a.md', 'node_modules/x/i.js', '.git/HEAD', 'build/out.js', '.env', 'keys/id.pem', '.agentlink/state.json', 'agentlink-map.txt']) file(path);
  file('core/fresh.ts', 5000); writeFileSync(join(outside, 'secret.txt'), 's'); symlinkSync(join(outside, 'secret.txt'), join(ws, 'escape.txt')); symlinkSync(join(ws, 'core/cli.ts'), join(ws, 'alias.ts'));
  const map = parseMap(['node hub | Hub | service | core/server.ts', 'node cli | CLI | component | core/cli.ts, core/fresh.ts', 'node page | Page | ui | ui/',
    'node gone | Gone | component | core/deleted.ts', 'node out | Out | data | escape.txt', 'node idea | Idea | process'].join('\n'));
  const check = await checkMap(ws, map, 2000 * 1000);
  assert.equal(typeof check.checkedAt, 'string');
  const state = (id: string) => [check.sources[id].state, check.sources[id].paths.map(p => `${p.path}:${p.state}`)];
  assert.deepEqual(state('hub'), ['present', ['core/server.ts:present']]);
  assert.deepEqual(state('cli'), ['changed', ['core/cli.ts:present', 'core/fresh.ts:changed']]);
  assert.deepEqual(state('page'), ['present', ['ui/:present']]);
  assert.deepEqual(state('gone'), ['missing', ['core/deleted.ts:missing']]);
  assert.deepEqual(state('out'), ['missing', ['escape.txt:missing']], 'a link out of the workspace is not a source');
  assert.deepEqual(state('idea'), ['none', []]);
  // Coverage: the excluded and private files are not in the inventory; a link inside the workspace counts once as a file.
  assert.equal(check.coverage.state, 'complete');
  assert.deepEqual(check.coverage.byArea, [{ area: '.', files: 2, uncited: 2 }, { area: 'core', files: 4, uncited: 1 }, { area: 'docs', files: 1, uncited: 1 }, { area: 'ui', files: 1, uncited: 0 }]);
  assert.deepEqual([check.coverage.files, check.coverage.uncited], [8, 4]);
  // Bounds say incomplete and why; a cancelled check says so; cited paths past the bound are unchecked.
  const small = await checkMap(ws, map, 2000 * 1000, { maxInventory: 3 }); assert.equal(small.coverage.state, 'incomplete'); assert.match(small.coverage.reason!, /3 files/);
  const few = await checkMap(ws, map, 2000 * 1000, { maxCited: 2 }); assert.deepEqual(few.sources.page.paths.map(p => p.state), ['unchecked']); assert.equal(few.sources.page.state, 'unchecked');
  const stop = new AbortController(); stop.abort();
  const cancelled = await checkMap(ws, map, 2000 * 1000, { signal: stop.signal }); assert.equal(cancelled.coverage.state, 'incomplete'); assert.equal(cancelled.coverage.reason, 'cancelled');
});

test('exclusions hold after links are followed, a bound on citations makes the result incomplete, and "." or "./x" cite as written (GPT, 005-gpt)', async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path'); const { checkMap } = await import('../core/map.ts');
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'agentlink-map-x-'))); t.after(() => rmSync(ws, { recursive: true, force: true }));
  const file = (path: string) => { mkdirSync(join(ws, path, '..'), { recursive: true }); writeFileSync(join(ws, path), 'x'); };
  for (const path of ['.agentlink/state.json', '.env', 'keys/id.key', 'node_modules/m/i.js', 'src/a.ts', 'src/b.ts']) file(path);
  symlinkSync(join(ws, '.agentlink/state.json'), join(ws, 'state-alias.json')); symlinkSync(join(ws, '.env'), join(ws, 'env-alias')); symlinkSync(join(ws, '.agentlink'), join(ws, 'private'));
  const map = parseMap(['node a | A | data | state-alias.json', 'node b | B | data | .env', 'node c | C | data | private/state.json', 'node d | D | data | node_modules/m/i.js', 'node e | E | component | ./src//a.ts'].join('\n'));
  const check = await checkMap(ws, map, Date.now() + 60_000);
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map(id => check.sources[id].state), ['missing', 'missing', 'missing', 'missing', 'present']);
  // The aliases and the private folder behind a link are not in the inventory either; ./src//a.ts covers src/a.ts.
  assert.deepEqual(check.coverage.byArea, [{ area: 'src', files: 2, uncited: 1 }]); assert.equal(check.state, 'complete');
  const all = await checkMap(ws, parseMap('node all | Everything | component | .'), Date.now() + 60_000); assert.equal(all.coverage.uncited, 0);
  const bounded = await checkMap(ws, map, Date.now() + 60_000, { maxCited: 1 }); assert.equal(bounded.state, 'incomplete'); assert.match(bounded.reason!, /only the first 1 cited path/);
});

test('a private name anywhere in a path keeps it out, and a path that cannot be read makes the check incomplete, not missing (GPT, 009-gpt)', async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path'); const { checkMap } = await import('../core/map.ts');
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'agentlink-map-y-'))); t.after(() => { chmodSync(join(ws, 'locked'), 0o755); rmSync(ws, { recursive: true, force: true }); });
  for (const path of ['.env-folder/config', 'certs.pem.d/x', 'src/a.ts', 'locked/f.ts', 'agentlink-map.txt.tmp-3f2a']) { mkdirSync(join(ws, path, '..'), { recursive: true }); writeFileSync(join(ws, path), 'x'); }
  const map = parseMap('node a | A | data | .env-folder/config\nnode b | B | data | certs.pem.d/x\nnode c | C | component | src/a.ts');
  const open = await checkMap(ws, map, Date.now() + 60_000);
  assert.deepEqual(['a', 'b', 'c'].map(id => open.sources[id].state), ['missing', 'present', 'present']);
  assert.deepEqual(open.coverage.byArea.map(a => a.area), ['certs.pem.d', 'locked', 'src'], 'the .env folder is never entered, and a temporary map file left by the hub is not a project file');
  chmodSync(join(ws, 'locked'), 0o000);
  const locked = await checkMap(ws, parseMap('node l | L | component | locked/f.ts'), Date.now() + 60_000);
  assert.equal(locked.sources.l.state, 'unchecked'); assert.equal(locked.state, 'incomplete'); assert.match(locked.reason!, /locked\/f\.ts could not be read/);
});

test('a cited file written in the same millisecond as the map, but before it, is not changed (GPT, 019-gpt)', async t => {
  const { mkdtempSync, writeFileSync, utimesSync, rmSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path'); const { checkMap } = await import('../core/map.ts');
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'agentlink-map-ms-'))); t.after(() => rmSync(ws, { recursive: true, force: true }));
  writeFileSync(join(ws, 'a.ts'), 'x'); utimesSync(join(ws, 'a.ts'), 1793019376.8293718, 1793019376.8293718);
  const map = parseMap('node a | A | component | a.ts');
  assert.equal((await checkMap(ws, map, 1793019376829.4148)).sources.a.state, 'present', 'older by a fraction of a millisecond');
  assert.equal((await checkMap(ws, map, 1793019376829.1)).sources.a.state, 'changed');
});
