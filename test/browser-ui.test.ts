import test from 'node:test';
import assert from 'node:assert/strict';
import { EventStreamParser, applyRoomEvent, renderApproval, renderMessage, agentWaitLabel, budgetAttention, renderBudgetAttention, renderRecommendations, renderWhatNext, confirmedTask, mapSelection, layoutMap, renderMapFlow, renderProjectMap } from '../ui/app.js';

test('browser stream preserves split UTF-8, multiline data, CRLF and ordered event IDs', () => {
  const parser = new EventStreamParser();
  const source = new TextEncoder().encode(': heartbeat\r\n\r\nid: 21\r\ndata: {"type":"message",\r\ndata: "text":"Hello 👋, Claude’s ready"}\r\n\r\nid: 22\ndata: {"type":"approval_done","id":"approval-1"}\n\n');
  const frames = [];
  // Deliberately split each multibyte character and line ending across reads.
  for (const byte of source) frames.push(...parser.push(Uint8Array.of(byte)));
  frames.push(...parser.push(undefined, true));
  assert.deepEqual(frames, [
    { id: 21, data: { type: 'message', text: 'Hello 👋, Claude’s ready' } },
    { id: 22, data: { type: 'approval_done', id: 'approval-1' } },
  ]);
});

test('browser stream exposes reset and refuses malformed or oversized frames rather than inventing state', () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  assert.deepEqual(new EventStreamParser().push(encode('data: {"type":"reset"}\n\n')), [{ id: undefined, data: { type: 'reset' } }]);
  assert.throws(() => new EventStreamParser().push(encode('id: 1\ndata: not JSON\n\n')), SyntaxError);
  assert.throws(() => new EventStreamParser().push(encode('x'.repeat(2_000_001))), /oversized/);
});

test('replayed room messages remain unique and ordered without losing directed recipients', () => {
  const original = { messages: [{ sequence: 4, from: 'Claude', to: ['Codex'], text: 'Review this', at: '2026-10-24T13:00:00Z' }], agents: [], approvals: [] };
  const replay = applyRoomEvent(original, { type: 'message', ...original.messages[0] });
  const earlier = applyRoomEvent(replay, { type: 'message', sequence: 3, from: 'human', to: ['Claude'], text: 'Build it' });
  assert.deepEqual(earlier.messages.map((m: any) => m.sequence), [3, 4]);
  assert.deepEqual(earlier.messages[1].to, ['Codex']);
  assert.equal(original.messages.length, 1, 'the snapshot is not mutated');
});

test('native approval IDs stay independent from agents and are removed only by matching resolution', () => {
  let state: any = { messages: [], agents: [], approvals: [] };
  state = applyRoomEvent(state, { type: 'approval', id: '0', agent: 'Claude', kind: 'approval' });
  state = applyRoomEvent(state, { type: 'approval', id: '1', agent: 'Codex', kind: 'permission' });
  state = applyRoomEvent(state, { type: 'approval_done', id: '0' });
  assert.deepEqual(state.approvals.map((a: any) => [a.id, a.agent]), [['1', 'Codex']]);
  state = applyRoomEvent(state, { type: 'agent', name: 'Codex', session: 'closed', armed: 'not_armed' });
  state = applyRoomEvent(state, { type: 'agent', name: 'Codex', session: 'open', armed: 'waiting' });
  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].armed, 'waiting');
  state = applyRoomEvent(state, { type: 'agent', name: 'Claude', session: 'open', armed: 'waiting' });
  state = applyRoomEvent(state, { type: 'agent', name: 'Codex', session: 'closed', armed: 'not_armed' });
  assert.deepEqual(state.agents.map((a: any) => a.name), ['Codex', 'Claude'], 'status updates keep the crew in place');
});

