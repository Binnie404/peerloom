import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { HARNESSES, harnessOf, userHarnesses } from './harnesses.ts';
import { credential, request, requestHeld, saveCredential, TransportError, type Credential } from './client.ts';
import { bold, colourful, dim, title } from './splash.ts';
import { board } from './views.ts';
import { join } from 'node:path';
import { PROFILE_COMMANDS, profileForCredential, resolveAs, type Profile } from './profiles.ts';

// An invocation that is wrong before any call is made: a flag, a file or a value. It never reaches the hub.
class Usage extends Error { code: string; constructor(message: string, code = 'usage') { super(message); this.code = code; } }
const usage = (message: string, code?: string): never => { throw new Usage(message, code); };
const [command, ...args] = process.argv.slice(2);
const flags: Record<string, string> = {};
let profile: Profile | undefined;
// The flags a command may repeat, each value in order: map-edit's --add and --remove.
const REPEATABLE: Record<string, string[]> = { 'map-edit': ['add', 'remove'] }; const repeated: Record<string, string[]> = {};
// Every option is --name value, and the value is whatever follows the name: text may begin with "--" or be "-".
// The only exceptions are switches, which take no value: react --off, send --no-reply.
const SWITCHES: Record<string, string[]> = { react: ['off'], send: ['no-reply'] };
function parse() {
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].startsWith('--') ? args[i].slice(2) : '';
    if (!name) usage(`Expected an option where ${JSON.stringify(args[i])} is. Options are --name value`);
    if (SWITCHES[command]?.includes(name)) { if (Object.hasOwn(flags, name)) usage(`--${name} is given twice`); flags[name] = 'true'; i -= 1; continue; }
    if (i + 1 >= args.length) usage(`--${name} needs a value`);
    if (Object.hasOwn(flags, name) && !REPEATABLE[command]?.includes(name)) usage(`--${name} is given twice`);
    flags[name] ??= args[i + 1]; (repeated[name] ??= []).push(args[i + 1]);
  }
}
const required = (name: string) => flags[name] ? flags[name] : usage(`--${name} is required`);
// The credential comes from --client, or from AGENTLINK_CLIENT so that an agent does not repeat a long path in every call.
const clientPath = () => profile?.credentialPath ?? (flags.client === '' ? usage('--client is empty') : flags.client || process.env.AGENTLINK_CLIENT || usage('--client FILE is required (or set AGENTLINK_CLIENT to the credential file)'));
// A credential that cannot be read is reported by path only: a parser's own message can quote the file.
const load = (path: string) => {
  let auth: Credential;
  try { auth = credential(path); } catch (error: any) { return usage(`Cannot use the credential file ${path}: ${error.code === 'ENOENT' ? 'no such file' : error instanceof SyntaxError ? 'it is not JSON' : error.message}`, 'unreadable_credential'); }
  return flags.endpoint ? { ...auth, endpoint: flags.endpoint } : auth;
};
const key = () => flags.key ?? randomUUID();
const out = (value: any) => console.log(JSON.stringify(value));
const help = `Peerloom local core (Node 24+, no install needed)
  node core/server.ts --data .agentlink --port 4317
  node core/cli.ts create --admin-file .agentlink/admin.json --name Room --workspace /path --objective "Goal" --out owner.agentlink.json --key create-room
  node core/cli.ts invite --client owner.agentlink.json --name Astra --role Reviewer --harness cli --out astra-invite.agentlink.json --key invite-astra
  node core/cli.ts join --invite astra-invite.agentlink.json --out astra.agentlink.json --key join-astra
  node core/cli.ts room|inbox|history|heartbeat|leave --client astra.agentlink.json
  node core/cli.ts send --client astra.agentlink.json --to human --text "Ready" --key ready-1
  node core/cli.ts send --client owner.agentlink.json --text "Begin" --key start-1
  node core/cli.ts ack --client astra.agentlink.json --ids m_ID,m_ID --key ack-1
  node core/cli.ts status --client astra.agentlink.json --text "Reviewing"
  node core/cli.ts revoke --client owner.agentlink.json --invitation i_ID
  node core/cli.ts send --client astra.agentlink.json --to Bolt --text "FYI: merged" --no-reply          (mail that needs no answer)
  node core/cli.ts react --client astra.agentlink.json --message m_ID --emoji 👍 [--off]                   (👍 ✅ 👀 ❌ 🎉; wakes nobody; --off removes it)
  node core/cli.ts working|blocked|done --client astra.agentlink.json [--message m_ID] [--text "one line"]   (activity; blocked needs --text; done clears it; wakes nobody)
  node core/cli.ts post --client astra.agentlink.json --text "FYI for the room" [--to NAMES]               (room text that wakes nobody; agents name --to)
  node core/cli.ts receipts --client astra.agentlink.json [--after N] [--limit N]                           (read only)
  node core/cli.ts chat --client astra.agentlink.json
Set AGENTLINK_CLIENT to a credential file and --client can be left out of every command; --client wins when both are given.
Or use peerloom VERB --as ID in the room workspace or a child directory. It selects one indexed agent profile, never a control credential; it cannot be combined with --client or --endpoint. Managed --client and --as share one runtime directory.
Wherever a command takes --text it also takes --text - (read standard input) or --text-file FILE, so text need not pass through shell quoting.
Inbox/history support --after SEQUENCE --limit COUNT. Send supports --reply-to MESSAGE_ID, and with it --seen SEQUENCE: the highest message sequence you have read. If the thread holds a later message to you the hub refuses with thread_moved and sends nothing. reply does this by itself, from the wake; after a refusal, reply --seen with the sequence of the newest message shown says you have read it.
Use --endpoint http://127.0.0.1:PORT if the hub restarts on a different port.
Use --to all for an explicit agent broadcast, or comma-separated names/IDs. Read never acknowledges.
Chat commands: /send NAME TEXT, /all TEXT, /inbox, /room, /history, /ack ID, /status TEXT, /quit.
Collaboration (needs a version 2 or later store; see docs/LOCAL_CORE.md):
  node core/cli.ts item-open --client astra.agentlink.json --type decision --title "Plan" [--refs provider:ref,provider:ref]
  node core/cli.ts publish --client astra.agentlink.json --item it_ID --file plan.md            (or --text "…"; new artifact; --file is sent byte for byte)
  node core/cli.ts publish --client astra.agentlink.json --item it_ID --artifact ar_ID --base 1 --file plan.md
  node core/cli.ts request --client astra.agentlink.json --item it_ID --purpose review --to Bolt,Cleo [--policy any] --artifact ar_ID --revision 1 --digest HEX --text "Please review"
  node core/cli.ts request --client astra.agentlink.json --item it_ID --purpose answer|decision --to human --text "Which port?"
  node core/cli.ts respond --client bolt.agentlink.json --request rq_ID --outcome answered --verdict approve|changes_requested --artifact ar_ID --revision 1 --digest HEX --text "…"
  node core/cli.ts respond --client bolt.agentlink.json --request rq_ID --outcome declined [--artifact … --revision … --digest …] --text "Why"
  node core/cli.ts accept --client astra.agentlink.json --request rq_ID --responses rs_ID,rs_ID
  node core/cli.ts withdraw --client astra.agentlink.json --request rq_ID --reason "Why" [--respondents Bolt]
  node core/cli.ts suggest --client astra.agentlink.json --title "Retry failed sends" --text-file proposal.json   (a recommendation for the human; proposal JSON in docs/QUICKSTART.md)
  node core/cli.ts map --client astra.agentlink.json                                   (the project map, agentlink-map.txt in the room's workspace, with any lines in error)
  node core/cli.ts map-edit --client astra.agentlink.json --add "node hub | Hub | service | core/server.ts" [--add …] [--remove ID] [--base DIGEST]   (--add and --remove may repeat)
  node core/cli.ts map-edit --client astra.agentlink.json --text-file edit.txt          (lines "add ENTRY" / "remove ID", applied together or not at all)
  node core/cli.ts item-close --client astra.agentlink.json --item it_ID --state resolved|dropped --reason "Why" [--artifact ar_ID --revision 2 --digest HEX]
  node core/cli.ts owed|awaiting|items|board|capabilities --client bolt.agentlink.json
  node core/cli.ts item|requests --client bolt.agentlink.json --item it_ID
  node core/cli.ts revision --client bolt.agentlink.json --artifact ar_ID --revision 1
Pull delivery (Agent-armed mode; needs a store with delivery records):
  node core/cli.ts bind --client bolt.agentlink.json --label "bolt desktop"          (once per session; a new bind supersedes the old)
  node core/cli.ts wait --client bolt.agentlink.json [--timeout 55]                  (prints a pointer only; exit 0 offer, 3 timeout, 4 superseded, 5 disarmed, 6 refused, 7 hub did not answer, 8 hub closing)
  node core/cli.ts wait --client bolt.agentlink.json --recover true                  (asks again for the same attempt after exit 7 or a wait that died; never done by itself)
  node core/cli.ts fetch --client bolt.agentlink.json --wake wk_ID                   (in the foreground: fetches the named work and confirms intake)
  node core/cli.ts reply --client bolt.agentlink.json --wake wk_ID --text-file answer.txt [--to NAME] [--seen SEQUENCE]   (after fetch: answers the wake's message and acknowledges it, in one call)
  node core/cli.ts run --client bolt.agentlink.json
  node core/cli.ts run-start --client owner.agentlink.json [--room 40 --agent 12 --empty-waits 30]     (human only, as are the rest)
  node core/cli.ts run-pause|run-resume|run-end --client owner.agentlink.json
  node core/cli.ts run-limits --client owner.agentlink.json --room 60
  node core/cli.ts run-reoffer|run-rearm --client owner.agentlink.json --participant Bolt
Harnesses (local: no hub and no credential are needed):
  node core/cli.ts harnesses                                                    (the registry, each harness's routes and its recorded probe)
  node core/cli.ts harness-probe dsh [--timeout 4000]                            (a bounded version probe; it records and enables nothing)
After wait exits 3 an agent may wait again; each empty return counts against its allowance. Exit 8 means the hub is deliberately closing: stop without another wait. After 4, 5, 6, 7 or 1 it stops until a human acts.
Every command fails with one JSON line on standard output, {"status":"error","error":CODE,"message":…}: exit 1 if no call was made (a flag, a file, no binding), exit 6 if the hub refused it (error is the hub's code), exit 7 if the hub did not answer (error is hub_unreachable; whether the hub acted is unknown).
An option is --name value and the value is taken as it stands, so --text "--draft" is text. A flag a command does not use is refused.
Receipt (ack) never answers a request: only respond does. A review response must repeat the exact artifact, revision and digest it reviewed.
Accepting a response is the requester's act; a revision is agreed only when its designated reviewers approved it and the requester accepted.
Credential and invitation outputs contain secrets. Store them privately. Reuse a --key only for an identical retry.`;

