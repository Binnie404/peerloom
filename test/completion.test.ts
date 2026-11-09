import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { candidates, profileIds, script } from '../core/completion.ts';

const root = resolve(import.meta.dirname, '..');
const known = { profileCommands: ['send', 'status', 'reply'], harnesses: ['cursor', 'dsh'], profiles: ['kimi-ab12', 'dshag-7e4f'] };

test('the first word completes to subcommands and agent verbs', () => {
  assert.deepEqual(candidates([''], known), ['join', 'link', 'view', 'harnesses', 'help', 'completion', 'send', 'status', 'reply']);
  assert.deepEqual(candidates(['s'], known), ['send', 'status']);
  assert.deepEqual(candidates(['comp'], known), ['completion']);
});

test('option values complete from what is true here', () => {
  assert.deepEqual(candidates(['join', 'http://127.0.0.1:1/j/x', '--harness', ''], known), ['cursor', 'dsh']);
  assert.deepEqual(candidates(['send', '--as', 'k'], known), ['kimi-ab12']);
  assert.deepEqual(candidates(['completion', ''], known), ['zsh', 'bash', 'fish']);
  assert.deepEqual(candidates(['send', '--'], known), ['--as'], 'an agent verb needs --as');
  assert.deepEqual(candidates(['join', 'http://x', '--'], known), ['--harness', '--name', '--timeout']);
  assert.deepEqual(candidates(['view', ''], known), [], 'nothing invented for free text');
});

test('profile ids come from this folder, and only well-formed ones', t => {
  const dir = mkdtempSync(join(tmpdir(), 'peerloom-completion-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(profileIds(dir), []);
  for (const id of ['kimi-ab12', 'Bad Name', 'x']) mkdirSync(join(dir, '.agentlink', 'agents', id), { recursive: true });
  assert.deepEqual(profileIds(dir), ['kimi-ab12']);
});

test('each shell script is valid for that shell and registers both names, and not the old one', () => {
  for (const shell of ['zsh', 'bash', 'fish'] as const) { const text = script(shell); for (const name of ['peerloom', 'plm']) assert.match(text, new RegExp(`\\b${name}\\b`), `${shell} ${name}`); assert.doesNotMatch(text, /\bagentlink\b/, shell); }
  assert.equal(spawnSync('bash', ['-n', '-c', script('bash')]).status, 0);
  const zsh = spawnSync('zsh', ['-n', '-c', script('zsh')]); if (!zsh.error) assert.equal(zsh.status, 0);
});

test('peerloom completion and __complete print plainly and quickly', () => {
  const start = Date.now();
  const out = spawnSync(process.execPath, [join(root, 'bin/peerloom.mjs'), '__complete', 'comp'], { encoding: 'utf8' });
  assert.equal(out.status, 0); assert.equal(out.stdout, 'completion\n'); assert.equal(out.stderr, ''); assert.ok(Date.now() - start < 1500, 'fast enough for Tab');
  const zsh = spawnSync(process.execPath, [join(root, 'bin/peerloom.mjs'), 'completion', 'zsh'], { encoding: 'utf8' }); assert.equal(zsh.status, 0); assert.match(zsh.stdout, /compdef/);
  const bad = spawnSync(process.execPath, [join(root, 'bin/peerloom.mjs'), 'completion', 'tcsh'], { encoding: 'utf8' }); assert.notEqual(bad.status, 0); assert.match(bad.stdout, /zsh, bash or fish/);
});

test('the bash function hands each word to peerloom separately, including an empty current word (macOS bash 3.2)', t => {
  const dir = mkdtempSync(join(tmpdir(), 'peerloom-bash-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'peerloom'), `#!/bin/sh\nexec "${process.execPath}" "${join(root, 'bin/peerloom.mjs')}" "$@"\n`); chmodSync(join(dir, 'peerloom'), 0o755);
  const run = (words: string, cword: number) => spawnSync('bash', ['-c', `eval "$(peerloom completion bash)"; COMP_WORDS=(${words}); COMP_CWORD=${cword}; _peerloom; printf '%s,' "\${COMPREPLY[@]}"`], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }).stdout;
  assert.equal(run('plm comp', 1), 'completion,');
  assert.equal(run('peerloom completion ""', 2), 'zsh,bash,fish,');
});

test('the zsh setup line works in a plain zsh with no compinit, without printing anything', t => {
  const home = mkdtempSync(join(tmpdir(), 'peerloom-zsh-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const zsh = spawnSync('zsh', ['-f', '-c', `eval "$(cat)"; (( $+functions[_peerloom] )) && print ok`], { input: script('zsh'), encoding: 'utf8', env: { ...process.env, HOME: home, ZDOTDIR: home } });
  if (zsh.error) return;
  assert.equal(zsh.stderr, ''); assert.equal(zsh.stdout, 'ok\n');
});

test('zsh offers files when peerloom has nothing to say (a --room or --text-file value), and only then', t => {
  const dir = mkdtempSync(join(tmpdir(), 'peerloom-zshfiles-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'peerloom'), `#!/bin/sh\nexec "${process.execPath}" "${join(root, 'bin/peerloom.mjs')}" "$@"\n`); chmodSync(join(dir, 'peerloom'), 0o755);
  // Outside a real completion widget: compdef, compadd and _files are stand-ins that say which one ran.
  const run = (line: string) => spawnSync('zsh', ['-f', '-c', `compdef() { :; }; compadd() { print -r -- "add:\${(j:,:)@[2,-1]}"; }; _files() { print files; }
eval "$(peerloom completion zsh)"; words=(\${=1}); CURRENT=\${#words}; [[ $1 == *' ' ]] && { words+=(''); CURRENT=\${#words}; }; _peerloom`, 'zsh', line], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  const probe = run('peerloom comp'); if (probe.error) return;
  assert.equal(probe.stdout, 'add:completion\n');
  assert.equal(run('peerloom link --room ').stdout, 'files\n');
  assert.equal(run('peerloom send --as kimi-ab12 --text-file ').stdout, 'files\n');
});

test('fish completes peerloom words, and files when peerloom has nothing to offer', t => {
  const dir = mkdtempSync(join(tmpdir(), 'peerloom-fish-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'peerloom'), `#!/bin/sh\nexec "${process.execPath}" "${join(root, 'bin/peerloom.mjs')}" "$@"\n`); chmodSync(join(dir, 'peerloom'), 0o755);
  mkdirSync(join(dir, 'roomdir'));
  const run = (line: string) => spawnSync('fish', ['--no-config', '-c', 'peerloom completion fish | source; complete -C $argv[1]', line], { cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir, PATH: `${dir}:${process.env.PATH}` } });
  const probe = run('plm comp'); if (probe.error) return;
  const words = (line: string) => run(line).stdout.split('\n').filter(Boolean).map(l => l.split('\t')[0]);
  assert.deepEqual(words('plm comp'), ['completion']);
  assert.deepEqual(words('peerloom completion '), ['bash', 'fish', 'zsh']);
  assert.ok(words('peerloom link --room ').includes('roomdir/'), 'a --room value completes to folders');
  assert.ok(!words('peerloom ').includes('roomdir/'), 'files are not mixed into the subcommands');
});