test('message and approval text are rendered as data even with hostile HTML, attributes and scripts', () => {
  const attack = '"><img src=x onerror=alert(1)><script>fetch("https://example.invalid")</script>';
  for (const html of [
    renderMessage({ sequence: 1, from: attack, to: [attack], text: attack, at: attack }),
    renderApproval({ id: attack, agent: attack, kind: 'approval', command: attack, reason: attack, lines: [attack] }),
    renderApproval({ id: 'q1', agent: 'Codex', kind: 'answer', params: { questions: [{ id: attack, question: attack, isOther: true, options: [{ label: attack, description: attack }] }] } }),
  ]) {
    assert.doesNotMatch(html, /<img|<script|data-id="">/);
    assert.match(html, /&lt;img/);
  }
});

test('native questions render actual choices and secrets; permission requests show only the requested turn access', () => {
  const question = renderApproval({ id: 'q2', agent: 'Codex', kind: 'answer', params: { questions: [
    { id: 'target', question: 'Which target?', options: [{ label: 'One', description: 'First' }] },
    { id: 'secret', question: 'Temporary value?', isSecret: true, isOther: true },
  ] } });
  assert.match(question, /<select[^>]+name="answer-0"/);
  assert.match(question, /value="One"/);
  assert.match(question, /type="password"/);
  assert.doesNotMatch(question, /data-action="approve"/);
  const permission = renderApproval({ id: 'p1', agent: 'Codex', kind: 'permission', params: { permissions: { network: { enabled: true }, fileSystem: { write: ['/tmp/result'] } } } });
  assert.match(permission, /Network access/);
  assert.match(permission, /Write: \/tmp\/result/);
  assert.match(permission, /limited to this turn/);
  assert.match(permission, /data-action="deny-permission"/);
  const absent = renderApproval({ id: 'p2', agent: 'Codex', kind: 'permission', params: {} });
  assert.doesNotMatch(absent, /data-action="grant-permission"/);
});

const heldRoom = () => ({
  run: { state: 'running', limits: { room: 40, agent: 12 }, used: { room: 40, agents: { Claude: 12, Codex: 9 } } },
  agents: [{ name: 'Claude', armed: 'waiting', held: 'budget_agent' }, { name: 'Codex', armed: 'waiting', held: 'budget_room' }],
});

test('budget attention follows explicit held work and clears on events without guessing from a full counter', () => {
  let state: any = heldRoom();
  assert.equal(budgetAttention(state)?.agents.length, 2);
  assert.equal((renderBudgetAttention(state).match(/data-budget-card/g) ?? []).length, 1, 'one room decision for both holds');
  assert.equal(agentWaitLabel(state.agents[0], 'running'), 'Held: agent wake budget spent');
  state = applyRoomEvent(state, { type: 'agent', name: 'Claude', armed: 'waiting', held: null });
  assert.equal(budgetAttention(state)?.agents.length, 1);
  state = applyRoomEvent(state, { type: 'agent', name: 'Codex', armed: 'waiting', held: null });
  assert.equal(state.run.used.room, state.run.limits.room);
  assert.equal(budgetAttention(state), null, 'spent counters with no held work do not ask for input');
  assert.equal(renderBudgetAttention(state), '');
  assert.equal(agentWaitLabel(state.agents[0], 'running'), 'Waiting for work');
  state = heldRoom(); state.run.state = 'paused';
  assert.equal(renderBudgetAttention(state), '', 'stale budget fields cannot offer to release a paused run');
  assert.equal(agentWaitLabel(state.agents[0], 'paused'), 'Waiting for work');
  state = heldRoom(); state.agents.forEach((agent: any) => { agent.held = 'storage'; });
  assert.equal(budgetAttention(state), null, 'storage or other holds are not a budget decision');
});