// harness-probe takes its name as the first argument (or --harness); every other argument is --name value.
const probeName = command === 'harness-probe' && args.length && !args[0].startsWith('--') ? args.shift() : undefined;
const names = (value: string) => value.split(',');
const whole = (name: string) => { const value = Number(required(name)); return Number.isInteger(value) ? value : usage(`--${name} must be a whole number`); };
// A target is sent exactly as given; the hub compares it with the stored revision, so nothing is filled in here.
const target = () => flags.artifact || flags.revision || flags.digest ? { artifactId: required('artifact'), revision: whole('revision'), digest: required('digest') } : undefined;
const readText = (path: string) => { try { return readFileSync(path === '-' ? 0 : path, 'utf8'); } catch (error: any) { return usage(`Cannot read ${path === '-' ? 'standard input' : path}: ${error.code ?? error.message}`, 'unreadable_file'); } };
// Text is given once: inline, as "-" for standard input, or as a file, so that it never has to survive shell quoting.
// A message read from a file or a pipe loses its final line break; --file (a document) is sent byte for byte.
function content(document = false) {
  const sources = ['text', 'text-file', ...(document ? ['file'] : [])]; const given = sources.filter(name => flags[name] !== undefined);
  if (given.length !== 1) usage(given.length ? `Use one of --${given.join(', --')}, not ${given.length === 2 ? 'both' : 'all'}` : `Text is required: --text "…", --text - (standard input) or --text-file FILE${document ? ', or --file FILE' : ''}`);
  const value = given[0] === 'file' ? readText(required('file')) : given[0] === 'text-file' ? readText(required('text-file')).replace(/\r?\n$/, '') : flags.text === '-' ? readText('-').replace(/\r?\n$/, '') : flags.text;
  return value.trim() ? value : usage('The text is empty');
}
const proposal = (text: string) => { let value: any; try { value = JSON.parse(text); } catch { value = undefined; } return value && typeof value === 'object' && !Array.isArray(value) ? value : usage('The proposal must be a JSON object, as in --text \'{"v":1,"kind":"gap",…}\'', 'payload_not_json'); };
// A map edit is --add and --remove (each as often as needed), or a batch of lines "add ENTRY" and "remove ID" given as text; either
// way the hub applies it all or not at all.
function mapEdit() {
  const single = flags.add !== undefined || flags.remove !== undefined; const batch = flags.text !== undefined || flags['text-file'] !== undefined;
  if (single && batch) usage('Give either --add/--remove or --text/--text-file, not both');
  if (!single && !batch) usage('map-edit needs --add ENTRY, --remove ID, or --text with lines "add ENTRY" and "remove ID"');
  const add: string[] = []; const remove: string[] = [];
  if (single) { add.push(...repeated.add ?? []); remove.push(...repeated.remove ?? []); }
  else content().split(/\r?\n/).forEach((line, index) => { if (!line.trim()) return; const found = /^(add|remove)\s+(.+)$/.exec(line.trim()); if (!found) usage(`line ${index + 1}: each line is "add ENTRY" or "remove ID"`); (found![1] === 'add' ? add : remove).push(found![2].trim()); });
  return given({ requestId: key(), add: add.length ? add : undefined, remove: remove.length ? remove : undefined, base: flags.base });
}
const given = (fields: Record<string, any>) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
const runLimits = () => { const found = given({ room: flags.room ? whole('room') : undefined, agent: flags.agent ? whole('agent') : undefined, emptyWaits: flags['empty-waits'] ? whole('empty-waits') : undefined }); return Object.keys(found).length ? found : undefined; };
// The hub refuses unknown body fields, but it never sees a flag the CLI did not use; so each command names its own.
const collab: Record<string, [string, () => any, string[]]> = {
  'item-open': ['item_open', () => given({ requestId: key(), itemType: required('type'), title: required('title'), externalRefs: flags.refs ? names(flags.refs).map(pair => { const at = pair.indexOf(':'); if (at < 1) usage('--refs entries are provider:ref'); return { provider: pair.slice(0, at), ref: pair.slice(at + 1) }; }) : undefined }), ['type', 'title', 'refs', 'key']],
  'item-close': ['item_close', () => given({ requestId: key(), itemId: required('item'), state: required('state'), reason: required('reason'), agreed: target() }), ['item', 'state', 'reason', 'artifact', 'revision', 'digest', 'key']],
  // A proposal is JSON (docs/QUICKSTART.md lists its fields); the hub checks the fields, the CLI only that it is an object.
  suggest: ['suggest', () => ({ requestId: key(), title: required('title'), payload: proposal(content()) }), ['title', 'text', 'text-file', 'key']],
  map: ['map', () => ({}), []],
  'map-edit': ['map_edit', () => mapEdit(), ['add', 'remove', 'text', 'text-file', 'base', 'key']],
  publish: ['publish', () => given({ requestId: key(), itemId: required('item'), text: content(true), artifactId: flags.artifact, baseRevision: flags.base ? whole('base') : undefined }), ['item', 'text', 'text-file', 'file', 'artifact', 'base', 'key']],
  request: ['request', () => given({ requestId: key(), itemId: required('item'), purpose: required('purpose'), to: names(required('to')), text: content(true), policy: flags.policy, target: target() }), ['item', 'purpose', 'to', 'text', 'text-file', 'file', 'policy', 'artifact', 'revision', 'digest', 'key']],
  respond: ['respond', () => given({ requestId: key(), collabRequestId: required('request'), outcome: required('outcome'), verdict: flags.verdict, target: target(), text: content(true) }), ['request', 'outcome', 'verdict', 'artifact', 'revision', 'digest', 'text', 'text-file', 'file', 'key']],
  withdraw: ['withdraw', () => given({ requestId: key(), collabRequestId: required('request'), reason: required('reason'), respondents: flags.respondents ? names(flags.respondents) : undefined }), ['request', 'reason', 'respondents', 'key']],
  accept: ['accept', () => ({ requestId: key(), collabRequestId: required('request'), responseIds: names(required('responses')) }), ['request', 'responses', 'key']],
  owed: ['requests', () => ({ filter: 'owed_by_me' }), []],
  awaiting: ['requests', () => ({ filter: 'owed_to_me' }), []],
  requests: ['requests', () => ({ filter: 'item', itemId: required('item') }), ['item']],
  items: ['items', () => ({}), []],
  item: ['item', () => ({ itemId: required('item') }), ['item']],
  revision: ['revision', () => ({ artifactId: required('artifact'), revision: whole('revision') }), ['artifact', 'revision']],
  capabilities: ['capabilities', () => ({}), []],
  run: ['run', () => ({}), []],
  'run-start': ['run_start', () => given({ requestId: key(), limits: runLimits() }), ['room', 'agent', 'empty-waits', 'key']],
  'run-pause': ['run_pause', () => ({ requestId: key() }), ['key']],
  'run-resume': ['run_resume', () => ({ requestId: key() }), ['key']],
  'run-end': ['run_end', () => ({ requestId: key() }), ['key']],
  'run-limits': ['run_limits', () => ({ requestId: key(), limits: runLimits() ?? {} }), ['room', 'agent', 'empty-waits', 'key']],
  'run-reoffer': ['run_reoffer', () => ({ requestId: key(), participant: required('participant') }), ['participant', 'key']],
  'run-rearm': ['run_rearm', () => ({ requestId: key(), participant: required('participant') }), ['participant', 'key']],
};

