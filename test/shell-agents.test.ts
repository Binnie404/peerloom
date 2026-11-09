import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalText, nativeRequestLines, stoppedText } from '../core/shell-agents.ts';

test('command and file approvals display the action and access requested', () => {
  const command = { method: 'item/commandExecution/requestApproval', params: {
    command: `/bin/zsh -lc 'node core/cli.ts fetch'`, cwd: '/workspace', reason: 'Contact the local hub', kind: 'command',
    networkApprovalContext: { host: '127.0.0.1', protocol: 'http' },
  } };
  assert.deepEqual(nativeRequestLines(command), [
    'Command: node core/cli.ts fetch', 'Action: command', 'Working directory: /workspace', 'Reason: Contact the local hub',
    'Network access:', '  {', '    "host": "127.0.0.1",', '    "protocol": "http"', '  }',
  ]);
  assert.deepEqual(approvalText(command), { command: 'node core/cli.ts fetch', reason: 'Contact the local hub' });
  assert.deepEqual(nativeRequestLines({ method: 'item/fileChange/requestApproval', params: {
    itemId: 'edit-1', reason: 'Write outside the workspace', grantRoot: '/shared/source',
  } }), ['File change approval', 'Item: edit-1', 'Reason: Write outside the workspace', 'Requested write root: /shared/source']);
  assert.deepEqual(nativeRequestLines({ method: 'item/fileChange/requestApproval', params: { itemId: 'edit-2' } }), ['File change approval', 'Item: edit-2']);
});

test('permission requests expose the exact permission profile, including filesystem entries', () => {
  const permissions = { network: { enabled: true }, fileSystem: {
    read: ['/input'], write: ['/output'], entries: [{ access: 'write', path: { type: 'glob_pattern', pattern: '/project/**' } }], globScanMaxDepth: 3,
  } };
  const lines = nativeRequestLines({ method: 'item/permissions/requestApproval', params: {
    cwd: '/project', reason: 'Build artifacts', permissions,
  } });
  assert.deepEqual(lines.slice(0, 4), ['Permission request', 'Working directory: /project', 'Reason: Build artifacts', 'Requested permissions:']);
  assert.deepEqual(JSON.parse(lines.slice(4).map(line => line.slice(2)).join('\n')), permissions);
});

test('native questions show each answer key, header, question, choices and free-form/secret flags', () => {
  assert.deepEqual(nativeRequestLines({ method: 'item/tool/requestUserInput', params: { questions: [
    { id: 'target', header: 'Target', question: 'Which target should I use?', isOther: true, options: [
      { label: 'Preview', description: 'Use the temporary environment' }, { label: 'Production', description: 'Use the public environment' },
    ] },
    { id: 'token', header: 'Credential', question: 'Provide the token', isSecret: true, options: null },
  ] } }), [
    'Questions for the human', 'Question [target] · Target', 'Which target should I use?',
    '  Preview: Use the temporary environment', '  Production: Use the public environment', '  A free-form answer is allowed.',
    'Question [token] · Credential', 'Provide the token', '  This question requests a secret answer.',
  ]);
});

test('hostile controls in native request values cannot manipulate the terminal', () => {
  const hostile = '\x1b[2J\r\x07\u202e\u2066'; const safe = '\\u001b[2J\\u000d\\u0007\\u202e\\u2066';
  const events = [
    { method: 'item/commandExecution/requestApproval', params: { command: hostile, cwd: hostile, reason: hostile, kind: hostile,
      environmentId: hostile, commandActions: [{ type: hostile, command: hostile }], networkApprovalContext: { host: hostile } } },
    { method: 'item/fileChange/requestApproval', params: { itemId: hostile, reason: hostile, grantRoot: hostile } },
    { method: 'item/permissions/requestApproval', params: { cwd: hostile, reason: hostile, permissions: { fileSystem: { write: [hostile] }, network: { enabled: true } } } },
    { method: 'item/tool/requestUserInput', params: { questions: [{ id: hostile, header: hostile, question: hostile, options: [{ label: hostile, description: hostile }] }] } },
    { method: hostile, params: { reason: hostile } },
  ];
  for (const event of events) {
    const shown = nativeRequestLines(event).join('\n'); assert.doesNotMatch(shown, /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e\u2066]/);
    assert.ok(shown.includes(safe), `missing readable escaped controls for ${event.method}`);
  }
  assert.deepEqual(nativeRequestLines({ method: 'item/tool/requestUserInput', params: { questions: null } }), ['Questions for the human']);
});