test('an extension proposes enough room for current use, honours both caps, and cannot promise an ineffective increase', () => {
  const state = heldRoom();
  assert.deepEqual(budgetAttention(state)?.limits, { room: 60, agent: 18 });
  assert.equal(budgetAttention(state)?.canExtend, true);
  state.run.limits = { room: 10, agent: 5 }; state.run.used = { room: 100, agents: { Claude: 20, Codex: 19 } };
  assert.deepEqual(budgetAttention(state)?.limits, { room: 101, agent: 21 }, 'a lowered limit still needs to exceed use');
  state.run.limits = { room: 500, agent: 200 }; state.run.used = { room: 500, agents: { Claude: 200, Codex: 199 } };
  assert.deepEqual(budgetAttention(state)?.limits, { room: 500, agent: 200 });
  assert.equal(budgetAttention(state)?.canExtend, false);
  const html = renderBudgetAttention(state);
  assert.match(html, /data-action="extend-budget" data-blocked="true" disabled/);
  assert.match(html, /maximum/); assert.match(html, /data-action="run" data-op="pause"/);
});

test('the budget card escapes agent names, names the applicable counters, and keeps its remedies distinct from approvals', () => {
  const state = heldRoom(); state.agents[0].name = '"><img src=x onerror=alert(1)>';
  const html = renderBudgetAttention(state);
  assert.doesNotMatch(html, /<img|data-action="approve"|data-action="deny"/);
  assert.match(html, /&lt;img/); assert.match(html, /Room limit: 40 \/ 40/);
  assert.match(html, /Agent limit: 0 \/ 12/);
  assert.equal((html.match(/data-action="extend-budget"/g) ?? []).length, 1);
  assert.equal((html.match(/data-op="pause"/g) ?? []).length, 1);
});
test('recommendation cards retain dissent, escape untrusted evidence and allow human adoption without claiming agreement', () => {
  const html = renderRecommendations({ storeVersion: 5, agents: [{ name: 'Claude' }, { name: 'Codex' }], recommendations: [{ itemId: 'it_1', title: '<script>bad()</script>', author: 'Claude', disposition: 'open', target: { artifactId: 'ar_1', revision: 2, digest: 'abc' }, payload: { v: 1, kind: 'gap', gap: 'Missing failure state', outcome: 'Handle it', evidence: ['<img src=x onerror=bad()>'], why: 'Before release', payoff: 'Reliability', effort: 'small', impact: 'high', scope: 'Checkout', acceptance: ['Can retry'] }, positions: [{ from: 'Codex', state: 'changes_requested', text: '<b>Timeout risk</b>' }] }] });
  assert.ok(html.includes('Has concerns'));
  assert.ok(html.includes('&lt;b&gt;Timeout risk&lt;/b&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=bad()&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.match(html, /data-action="adopt-suggestion"[^>]*data-blocked="false"/);
  assert.ok(!html.includes('Agreed'));
});

test('malformed proposals are readable and non-adoptable; old stores and adopted cards cannot create another task', () => {
  const malformed = { itemId: 'it_bad', title: 'Old proposal', author: 'Claude', disposition: 'open', payload: null, rawText: '<button onclick=bad()>legacy</button>', payloadError: 'Needs correction', positions: [] };
  const raw = renderRecommendations({ storeVersion: 5, recommendations: [malformed] });
  assert.ok(raw.includes('&lt;button onclick=bad()&gt;legacy&lt;/button&gt;'));
  assert.match(raw, /data-action="adopt-suggestion"[^>]*data-blocked="true" disabled/);
  const payload = { v: 1, kind: 'idea', outcome: 'Try it', scope: 'Small', acceptance: ['Works'], evidence: [] };
  const proposal = { ...malformed, payload, target: { artifactId: 'ar_1', revision: 1, digest: 'abc' } };
  const old = renderRecommendations({ storeVersion: 4, recommendations: [proposal] });
  assert.match(old, /data-action="adopt-suggestion"[^>]*data-blocked="true" disabled/);
  const adopted = renderRecommendations({ storeVersion: 5, recommendations: [{ ...proposal, disposition: 'adopted', adoption: { assignee: 'Codex', taskItemId: 'it_task' }, positions: [{ from: 'Codex', state: 'changes_requested', text: 'Still a concern' }] }] });
  assert.ok(adopted.includes('Task created for Codex'));
  assert.ok(adopted.includes('Still a concern'));
  assert.ok(!adopted.includes('data-action="adopt-suggestion"'));
  assert.ok(!adopted.includes('Work started'));
});

test('confirmed tasks validate the actual edited criteria and assessment status comes from explicit slots', () => {
  assert.deepEqual(confirmedTask({ outcome: ' Test ', scope: ' Only checkout ', acceptanceText: ' Retry succeeds \n\n Error is visible ' }), { outcome: 'Test', scope: 'Only checkout', acceptance: ['Retry succeeds', 'Error is visible'] });
  assert.throws(() => confirmedTask({ outcome: 'Test', scope: 'Checkout', acceptanceText: '' }));
  assert.throws(() => confirmedTask({ outcome: 'Test', scope: 'Checkout', acceptanceText: Array(11).fill('Criterion').join('\n') }));
  const html = renderWhatNext([{ at: '2026-10-25T19:00:00Z', leads: [{ name: '<Claude>', state: 'owed' }, { name: 'Codex', state: 'answered', suggestionIds: [] }] }]);
  assert.ok(html.includes('&lt;Claude&gt; · Waiting for a response'));
  assert.ok(html.includes('Codex · Answered'));
  assert.ok(!html.includes('0 suggestions'));
});

const projectMap = () => ({
  path: '/project/agentlink-map.txt', exists: true, digest: 'abc', mtimeMs: 1000.123, nodes: [
    { id: 'browser', label: 'Browser page', kind: 'ui', paths: ['ui/'] },
    { id: 'hub', label: 'Message hub', kind: 'service', paths: ['core/server.ts'] },
    { id: 'store', label: 'State file', kind: 'data', paths: ['state.json'] },
    { id: 'docs', label: 'Guide', kind: 'doc', paths: [] },
  ], flows: [{ from: 'browser', to: 'hub', label: 'sends actions' }, { from: 'hub', to: 'store', label: 'persists' }], errors: [],
  check: { state: 'done', forDigest: 'abc', forMtimeMs: 1000.123, checkedAt: '2026-10-26T12:00:00Z', sources: { hub: { state: 'changed', paths: [{ path: 'core/server.ts', state: 'changed' }] } }, coverage: { state: 'incomplete', reason: 'inventory bound reached', files: 100, uncited: 8, byArea: [{ area: 'core', files: 100, uncited: 8 }] } },
});

test('the same map supports a bounded directed diagram, an exhaustive accessible list and a neighborhood search', () => {
  const map = projectMap(); const selection = mapSelection(map, 'Message');
  assert.deepEqual(selection.nodes.map(n => n.id), ['browser', 'hub', 'store']); assert.equal(selection.flows.length, 2);
  assert.equal(mapSelection(map, 'absent').nodes.length, 0); assert.equal(mapSelection(map, 'state.json').nodes.length, 2);
  const layout = layoutMap(map); assert.ok(layout.nodes.find(n => n.id === 'browser')!.x < layout.nodes.find(n => n.id === 'hub')!.x);
  const flow = renderProjectMap(map, { mode: 'flow', selected: 'hub' });
  assert.match(flow, /<svg/); assert.match(flow, /<line x1=/); assert.match(flow, /data-map-node="hub" data-x="\d+" data-y="\d+"/); assert.match(flow, /class="map-node[^"]* selected" data-map-node="hub"/);
  assert.match(flow, /aria-label="Inspect Message hub"/); assert.match(flow, /id="map-node-detail" tabindex="-1"/); assert.match(flow, /Connected flows/);
  const list = renderProjectMap(map, { mode: 'list' });
  assert.doesNotMatch(list, /<svg/); for (const node of map.nodes) assert.ok(list.includes(node.label));
  assert.ok(list.includes('sends actions')); assert.ok(list.includes('persists'));
});

test('map checks distinguish source timestamps, inventory bounds, unchecked versions, read failures and update outcomes', () => {
  const map = projectMap();
  let html = renderProjectMap(map, { mode: 'list' });
  assert.ok(html.includes('Changed since the map was last updated')); assert.ok(html.includes('8 of 100 inventoried files are uncited'));
  assert.ok(html.includes('Incomplete: inventory bound reached')); assert.ok(html.includes('does not establish')); assert.ok(html.includes('folder’s presence does not check its contents'));
  map.mtimeMs = 1000.124; html = renderProjectMap(map, { mode: 'list' });
  assert.ok(!html.includes('data-source="changed"'), 'same bytes with a new sub-millisecond map timestamp need a new check');
  map.mtimeMs = 1000.123;
  map.digest = 'new'; html = renderProjectMap(map, { mode: 'list' });
  assert.ok(html.includes('Unchecked for this version')); assert.ok(html.includes('Previous check; the map has changed'));
  assert.ok(!html.includes('data-source="changed"'), 'old citation checks are not attached to a new map');
  const failed: any = { ...map, readError: 'unsafe map file', update: { lead: 'Claude', state: 'declined', text: 'Could not inspect the workspace' }, errors: [{ line: 5, reason: 'invalid entry', text: 'bad entry' }] };
  html = renderProjectMap(failed);
  assert.ok(html.includes('last readable view')); assert.ok(html.includes('Declined')); assert.ok(html.includes('Could not inspect')); assert.ok(html.includes('Line 5'));
  assert.ok(renderProjectMap({ ...map, nodes: [], flows: [], exists: false }).includes('Your project, connected.'));
});

test('map labels, paths, flow labels, author metadata and malformed lines cannot introduce markup or navigable external URLs', () => {
  const attack = '\"><img src=x onerror=bad()><script>bad()</script>';
  const map: any = projectMap(); map.nodes[0] = { id: attack, label: attack, kind: attack, paths: [attack] }; map.flows = [{ from: attack, to: 'hub', label: attack }];
  map.path = attack; map.updatedBy = attack; map.errors = [{ line: 1, text: attack, reason: attack }];
  map.check.coverage.byArea[0].area = attack; map.check.coverage.reason = attack;
  for (const html of [renderProjectMap(map), renderProjectMap(map, { mode: 'list' }), renderMapFlow(map)]) {
    assert.doesNotMatch(html, /<img|<script|onerror=bad\(\)>/); assert.ok(html.includes('&lt;img'));
    assert.doesNotMatch(html, /href="(?!#map-node-detail)/); assert.doesNotMatch(html, /style="/);
  }
});

test('flow layout terminates for cycles and disconnected parts and announces when the visual bounds are reached', () => {
  const nodes = Array.from({ length: 1000 }, (_, i) => ({ id: `n${i}`, label: `Part ${i}`, kind: 'component', paths: [] }));
  const flows = nodes.map((n, i) => ({ from: n.id, to: nodes[(i + 1) % nodes.length].id, label: 'cycle' }));
  flows.unshift({ from: 'n0', to: 'n0', label: 'self' }); const map = { nodes, flows };
  const graph = layoutMap(map); assert.equal(graph.nodes.length, 80); assert.equal(graph.totalNodes, 1000);
  assert.ok(graph.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)));
  const html = renderMapFlow(map); assert.ok(html.includes('80 of 1000 parts')); assert.ok(html.includes('List for every entry'));
  assert.equal((html.match(/ data-map-node="/g) ?? []).length, 80);
  assert.equal(map.nodes.length, 1000, 'visual layout never mutates or stores a second map');
});

test('an agent card takes its label and controls from the console, so a new harness needs no page change (item 23)', async () => {
  const { renderAgentCard } = await import('../ui/app.js');
  const card = (agent: any) => renderAgentCard({ name: 'X', model: null, effort: null, armed: 'waiting', held: null, note: null, ...agent }, 'running');
  const buttons = (html: string) => [...html.matchAll(/data-action="([a-z-]+)"/g)].map(m => m[1]);
  // An external harness: its own label and kind, "its own session", and no Stop, Relaunch, Message (to its session) or
  // Settings. Its Message button only addresses the room composer to it, so it is not a console control.
  const dsh = card({ name: 'DeepSeek', kind: 'dsh', label: 'DeepSeek Harness', where: 'external', session: 'open', controls: { stop: false, relaunch: false, tell: false, settings: false } });
  assert.match(dsh, /DeepSeek Harness · its own session/); assert.match(dsh, /data-kind="other"/); assert.match(dsh, /data-compose="DeepSeek"/); assert.deepEqual(buttons(dsh), []);
  // The controls the console sends are the ones shown, for any kind.
  assert.deepEqual(buttons(card({ kind: 'claude', where: 'owned', session: 'open', controls: { stop: true, relaunch: false, tell: true, settings: true } })), ['tell', 'stop', 'agent-settings']);
  assert.deepEqual(buttons(card({ kind: 'codex', where: 'owned', session: 'closed', controls: { stop: false, relaunch: true, tell: false, settings: true } })), ['relaunch', 'agent-settings']);
  // A console from before item 23 sends no controls or label: the card is what it was.
  const old = card({ kind: 'codex', where: 'owned', session: 'open' }); assert.match(old, /Codex · hosted here/); assert.match(old, /data-kind="codex"/); assert.deepEqual(buttons(old), ['tell', 'stop', 'agent-settings']);
  // A hostile label is text.
  assert.doesNotMatch(card({ kind: 'x', label: '<img src=x onerror=alert(1)>', where: 'external', session: 'closed', controls: { stop: false, relaunch: false, tell: false, settings: false } }), /<img/);
});

test('the invite form lists the console\'s harnesses, disabled with the reason when unprobed, and asks nothing an external one cannot use (item 23)', async () => {
  const { inviteChoices } = await import('../ui/app.js');
  const harnesses = [
    { id: 'claude', label: 'Claude Code', routes: ['owned', 'terminal', 'app'], enabled: true, reason: null },
    { id: 'dsh', label: 'DeepSeek Harness', routes: ['external'], enabled: true, reason: null },
    { id: 'gemini', label: 'Gemini CLI', routes: ['external'], enabled: false, reason: 'not probed yet' },
  ];
  assert.deepEqual(inviteChoices(harnesses, []), [
    { id: 'claude', label: 'Claude Code', enabled: true, reason: null, external: false, name: 'Claude' },
    { id: 'dsh', label: 'DeepSeek Harness', enabled: true, reason: null, external: true, name: 'DeepSeek' },
    { id: 'gemini', label: 'Gemini CLI', enabled: false, reason: 'not probed yet', external: true, name: 'Gemini' },
  ]);
  assert.equal(inviteChoices(harnesses, [{ name: 'DeepSeek' }])[1].name, 'DeepSeek2', 'a free name');
  // A console from before item 23 sends no list: Claude Code and Codex, as before.
  assert.deepEqual(inviteChoices(undefined, []).map((c: any) => [c.id, c.external]), [['claude', false], ['codex', false]]);
});

test('a message from an agent in another harness is tagged with that harness\'s label, as its crew card is (DeepSeek, 007-deepseek)', () => {
  const html = renderMessage({ sequence: 1, from: 'DeepSeek', to: ['human'], text: 'Hi' }, [{ name: 'DeepSeek', kind: 'dsh', label: 'DeepSeek Harness' }]);
  assert.match(html, /<span class="harness">DeepSeek Harness<\/span>/);
  assert.match(renderMessage({ sequence: 2, from: 'Codex', to: ['human'], text: 'Hi' }, [{ name: 'Codex', kind: 'codex' }]), /<span class="harness">Codex<\/span>/, 'a console from before item 23');
});
