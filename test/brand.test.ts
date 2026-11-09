import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// After the rename, "agentlink" survives only where it names stored data or protocol that existing rooms and sessions
// depend on. Anything else a person or an agent reads says Peerloom / peerloom.
const root = resolve(import.meta.dirname, '..');
const KEPT = [/\.agentlink\b/g, /agentlink-map\.txt/g, /provider: 'agentlink'/g, /namespace: 'agentlink'/g, /AgentLink wake/g, /AGENTLINK_[A-Z_]+/g,
  /'skills', 'agentlink'/g, /agentlink\.browser-control/g,
  // Also stored or protocol: the retry-credential key label (changing it breaks sealed secrets), the Claude hook and Codex
  // client ids, the suggestion provider ref, the map's temp-file pattern, and the app/Cursor slash command and its files.
  /agentlink retry credential v1/g, /'agentlink_shell'/g, /agentlink_native_adapter/g, /agentlink-suggestion/g, /agentlink-map\\\.txt/g,
  /name: agentlink/g, /AgentLink host: work/g, /AgentLink wait tool-output/g, /\/agentlink\b/g, /\$agentlink/g, /'agentlink\.md'/g, /agentlinkCall/g];
const files = [...readdirSync(join(root, 'core')).filter(f => f.endsWith('.ts')).map(f => `core/${f}`), 'bin/peerloom.mjs', 'ui/app.js', 'ui/index.html'];

test('no product or command word still says agentlink outside stored names and protocol', () => {
  const left: string[] = [];
  for (const file of files) readFileSync(join(root, file), 'utf8').split('\n').forEach((line, i) => {
    let code = line.replace(/(^|\s)\/\/\s.*$/, '');
    for (const kept of KEPT) code = code.replace(kept, '');
    if (/agentlink/i.test(code)) left.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
  assert.deepEqual(left, []);
});

test('the app allow rules name the peerloom link command, and no old file name', async () => {
  const shell = readFileSync(join(root, 'core/shell.ts'), 'utf8');
  assert.match(shell, /bin\/peerloom\.mjs'\)\} link:\*\)/); assert.doesNotMatch(shell, /bin\/agentlink\.mjs/);
});

test('an agent opening names peerloom with its profile', async () => {
  const { externalOpening } = await import('../core/shell-agents.ts');
  const text = externalOpening('Kimi', 'Room', '/tmp/cred.json', '/x/core/cli.ts', 'Kimi K3', 'kimi-ab12', 'self-arming');
  assert.match(text, /peerloom \w+ --as kimi-ab12/); assert.doesNotMatch(text, /agentlink \w+ --as/);
});
