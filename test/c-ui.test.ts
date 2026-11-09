import test from 'node:test';
import assert from 'node:assert/strict';
import { activityOf, applyRoomEvent, composerMentionRoute, composerPlan, mentionedNames, renderAgentCard, renderAgentWork, renderMessage, renderReactions, renderReceipts } from '../ui/app.js';

// Slice C page contract (opus fc3aa5d): per-recipient receipts that never claim a model read, quiet posts, reactions,
// the working/blocked line, @mentions and the reply-not-required choice. Plain functions; no browser.

const mail = (extra: any = {}) => ({ sequence: 1, id: 'm_1', from: 'Claude', to: ['human'], text: 'Built it', at: '2026-10-29T15:00:00.000Z', kind: 'mail', receipts: [], reactions: [], ...extra });

test('receipts are worded exactly as the client actions, per recipient, and never say Read', () => {
  const html = renderReceipts(mail({ receipts: [{ to: 'human', state: 'stored' }, { to: 'Codex', state: 'fetched' }, { to: 'Sol', state: 'acknowledged' }] }));
  for (const wording of ['Stored', 'Fetched', 'Acknowledged']) assert.ok(html.includes(wording), `shows ${wording}`);
  assert.match(html, /✓ Stored/);
  assert.match(html, /✓✓ Fetched/);
  assert.match(html, /✓✓ Acknowledged/);
  assert.match(html, /receipt-acknowledged/, 'the acknowledged tick is the stronger colour');
  assert.doesNotMatch(html, /\bRead\b/, 'nothing is called Read');
  // A quiet post has no ticks even if a receipt list is present.
  assert.equal(renderReceipts(mail({ kind: 'post', receipts: [{ to: 'human', state: 'stored' }] })), '');
  assert.equal(renderReceipts(mail()), '');
});

