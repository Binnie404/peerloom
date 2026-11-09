import test from 'node:test';
import assert from 'node:assert/strict';
import { agentStateLabel, agentWaitLabel, defaultRecipient, recipientChoices, renderAgentCard, renderCapacity, renderJoinCard, renderNeedsQuestion, renderNeedsReview } from '../ui/app.js';

// Item 24, slice A: the page shows one state word per agent, the room's record capacity beside the wake budget, and a
// Needs-you card with an answer form for each question an agent asks the human. Plain functions, no browser.

const attack = '"><img src=x onerror=alert(1)><script>fetch("https://example.invalid")</script>';

test('one state word per agent, and an older console without the field keeps the armed wording', () => {
  assert.equal(agentStateLabel({ state: 'listening' }), 'Listening');
  assert.equal(agentStateLabel({ state: 'joined' }), 'Joined · not listening yet');
  assert.equal(agentStateLabel({ state: 'held' }), 'Held');
  assert.equal(agentStateLabel({ state: 'blocked_approval' }), 'Blocked · waiting for your approval');
  assert.equal(agentStateLabel({ state: 'stopped' }), 'Stopped');
  assert.equal(agentStateLabel({}), null);
  assert.equal(agentStateLabel({ state: 'invented' }), null, 'an unknown word is not shown as a state');
  assert.equal(agentStateLabel(null), null);
  // A handed-down state wins over the older armed/held vocabulary, except the budget hold the card explains in full.
  assert.equal(agentWaitLabel({ armed: 'waiting', state: 'listening' }, 'running'), 'Listening');
  assert.equal(agentWaitLabel({ armed: 'waiting' }, 'running'), 'Waiting for work');
  assert.equal(agentWaitLabel({ armed: 'waiting', held: 'budget_agent' }, 'running'), 'Held: agent wake budget spent');
  assert.equal(agentWaitLabel({ armed: 'waiting', held: 'storage' }, 'running'), 'Waiting for work');
});

test('an agent card carries the state as data and as one readable line', () => {
  const card = renderAgentCard({ name: 'Claude', kind: 'claude', where: 'external', session: 'open', armed: 'waiting', held: null, state: 'listening', controls: {} }, 'running');
  assert.match(card, /data-state="listening"/);
  assert.match(card, /Listening/);
  const identified = renderAgentCard({ name: 'DeepSeek', kind: 'dsh', where: 'external', session: 'open', armed: 'waiting', held: null, state: 'verified', agentId: 'dshag-7e4f' }, 'running');
  assert.match(identified, /dshag-7e4f/, 'a pasted agent shows its short id');
  const stopped = renderAgentCard({ name: 'Codex', kind: 'codex', where: 'owned', session: 'closed', armed: 'not_armed', held: null, state: 'stopped' }, 'running');
  assert.match(stopped, /data-state="stopped"/);
  assert.match(stopped, />Stopped</);
  const legacy = renderAgentCard({ name: 'Codex', kind: 'codex', where: 'owned', session: 'open', armed: 'waiting', held: null }, 'running');
  assert.doesNotMatch(legacy, /data-state=/);
  assert.match(legacy, /Waiting for work/);
});

test('capacity is shown beside the budget as three used/cap counters, and an older console shows nothing', () => {
  const html = renderCapacity({ capacity: { offers: { used: 0, cap: 2000 }, grants: { used: 3, cap: 500 }, controls: { used: 1, cap: 1000 } } });
  assert.match(html, /Capacity: /);
  assert.match(html, /offers 0 \/ 2000/);
  assert.match(html, /grants 3 \/ 500/);
  assert.match(html, /controls 1 \/ 1000/);
  assert.match(html, /lifetime caps, not the wake budget/);
  assert.equal(renderCapacity({}), '');
  assert.equal(renderCapacity({ capacity: null }), '');
  assert.equal(renderCapacity({ capacity: { offers: { used: 0 } } }), '', 'a half-read counter is not shown as zero of nothing');
  assert.doesNotMatch(renderCapacity({ capacity: { offers: { used: attack, cap: 2 } } }), /<img|<script/, 'a hostile counter is not rendered');
});

