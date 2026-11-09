import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { console_, joinSkip, page, repoRoot, until } from './helpers/join-testkit.ts';

// Probe 2 (spec.md, assumptions): a harness that kills a long command lets the agent rerun `peerloom join` and keep
// the same pairing code. In this implementation the claim is written to disk before the code is printed, so the kill
// point is right after the code; the recorded 60-second-approval variant is the same test with
// AGENTLINK_PROBE_DELAY_MS=60000 (nothing in the process holds the claim, the page is not pressed until after the rerun).
// Harness `dsh` is used on purpose: it is an enabled descriptor in a production CLI process, unlike the console-test
// fixture `fakeext`, and naming it starts no model. The spawned client never starts a model either.
const binPath = join(repoRoot, 'bin', 'peerloom.mjs');
const delayMs = Math.max(0, Number(process.env.AGENTLINK_PROBE_DELAY_MS ?? 750));

// The CLI side of the join is Codex's file; skip the probe until it is on the branch that runs this test.
async function cliJoinMissing() {
  return new Promise<false | string>(ok => {
    const child = spawn(process.execPath, [binPath, 'join'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; child.stdout.on('data', d => { text += d; }); child.stderr.on('data', d => { text += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); ok('the peerloom command did not answer'); }, 5000);
    child.once('error', () => { clearTimeout(timer); ok('the peerloom command is not runnable in this branch'); });
    child.once('exit', () => { clearTimeout(timer); ok(/join http|Use: peerloom join|--harness/.test(text) ? false : 'peerloom join is not on this branch yet'); });
  });
}
const unsupported = await cliJoinMissing();
const skip = joinSkip || unsupported;

function startJoin(url: string, cwd: string) {
  const child = spawn(process.execPath, [binPath, 'join', url, '--harness', 'dsh'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = ''; child.stdout.on('data', d => { text += d; }); child.stderr.on('data', d => { text += d; });
  const exited = new Promise<number | null>(ok => child.once('exit', code => ok(code)));
  return { child, get text() { return text; }, exited };
}
const pairingCode = (text: string) => /([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(text)?.[1];

test('probe 2: a killed join rerun keeps its pairing code, then the approved rerun finishes with the opening', { skip, timeout: 180_000 }, async t => {
  const c = console_(t); const p = await page(c); t.after(p.close);
  await p.call('POST', '/api/room', { name: 'Probe room', workspace: c.dir });
  const made = (await p.call('POST', '/api/join-line', { harness: 'dsh' })).json;
  const url = /peerloom join (\S+) --harness/.exec(made.line)![1];
  // First run: the code appears, then the harness kills the command while the human has not approved.
  const first = startJoin(url, c.dir);
  const before = await until(() => pairingCode(first.text), 'the first pairing code', 20_000);
  await new Promise(ok => setTimeout(ok, delayMs));
  first.child.kill('SIGKILL'); await first.exited;
  // Rerun: the same command, and the same code. One claim exists, and it is this one.
  const second = startJoin(url, c.dir);
  const after = await until(() => pairingCode(second.text), 'the rerun pairing code', 20_000);
  assert.equal(after, before, 'a killed join rerun keeps the same pairing code');
  const joins = (await p.state()).joins as any[];
  assert.equal(joins.length, 1, 'one claim, not a second identity');
  assert.equal(joins[0].pairingCode, before); assert.equal(joins[0].harness, 'dsh', 'the descriptor the agent declared');
  // Approve the matching code; the waiting rerun finishes by itself and prints the identity it now acts as.
  assert.equal((await p.call('POST', '/api/join-approve', { claimId: joins[0].claimId })).status, 200);
  assert.equal(await second.exited, 0, second.text);
  const agentId = /--as ([a-z]{2,6}-[a-z0-9]{4})/.exec(second.text)?.[1];
  assert.ok(agentId, `the approved rerun prints its --as identity:\n${second.text}`);
  assert.ok(existsSync(join(c.dir, '.agentlink', 'agents', agentId!, 'credential.json')));
  const state = await p.state();
  assert.deepEqual(state.joins, []); assert.equal(state.agents.filter((a: any) => a.kind === 'dsh').length, 1);
  // Rerunning once more after approval is safe: same identity, no second participant.
  const third = await new Promise<{ code: number | null; text: string }>(ok => {
    const child = spawn(process.execPath, [binPath, 'join', url, '--harness', 'dsh'], { cwd: c.dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; child.stdout.on('data', d => { text += d; }); child.stderr.on('data', d => { text += d; }); child.once('exit', code => ok({ code, text }));
  });
  assert.equal(third.code, 0, third.text);
  assert.match(third.text, new RegExp(agentId!), 'the same identity, not a new one');
  assert.equal((await p.state()).agents.filter((a: any) => a.kind === 'dsh').length, 1);
  c.input.write('/quit\n'); await c.done;
});