// The binding generation is kept beside the credential file, so each one-shot command of a session names the same binding.
const bindingFile = () => profile ? join(profile.stateDir, 'binding.json') : `${clientPath()}.binding.json`;
const boundGeneration = () => { try { return JSON.parse(readFileSync(bindingFile(), 'utf8')).generation as number; } catch { return usage(`No binding saved for this credential; run: node core/cli.ts bind --client ${clientPath()} --label "..."`, 'no_binding'); } };
// The current wait attempt, and a lock so that one credential file has one live wait. The lock is a file holding a
// process ID, put in place whole (a link to a file already written), so it is never seen empty. A killed wait cannot
// remove its own, so a lock is taken over from a process that is proved gone, and only by one wait at a time: the
// takeover has a guard of its own, made the same way and held until the new lock is in place. A lock or a guard that
// cannot be read as the ID of a process proved gone is left alone and refuses the wait.
const waitFile = () => profile ? join(profile.stateDir, 'wait.json') : `${clientPath()}.wait.json`;
type WaitRecord = { generation: number; attemptId: string; wakeId?: string };
const waitRecord = (): WaitRecord | undefined => { try { const value = JSON.parse(readFileSync(waitFile(), 'utf8')); return Number.isInteger(value?.generation) && typeof value.attemptId === 'string' && value.attemptId ? value : undefined; } catch { return undefined; } };
function waitLock() {
  const path = profile ? join(profile.stateDir, 'wait.lock') : `${clientPath()}.wait.lock`; const guard = `${path}.reclaim`; const mine = `${path}.${process.pid}`; const own = String(process.pid);
  const drop = (file: string) => { try { if (readFileSync(file, 'utf8') === own) rmSync(file, { force: true }); } catch { /* already gone */ } };
  const take = (file: string) => { try { linkSync(mine, file); return true; } catch (error: any) { if (error.code === 'EEXIST') return false; throw error; } };
  // The process a lock file names, if it is proved gone; a refusal if it is alive or the file does not say.
  const deadOwner = (file: string, what: string) => {
    let text: string; try { text = readFileSync(file, 'utf8'); } catch (gone: any) { if (gone.code === 'ENOENT') return null; throw gone; }
    const pid = /^[1-9]\d*$/.test(text) ? Number(text) : 0;
    if (pid < 2) usage(`${what} ${file} does not hold a process ID. If no wait is running for this credential, remove that file`, 'wait_running');
    let alive = true; try { process.kill(pid, 0); } catch (probe: any) { alive = probe.code !== 'ESRCH'; }
    if (alive) usage(`Another wait is already running for this credential (process ${pid}). One credential holds one wait`, 'wait_running');
    return text;
  };
  try {
    writeFileSync(mine, own, { mode: 0o600 });
    if (take(path)) return () => drop(path);
    if (deadOwner(path, 'The wait lock') === null) { if (take(path)) return () => drop(path); usage('Another wait took the lock for this credential first', 'wait_running'); }
    // The owner is gone. One wait at a time may clear its lock; a guard left by a wait that died doing so is not
    // cleared by anything but a person, because clearing it would need a guard of its own.
    if (!take(guard)) { if (deadOwner(guard, 'The wait lock\'s takeover guard') !== null) usage(`A wait died while taking over the lock for this credential. If no wait is running, remove ${guard}`, 'wait_running'); usage('Another wait is taking over the lock for this credential', 'wait_running'); }
    try {
      // Looked at again under the guard: another wait may have finished the same takeover a moment ago.
      if (deadOwner(path, 'The wait lock') !== null) rmSync(path, { force: true });
      if (take(path)) return () => drop(path);
      return usage('Another wait took the lock for this credential first', 'wait_running');
    } finally { drop(guard); }
  } finally { rmSync(mine, { force: true }); }
}
// Every command fails the same way: one JSON object on standard output and an exit code. Exit 1 is an invocation that
// made no call: a missing flag, an unreadable file, no saved binding. Exit 6 is a call the hub answered with a refusal,
// and "error" is the hub's own code, with the hub's "detail" when it gave one. Exit 7 is a call the hub did not answer, and "transport" says how; whether the hub
// acted on it is then unknown. A stale binding is 4. Nothing here retries.
const failed = (error: any) => {
  if (error?.code === 'hub_closing') { out({ status: 'closing' }); process.exitCode = 8; return; }
  if (error?.code === 'stale_binding') { out({ status: 'stale_binding' }); process.exitCode = 4; return; }
  if (error instanceof TransportError) { out({ status: 'error', error: error.code, transport: error.transport, message: error.message }); process.exitCode = 7; return; }
  out({ status: 'error', error: error?.code ?? error?.name ?? 'failed', message: String(error?.message ?? error), ...(error?.detail !== undefined ? { detail: error.detail } : {}) }); process.exitCode = error instanceof Usage ? 1 : 6;
};
// One attempt each. None of these retries, rebinds or starts a run, and none prints a suggestion that the caller should.
const delivery: Record<string, [string, (auth: Credential) => Promise<void>, string[]]> = {
  bind: ['bind', async auth => {
    const result = await request(auth, 'bind', { requestId: key(), label: required('label') });
    saveCredential(bindingFile(), { generation: result.generation, label: flags.label });
    out({ ...result, savedBinding: bindingFile() });
  }, ['label', 'key']],
  // Prints a pointer and nothing else: on some surfaces a background process's output reaches the session as a
  // notification, and text written by another participant must not arrive that way.
  // A wait is one attempt with an identity of its own, saved beside the credential before the call is made. The hub
  // hands a prepared offer back only to the attempt it was prepared for, so two waits can never both receive it; the
  // saved record is what lets the one true owner ask again after a lost answer, and only when told to (--recover true).
  wait: ['wait', async auth => {
    const timeoutSeconds = flags.timeout ? whole('timeout') : 55; const generation = boundGeneration();
    if (flags.recover !== undefined && flags.recover !== 'true') usage('--recover takes exactly: true');
    const release = waitLock();
    try {
      let saved = waitRecord(); let attemptId: string;
      if (flags.recover) {
        if (!saved || saved.generation !== generation) usage('There is no unfinished wait to recover for this binding; run wait without --recover', 'nothing_to_recover');
        attemptId = saved!.attemptId;
      } else {
        // A record left by an earlier wait of this binding stands in the way only while the hub still holds an offer
        // for it. Otherwise that wait ended without one, or its work has since been fetched or closed.
        if (saved && saved.generation === generation) {
          const mine = (await request(auth, 'run')).bindings?.find((b: any) => b.participantId === auth.participantId);
          const pending = mine?.generation === generation ? mine.pending : null;
          if (pending && pending.attemptId === saved.attemptId) usage(saved.wakeId
            ? `Wake ${saved.wakeId} was offered to an earlier wait and has not been fetched. Fetch it: node core/cli.ts fetch --wake ${saved.wakeId}   (wait --recover true prints the pointer again)`
            : 'An earlier wait was prepared an offer and ended before printing it. Run: node core/cli.ts wait --recover true', saved.wakeId ? 'wake_pending' : 'wait_unfinished');
          // The hub may still be holding that earlier wait after its process died, and can yet prepare an offer for it.
          if (mine?.generation === generation && mine.armed === 'waiting') usage('The hub is still holding an earlier wait of this binding, whose process is gone. Run: node core/cli.ts wait --recover true', 'wait_unfinished');
        }
        attemptId = randomUUID(); saved = { generation, attemptId }; saveCredential(waitFile(), saved);
      }
      const forget = () => { if (waitRecord()?.attemptId === attemptId) rmSync(waitFile(), { force: true }); };
      let result: any;
      // Kept when the hub did not answer: whether it prepared an offer is then unknown. Dropped when it refused, except
      // that a recovery told another wait is held keeps its key: that older hold can still prepare an offer for it.
      try { result = await requestHeld(auth, 'wait', { generation, timeoutSeconds, attemptId }, (timeoutSeconds + 10) * 1000); }
      catch (error: any) { if (!(error instanceof TransportError) && !(flags.recover && error?.code === 'already_waiting')) forget(); throw error; }
      if (result.status === 'offer') { saveCredential(waitFile(), { generation, attemptId, wakeId: result.wakeId }); out({ status: 'offer', wakeId: result.wakeId, units: result.units.map((u: any) => ({ kind: u.kind, id: u.id })), more: result.more }); return; }
      forget();
      out(result.status === 'timeout' ? { status: 'timeout', held: result.held } : { status: result.status });
      process.exitCode = result.status === 'timeout' ? 3 : result.status === 'superseded' ? 4 : result.status === 'disarmed' ? 5 : result.status === 'closing' ? 8 : 1;
    } finally { release(); }
  }, ['timeout', 'recover']],
  // The foreground step: obtain the named work, and confirm intake only once this process holds it.
  fetch: ['fetch', async auth => {
    const generation = boundGeneration(); const wakeId = required('wake');
    const fetched = await request(auth, 'fetch', { generation, wakeId });
    const confirmed = await request(auth, 'confirm', { requestId: `confirm-${wakeId}`, generation, wakeId });
    // Intake is confirmed: the wait that was offered this wake is finished, and the next wait is a fresh one.
    const saved = waitRecord(); if (saved && (saved.wakeId === wakeId || fetched.attemptId !== undefined && saved.attemptId === fetched.attemptId)) rmSync(waitFile(), { force: true });
    out({ wakeId, confirmedAt: confirmed.confirmedAt, units: fetched.units });
  }, ['wake']],
  // Answer and acknowledge in one call. The reply goes to whoever wrote the wake's mail, as a reply to their last
  // message, and only the mail of those it answers is acknowledged: anything else in the wake stays owed. Only a wake
  // already fetched can be answered. The hub is told how far the answered thread had been read, and refuses with
  // thread_moved (the newer messages in "detail") if it has gone further; --seen says the agent has read up to there
  // and answers all the same. Both keys are made from everything that
  // decides the call, so repeating it after a failure cannot send twice, and a second answer from one wake is its own.
  reply: ['reply', async auth => {
    const generation = boundGeneration(); const wakeId = required('wake'); const text = content();
    const fetched = await request(auth, 'fetch', { generation, wakeId });
    if (!fetched.confirmed) usage(`Fetch ${wakeId} before replying to it`, 'not_fetched');
    const mail = fetched.units.filter((u: any) => u.kind === 'human_message' || u.kind === 'agent_message');
    if (!mail.length) usage('This wake holds no message. A request is answered with respond', 'no_message');
    const wrote = (u: any, who: string) => who === u.sender.id || who.toLowerCase() === String(u.sender.name).toLowerCase();
    const senders = [...new Set<string>(mail.map((u: any) => u.sender.name))];
    const asked = flags.to ? names(flags.to) : senders.length === 1 ? senders : usage(`This wake holds messages from ${senders.join(' and ')}; name who you are answering with --to`, 'recipient_required');
    const absent = asked.filter(who => !mail.some((u: any) => wrote(u, who)));
    if (absent.length) usage(`${absent.join(', ')} wrote nothing in this wake (it holds messages from ${senders.join(' and ')}). Use send to write to someone else`, 'not_in_wake');
    const answered = mail.filter((u: any) => asked.some(who => wrote(u, who)));
    const parent = answered.at(-1).view; const to = [...new Set<string>(answered.map((u: any) => u.sender.id))]; const ids: string[] = answered.map((u: any) => u.id);
    const seen = flags.seen ? whole('seen') : Math.max(...mail.filter((u: any) => u.view.threadId === parent.threadId).map((u: any) => u.view.sequence));
    const digest = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
    const requestId = flags.key ?? `reply-${digest(wakeId, to, parent.id, seen, text)}`;
    const { message } = await request(auth, 'send', { requestId, to, text, replyTo: parent.id, seen });
    await request(auth, 'ack', { requestId: `reply-ack-${digest(wakeId, ids)}`, messageIds: ids });
    out({ status: 'replied', messageId: message.id, sequence: message.sequence, to: message.recipientIds, replyTo: parent.id, acknowledged: ids, requestId });
  }, ['wake', 'to', 'text', 'text-file', 'seen', 'key']],
};

