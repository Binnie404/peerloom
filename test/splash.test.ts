import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BANNER_WIDTH, MARK, MARK_ROWS, MARK_WIDTH, brandColour, checklist, promptText, rgbCode, shade, splash, title } from '../core/splash.ts';
import { VERSION } from '../core/brand.ts';

// The title is for a person at a terminal. Whatever reads the hub's or the CLI's output must see what it always saw.
const root = resolve(import.meta.dirname, '..');
const stream = (isTTY: boolean, columns = 100) => { let text = ''; return { isTTY, columns, write: (chunk: string) => { text += chunk; return true; }, get text() { return text; } }; };
const bare = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

// What a row of the mark looks like with the colour taken away: a half block wherever either of its two pixels is set.
const glyphs = (row: number) => [...MARK[2 * row]].map((top, i) => top !== '.' ? '▀' : MARK[2 * row + 1][i] !== '.' ? '▄' : ' ').join('');

test('the mark is the logo traced into 28 by 24 square pixels, a colour for every pixel, drawn as twelve rows of half blocks', () => {
  assert.equal(MARK.length, 24); assert.equal(MARK_ROWS, 12); for (const line of MARK) { assert.equal(line.length, MARK_WIDTH); assert.match(line, /^[.a-x]+$/); }
  for (const pixel of new Set(MARK.join('').replaceAll('.', ''))) { const c = shade(pixel)!; assert.equal(c.length, 3); assert.ok(c.every(v => v >= 0 && v <= 255)); }
  assert.equal(shade('.'), undefined); assert.equal(shade('z'), undefined);
  const lines = title(stream(true, 100), { COLORTERM: 'truecolor' });
  assert.equal(lines.length, MARK_ROWS);
  lines.forEach((line, row) => { assert.ok([...bare(line)].length <= BANNER_WIDTH); assert.ok(bare(line).startsWith(glyphs(row))); assert.doesNotMatch(bare(line), /[\x00-\x1f\x7f]/); assert.doesNotMatch(line, /[▀▄](?!\x1b\[0m)/, 'every coloured cell resets itself'); });
  assert.match(lines.join(''), /\x1b\[38;2;\d+;\d+;\d+;48;2;\d+;\d+;\d+m▀/, 'a cell with two pixels sets both colours');
  assert.match(bare(lines[5]), new RegExp(`Peerloom v${VERSION.replaceAll('.', '\\.')}$`)); assert.match(bare(lines[6]), /Let your agents think together\.$/);
});

test('the gradient runs magenta to violet, in true colour when the terminal says so and in 256 colours otherwise', () => {
  assert.equal(brandColour(0, { COLORTERM: 'truecolor' }), '38;2;240;48;168'); assert.equal(brandColour(1, { COLORTERM: '24bit' }), '38;2;155;107;255');
  assert.match(brandColour(0, {}), /^38;5;\d{2,3}$/); assert.match(title(stream(true, 100), {}).join(''), /\x1b\[38;5;\d+;48;5;\d+m/);
  assert.equal(rgbCode([0xF0, 0x30, 0xA8], { COLORTERM: 'truecolor' }, 48), '48;2;240;48;168');
});

test('nothing is written unless a terminal is attached, and colour is never forced on one that declined it', () => {
  const piped = stream(false); splash(piped, [['Endpoint', 'http://127.0.0.1:1']], 'hint', {}); checklist(piped, {})('Initialising workspace'); assert.equal(piped.text, '');
  const terminal = stream(true); splash(terminal, [['Endpoint', 'http://127.0.0.1:1'], ['Admin file', '/x/admin.json']], 'Ctrl-C stops the hub.', {});
  assert.ok(bare(terminal.text).includes(glyphs(0).trimEnd()));
  assert.match(bare(terminal.text), /\n  Endpoint    http:\/\/127\.0\.0\.1:1\n  Admin file  \/x\/admin\.json\n\n  Ctrl-C stops the hub\.\n\n$/);
  for (const env of [{ NO_COLOR: '1' }, { TERM: 'dumb' }]) { const plain = stream(true); splash(plain, [['Endpoint', 'e']], 'hint', env); assert.doesNotMatch(plain.text, /\x1b/); assert.equal(plain.text, `\nPeerloom v${VERSION}\n\n  Endpoint  e\n\n  hint\n\n`); }
  assert.deepEqual(title(stream(true, BANNER_WIDTH - 1), {}), [`Peerloom v${VERSION}`]); assert.equal(title(stream(true, BANNER_WIDTH), {}).length, MARK_ROWS);
});

test('the checklist ticks each step on a terminal and marks a failed one', () => {
  const s = stream(true); const tick = checklist(s, {}); tick('Initialising workspace'); tick('Looming conversation threads', false);
  assert.equal(bare(s.text), '[✓] Initialising workspace...\n[✗] Looming conversation threads...\n');
  const plain = stream(true); checklist(plain, { NO_COLOR: '1' })('Connecting agents'); assert.equal(plain.text, '[✓] Connecting agents...\n');
});

test('the prompt is peerloom, with the sticky recipient when there is one', () => {
  assert.equal(promptText(false), 'peerloom › '); assert.equal(promptText(false, 'Claude'), 'peerloom → Claude › ');
  assert.equal(bare(promptText(true)), 'peerloom › '); assert.match(promptText(true), /\x1b\[1;38;/);
});

test('piped, the hub still prints exactly one JSON line and the CLI help is plain text', { timeout: 30_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentlink-splash-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hub = spawn(process.execPath, ['core/server.ts', '--data', join(dir, 'hub'), '--port', '0'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = ''; hub.stdout.on('data', chunk => { out += chunk; }); hub.stderr.on('data', chunk => { err += chunk; });
  t.after(() => { if (hub.exitCode === null) hub.kill('SIGKILL'); });
  for (let waited = 0; !out.includes('\n') && waited < 10_000; waited += 20) await new Promise(ok => setTimeout(ok, 20));
  const started = JSON.parse(out); assert.deepEqual(Object.keys(started), ['endpoint', 'adminFile', 'mode']); assert.equal(out.trim().split('\n').length, 1); assert.equal(err, '');
  hub.kill('SIGTERM'); await once(hub, 'exit');

  const help = spawn(process.execPath, ['core/cli.ts', 'help'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); let text = ''; help.stdout.on('data', chunk => { text += chunk; });
  assert.equal((await once(help, 'exit'))[0], 0); assert.doesNotMatch(text, /\x1b/); assert.match(text, /^Peerloom local core \(Node 24\+, no install needed\)\n  node core\/server\.ts --data/);
});