test('a question card names who asks and carries an answer form that escapes everything it shows', () => {
  const html = renderNeedsQuestion({ id: 'rq_1', from: 'Claude', item: 'One-paste join', purpose: 'answer', text: 'Which port should the join line use?', at: '2026-10-29T10:45:51.039Z' });
  assert.match(html, /data-needs-id="rq_1"/);
  assert.match(html, /data-needs-form="rq_1"/);
  assert.match(html, /Claude needs an answer/);
  assert.match(html, /One-paste join/);
  assert.match(html, /Which port should the join line use\?/);
  assert.match(html, /name="outcome" value="answered"/);
  assert.match(html, /name="outcome" value="declined"/);
  assert.match(html, /<time datetime="2026-10-29T10:45:51.039Z">/);
  assert.doesNotMatch(html, /data-action="approve"|data-action="deny"/, 'a question is answered, not approved as a tool request');

  const hostile = renderNeedsQuestion({ id: attack, from: attack, item: attack, purpose: attack, text: attack, at: attack }, attack);
  assert.doesNotMatch(hostile, /<img|<script/);
  for (const escaped of ['&lt;img', '&lt;script', '&quot;']) assert.ok(hostile.includes(escaped), `escapes ${escaped}`);

  const draft = renderNeedsQuestion({ id: 'rq_2', from: 'Codex', text: 'Q' }, 'typed <b>answer</b>');
  assert.match(draft, /typed &lt;b&gt;answer&lt;\/b&gt;/);
});

test('a question without an item, purpose or time still renders a complete answer form', () => {
  const html = renderNeedsQuestion({ id: 'rq_3', from: 'human', text: 'Ready?' });
  assert.match(html, /You needs an answer/);
  assert.match(html, /data-needs-form="rq_3"/);
  assert.doesNotMatch(html, /needs-item/);
  assert.doesNotMatch(html, /<time/);
});

test('a join card shows the pairing code and only the actions that create or refuse a participant', () => {
  const html = renderJoinCard({ claimId: 'jc_1', label: 'Claude Code', harness: 'claude-code', pairingCode: 'KQ7M-3XHD', state: 'claimed', expiresAt: '2026-10-29T11:30:00.000Z' });
  assert.match(html, /data-join-id="jc_1"/);
  assert.match(html, /data-join-state="claimed"/);
  assert.match(html, /KQ7M-3XHD/);
  assert.match(html, /Check this matches the code in the agent’s session/);
  assert.match(html, /data-action="join-approve" data-id="jc_1">Let in/);
  assert.match(html, /data-action="join-refuse" data-id="jc_1">Refuse/);
  assert.match(html, /<time datetime="2026-10-29T11:30:00.000Z">/);
  assert.doesNotMatch(html, /data-action="approve"/, 'a join is not a native tool approval');
});

test('a join being approved has no buttons, and a stopped approval can only be refused', () => {
  const approving = renderJoinCard({ claimId: 'jc_2', label: 'Codex', harness: 'codex', pairingCode: 'ABCD-EFGH', state: 'approving' });
  assert.match(approving, /data-join-state="approving"/);
  assert.doesNotMatch(approving, /data-action="join-approve"/);
  assert.doesNotMatch(approving, /data-action="join-refuse"/);
  assert.match(approving, /finishes on its own/);

  const reconcile = renderJoinCard({ claimId: 'jc_3', label: 'Codex', harness: 'codex', pairingCode: 'ABCD-EFGH', state: 'reconcile' });
  assert.match(reconcile, /data-join-state="reconcile"/);
  assert.doesNotMatch(reconcile, /data-action="join-approve"/);
  assert.match(reconcile, /data-action="join-refuse"/);
  assert.match(reconcile, /stopped too long ago/);
  assert.doesNotMatch(reconcile, /data-action="join-retry"/, 'no Retry without the server saying it may be retried');
  const retryable = renderJoinCard({ claimId: 'jc_8', label: 'Codex', harness: 'codex', pairingCode: 'ABCD-EFGH', state: 'reconcile', retry: true, note: 'Carry on with the same identity, or refuse.' });
  assert.match(retryable, /data-action="join-retry" data-id="jc_8">Retry/);
  assert.match(retryable, /data-action="join-refuse" data-id="jc_8">Refuse/);
  assert.match(retryable, /Carry on with the same identity/);
  const mismatched = renderJoinCard({ claimId: 'jc_9', label: 'Codex', harness: 'codex', pairingCode: 'ABCD-EFGH', state: 'reconcile', retry: false, note: 'A different participant came back.' });
  assert.doesNotMatch(mismatched, /data-action="join-retry"/, 'a participant mismatch cannot be retried');
  assert.match(mismatched, /data-action="join-refuse"/);
  const detailed = renderJoinCard({ claimId: 'jc_4', label: 'Codex', harness: 'codex', pairingCode: 'ABCD-EFGH', state: 'reconcile', detail: 'The hub returned a different participant.' });
  assert.match(detailed, /The hub returned a different participant\./);
  // The server's own note wins over the page's fallback wording, and it is shown as data.
  const noted = renderJoinCard({ claimId: 'jc_6', label: 'Codex', harness: 'codex', pairingCode: 'ABCD-EFGH', state: 'reconcile', note: 'This approval stopped too long ago to finish by itself; refuse it and send a new join line.' });
  assert.match(noted, /refuse it and send a new join line/);
  assert.match(noted, /data-action="join-refuse"/);
  const hostileNote = renderJoinCard({ claimId: 'jc_7', label: 'X', harness: 'dsh', pairingCode: 'AAAA-BBBB', state: 'reconcile', note: attack });
  assert.doesNotMatch(hostileNote, /<img|<script/);
});

