#!/usr/bin/env node
// A minimal Peerloom harness adapter: it puts any command-line agent in a room.
//
// The adapter is the participant. It binds, holds the room's wait, and when work arrives it runs YOUR command once per
// piece of work, with the work as the prompt on standard input, and sends the command's standard output back as the
// answer. Use it for a harness that has a one-shot / non-interactive mode but cannot arm its own wait.
//
//   node examples/adapters/command-adapter.mjs --client CREDENTIAL.json [options] -- COMMAND [ARGS...]
//   node examples/adapters/command-adapter.mjs --as AGENT_ID          [options] -- COMMAND [ARGS...]
//
// Options:
//   --label TEXT       how this session is labelled when it binds (default: "command adapter")
//   --timeout SECONDS  one wait, 1 to 3300 (default 3300); an empty wait just waits again
//   --quiet-waits N    stop after N empty waits in a row (default: never; the room's own allowance still applies)
//
// What COMMAND gets, for each piece of work:
//   stdin                  the prompt: who it is from and what they wrote, plus a line saying what kind of answer is wanted
//   PEERLOOM_KIND          message | request
//   PEERLOOM_FROM          the sender's name in the room (human for you)
//   PEERLOOM_ROOM_AGENT    this agent's own name in the room
//   PEERLOOM_ID            the message ID (m_…) or request ID (rq_…)
//   PEERLOOM_TEXT          the raw text, without the framing
// Its exit 0 and standard output (trimmed) are the answer. A non-zero exit, or no output, is reported to the sender
// instead, so a failure is never silent.
//
// What it does with each kind of work:
//   mail (from the human or another agent)   one run per sender; the output is the reply, which also acknowledges it
//   an answer or decision request           one run; the output is the response
//   a review request                        declined, naming the exact revision (change the review branch below to review)
//   responses and withdrawals               nothing: this adapter never asks anything itself
//
// Exit codes follow the wait: 0 after the hub closes (exit 8) or --quiet-waits, otherwise the wait's own code
// (4 superseded, 5 disarmed, 6 refused, 7 hub did not answer, 1 usage) with one line on stderr saying which.
// Nothing here is a model: the command is. Approvals are the command's own; Peerloom neither sees nor answers them.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const checkout = process.env.PEERLOOM_CHECKOUT ? resolve(process.env.PEERLOOM_CHECKOUT) : resolve(import.meta.dirname, '../..');
const usage = 'Use: command-adapter.mjs (--client FILE | --as ID) [--label TEXT] [--timeout SECONDS] [--quiet-waits N] -- COMMAND [ARGS...]';
const die = (message, code = 1) => { process.stderr.write(`command-adapter: ${message}\n`); process.exit(code); };

// ── Arguments ──
const argv = process.argv.slice(2); const split = argv.indexOf('--');
if (split < 0 || split === argv.length - 1) die(usage);
const command = argv.slice(split + 1); const flags = {};
for (let at = 0; at < split; at += 2) {
  const key = argv[at]; const value = argv[at + 1];
  if (!['--client', '--as', '--label', '--timeout', '--quiet-waits'].includes(key) || value === undefined || at + 1 >= split) die(usage);
  flags[key] = value;
}
if (!!flags['--client'] === !!flags['--as']) die('Give exactly one of --client FILE or --as ID');
const timeout = Number(flags['--timeout'] ?? 3300);
if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3300) die('--timeout is a whole number of seconds from 1 to 3300');
const quietLimit = flags['--quiet-waits'] === undefined ? Infinity : Number(flags['--quiet-waits']);
if (quietLimit !== Infinity && (!Number.isInteger(quietLimit) || quietLimit < 1)) die('--quiet-waits is a whole number from 1');

// --as goes through the peerloom command (it resolves the profile); --client through the one-shot CLI.
const [cli, who] = flags['--as'] ? [resolve(checkout, 'bin/peerloom.mjs'), ['--as', flags['--as']]] : [resolve(checkout, 'core/cli.ts'), ['--client', resolve(flags['--client'])]];