// At a terminal the help gets the title and a little emphasis; piped or redirected it is the plain text, unchanged.
function shownHelp() {
  const on = colourful(process.stdout); const banner = title(process.stdout);
  if (!banner.length) return help;
  const lines = help.split('\n').map((line, index) => {
    const call = /^(  node core\/(?:cli|server)\.ts )(\S+)(.*)$/.exec(line);
    if (call) return `${dim(call[1], on)}${bold(call[2], on)}${call[3]}`;
    return index === 0 || /:$/.test(line) ? bold(line, on) : line;
  });
  return ['', ...banner, '', ...lines, ''].join('\n');
}

// What each remaining command takes besides --client and --endpoint. Every command has an entry here or in the two
// tables above, and a flag outside its list is refused: the hub never sees a flag the CLI did not use.
const mailbox: Record<string, string[]> = {
  create: ['admin-file', 'name', 'workspace', 'objective', 'out', 'key'], invite: ['name', 'role', 'harness', 'ttl', 'out', 'key'], join: ['invite', 'out', 'key'],
  room: [], heartbeat: [], leave: [], chat: [], board: [], inbox: ['after', 'limit'], history: ['after', 'limit'],
  send: ['to', 'text', 'text-file', 'reply-to', 'seen', 'no-reply', 'key'], ack: ['ids', 'key'], status: ['text', 'text-file', 'key'], revoke: ['invitation', 'key'],
  react: ['message', 'emoji', 'off', 'key'], working: ['message', 'text', 'text-file', 'key'], blocked: ['message', 'text', 'text-file', 'key'], done: ['message', 'key'],
  post: ['to', 'text', 'text-file', 'key'], receipts: ['after', 'limit'],
  harnesses: [], 'harness-probe': ['harness', 'timeout'],
};