test('a Peerloom CLI approval is summarised only when it is exactly that, and a message to oneself is flagged', async () => {
  const { agentlinkCall, shellWords } = await import('../core/shell-agents.ts');
  const known = { cli: '/a/core/cli.ts', clientPath: '/r/codex.json', self: 'codex', names: { p_1: 'Claude', p_2: 'codex', p_0: 'human' } };
  assert.deepEqual(agentlinkCall(`/bin/zsh -lc 'node /a/core/cli.ts send --client /r/codex.json --to p_2 --text "Hi! 👋" --key k1'`, known), { text: 'peerloom send --to codex --text "Hi! 👋"', warnings: ['This is addressed to codex itself.'] });
  assert.deepEqual(agentlinkCall('node /a/core/cli.ts send --client /r/codex.json --to p_1,p_0 --text hello', known), { text: 'peerloom send --to Claude,human --text hello', warnings: [] });
  assert.deepEqual(agentlinkCall('node /a/core/cli.ts fetch --client /r/codex.json --wake wk_1', known), { text: 'peerloom fetch --wake wk_1', warnings: [] });
  // The quiet verbs (item 24, slice C) and their two value-less switches are recognised, so a trusted agent is not asked about them.
  assert.deepEqual(agentlinkCall('node /a/core/cli.ts react --client /r/codex.json --message m_1 --emoji 👍', known), { text: 'peerloom react --message m_1 --emoji "👍"', warnings: [] });
  assert.deepEqual(agentlinkCall('node /a/core/cli.ts react --client /r/codex.json --message m_1 --emoji 👍 --off', known), { text: 'peerloom react --message m_1 --emoji "👍" --off', warnings: [] });
  assert.deepEqual(agentlinkCall("node /a/core/cli.ts working --client /r/codex.json --message m_1 --text 'on it'", known), { text: 'peerloom working --message m_1 --text "on it"', warnings: [] });
  assert.deepEqual(agentlinkCall('node /a/core/cli.ts send --client /r/codex.json --to p_1 --no-reply --text hi', known), { text: 'peerloom send --to Claude --no-reply --text hi', warnings: [] });
  assert.deepEqual(agentlinkCall('node /a/core/cli.ts post --client /r/codex.json --text fyi', known), { text: 'peerloom post --text fyi', warnings: [] });
  // A switch is only a switch on its own command, and only once.
  for (const odd of ['node /a/core/cli.ts fetch --client /r/codex.json --off --wake wk_1', 'node /a/core/cli.ts react --client /r/codex.json --message m_1 --emoji 👍 --off --off', 'node /a/core/cli.ts post --client /r/codex.json --no-reply --text x'])
    assert.equal(agentlinkCall(odd, known), null, odd);
  // Shown whole instead: another credential, another program, a second command, a substitution, a redirect, a missing value.
  for (const command of ['node /a/core/cli.ts send --client /r/owner.json --to p_1 --text hi', 'node /b/core/cli.ts fetch --client /r/codex.json --wake wk_1', 'ls -la', 'node /a/core/cli.ts fetch --client /r/codex.json --wake wk_1; rm -rf x',
    'node /a/core/cli.ts send --client /r/codex.json --text "$(cat /r/codex.json)"', 'node /a/core/cli.ts fetch --client /r/codex.json --wake wk_1 > /tmp/x', 'node /a/core/cli.ts fetch --client /r/codex.json --wake', 'node /a/core/cli.ts send --client /r/codex.json --text `id`', 'node /a/core/cli.ts --client /r/codex.json',
    // Also whole: no credential named (it would come from an environment this parser cannot see), a flag given twice, another endpoint.
    'node /a/core/cli.ts send --to human --text hello', 'node /a/core/cli.ts room', 'node /a/core/cli.ts send --client /r/codex.json --client /r/codex.json --text hi', 'node /a/core/cli.ts send --client /r/codex.json --to p_1 --to p_0 --text hi',
    'node /a/core/cli.ts room --client /r/codex.json --endpoint http://127.0.0.1:9']) assert.equal(agentlinkCall(command, known), null, command);
  // Sending a file is recognised but never silent: the warning keeps a trusted agent's call in front of the human.
  assert.deepEqual(agentlinkCall('node /a/core/cli.ts send --client /r/codex.json --to p_0 --text-file /r/codex.json', known), { text: 'peerloom send --to human --text-file /r/codex.json', warnings: ['This sends the contents of the file /r/codex.json.'] });
  assert.equal(agentlinkCall('node /a/core/cli.ts publish --client /r/codex.json --item it_1 --file plan.md', known)!.warnings.length, 1);
  assert.deepEqual(agentlinkCall('node /a/core/cli.ts reply --client /r/codex.json --wake wk_1 --text -', known), { text: 'peerloom reply --wake wk_1 --text -', warnings: [] });
  assert.deepEqual(shellWords(String.raw`a 'b c' "d \"e\"" f\ g ''`), ['a', 'b c', 'd "e"', 'f g', '']); assert.equal(shellWords(`a 'unfinished`), null); assert.equal(shellWords('a && b'), null);
  // Control characters in what the model wrote stay visible in the summary.
  assert.equal(agentlinkCall('node /a/core/cli.ts send --client /r/codex.json --text "x\u001b[2Jy"', known)!.text, 'peerloom send --text "x\\u001b[2Jy"');
  // Codex's own wrapper quotes the command a second time. Text single-quoted inside it stays literal after both layers
  // are decoded, so a reply that mentions $HOME, a backtick or "!" is recognised; a real expansion or operator is not.
  const { quote } = await import('../core/shell-agents.ts');
  const wrap = (inner: string) => `/bin/zsh -lc ${quote(inner)}`;
  const literal = 'CLI_ERGONOMICS_OK $HOME `tick` ! "quoted" it\'s';
  assert.deepEqual(agentlinkCall(wrap(`node /a/core/cli.ts reply --client /r/codex.json --wake wk_1 --text ${quote(literal)}`), known), { text: `peerloom reply --wake wk_1 --text ${JSON.stringify(literal)}`, warnings: [] });
  assert.deepEqual(agentlinkCall(`/bin/bash -lc "node /a/core/cli.ts fetch --client /r/codex.json --wake wk_1"`, known), { text: 'peerloom fetch --wake wk_1', warnings: [] });
  for (const inner of ['node /a/core/cli.ts reply --client /r/codex.json --wake wk_1 --text "$HOME"', 'node /a/core/cli.ts reply --client /r/codex.json --wake wk_1 --text `id`', 'node /a/core/cli.ts reply --client /r/codex.json --wake wk_1 --text hi!',
    'node /a/core/cli.ts fetch --client /r/codex.json --wake wk_1 && id', 'node /a/core/cli.ts fetch --client /r/codex.json --wake wk_1 | tee x']) assert.equal(agentlinkCall(wrap(inner), known), null, inner);
  // A wrapper of another shape is not looked into: more arguments, another flag, another shell, or one nested in another.
  for (const command of [`/bin/zsh -lc 'node /a/core/cli.ts room --client /r/codex.json' extra`, `/bin/zsh -c 'node /a/core/cli.ts room --client /r/codex.json'`, `/usr/bin/env sh -lc 'node /a/core/cli.ts room --client /r/codex.json'`,
    wrap(wrap('node /a/core/cli.ts room --client /r/codex.json')), `/bin/zsh -lc "node /a/core/cli.ts send --client /r/codex.json --text $(id)"`]) assert.equal(agentlinkCall(command, known), null, command);
});