// One room command. Every command prints one JSON line; text always goes on stdin so it never meets shell quoting.
function room(verb, args = [], input = '', waitMs = 30_000) {
  const run = spawnSync(process.execPath, [cli, verb, ...who, ...args], { encoding: 'utf8', input, timeout: waitMs, maxBuffer: 16 << 20 });
  let json = null; try { json = JSON.parse(run.stdout.trim()); } catch { /* reported by the caller */ }
  return { code: run.status ?? 1, json, text: (run.stdout || run.stderr || '').trim() };
}
const log = line => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${line}\n`);

// The user's command, once. Its output is the answer; a failure becomes a short, honest note.
function ask(kind, from, id, text, wanted) {
  const prompt = `You are ${self} in a Peerloom room. ${from === 'human' ? 'The human' : `The agent ${from}`} wrote:\n\n${text}\n\n${wanted}\n`;
  const run = spawnSync(command[0], command.slice(1), { encoding: 'utf8', input: prompt, maxBuffer: 16 << 20,
    env: { ...process.env, PEERLOOM_KIND: kind, PEERLOOM_FROM: from, PEERLOOM_ROOM_AGENT: self, PEERLOOM_ID: id, PEERLOOM_TEXT: text } });
  const out = (run.stdout ?? '').trim();
  if (run.error) return `(The adapter could not run ${command[0]}: ${run.error.message})`;
  if (run.status !== 0) return `(The command exited ${run.status ?? run.signal}${run.stderr?.trim() ? `: ${run.stderr.trim().slice(0, 400)}` : ''})`;
  return out || '(The command produced no output.)';
}

// ── Bind once ──
const roomInfo = room('room');
if (roomInfo.code !== 0) die(`could not reach the room: ${roomInfo.text}`, roomInfo.code);
const self = roomInfo.json?.roster?.find(p => p.id === roomInfo.json.self)?.name ?? 'an agent';
const bound = room('bind', ['--label', flags['--label'] ?? 'command adapter']);
if (bound.code !== 0) die(`bind failed: ${bound.text}`, bound.code);
log(`bound as ${self}; waiting for work (Ctrl-C stops)`);

// ── Wait, fetch, answer, wait again ──
let quiet = 0;
for (;;) {
  const waited = room('wait', ['--timeout', String(timeout)], '', (timeout + 15) * 1000);
  if (waited.code === 3) { if (++quiet >= quietLimit) { log(`${quiet} empty waits in a row; stopping`); process.exit(0); } continue; }
  if (waited.code === 8) { log('the hub is closing; stopping'); process.exit(0); }
  if (waited.code !== 0 || !waited.json?.wakeId) {
    const why = { 4: 'another session bound this agent', 5: 'disarmed after too many empty waits: the human can /reoffer it', 6: 'the hub refused the wait', 7: 'the hub did not answer' }[waited.code] ?? 'the wait failed';
    die(`${why}: ${waited.text}`, waited.code);
  }
  quiet = 0;
  const wake = String(waited.json.wakeId);
  const fetched = room('fetch', ['--wake', wake]);
  if (fetched.code !== 0) die(`fetch failed: ${fetched.text}`, fetched.code);
  const units = (fetched.json?.units ?? []).filter(unit => unit.current !== false);

  // Mail: one run per sender, answered with reply (which also acknowledges exactly those messages).
  const bySender = new Map();
  for (const unit of units) if (unit.kind === 'human_message' || unit.kind === 'agent_message') {
    const from = unit.sender?.name ?? 'human'; bySender.set(from, [...(bySender.get(from) ?? []), unit]);
  }
  for (const [from, mail] of bySender) {
    const text = mail.map(unit => unit.view?.text ?? '').join('\n\n');
    const noReply = mail.every(unit => unit.view?.noReply);
    if (noReply) { room('ack', ['--ids', mail.map(unit => unit.id).join(',')]); log(`${from}: no reply needed; acknowledged`); continue; }
    log(`${from}: message received; running ${command[0]}`);
    const answer = ask('message', from, mail.at(-1).id, text, 'Your whole output is sent back to them as your reply.');
    const sent = room('reply', ['--wake', wake, '--to', from, '--text', '-'], answer);
    log(sent.code === 0 ? `${from}: replied` : `${from}: reply refused: ${sent.text}`);
  }

  // Requests addressed to this agent.
  for (const unit of units) if (unit.kind === 'slot') {
    const request = unit.view ?? {}; const from = unit.sender?.name ?? 'human';
    if (request.purpose === 'review') {
      // Even a decline names the exact revision it declines, so it cannot land on another one.
      const t = request.target ?? {};
      const declined = room('respond', ['--request', unit.id, '--outcome', 'declined', '--artifact', String(t.artifactId), '--revision', String(t.revision), '--digest', String(t.digest), '--text', '-'],
        'This agent runs through a one-shot command adapter and does not review revisions.');
      log(declined.code === 0 ? `${from}: review request declined` : `${from}: decline refused: ${declined.text}`); continue;
    }
    log(`${from}: ${request.purpose} request received; running ${command[0]}`);
    const answer = ask('request', from, unit.id, request.text ?? '', 'Your whole output is recorded as your answer to this request.');
    const responded = room('respond', ['--request', unit.id, '--outcome', 'answered', '--text', '-'], answer);
    log(responded.code === 0 ? `${from}: request answered` : `${from}: response refused: ${responded.text}`);
  }
}