// The version line a harness prints, or why it did not. Bounded, with standard input closed, and it records nothing:
// enabling a harness is a code change with evidence, never a side effect of a probe.
function harnessProbe(id: string, timeoutMs: number) {
  const harness = harnessOf(id) ?? usage(`There is no harness ${JSON.stringify(id)}. Run node core/cli.ts harnesses to list them.`, 'unknown_harness');
  const bin = harness.detect.bin;
  if (!bin) return { status: 'probe', harness: harness.id, label: harness.label, bin: null, found: false, ok: false, enables: false,
    reason: 'this harness is an external chat with no CLI to probe; its wake evidence is recorded separately', evidence: harness.probe.evidence };
  const started = Date.now();
  const run = spawnSync(bin, harness.detect.version, { input: '', encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: process.env });
  const missing = (run.error as any)?.code === 'ENOENT';
  const timedOut = (run.error as any)?.code === 'ETIMEDOUT' || run.signal === 'SIGKILL';
  const lines = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.split('\n').map(line => line.replace(/[\u0000-\u001f\u007f]/g, '').trim()).filter(Boolean);
  const version = lines.find(line => !/^WARNING/i.test(line)) ?? '';
  const ok = !missing && !timedOut && run.status === 0 && version.length > 0;
  const reason = missing ? 'not installed (the binary is not on PATH)' : timedOut ? `no answer within ${timeoutMs} ms` : run.status !== 0 ? `exited ${run.status ?? 'without a status'}` : !version ? 'the version command printed nothing' : undefined;
  return { status: 'probe', harness: harness.id, label: harness.label, bin, found: !missing, ok, enables: false,
    exitCode: run.status, signal: run.signal ?? null, timedOut, version, ms: Date.now() - started, ...(reason ? { reason } : {}),
    ...((run.error as any)?.code && !missing && !timedOut ? { spawnError: (run.error as any).code } : {}), evidence: harness.probe.evidence };
}