test('a stopped agent is told the way back: the same session, the work again, or Codex unarchiving it first', () => {
  const thread = '01a125db-85c3-7b33-91a1-92252326344c';
  // Codex archived the session (item 18): relaunching alone would fail the same way, so the remedy comes first.
  // The host's reason already says it in prose; the console says it once, as the two commands to type.
  const archived = stoppedText('Codex', { reason: 'Codex refused thread/resume (-32600): saved session … is archived. Run `codex unarchive …`, then relaunch this agent; no automatic retry', archivedThreadId: thread }, { threadId: thread });
  assert.equal(archived, `Codex stopped: Codex has archived this agent's session, so it cannot be resumed.\n  Run: codex unarchive ${thread}   then /relaunch Codex`);
  assert.doesNotMatch(archived, /takes the same session up again/);
  // An id that is not the one this console saved for the agent, or not a session id at all, is never printed as a command.
  for (const other of ['01a125db-0000-7b33-91a1-92252326344c', 'x; rm -rf /', undefined]) {
    const text = stoppedText('Codex', { reason: 'Codex refused thread/resume (-32600)', archivedThreadId: other }, { threadId: thread });
    assert.doesNotMatch(text, /unarchive/); assert.match(text, /   \/relaunch Codex takes the same session up again\.$/);
  }
  assert.doesNotMatch(stoppedText('Codex', { reason: 'archived', archivedThreadId: 'x; rm -rf /' }, { threadId: 'x; rm -rf /' }), /unarchive/);
  // What it said before item 18, unchanged.
  assert.equal(stoppedText('Codex', { reason: 'the run is paused' }, { threadId: thread }), 'Codex stopped: the run is paused   /relaunch Codex takes the same session up again.');
  assert.equal(stoppedText('Codex', { reason: 'Native app-server exited' }, null), 'Codex stopped: Native app-server exited');
  assert.match(stoppedText('Codex', { reason: 'wk_1 was already dispatched once' }, { threadId: thread }), /\n  It was given that work once and did not take it\. \/reoffer Codex offers it again and reopens the session\.$/);
  assert.equal(stoppedText('Codex', { reason: 'a\x1b[2Jb' }, null), 'Codex stopped: a\\u001b[2Jb');
});

