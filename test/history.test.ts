import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HISTORY_SIZE, loadHistory, saveHistory } from '../core/history.ts';

const folder = (t: any) => { const dir = mkdtempSync(join(tmpdir(), 'peerloom-history-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return join(dir, 'history'); };

test('history comes back newest first after a restart, and a missing file is an empty history', t => {
  const path = folder(t); assert.deepEqual(loadHistory(path), []);
  saveHistory(path, ['/status', 'hello all', '/send Claude hi']);
  assert.deepEqual(loadHistory(path), ['/status', 'hello all', '/send Claude hi']);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('a /reply line, which can carry a secret answer, is never written, and the file keeps the newest 500', t => {
  const path = folder(t);
  saveHistory(path, ['/reply 7 {"answers":{"pw":"hunter2"}}', '/status', ...Array.from({ length: 600 }, (_, i) => `line ${i}`)]);
  const back = loadHistory(path); assert.equal(back.length, HISTORY_SIZE); assert.equal(back[0], '/status'); assert.doesNotMatch(readFileSync(path, 'utf8'), /hunter2|\/reply/);
});

test('a damaged history file is ignored rather than stopping the console', t => {
  const path = folder(t); writeFileSync(path, Buffer.from([0xff, 0xfe, 0x00, 0x0a]));
  assert.ok(Array.isArray(loadHistory(path)));
});

test('a history path that is a link to another file is replaced, never written through, and not read', t => {
  const path = folder(t); const outside = `${path}-outside`; writeFileSync(outside, 'keep me\n');
  symlinkSync(outside, path);
  assert.deepEqual(loadHistory(path), [], 'a symlinked history is not read');
  saveHistory(path, ['/status']);
  assert.equal(readFileSync(outside, 'utf8'), 'keep me\n'); assert.ok(lstatSync(path).isFile(), 'the link is replaced by a plain file');
  assert.deepEqual(loadHistory(path), ['/status']);
  rmSync(path); linkSync(outside, path); saveHistory(path, ['/status']);
  assert.equal(readFileSync(outside, 'utf8'), 'keep me\n', 'a hard link is not written through either');
});

test('a history line carrying terminal control sequences is dropped on load and never saved', t => {
  const path = folder(t);
  writeFileSync(path, ['/status', 'hi \u001b]52;c;cHduZWQ=\u0007', 'x\u001b[2J', 'bell\u0007', 'csi \u009b31m', 'bidi \u202eevil', 'tab\tis fine', 'cr\rline'].join('\n') + '\n');
  assert.deepEqual(loadHistory(path), ['tab\tis fine', '/status']);
  saveHistory(path, ['ok', 'bad \u001b[31m']); assert.equal(readFileSync(path, 'utf8'), 'ok\n');
});