async function main() {
  if (!command || command === 'help' || command === '--help') { if (args.length) usage(`help takes nothing after it; ${JSON.stringify(args[0])} was given`); console.log(shownHelp()); return; }
  parse();
  if (flags.as !== undefined) {
    if (!PROFILE_COMMANDS.has(command)) usage(`${command} is not an agent-profile command`);
    if (flags.client !== undefined || flags.endpoint !== undefined) usage('--as cannot be combined with --client or --endpoint');
    try { profile = resolveAs(required('as')); } catch (error: any) { usage(String(error.message), error.code ?? 'profile_unknown'); }
  }
  const takes = mailbox[command] ?? collab[command]?.[2] ?? delivery[command]?.[2] ?? usage(`Unknown command ${command}. Run node core/cli.ts help`, 'unknown_command');
  const local = command === 'harnesses' || command === 'harness-probe';
  const allowed = [...(command === 'create' || command === 'join' || local ? [] : ['client']), ...(local ? [] : ['endpoint']), ...(PROFILE_COMMANDS.has(command) ? ['as'] : []), ...takes];
  const stray = Object.keys(flags).filter(name => !allowed.includes(name));
  if (stray.length) usage(`${command} does not take --${stray.join(', --')}. It takes: ${allowed.map(name => `--${name}`).join(' ')}`);
  if (local) {
    if (command === 'harnesses') {
      const user = userHarnesses();
      out({ status: 'harnesses', harnesses: HARNESSES.map(h => ({ id: h.id, label: h.label, hubName: h.hubName, routes: h.routes, wake: h.wake,
        approvals: h.approvals, host: h.host ?? null, detect: h.detect.bin || null, enabled: h.probe.ok, version: h.probe.version,
        probedAt: h.probe.date, reason: h.probe.ok ? null : h.probe.missing ?? 'unprobed', source: h.source ?? 'built-in' })),
        userRegistry: { path: user.path, loaded: user.loaded, errors: user.errors } });
      return;
    }
    const id = probeName ?? (flags.harness || usage('harness-probe needs a harness: node core/cli.ts harness-probe dsh [--timeout 4000]'));
    const timeoutMs = flags.timeout ? whole('timeout') : 4000;
    if (timeoutMs < 100 || timeoutMs > 30_000) usage('--timeout is milliseconds from 100 to 30000');
    out(harnessProbe(id, timeoutMs)); return;
  }
  if (command === 'create' || command === 'invite' || command === 'join') {
    const path = required('out');
    const auth = load(command === 'create' ? required('admin-file') : command === 'join' ? required('invite') : clientPath());
    let body: any = { requestId: key() };
    if (command === 'create') body = { ...body, name: required('name'), workspace: required('workspace'), ...(flags.objective ? { objective: flags.objective } : {}) };
    if (command === 'invite') body = { ...body, name: required('name'), ...(flags.role ? { role: flags.role } : {}), ...(flags.harness ? { harness: flags.harness } : {}), ...(flags.ttl ? { ttlSeconds: whole('ttl') } : {}) };
    if (command === 'join') body.token = auth.token;
    const result = await request(auth, command, body);
    saveCredential(path, result);
    const { token, ...publicResult } = result;
    out({ ...publicResult, savedCredential: path, requestId: body.requestId });
    return;
  }
  const auth = load(clientPath());
  if (!profile) { try { profile = profileForCredential(clientPath()); } catch (error: any) { usage(String(error.message), error.code ?? 'profile_unknown'); } }
  if (command === 'chat') {
    const room = await request(auth, 'room');
    const lines = createInterface({ input: process.stdin, terminal: false });
    const timer = setInterval(() => { void request(auth, 'heartbeat').catch(error => out({ error: error.message })); }, 10_000);
    try {
      out({ chat: 'connected', ...room });
      for await (const line of lines) {
        try {
          let op: string; let body: any = {};
          if (line === '/quit') break;
          if (['/inbox', '/room', '/history'].includes(line)) op = line.slice(1);
          else if (line.startsWith('/send ')) {
            const match = /^\/send (\S+) (.+)$/.exec(line);
            if (!match) throw new Error('Use /send NAME TEXT');
            op = 'send'; body = { to: match[1], text: match[2], requestId: randomUUID() };
          } else if (line.startsWith('/all ')) { op = 'send'; body = { to: 'all', text: line.slice(5), requestId: randomUUID() }; }
          else if (line.startsWith('/ack ')) { op = 'ack'; body = { messageIds: line.slice(5).split(','), requestId: randomUUID() }; }
          else if (line.startsWith('/status ')) { op = 'status'; body = { text: line.slice(8), requestId: randomUUID() }; }
          else throw new Error('Use /send NAME TEXT, /all TEXT, /inbox, /room, /history, /ack ID, /status TEXT or /quit');
          out({ operation: op, ...(await request(auth, op, body)) });
        } catch (error: any) { out({ error: error.message }); }
      }
    } finally { clearInterval(timer); lines.close(); await request(auth, 'leave').catch(() => {}); }
    return;
  }
  if (command === 'board') { console.log(await board(auth)); return; }
  if (Object.hasOwn(delivery, command)) { await delivery[command][1](auth); return; }
  if (Object.hasOwn(collab, command)) {
    const [op, build] = collab[command];
    const body = build();
    out({ ...(await request(auth, op, body)), ...(body.requestId ? { requestId: body.requestId } : {}) });
    return;
  }
  let body: any = {};
  if (command === 'send') {
    body = { text: content(), requestId: key(), ...(flags['reply-to'] ? { replyTo: flags['reply-to'] } : {}), ...(flags.seen ? { seen: whole('seen') } : {}) };
    if (flags.to) body.to = flags.to.includes(',') ? flags.to.split(',') : flags.to;
    if (flags['no-reply']) body.noReply = true;
  } else if (command === 'post') {
    body = { text: content(), requestId: key(), post: true };
    if (flags.to) body.to = flags.to.includes(',') ? flags.to.split(',') : flags.to;
  } else if (command === 'react') body = { messageId: required('message'), emoji: required('emoji'), requestId: key(), ...(flags.off ? { on: false } : {}) };
  else if (command === 'working' || command === 'blocked' || command === 'done') {
    const text = command === 'blocked' || (command === 'working' && (flags.text !== undefined || flags['text-file'] !== undefined)) ? content() : undefined;
    body = { state: command, requestId: key(), ...(flags.message ? { messageId: flags.message } : {}), ...(text ? { text } : {}) };
  } else if (command === 'ack') body = { messageIds: required('ids').split(','), requestId: key() };
  else if (command === 'status') body = { text: content(), requestId: key() };
  else if (command === 'revoke') body = { invitationId: required('invitation'), requestId: key() };
  else if (command === 'inbox' || command === 'history' || command === 'receipts') body = { ...(flags.after ? { after: whole('after') } : {}), ...(flags.limit ? { limit: whole('limit') } : {}) };
  out({ ...(await request(auth, command === 'working' || command === 'blocked' || command === 'done' ? 'activity' : command === 'post' ? 'send' : command, body)), ...(body.requestId ? { requestId: body.requestId } : {}) });
}
await main().catch(failed);
