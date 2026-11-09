#!/usr/bin/env node
// One executable, two surfaces: the human's console and narrowly scoped one-shot agent commands. Dispatching the
// CLI in this process preserves the native background-job PID and its single-wait lock; there is no child daemon.
import { realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { PROFILE_COMMANDS, PROFILE_ID, ProfileError, joinClaim, readProfile } from '../core/profiles.ts';
import { HARNESSES, harnessOf } from '../core/harnesses.ts';
import { credential, request, TransportError } from '../core/client.ts';
import { clean, externalOpening } from '../core/shell-agents.ts';

class JoinFailure extends Error {
  constructor(code, message, exitCode = 1) { super(message); this.code = code; this.exitCode = exitCode; }
}
const fail = (code, message, exitCode) => { throw new JoinFailure(code, message, exitCode); };
const args = process.argv.slice(2);
const cli = resolve(import.meta.dirname, '../core/cli.ts');
const help = `peerloom                            open the room console in this folder
peerloom join URL --harness ID      claim a one-paste invitation; --name LABEL and --timeout SECONDS are optional
peerloom VERB --as ID [options]     run an agent command in its room workspace or a child folder
peerloom link --room DIR [NAME]     print the existing app/external opening
peerloom view NAME                  follow one owned agent's activity
peerloom harnesses                  show enabled harnesses and route evidence
peerloom completion zsh|bash|fish   print tab completion for your shell (eval it in your shell's rc file)

plm is the short name for peerloom.
Agent commands: ${[...PROFILE_COMMANDS].join(', ')}.
--as selects one profile; --client, --endpoint, membership and run-control commands are not accepted there.
Legacy one-shot forms remain available with node core/cli.ts help.
Joining is complete only after the agent follows the printed route and is listening. Approval alone is not listening.
`;

function options(values) {
  const found = {};
  for (let at = 0; at < values.length; at += 2) {
    const key = values[at];
    if (!key?.startsWith('--') || at + 1 === values.length) fail('usage', 'Join options are --harness ID, --name LABEL and --timeout SECONDS');
    if (!['--harness', '--name', '--timeout'].includes(key) || Object.hasOwn(found, key)) fail('usage', 'An unknown or duplicate join option was given');
    found[key] = values[at + 1];
  }
  return found;
}
async function joinTicket(values) {
  const url = values[0];
  const match = typeof url === 'string' && /^http:\/\/127\.0\.0\.1:(\d{1,5})\/j\/(alj_[A-Za-z0-9_-]{32})$/.exec(url);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) fail('join_url', 'Use: peerloom join http://127.0.0.1:PORT/j/TICKET --harness ID. Queries, fragments, other hosts and redirects are refused');
  const flags = options(values.slice(1)); const harnessId = flags['--harness'];
  const harness = harnessOf(harnessId);
  if (!harness?.probe.ok || !harness.routes.includes('external') || !['self-arming', 'in-turn'].includes(harness.wake.external)) {
    const enabled = HARNESSES.filter(h => h.probe.ok && h.routes.includes('external')).map(h => h.id);
    fail('join_harness', `Choose an enabled external harness with --harness: ${enabled.join(', ')}`);
  }
  const label = flags['--name'] ?? harness.label;
  if (!label.trim() || label.length > 60 || /[\u0000-\u001f\u007f]/.test(label)) fail('join_label', '--name is a nonempty single-line label of at most 60 characters');
  const timeout = flags['--timeout'] === undefined ? 5400 : Number(flags['--timeout']);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 5400) fail('usage', '--timeout is a whole number from 1 to 5400 seconds');
  const data = join(process.cwd(), '.agentlink');
  // This must finish before the first network call. A killed or rejected command never loses its claimant identity.
  const claim = joinClaim(data, match[2], harnessId, label);
  const redact = text => clean(String(text)).replaceAll(match[2], '[ticket]').replaceAll(claim.secret, '[claim]').slice(0, 500);
  async function call(op, body) {
    let response; let value;
    try {
      response = await fetch(`${url}/${op}`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); fail('join_redirect', 'The join endpoint redirected the request; no redirect was followed', 6); }
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body ?? []) {
        bytes += chunk.length;
        if (bytes > 64 * 1024) fail('join_response', 'The join endpoint returned an oversized response; stop and ask the human to inspect it', 7);
        chunks.push(chunk);
      }
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error instanceof JoinFailure) throw error;
      fail('join_unreachable', 'The join endpoint did not return a usable answer. The claim was saved; stop and ask the human before rerunning this exact command', 7);
    }
    if (!response.ok) fail(typeof value?.error?.code === 'string' ? redact(value.error.code) : 'join_refused', redact(value?.error?.message ?? 'The console refused this join request'), 6);
    if (value?.ok !== true || !['awaiting_approval', 'approving', 'approved', 'refused', 'expired', 'revoked', 'reconcile'].includes(value.state)
      || typeof value.claimId !== 'string' || !/^jc_[A-Za-z0-9_-]{1,96}$/.test(value.claimId) || typeof value.pairingCode !== 'string' || !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(value.pairingCode)
      || !Number.isFinite(Date.parse(value.expiresAt))) fail('join_response', 'The console returned an invalid join status; stop without another request', 7);
    return value;
  }
  const deadline = Date.now() + timeout * 1000;
  let result = await call('claim', { secret: claim.secret, harness: harnessId, label });
  const pairing = result.pairingCode; const claimId = result.claimId;
  console.log(`Pairing code: ${pairing}`);
  console.log(`Tell the human: compare code ${pairing} in your existing Peerloom page and approve this request only if it matches.`);
  for (;;) {
    if (result.claimId !== claimId || result.pairingCode !== pairing) fail('join_response', 'The claim identity changed; stop and ask the human to inspect the pairing request', 7);
    if (result.state === 'approved') break;
    if (['refused', 'expired', 'revoked', 'reconcile'].includes(result.state)) fail(`join_${result.state}`, `The join is ${result.state}; stop and ask the human to decide the next step`, 6);
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail('join_wait_ended', 'The bounded approval wait ended. The claim is saved; do not continue or rerun without the human', 1);
    await new Promise(ok => setTimeout(ok, Math.min(2000, remaining)));
    if (Date.now() >= deadline) fail('join_wait_ended', 'The bounded approval wait ended. The claim is saved; do not continue or rerun without the human', 1);
    result = await call('poll', { secret: claim.secret });
  }
  if (!PROFILE_ID.test(result.agentId) || typeof result.name !== 'string') fail('join_response', 'The approved response has no valid agent identity', 7);
  if (typeof result.workspace !== 'string' || !isAbsolute(result.workspace) || /[\u0000-\u001f\u007f]/.test(result.workspace)) fail('join_response', 'The approved response has no valid absolute workspace; no ancestor profile store was used', 7);
  const workspace = realpathSync(result.workspace);
  const profile = readProfile(join(workspace, '.agentlink'), result.agentId);
  if (profile.name !== result.name || profile.harness !== harnessId) fail('join_profile', 'The approved profile does not match this claim; stop without binding');
  const auth = credential(profile.credentialPath);
  let room;
  try { room = await request(auth, 'room'); }
  catch (error) { fail('join_room', 'The approved profile could not read its room; stop without binding', error instanceof TransportError ? 7 : 6); }
  if (room.self !== auth.participantId || !room.roster?.some(p => p.id === room.self && p.kind === 'agent')) fail('join_profile', 'The profile is not an agent participant; no commands were armed');
  if (typeof room.workspace !== 'string' || !isAbsolute(room.workspace) || realpathSync(room.workspace) !== workspace) fail('join_profile', 'The approved workspace and profile room do not match; no commands were armed');
  const roomName = clean(room.name).replaceAll('\n', ' ').slice(0, 100);
  console.log(`Approved as ${profile.name} (${profile.id}). Joined; not listening yet.`);
  console.log(`Run the short commands in the approved workspace ${clean(workspace)} or a child directory. A pending join is resumed from the same folder in which its claim was saved.`);
  console.log(externalOpening(profile.name, roomName, profile.credentialPath, cli, harness.label, profile.id, harness.wake.external));
  console.log(`\nTell the human this: ${profile.name} is joined to ${roomName}. Finish the listening steps above before reporting ready. Then try: send me a task; ask me what to do next; connect another agent. Use your existing Peerloom page at ${new URL(url).origin}.`);
}