test('reactions are the bounded set, show counts and who reacted, and toggle for the human', () => {
  const html = renderReactions(mail({ reactions: [{ by: 'human', emoji: '👍' }, { by: 'Codex', emoji: '👍' }, { by: 'Sol', emoji: '✅' }, { by: 'X', emoji: '🤖' }] }));
  for (const emoji of ['👍', '✅', '👀', '❌', '🎉']) assert.ok(html.includes(emoji), `offers ${emoji}`);
  assert.doesNotMatch(html, /🤖/, 'an emoji outside the allowed set is not shown');
  assert.match(html, /data-action="react" data-id="m_1" data-emoji="👍" data-on="false"/, 'the human already reacted, so the next press removes it');
  assert.match(html, /data-emoji="✅" data-on="true"/, 'another reaction would be added');
  assert.match(html, /reaction-count">2</, 'the count is shown');
  assert.match(html, /title="human, Codex"/, 'the reactors are named');
  const noId = renderReactions({ reactions: [] });
  assert.match(noId, /data-action="react"/); assert.match(noId, /disabled/, 'without a stable message id the buttons are not actionable');
});

test('a post is a quiet FYI line, and no-reply-needed is labelled on the message', () => {
  const html = renderMessage(mail({ kind: 'post', receipts: [{ to: 'human', state: 'fetched' }] }));
  assert.match(html, /class="message quiet-post"/);
  assert.match(html, /data-kind="post"/);
  assert.match(html, /post-marker">quiet/);
  assert.doesNotMatch(html, /message-receipts/, 'a post has no ticks');
  assert.match(renderMessage(mail({ noReply: true })), /no reply needed/);
  assert.match(renderMessage(mail()), /data-message-id="m_1"/);
  assert.match(renderMessage(mail()), /data-kind="mail"/);
});

test('a working or blocked line appears on the crew card and blocked is amber with its text', () => {
  const working = [{ name: 'Claude', state: 'working', messageId: 'm_1', text: 'the join route', at: '2026-10-29T15:00:00.000Z' }];
  assert.equal(activityOf(working, 'Claude')?.state, 'working');
  assert.equal(activityOf(working, 'Codex'), null);
  assert.match(renderAgentWork(working, 'Claude'), /working on the join route/);
  const blocked = [{ name: 'Codex', state: 'blocked', text: 'waiting for the human decision' }];
  assert.match(renderAgentWork(blocked, 'Codex'), /class="agent-work blocked"/);
  assert.match(renderAgentWork(blocked, 'Codex'), /blocked: waiting for the human decision/);
  const card = renderAgentCard({ name: 'Claude', kind: 'claude', where: 'external', session: 'open', armed: 'waiting', held: null, state: 'listening' }, 'running', working);
  assert.match(card, /working on the join route/);
  const plain = renderAgentCard({ name: 'Codex', kind: 'codex', where: 'external', session: 'closed', armed: 'not_armed', held: null, state: 'joined' }, 'running', working);
  assert.doesNotMatch(plain, /agent-work/, 'only the named agent gets the line');
});

test('receipt and activity events patch the room without dropping message identity or order', () => {
  let state: any = { messages: [mail(), { ...mail(), sequence: 2, id: 'm_2' }], agents: [], activity: [] };
  state = applyRoomEvent(state, { type: 'receipts', updates: [{ id: 'm_1', receipts: [{ to: 'human', state: 'acknowledged' }], reactions: [{ by: 'human', emoji: '🎉' }] }] });
  assert.deepEqual(state.messages.map((message: any) => message.id), ['m_1', 'm_2'], 'order and identity are kept');
  assert.equal(state.messages[0].receipts[0].state, 'acknowledged');
  assert.equal(state.messages[1].receipts.length, 0, 'other messages are untouched');
  state = applyRoomEvent(state, { type: 'activity', activity: [{ name: 'Claude', state: 'blocked', text: 'needs a decision' }] });
  assert.deepEqual(state.activity.map((entry: any) => [entry.name, entry.state]), [['Claude', 'blocked']]);
});

test('@mentions match the crew case-insensitively and choose the recipients', () => {
  const agents = [{ name: 'Claude' }, { name: 'Codex' }, { name: 'deepseek' }];
  assert.deepEqual(mentionedNames('ask @Claude and @codex, not @Nobody', agents), ['Claude', 'Codex']);
  assert.deepEqual(mentionedNames('email me at me@example.com', agents), [], 'an email address is not a mention');
  assert.deepEqual(mentionedNames('@DEEPSEEK go', agents), ['deepseek']);
  // A mention addresses exactly the named agents, as one name or a list.
  assert.deepEqual(composerPlan({ text: '@Claude look', agents, recipient: '' }), { text: '@Claude look', to: 'Claude' });
  assert.deepEqual(composerPlan({ text: '@Claude and @Codex', agents, recipient: 'Codex' }), { text: '@Claude and @Codex', to: ['Claude', 'Codex'] });
  // Without a mention the selected recipient is used; empty means all agents, which is the console's own broadcast.
  assert.deepEqual(composerPlan({ text: 'status?', agents, recipient: 'Codex' }), { text: 'status?', to: 'Codex' });
  assert.deepEqual(composerPlan({ text: 'status?', agents, recipient: '' }), { text: 'status?' });
  // The two promises are exclusive.
  assert.deepEqual(composerPlan({ text: 'fyi', agents, post: true }), { text: 'fyi', post: true });
  assert.deepEqual(composerPlan({ text: 'fyi', agents, noReply: true }), { text: 'fyi', noReply: true });
  assert.throws(() => composerPlan({ text: 'fyi', agents, post: true, noReply: true }), /cannot also ask for an answer/);
});

test('hostile receipt, reaction and activity text is shown as data', () => {
  const attack = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
  const html = renderMessage(mail({ receipts: [{ to: attack, state: attack }], reactions: [{ by: attack, emoji: '👍' }], noReply: true }))
    + renderAgentWork([{ name: attack, state: 'blocked', text: attack }], attack);
  assert.doesNotMatch(html, /<img|<script/);
  assert.ok(html.includes('&lt;img')); assert.ok(html.includes('&lt;script'));
});

test('a mention overrides the Message to choice visibly, and the route says who will receive it', () => {
  const agents = [{ name: 'Claude' }, { name: 'Codex' }];
  assert.deepEqual(composerMentionRoute('@Claude and @Codex, please look', agents), { names: ['Claude', 'Codex'], disabled: true });
  assert.deepEqual(composerMentionRoute('just @Claude', agents), { names: ['Claude'], disabled: true });
  assert.deepEqual(composerMentionRoute('no mentions here', agents), { names: [], disabled: false });
  assert.deepEqual(composerMentionRoute('mail me at a@b.example', agents), { names: [], disabled: false }, 'an email address does not override the choice');
  assert.deepEqual(composerMentionRoute('@Nobody hi', agents), { names: [], disabled: false }, 'an unknown name does not override the choice');
});
