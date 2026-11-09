// A stand-in for an external, self-arming harness (item 23). It is not a model and it speaks no native protocol: it
// binds, waits, fetches and replies through the real `core/cli.ts`, so a console test can exercise the whole external
// route with no native CLI installed. Run it as its own process, the way a real external session would.
//
//   FAKE_HARNESS_CLIENT   the participant credential file (required)
//   FAKE_HARNESS_REPLY    the text it answers the first message of a wake with (default: a fixed line)
//   FAKE_HARNESS_WAITS    how many waits it arms (default 1); each wake it answers, then it arms again
//   FAKE_HARNESS_TIMEOUT  seconds in one wait (default 30)
//   FAKE_HARNESS_LOG      a JSONL file it appends each step to, for assertions
//   FAKE_HARNESS_CLI      the CLI to call (default: this checkout's core/cli.ts)
//
// It exits 0 after its waits, 2 when it has no credential, and records every CLI result (including refusals) in the log.
// Text is passed on standard input, so it never has to survive shell quoting.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const env = (name: string, fallback = '') => process.env[name] ?? fallback;
const client = env('FAKE_HARNESS_CLIENT');
const log = env('FAKE_HARNESS_LOG');
const replyText = env('FAKE_HARNESS_REPLY', 'The fake external harness answered.');
const waits = Number(env('FAKE_HARNESS_WAITS', '1'));
const timeout = Number(env('FAKE_HARNESS_TIMEOUT', '30'));
const cli = env('FAKE_HARNESS_CLI') || fileURLToPath(new URL('../../core/cli.ts', import.meta.url));

const record = (value: Record<string, unknown>) => { if (log) appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...value })}\n`); };
const fail = (message: string) => { record({ step: 'error', message }); process.stderr.write(`fake-harness: ${message}\n`); process.exit(2); };

function call(args: string[], input = '', waitMs?: number) {
  const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input, timeout: waitMs ?? 15_000 });
  let value: any = null; try { value = JSON.parse(run.stdout.trim()); } catch { /* the caller records the raw text */ }
  return { code: run.status, text: run.stdout.trim(), json: value };
}

if (!client) fail('FAKE_HARNESS_CLIENT is required (the participant credential file)');
if (!Number.isInteger(waits) || waits < 1 || waits > 20) fail('FAKE_HARNESS_WAITS is a whole number from 1 to 20');
if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3300) fail('FAKE_HARNESS_TIMEOUT is a whole number of seconds from 1 to 3300');

record({ step: 'start', cli, client, waits, timeout });
const bound = call(['bind', '--client', client, '--label', 'Fake Harness (external)']);
record({ step: 'bind', code: bound.code, body: bound.json });
if (bound.code !== 0) fail(`bind failed: ${bound.text}`);

for (let armed = 0; armed < waits; armed += 1) {
  const waited = call(['wait', '--client', client, '--timeout', String(timeout)], '', (timeout + 10) * 1000);
  record({ step: 'wait', code: waited.code, body: waited.json, text: waited.json ? undefined : waited.text });
  if (waited.code === 3) continue;                                  // nothing arrived; arm again
  if (waited.code !== 0 || !waited.json?.wakeId) break;             // 4/5/6/7/1: stop, the console owns the reason
  const wake = String(waited.json.wakeId);
  const fetched = call(['fetch', '--client', client, '--wake', wake]);
  record({ step: 'fetch', code: fetched.code, units: (fetched.json?.units ?? []).map((unit: any) => ({ kind: unit.kind, id: unit.id, sender: unit.sender?.name ?? null })) });
  if (fetched.code !== 0) break;
  const mail = (fetched.json?.units ?? []).find((unit: any) => unit.kind === 'human_message' || unit.kind === 'agent_message');
  if (!mail) { record({ step: 'reply', skipped: 'the wake held no message to answer' }); continue; }
  const to = mail.sender?.name;
  const replied = call(['reply', '--client', client, '--wake', wake, ...(to ? ['--to', String(to)] : []), '--text', '-'], replyText);
  record({ step: 'reply', code: replied.code, to: to ?? null, body: replied.json ?? replied.text });
}
record({ step: 'done' });