async function main() {
  const verb = args[0];
  if (verb === 'help' || verb === '--help') { if (args.length !== 1) fail('usage', 'peerloom help takes no options'); console.log(help); return; }
  if (verb === 'join') { await joinTicket(args.slice(1)); return; }
  if (verb === 'completion') {
    const { script } = await import('../core/completion.ts');
    if (args.length !== 2 || !['zsh', 'bash', 'fish'].includes(args[1])) fail('usage', 'Use: peerloom completion zsh, bash or fish');
    process.stdout.write(script(args[1])); return;
  }
  if (verb === '__complete') {
    const { candidates, profileIds } = await import('../core/completion.ts');
    const harnesses = HARNESSES.filter(h => h.probe.ok && h.routes.includes('external')).map(h => h.id);
    const words = args.slice(1); if (!words.length) words.push('');
    for (const item of candidates(words, { profileCommands: [...PROFILE_COMMANDS], harnesses, profiles: profileIds(process.cwd()) })) console.log(item);
    return;
  }
  if (PROFILE_COMMANDS.has(verb)) {
    if (!args.slice(1).some((word, index) => index % 2 === 0 && word === '--as')) fail('usage', 'Agent commands require --as ID; use node core/cli.ts for legacy --client forms');
    await import('../core/cli.ts'); return;
  }
  if (verb === 'harnesses' || verb === 'harness-probe') { await import('../core/cli.ts'); return; }
  if (verb && verb !== 'link' && verb !== 'view') fail('unknown_command', 'Unknown peerloom command; use peerloom help. Run controls and membership are not agent-profile commands');
  const { main: consoleMain } = await import('../core/shell.ts'); await consoleMain(args);
}
await main().catch(error => {
  const known = error instanceof JoinFailure || error instanceof ProfileError;
  console.log(JSON.stringify({ status: 'error', error: known ? error.code : 'join_local', message: known ? error.message : 'The local join/profile operation failed; stop and ask the human to inspect its storage' }));
  process.exitCode = error instanceof JoinFailure ? error.exitCode : 1;
});
