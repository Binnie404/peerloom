import test from 'node:test';
import assert from 'node:assert/strict';
import { ALIASES, complete, expandAlias, onlyApproval, resolveName, routeLine } from '../core/complete.ts';

const ctx = { commands: ['/send', '/status', '/start', '/approve', '/accept', '/invite', '/to', '/tell'], agents: ['Claude', 'Codex', 'DeepSeek'], harnesses: ['claude', 'codex', 'cursor'], approvals: ['7', '12'], requests: ['rq_abc', 'rq_abd'] };

test('a slash word completes to commands, case-insensitively, and one match gets a trailing space', () => {
  assert.deepEqual(complete('/st', ctx), [['/status', '/start'], '/st']);
  assert.deepEqual(complete('/SE', ctx), [['/send '], '/SE']);
  assert.deepEqual(complete('hello', ctx), [[], 'hello']);
});

test('the argument after a command completes to what that command takes', () => {
  assert.deepEqual(complete('/send c', ctx), [['Claude', 'Codex'], 'c']);
  assert.deepEqual(complete('/tell D', ctx), [['DeepSeek '], 'D']);
  assert.deepEqual(complete('/to ', ctx), [['Claude', 'Codex', 'DeepSeek', 'all'], '']);
  assert.deepEqual(complete('/invite cu', ctx), [['cursor '], 'cu']);
  assert.deepEqual(complete('/approve 1', ctx), [['12 '], '1']);
  assert.deepEqual(complete('/accept rq_ab', ctx), [['rq_abc', 'rq_abd'], 'rq_ab']);
  assert.deepEqual(complete('/send Claude hel', ctx), [[], 'hel'], 'the message text is not completed');
});

test('@ anywhere in a line completes to the crew', () => {
  assert.deepEqual(complete('please ask @co', ctx), [['@Codex '], '@co']);
  assert.deepEqual(complete('@', ctx), [['@Claude', '@Codex', '@DeepSeek'], '@']);
});

test('short aliases expand to their command and leave everything else alone', () => {
  assert.deepEqual(ALIASES, { '/s': '/send', '/a': '/approve', '/d': '/deny', '/st': '/status', '/i': '/invite', '/p': '/pause', '/q': '/quit' });
  assert.equal(expandAlias('/s Claude hi'), '/send Claude hi'); assert.equal(expandAlias('/a'), '/approve'); assert.equal(expandAlias('/status'), '/status'); assert.equal(expandAlias('/sx'), '/sx'); assert.equal(expandAlias('hi /s'), 'hi /s');
});

test('a name resolves exactly, then by a unique prefix, and an ambiguous prefix is refused naming the candidates', () => {
  const names = ['Claude', 'Codex', 'Claude2'];
  assert.deepEqual(resolveName('claude', names), { name: 'Claude' }, 'exact beats prefix');
  assert.deepEqual(resolveName('cod', names), { name: 'Codex' });
  assert.deepEqual(resolveName('c', names), { error: 'c could be Claude, Codex or Claude2; type more of the name.' });
  assert.deepEqual(resolveName('x', names), { error: 'There is no agent called x. /status lists them.' });
  assert.deepEqual(resolveName('', names), { error: 'There is no agent called (nothing). /status lists them.' });
});

test('a line goes to the agents it mentions, else to the sticky recipient, else to everyone', () => {
  const agents = ['Claude', 'Codex'];
  assert.deepEqual(routeLine('@claude and @Codex review this', agents), { text: '@claude and @Codex review this', to: ['Claude', 'Codex'] });
  assert.deepEqual(routeLine('look at this', agents, 'Codex'), { text: 'look at this', to: ['Codex'] });
  assert.deepEqual(routeLine('@Claude only you', agents, 'Codex'), { text: '@Claude only you', to: ['Claude'] }, 'a mention beats the sticky recipient');
  assert.deepEqual(routeLine('  everyone, hello  ', agents), { text: 'everyone, hello' });
});

test('an @ that is not a crew member, or sits inside an email address, does not change who receives the line', () => {
  const agents = ['Claude', 'Codex'];
  assert.deepEqual(routeLine('mail me@codex.dev about it', agents), { text: 'mail me@codex.dev about it' });
  assert.deepEqual(routeLine('@everyone @nobody hi', agents, 'Claude'), { text: '@everyone @nobody hi', to: ['Claude'] });
});

test('a mention set off by punctuation still addresses its agent, as on the page', () => {
  const agents = ['Alpha', 'Beta'];
  assert.deepEqual(routeLine('@Alpha,@Beta review this', agents).to, ['Alpha', 'Beta']);
  assert.deepEqual(routeLine('(@Beta) private question', agents).to, ['Beta']);
  assert.deepEqual(routeLine('cc:@alpha; thanks', agents).to, ['Alpha']);
  assert.deepEqual(routeLine('write to x@alpha.dev or y_@beta', agents).to, undefined, 'still not inside a word or an address');
  assert.deepEqual(complete('(@Be', { ...ctx, agents }), [['@Beta '], '@Be']);
  assert.deepEqual(complete('@Alpha,@b', { ...ctx, agents }), [['@Beta '], '@b']);
});

test('where a prefix could pick the wrong agent (trust, kill, the page), only an exact name is accepted', () => {
  assert.deepEqual(resolveName('Claude', ['Claude2'], { prefix: false }), { error: 'There is no agent called Claude. /status lists them.' });
  assert.deepEqual(resolveName('codex', ['Codex'], { prefix: false }), { name: 'Codex' });
  assert.deepEqual(resolveName('Claude', ['Claude2']), { name: 'Claude2' }, 'a prefix is still fine for sending');
});

test('/approve without an ID takes the only waiting request only if it was already waiting when the prompt was shown', () => {
  assert.equal(onlyApproval(['7'], ['7']), '7');
  assert.equal(onlyApproval(['8'], ['7']), '', 'B arrived while typing: ask for the ID');
  assert.equal(onlyApproval(['7', '8'], ['7', '8']), '');
  assert.equal(onlyApproval([], []), '');
});