test('both owned openings teach suggest on the agent\'s own credential, with every proposal field, as a room command', async () => {
  const { ownedClaudeOpening } = await import('../core/claude-host.ts'); const { opening } = await import('../core/codex-adapter.ts');
  for (const text of [ownedClaudeOpening('Opus', 'Room', '/x/opus.json', '/c/core/cli.ts'), opening('Codex', 'Room', '/x/codex.json', '/c/core/cli.ts')]) {
    const command = /node \/c\/core\/cli\.ts suggest --client \/x\/(opus|codex)\.json --title '[^']+' --text '(\{[^']+\})'/.exec(text);
    assert.ok(command, 'the suggest command, in the form the console answers by itself');
    const shown = JSON.parse(command[2]); assert.deepEqual(Object.keys(shown), ['v', 'kind', 'gap', 'outcome', 'evidence', 'why', 'payoff', 'effort', 'impact', 'scope', 'acceptance']); assert.equal(shown.v, 1);
    // Seen in the real run: prose with an apostrophe inside the single-quoted JSON broke the shell command.
    assert.ok(text.includes('write an apostrophe as \\u0027'), 'the shell-safe JSON escape for an apostrophe');
    assert.match(text, /starts no work and wakes nobody/); assert.match(text, /kind is gap \(something missing or wrong, with evidence\) or idea/);
  }
});

test('both owned openings teach keeping the project map current with map-edit on their own credential (item 22)', async () => {
  const { ownedClaudeOpening } = await import('../core/claude-host.ts'); const { opening } = await import('../core/codex-adapter.ts'); const { parseMap } = await import('../core/map.ts');
  for (const text of [ownedClaudeOpening('Opus', 'Room', '/x/opus.json', '/c/core/cli.ts'), opening('Codex', 'Room', '/x/codex.json', '/c/core/cli.ts')]) {
    assert.match(text, /agentlink-map\.txt/); assert.match(text, /when your work adds, removes or rewires a part of the project, update the map in the same turn/i);
    const adds = [...text.matchAll(/node \/c\/core\/cli\.ts map-edit --client \/x\/(?:opus|codex)\.json --add '([^']+)'/g)].map(m => m[1]);
    assert.equal(adds.length, 2, 'a node and a flow example'); assert.deepEqual(parseMap(['node hub | Hub | service', ...adds].join('\n')).errors, []);
    assert.match(text, /map-edit --client \/x\/(opus|codex)\.json --remove ID/);
  }
});

test('a profile opening uses short identity commands, silent informational receipts and the selected wake route', async () => {
  const { externalOpening, MAIL_RULES } = await import('../core/shell-agents.ts');
  const self = externalOpening('DeepSeek', 'Room', '/room/.agentlink/agents/dsh-a123/credential.json', '/checkout/core/cli.ts', 'DeepSeek Harness', 'dsh-a123', 'self-arming');
  assert.match(self, /peerloom bind --as dsh-a123/); assert.match(self, /peerloom wait --as dsh-a123 --timeout 3300/);
  assert.match(self, /peerloom reply --as dsh-a123/); assert.match(self, /peerloom help/); assert.ok(!self.includes('node /checkout/core/cli.ts'));
  assert.ok(self.includes(MAIL_RULES)); assert.match(self, /no reply is expected/); assert.match(self, /A receipt never settles that obligation/);
  assert.match(self, /Exit 8 means the hub is closing/); assert.match(self, /never guess a different identity/);
  const active = externalOpening('Agent', 'Room', '/room/credential.json', '/checkout/core/cli.ts', 'In-turn harness', 'agent-a123', 'in-turn');
  assert.match(active, /inside your current turn/); assert.match(active, /--timeout 600/); assert.match(active, /return to step 2 inside this turn/);
  assert.doesNotMatch(active, /Then start the wait again exactly as in step 2 and end your turn/);
  assert.throws(() => externalOpening('Agent', 'Room', '/room/credential.json', '/checkout/core/cli.ts', 'Harness', '../owner'), /Invalid agent profile id/);
});

test('all route openings share the same mail contract while keeping their own binding and listening ownership', async () => {
  const { MAIL_RULES, mailProtocol, claudeOpening, codexAppOpening, externalOpening } = await import('../core/shell-agents.ts');
  const { ownedClaudeOpening } = await import('../core/claude-host.ts'); const { opening } = await import('../core/codex-adapter.ts');
  const rows = [
    { text: claudeOpening('Agent', 'Room', '/room/agent.json', '/checkout/core/cli.ts'), hosted: false },
    { text: codexAppOpening('Agent', 'Room', '/room/agent.json', '/checkout/core/cli.ts'), hosted: false },
    { text: externalOpening('Agent', 'Room', '/room/agent.json', '/checkout/core/cli.ts', 'External'), hosted: false },
    { text: ownedClaudeOpening('Agent', 'Room', '/room/agent.json', '/checkout/core/cli.ts'), hosted: true },
    { text: opening('Agent', 'Room', '/room/agent.json', '/checkout/core/cli.ts'), hosted: true },
  ];
  for (const { text, hosted } of rows) {
    assert.equal(text.split(MAIL_RULES).length, 2, 'one shared mail policy, once per opening');
    assert.match(text, /A message that needs no answer is acknowledged with: node \/checkout\/core\/cli.ts ack/);
    assert.match(text, /react.* --message MESSAGE_ID --emoji 👍/); assert.match(text, /blocked.* --text/); assert.match(text, /post.* --to NAME/); assert.match(text, /--no-reply/);
    assert.match(text, /A structured request is answered or declined with respond, not reply or ack/);
    assert.match(text, /exact artifact, revision and digest actually reviewed/); assert.match(text, /thread_moved/);
    assert.match(text, /Exit 8 means the hub is closing/); assert.match(text, /Do not send the human a progress line after each exchange with another agent/);
    assert.match(text, /stand in for human approval/);
    assert.equal(text.includes('node /checkout/core/cli.ts bind'), !hosted, 'only a self-owned route teaches its own bind');
    if (hosted) assert.doesNotMatch(text, /node \/checkout\/core\/cli.ts wait/);
  }
  assert.match(rows[0].text, /run_in_background/); assert.match(rows[1].text, /write_stdin/);
  assert.match(rows[3].text, /peerloom starts waiting again by itself/); assert.match(rows[4].text, /the host owns re-arming/);
  assert.match(rows[4].text, /Do not try them inside the sandbox first/); assert.match(rows[4].text, /--text-file FILE.*asks for approval even when/);
  assert.match(mailProtocol('Agent', verb => `peerloom ${verb} --as ag-a123`), /peerloom reply --as ag-a123/);
});