test('a join card escapes the code, claim, label and harness, and an unknown state falls back to the code view', () => {
  const hostile = renderJoinCard({ claimId: attack, label: attack, harness: attack, pairingCode: attack, state: attack, expiresAt: attack });
  assert.doesNotMatch(hostile, /<img|<script/);
  for (const escaped of ['&lt;img', '&lt;script', '&quot;']) assert.ok(hostile.includes(escaped), `escapes ${escaped}`);
  const unknown = renderJoinCard({ claimId: 'jc_5', label: 'X', harness: 'dsh', pairingCode: 'AAAA-BBBB', state: 'someday' });
  assert.match(unknown, /data-join-state="someday"/);
  assert.match(unknown, /AAAA-BBBB/);
  assert.match(unknown, /data-action="join-approve"/);
});

test('a review request is listed without an answer form and opens Work, because a verdict needs the exact revision', () => {
  const html = renderNeedsReview({ id: 'rq_rev1', from: 'Codex', item: 'One-paste join', purpose: 'review', text: 'Please review revision 2 of the join line.', at: '2026-10-29T11:00:00.000Z', target: { artifactId: 'ar_1', revision: 2, digest: 'a'.repeat(64) } });
  assert.match(html, /data-review-id="rq_rev1"/);
  assert.match(html, /Codex asks for a verdict/);
  assert.match(html, /One-paste join/);
  assert.match(html, /Please review revision 2 of the join line\./);
  assert.match(html, /Revision 2/);
  assert.match(html, /<time datetime="2026-10-29T11:00:00.000Z">/);
  assert.match(html, /data-view="work"/);
  assert.match(html, /Review: open it in Work/);
  assert.doesNotMatch(html, /data-needs-form|name="outcome"|data-action="answer"/, 'a review is not answered with the plain answer form');
  assert.doesNotMatch(html, /data-action="approve"|data-action="deny"/, 'and it is not a native tool approval');
});

test('a review card escapes its text and target, and one without a target or time still renders', () => {
  const hostile = renderNeedsReview({ id: attack, from: attack, item: attack, text: attack, at: attack, target: { revision: attack } });
  assert.doesNotMatch(hostile, /<img|<script/);
  for (const escaped of ['&lt;img', '&lt;script', '&quot;']) assert.ok(hostile.includes(escaped), `escapes ${escaped}`);
  const plain = renderNeedsReview({ id: 'rq_rev2', from: 'Claude', text: 'Verdict?' });
  assert.match(plain, /data-review-id="rq_rev2"/); assert.match(plain, /data-view="work"/);
  assert.doesNotMatch(plain, /Revision|needs-item|<time/);
});

test('a verified agent reads "Verified · listening", and the card carries the state', () => {
  assert.equal(agentStateLabel({ state: 'verified' }), 'Verified · listening');
  const card = renderAgentCard({ name: 'Claude', kind: 'claude', where: 'external', session: 'open', armed: 'waiting', held: null, state: 'verified' }, 'running');
  assert.match(card, /data-state="verified"/);
  assert.match(card, /Verified · listening/);
  // The state words before it stay exactly as they were.
  assert.equal(agentStateLabel({ state: 'listening' }), 'Listening');
  assert.equal(agentStateLabel({ state: 'joined' }), 'Joined · not listening yet');
});

test('the composer starts on one recipient; All agents is only a deliberate choice', () => {
  const agents = [{ name: 'Claude' }, { name: 'Codex' }];
  assert.deepEqual(recipientChoices(agents).map(choice => [choice.value, choice.label]), [['Claude', 'Claude'], ['Codex', 'Codex'], ['', 'Everyone']]);
  assert.deepEqual(recipientChoices([]), [{ value: '', label: 'Everyone' }]);
  assert.equal(defaultRecipient(agents, undefined), 'Claude', 'the first agent is the starting point, not Everyone');
  assert.equal(defaultRecipient(agents, 'Codex'), 'Codex', 'a chosen agent stays chosen');
  assert.equal(defaultRecipient(agents, ''), '', 'All stays chosen once the human picked it');
  assert.equal(defaultRecipient(agents, 'Gone'), 'Claude', 'a removed agent falls back to one recipient');
  assert.equal(defaultRecipient([], undefined), '');
});
