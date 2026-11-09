import { createInterface, clearLine, cursorTo, emitKeypressEvents } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { inspectHubUpgrade, startHub, upgradeHubData } from './server.ts';
import { STATE_VERSION } from './snapshot.ts';
import { parseProposal } from './collab.ts';
import { MAP_FILE, MAP_TEMPLATE, checkMap } from './map.ts';
import { harnessList, harnessOf, userHarnesses } from './harnesses.ts';
import { credential, request, requestHeld, saveCredential, type Credential } from './client.ts';
import { NativeAdapter, type AdapterDependencies } from './codex-adapter.ts';
import { ClaudeHost, claudeModels } from './claude-host.ts';
import { board } from './views.ts';
import { startWeb } from './web.ts';
import { joinService, type Effects, type JoinService } from './join.ts';
import { complete, expandAlias, onlyApproval, resolveName, routeLine } from './complete.ts';
import { CLI, installed } from './brand.ts';
import { HISTORY_SIZE, loadHistory, saveHistory } from './history.ts';
import { bold, checklist, colourful, details, dim, green, heading, promptText, red, yellow } from './splash.ts';
import { PROPOSAL_EXAMPLE, PROPOSAL_RULES, mapHelp, agentlinkCall, alive, claudeLauncher, claudeOpening, clean, codexAppOpening, cursorCommand, externalOpening, codexModels, describe, linkSkill, stoppedText, nativeRequestLines, openTerminal, projectAllow, quote, stopWindow, view, viewLauncher, type CodexModel } from './shell-agents.ts';

// `peerloom`: one prompt that runs the hub, makes the room and launches the agents, so that a session does not
// take three terminals and a page of commands. It acts as the human through the same hub operations the CLI uses.

const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'core/cli.ts'); const realCli = realpathSync(cli);
// This checkout's CLI as a shell word, for the commands a request tells an agent to run.
const cliWord = /^[A-Za-z0-9_\/.:@%+-]+$/.test(realCli) ? realCli : quote(realCli);
// `app` marks an agent that lives in a session the human opened in the Claude Code app or the Codex app: the shell
// does not launch, stop or watch a process for it, and knows it only through the hub.
// `noWindow` marks an agent invited from the page, which shows what it does, so no Terminal window is opened for it.
// `owned` marks a Claude in a session peerloom runs (core/claude-host.ts); every Codex not in the app is owned.
// `external` (item 23): an agent in a harness from core/harnesses.ts that the console does not run; like `app`, it has no
// process here, and it is open exactly while its own wait is armed.
type Agent = { kind: string; agentId?: string; verify?: 'pending' | 'sent' | 'done'; app?: boolean; external?: boolean; owned?: boolean; noWindow?: boolean; model?: string; effort?: string; allow?: boolean; credential: string; participantId: string };
type Saved = { port?: number; room?: { name: string; workspace?: string; objective?: string }; agents: Record<string, Agent> };
type PendingRequest = { name: string; id: string | number; method: string; params: any; lines?: string[] };
type Stream = { write(text: string): unknown; isTTY?: boolean; columns?: number };
export type ShellOptions = {
  cwd?: string; input?: NodeJS.ReadableStream; output?: Stream;
  openTerminal?: (script: string) => void; claude?: string; codexBinary?: string; codex?: AdapterDependencies;
  codexModels?: () => Promise<CodexModel[]>; claudeModels?: () => Promise<CodexModel[]>; upgradeHubData?: typeof upgradeHubData; pollMs?: number; waitSeconds?: number; controlIntervalMs?: number;
  // The browser page (item 17): served from `uiDir`, on unless `web` is false.
  uiDir?: string; web?: boolean;
  // The clock the join service reads (item 24), so a test can expire a join line without waiting.
  now?: () => number;
};

// Where the human's own credential lives (item 24, PRIORITIES 1): outside the workspace agents are pointed at, in a
// folder per room under ~/.agentlink (or AGENTLINK_HOME), keyed by the room folder's real path. This keeps owner material
// out of the files agents work in and out of anything shared from the workspace. It is not isolation: a process running
// as the same user can still read it, and the docs say so.
export function ownerStore(cwd: string) {
  const home = process.env.AGENTLINK_HOME || join(homedir(), '.agentlink');
  return join(home, 'rooms', createHash('sha256').update(join(realpathSync(cwd), '.agentlink')).digest('hex').slice(0, 16));
}

const COMMANDS: [string, string, string][] = [
  ['/help', '', 'Show this list'],
  ['/create-room', '', 'Make the room for this folder'],
  ['/invite', 'claude|codex [NAME]', 'Add an agent: Claude in the Claude Code app or a terminal, Codex in its own session (also /invite-claude, /invite-codex)'],
  ['/start', '[OFFERS [PER_AGENT]]', 'Start a run: from now on agents are offered work, up to these limits'],
  ['/pause', '', 'No new offers; work under way finishes'],
  ['/resume', '', 'Continue a paused run'],
  ['/limits', 'OFFERS [PER_AGENT]', 'Change how often agents may be woken in this run'],
  ['/end', '', 'End the run (asks first)'],
  ['/status', '', 'The run and each agent, briefly'],
  ['/board', '', 'Everything: items, requests, who owes what'],
  ['/send', 'NAME TEXT', 'Message one agent. Plain text goes to all of them, @Name to the ones named'],
  ['/to', 'NAME|all', 'Send plain text to one agent from now on; /to all goes back to everyone'],
  ['/tell', 'NAME TEXT', 'Codex only: speak to its session directly, outside the room'],
  ['/approve', '[ID]', 'Allow, once, a command an agent asked to run (the only one waiting, if no ID)'],
  ['/deny', '[ID]', 'Refuse it (the only one waiting, if no ID); that session then stops'],
  ['/reply', 'ID JSON', 'Answer a native question or an explicit turn-scoped permission request'],
  ['/task', '', 'Give an agent a piece of work, optionally reviewed by another'],
  ['/upgrade', '', 'Upgrade this folder\'s saved data to the current version, after a backup (asks first)'],
  ['/map', '', 'The project map, checked against the workspace'],
  ['/map-update', '[NAME]', 'Ask an agent (a connected one, or the one named) to bring the project map up to date'],
  ['/what-next', '[NAME,NAME]', 'Ask the agents (connected ones, or those named) to look and suggest what to do next'],
  ['/tasks', '', 'List the work and its state'],
  ['/accept', 'REQUEST_ID', 'Accept the answer to something you asked for'],
  ['/relaunch', '[NAME]', 'Open a stopped agent again; for an agent in the app, show the line to type there'],
  ['/trust', 'NAME', 'Let an agent run Peerloom room commands without asking; /untrust NAME takes that back'],
  ['/reoffer', 'NAME', 'Offer an agent its outstanding work again, and reopen it if it had stopped'],
  ['/kill', 'NAME', 'Stop one agent (asks first)'],
  ['/clear', '', 'Clear the screen; nothing is deleted'],
  ['/delete-room', '', 'Stop everything and remove this folder\'s room (asks first)'],
  ['/quit', '', 'Stop the agents and the hub; the room stays on disk'],
];
// The hub says when an agent has work an agent caused that a spent budget holds (item 19); that is shown instead.
const HELD: Record<string, string> = { budget_agent: 'held: this agent\'s budget is spent', budget_room: 'held: the room\'s budget is spent' };
const ARMED: Record<string, string> = { waiting: 'armed, waiting for work', not_armed: 'not armed', disarmed: 'disarmed (too many empty waits)', unknown: 'has not bound yet' };
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
// Refusals the page answers differently, so their codes reach it (item 21); every other refusal is just "refused".
const CONFLICTS = new Set(['upgrade_required', 'stale_revision', 'adoption_conflict', 'open_requests', 'item_closed', 'upgrade_changed', 'reconcile']);
// A run the shell starts. Every message between agents wakes its recipient, so one piece of joint work spends about
// eight offers per agent; the hub's own default of 12 was set when only the human's mail did.
const RUN_LIMITS = { room: 120, agent: 40 };
// What a trusted Codex may run without being asked each time: the room's own verbs, never binding, waiting, run
// controls or membership. Claude gets the equivalent through its session's allow rule.
// What a trusted agent's host may run without asking. The quiet verbs (item 24, slice C) change nothing but what the
// room can see, so they belong here as much as ack does.
const ROOM_VERBS = new Set(['react', 'working', 'blocked', 'done', 'post', 'receipts', 'fetch', 'reply', 'send', 'ack', 'respond', 'request', 'publish', 'suggest', 'map', 'map-edit', 'item-open', 'item-close', 'accept', 'withdraw', 'status', 'room', 'inbox', 'history', 'board', 'item', 'items', 'requests', 'owed', 'awaiting', 'revision', 'capabilities', 'help']);

export async function runShell(options: ShellOptions = {}): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd()); const out: Stream = options.output ?? process.stdout; const tty = !!out.isTTY; const colour = colourful(out);
  const data = join(cwd, '.agentlink'); const credentials = join(data, 'credentials'); const run = join(data, 'run'); const savedPath = join(data, 'shell.json');
  const launch = options.openTerminal ?? openTerminal; const pollMs = options.pollMs ?? 1500;
  type Host = NativeAdapter | ClaudeHost;
  const adapters = new Map<string, Host>(); const approvals = new Map<string, PendingRequest>(); let nextApproval = 0;
  const input = options.input ?? process.stdin;
  // The mark first; then one ticked line per startup step as it finishes (a terminal only).
  heading(out); const tick = checklist(out);

  // ── Input: one queue of lines, read by the command loop and by whatever question a command is asking ──
  // Plain text goes to everyone unless /to set one agent; the prompt shows who.
  let sticky = ''; let approvalsSeen: string[] = [];
  const rl = createInterface({ input, output: tty ? out as any : undefined, terminal: tty, prompt: promptText(colour), history: loadHistory(join(data, 'history')), historySize: HISTORY_SIZE,
    // What is true when Tab is pressed: the crew, enabled harnesses, waiting approvals and requests not yet accepted.
    completer: (line: string) => complete(line, { commands: COMMANDS.map(c => c[0]), agents: Object.keys(saved.agents), harnesses: harnessList().filter(h => h.enabled).map(h => h.id),
      approvals: [...approvals.keys()], requests: (JSON.parse(page.requests) as any[]).filter(r => !r.accepted).map(r => String(r.id ?? r.collabRequestId ?? '')).filter(Boolean) }) });
  rl.on('history', (kept: string[]) => { if (existsSync(data)) saveHistory(join(data, 'history'), kept); });
  const lines: (string | null)[] = []; const waiters: ((line: string | null) => void)[] = []; let idle = false; let closed = false;
  const push = (line: string | null) => { const waiter = waiters.shift(); if (waiter) waiter(line); else lines.push(line); };
  // A wake waits while the human is typing at the prompt, or between pressing Enter and the command acting (so a typed
  // /tell is not overtaken). A question waiting for an answer with nothing typed holds nothing back: the human may be
  // working in the page, and the console's startup question must not stop a room the page reopened.
  let asking = false;
  const syncDraft = () => { for (const adapter of adapters.values()) adapter.setDraft(tty && !closed && ((!idle && !asking) || rl.line.length > 0)); };
  const keypress = () => { queueMicrotask(syncDraft); };
  if (tty) { emitKeypressEvents(input, rl); input.on('keypress', keypress); }
  rl.on('line', line => push(line)); rl.on('close', () => { closed = true; push(null); });
  const nextLine = () => lines.length ? Promise.resolve(lines.shift()!) : new Promise<string | null>(ok => waiters.push(ok));
  // Printed above whatever the human is typing, never through it.
  // Only while the prompt is waiting for a command is there a line to protect; inside a command, output just follows.
  const print = (text = '') => { const redraw = tty && idle && !closed; if (redraw) { clearLine(out as any, 0); cursorTo(out as any, 0); } out.write(`${text}\n`); if (redraw) rl.prompt(true); };
  // While a page action runs a prompt command, what the command says in words is the page's answer too.
  let mirror = false;
  const say = (text = '') => { print(text); if (mirror && plain(text).trim()) notice('info', plain(text).trim()); };
  // ── The page: what this prompt prints, the browser page receives as events, and can read again as a snapshot ──
  let web: Awaited<ReturnType<typeof startWeb>> | undefined;
  const page = { messages: [] as any[], notices: [] as any[], outputs: [] as any[], requests: '[]', activity: '[]', marks: new Map<string, string>(), questions: '{"questions":[],"reviews":[]}', run: '', agents: new Map<string, string>(), noticeId: 0, outputId: 0 };
  const keep = <T>(list: T[], entry: T, size: number) => { list.push(entry); if (list.length > size) list.shift(); return entry; };
  const at = () => new Date().toISOString(); const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');
  const notice = (level: 'info' | 'warn' | 'error', text: string) => web?.emit({ type: 'notice', ...keep(page.notices, { id: ++page.noticeId, level, text: plain(text), at: at() }, 100) });
  const output = (agent: string, text: string) => web?.emit({ type: 'output', ...keep(page.outputs, { id: ++page.outputId, agent, text: plain(text), at: at() }, 100) });
  // A line that only repeats what the page shows in its own form, such as a new approval, is not also a notice.
  const ok = (text: string, toPage = true) => { print(`${green('✔', colour)} ${text}`); if (toPage) notice('info', text); };
  const warn = (text: string, toPage = true) => { print(`${yellow('⚠', colour)} ${text}`); if (toPage) notice('warn', text); };
  const bad = (text: string, toPage = true) => { print(`${red('✖', colour)} ${text}`); if (toPage) notice('error', text); };
  async function ask(question: string, fallback = ''): Promise<string> {
    out.write(`  ${question}${fallback ? dim(` [${fallback}]`, colour) : ''}: `); if (!tty) out.write('\n');
    asking = true; syncDraft(); const line = await nextLine().finally(() => { asking = false; syncDraft(); }); if (line === null) throw new Error('input closed'); return line.trim() || fallback;
  }
  async function choose(question: string, choices: string[], fallback = 0): Promise<string> {
    say(`  ${question}`); choices.forEach((choice, index) => say(`    ${index + 1}) ${choice}`));
    for (;;) { const answer = await ask('Number or name', String(fallback + 1)); const index = /^\d+$/.test(answer) ? Number(answer) - 1 : choices.findIndex(c => c.toLowerCase() === answer.toLowerCase());
      if (choices[index] !== undefined) return choices[index]; if (/^[A-Za-z0-9._:-]{1,64}$/.test(answer) && !/^\d+$/.test(answer)) return answer; say('  Pick one of the numbers, or type a name.'); }
  }
  const confirm = async (question: string, fallback = false) => { const answer = (await ask(`${question} ${fallback ? '[Y/n]' : '[y/N]'}`)).toLowerCase(); return answer ? answer === 'y' || answer === 'yes' : fallback; };

  // ── State on disk ──
  mkdirSync(run, { recursive: true, mode: 0o700 }); mkdirSync(credentials, { recursive: true, mode: 0o700 });
  let saved: Saved = { agents: {} }; try { saved = { agents: {}, ...JSON.parse(readFileSync(savedPath, 'utf8')) }; } catch { /* first launch in this folder */ }
  tick('Initialising workspace');
  const persist = () => saveCredential(savedPath, saved);
  const store = ownerStore(cwd); const ownerPath = join(store, 'owner.json'); const legacyOwner = join(credentials, 'owner.json'); let owner: Credential | null = null;
  let joinJournal: JoinService | undefined;
  const joins = () => joinJournal ??= joinService(join(data, 'joins.json'), { now: options.now });
  const key = () => randomUUID();
  // Paths are shown the way the human would type them from this folder.
  const shownPath = (path: string) => path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
  const hubCall = (op: string, body: any = {}) => { if (!owner) throw new Error('There is no room in this folder yet. /create-room makes one.'); return request(owner, op, body); };

  // ── The hub, in this process ──
  let hub: Awaited<ReturnType<typeof startHub>>;
  async function openHub() {
    mkdirSync(run, { recursive: true, mode: 0o700 }); mkdirSync(credentials, { recursive: true, mode: 0o700 });
    // The hub's administrator credential lives beside the human's, outside the workspace (item 24); a room made before
    // that keeps it in the workspace until this first start moves it, read back before the old copy goes.
    const legacyAdmin = join(data, 'admin.json'); const storedAdmin = join(store, 'admin.json');
    if (existsSync(legacyAdmin)) {
      const old = readFileSync(legacyAdmin, 'utf8'); mkdirSync(store, { recursive: true, mode: 0o700 });
      if (!existsSync(storedAdmin)) { saveCredential(storedAdmin, JSON.parse(old)); if (readFileSync(storedAdmin, 'utf8').trim() !== JSON.stringify(JSON.parse(old), null, 2)) throw new Error('The administrator credential could not be moved intact; nothing was removed.'); }
      else if (JSON.stringify(JSON.parse(readFileSync(storedAdmin, 'utf8'))) !== JSON.stringify(JSON.parse(old))) throw new Error(`There are two different administrator credentials, ${shownPath(legacyAdmin)} and ${storedAdmin}. Keep the one this room was made with and remove the other.`);
      rmSync(legacyAdmin);
    }
    try { hub = await startHub({ dataDir: data, adminDir: store, port: saved.port ?? 0 }); }
    catch (error: any) { if (error.code !== 'EADDRINUSE') throw error; hub = await startHub({ dataDir: data, adminDir: store, port: 0 }); }
    const port = Number(new URL(hub.endpoint).port);
    // Every credential remembers the endpoint it was made on. If the saved port was taken, they are moved to the new one.
    if (saved.port !== undefined && saved.port !== port) for (const file of readdirSync(credentials)) { if (!file.endsWith('.json') || file.includes('.json.')) continue; const path = join(credentials, file);
      try { const value = JSON.parse(readFileSync(path, 'utf8')); if (typeof value.endpoint === 'string') saveCredential(path, { ...value, endpoint: hub.endpoint }); } catch { /* not a credential */ } }
    // A room made before item 24 kept the owner credential in the workspace: it moves out once, read back before the old
    // copy goes, and the store names the room it belongs to so the human can find it.
    if (!existsSync(ownerPath) && existsSync(legacyOwner)) {
      mkdirSync(store, { recursive: true, mode: 0o700 }); saveCredential(ownerPath, credential(legacyOwner)); credential(ownerPath); rmSync(legacyOwner);
      saveCredential(join(store, 'room.json'), { dataDir: data }); ok(`Your credential moved out of the workspace, to ${ownerPath}.`); }
    if (saved.port !== undefined && saved.port !== port && existsSync(ownerPath)) saveCredential(ownerPath, { ...credential(ownerPath), endpoint: hub.endpoint });
    saved.port = port; owner = existsSync(ownerPath) ? credential(ownerPath) : null;
    // The hub is authoritative, including for rooms created before the shell saved a workspace.
    // A previous in-process hub may have just closed on this port. Use one fresh HTTP connection so this
    // startup read cannot reuse its dead fetch keep-alive socket. There is no retry or state mutation here.
    if (owner) { const room = await requestHeld(owner, 'room', {}, 10_000); saved.room = { name: room.name, workspace: room.workspace, ...(room.objective ? { objective: room.objective } : {}) }; }
    persist();
  }
  try { await openHub(); }
  catch (error: any) { if (hub!) await hub.close(); input.off('keypress', keypress); rl.close(); out.write(`${error.code === 'hub_running' ? 'Another peerloom is already running in this folder.' : `The hub could not start: ${clean(error.message)}`}\n`); process.exitCode = 1; return; }

  // ── Agents ──
  const joining = new Map<string, number>(); const announced = new Set<string>(); const seenMail = new Set<string>(); const stoppedQuietly = new Set<string>();
  const stopping = new Set<Host>(); const restarts = new Map<string, symbol>(); let shuttingDown = false;
  const workspace = () => saved.room?.workspace ?? cwd;
  const isDecision = (pending: PendingRequest) => pending.method === 'item/commandExecution/requestApproval' || pending.method === 'item/fileChange/requestApproval' || pending.method === 'claude/toolApproval';
  const cleanDeep = (value: any): any => typeof value === 'string' ? clean(value) : Array.isArray(value) ? value.map(cleanDeep) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanDeep(v)])) : value;
  function hold(id: string, pending: PendingRequest, lines: string[]) {
    pending.lines = lines.map(plain); approvals.set(id, pending);
    web?.emit({ type: 'approval', id, agent: pending.name, kind: isDecision(pending) ? 'approval' : pending.method === 'item/tool/requestUserInput' ? 'answer' : 'permission', method: pending.method, params: cleanDeep(pending.params), lines: pending.lines });
  }
  const drop = (id: string, how: 'approved' | 'denied' | 'answered' | 'resolved' | 'gone') => { if (approvals.delete(id)) web?.emit({ type: 'approval_done', id, how }); };
  const removeRequest = (name: string, nativeId: string | number, how: 'resolved' | 'gone' = 'gone') => { for (const [id, pending] of approvals) if (pending.name === name && pending.id === nativeId) drop(id, how); };
  const replyHint = (id: string, pending: PendingRequest) => isDecision(pending) ? `/approve ${id}   or   /deny ${id}` : pending.method === 'item/tool/requestUserInput' ? `/reply ${id} {"answers":{"QUESTION_ID":{"answers":["your answer"]}}}` : `/reply ${id} {"permissions":{},"scope":"turn"}  (empty permissions grant nothing)`;
  const pidFile = (name: string, suffix = '') => join(run, `${name.toLowerCase()}${suffix}.pid`);
  const owns = (name: string) => !!saved.agents[name] && !saved.agents[name].app && (saved.agents[name].kind === 'codex' || !!saved.agents[name].owned);
  const hostState = (name: string) => `${saved.agents[name].credential}.${saved.agents[name].kind === 'codex' ? 'codex-adapter' : 'claude-host'}.json`;
  // A host's saved session, {} if its file is there but unreadable, null if it has none.
  const savedHost = (name: string) => { if (!existsSync(hostState(name))) return null; try { return JSON.parse(readFileSync(hostState(name), 'utf8')); } catch { return {}; } };
  const running = (name: string) => owns(name) ? adapters.has(name) : saved.agents[name]?.app || saved.agents[name]?.external ? false : alive(pidFile(name));
  // What the folder's Claude Code sessions may run unasked when the human trusts an agent that lives in the app.
  const appRules = () => [`Bash(node ${cli}:*)`, `Bash(node ${quote(cli)}:*)`,
    `Bash(node ${join(root, 'bin/peerloom.mjs')} link:*)`, `Bash(node ${quote(join(root, 'bin/peerloom.mjs'))} link:*)`];
  // Claude Code finds a project skill in .claude/skills; the Codex app in .agents/skills (measured in a plain folder).
  const cursorCommandPath = () => join(workspace(), '.cursor', 'commands', 'agentlink.md');
  const skillPath = (kind: 'claude' | 'codex' = 'claude') => join(workspace(), kind === 'codex' ? '.agents' : '.claude', 'skills', 'agentlink', 'SKILL.md');
  function linkLine(name: string) {
    const kind = saved.agents[name].kind; const others = Object.values(saved.agents).filter(a => a.app && a.kind === kind).length > 1;
    if (kind === 'codex') {
      say(`  In the Codex app, open a chat in ${bold(workspace(), colour)} and write:  ${bold(`$agentlink${others ? ` ${name}` : ''}`, colour)}   ${dim('(or: join the Peerloom room)', colour)}`);
      say(dim(`  It joins as ${name} and listens inside that one turn: the chat is busy while it listens, and it stops by itself after about an hour with no work, and notices a pause or a spent budget within ten minutes. Ask it to stop listening rather than pressing Stop: Stop leaves its wait running for up to ten minutes. Its approvals are Codex's own. This prompt says when it is armed.`, colour));
      return;
    }
    say(`  In the Claude Code app, open a session in ${bold(workspace(), colour)} and type:  ${bold(`/agentlink${others ? ` ${name}` : ''}`, colour)}`);
    say(dim(`  It joins as ${name}, waits in the background and works the room from there. This prompt says when it is armed.`, colour));
  }
  const runState = async () => (await hubCall('run')) as any;

  function claudeBinary() {
    if (options.claude) return options.claude;
    try { return execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8', env: process.env }).trim(); } catch { throw new Error('Claude Code is not on your PATH; install it or start peerloom from a shell where `claude` works'); }
  }
  function startClaude(name: string) {
    const agent = saved.agents[name]; const claude = claudeBinary();
    const made = claudeLauncher({ dir: run, name, cwd: workspace(), claude, model: agent.model, effort: agent.effort, allow: !!agent.allow, clientPath: agent.credential, cli, room: saved.room!.name, path: process.env.PATH ?? '/usr/bin:/bin' });
    launch(made.script); joining.set(name, Date.now());
    say(dim(`  Opening a terminal for ${name}. If its window asks you something first (folder trust, sign-in), answer it there.`, colour));
  }
  // What an owned agent's host reports, Codex's or Claude's: they publish the same events.
  function listen(name: string, resume: boolean, host: () => Host) {
    const agent = saved.agents[name]; const log = join(run, `${name.toLowerCase()}.log`); let first = true; let direct = false;
    return (event: any) => { const adapter = host();
        // The usual request, a Peerloom CLI call on this agent's own credential, is recognised first, so that the log
        // the agent's window follows can say which ones the console answered by itself.
        const names = Object.fromEntries([...Object.entries(saved.agents).map(([n, a]) => [a.participantId, n]), ...(owner?.participantId ? [[owner.participantId, 'human']] : [])]);
        const call = event.event === 'native_request' && event.method === 'item/commandExecution/requestApproval' ? agentlinkCall(event.params?.command, { cli: realCli, clientPath: realpathSync(agent.credential), self: name, names }) : null;
        const auto = !!call && !!agent.allow && !call.warnings.length && ROOM_VERBS.has(call.text.split(' ')[1]);
        try { appendFileSync(log, `${JSON.stringify(auto ? { ...event, auto: true } : event)}\n`, { mode: 0o600 }); } catch { /* the view is a convenience */ }
        // The page's view of this agent is what its window shows, less the approvals, which the page has as its own.
        const line = event.event === 'native_request' ? null : describe(event); if (line) output(name, line.trim());
        if (event.event === 'native_request') {
          removeRequest(name, event.id); const id = String(nextApproval++); const pending = { name, id: event.id, method: event.method, params: event.params };
          const [first, ...details] = nativeRequestLines(event); const kind = isDecision(pending) ? 'approval' : pending.method === 'item/tool/requestUserInput' ? 'an answer' : 'permission';
          // The usual case, a Peerloom CLI call on this agent's own credential, is shown as one short line; anything else in full.
          // Trusted at invite or with /trust: exactly such a call, with nothing odd about it, is answered at once and shown.
          if (call && auto) { say(dim(`  ${name} ran: ${call.text}`, colour)); output(name, `ran: ${call.text}`); queueMicrotask(() => { try { adapter.reply(event.id, { decision: 'accept' }); } catch (error: any) { bad(`${name}'s command could not be allowed: ${clean(error.message)}`); } }); return; }
          if (call) { hold(id, pending, [`${name} wants to run: ${call.text}`, ...call.warnings, ...(event.params?.reason ? [`why: ${clean(event.params.reason)}`] : [])]);
            warn(`${name} wants to run [${id}]: ${call.text}`, false); for (const warning of call.warnings) say(`  ${yellow(warning, colour)}`); if (event.params?.reason) say(dim(`  why: ${clean(event.params.reason)}`, colour)); }
          else { hold(id, pending, [first ?? clean(event.method), ...details]); warn(`${name} needs ${kind} [${id}]: ${first ?? clean(event.method)}`, false); for (const line of details) say(dim(`  ${line}`, colour)); }
          say(dim(`  ${replyHint(id, pending)}`, colour));
        }
        else if (event.event === 'native_request_answered' || event.event === 'native_request_resolved') removeRequest(name, event.id, 'resolved');
        else if (event.event === 'turn_completed') { for (const [id, pending] of approvals) if (pending.name === name && pending.params?.turnId === event.turnId) drop(id, 'gone'); }
        else if (event.event === 'delivery_stopped') stopping.add(adapter);
        else if (event.event === 'binding_unknown') bad(`${name} did not accept the opening: ${clean(event.reason)}`);
        else if (event.event === 'armed' && first) { first = false; ok(resume ? `${name} resumed and is armed.` : `${name} said Ready, joined and is armed. Credential: ${shownPath(agent.credential)}`); }
        else if (event.event === 'turn_started') direct = event.purpose === 'human';
        else if (event.event === 'agent_message' && direct) say(`${bold(name, colour)} ${dim('(its own session)', colour)} › ${clean(event.text)}`);
        else if (event.event === 'stopped') { if (adapters.get(name) === adapter) adapters.delete(name); stopping.delete(adapter); for (const [id, pending] of approvals) if (pending.name === name) drop(id, 'gone');
          // A stop the shell made in order to restart the host on new run controls is not news, and needs no /relaunch.
          if (stoppedQuietly.delete(name)) { /* said already */ } else if (restarts.has(name)) say(dim(`  ${name}'s host restarts on the same session: the run's controls changed.`, colour)); else warn(stoppedText(name, event, savedHost(name))); }
    };
  }
  function begin(name: string, host: Host, start: () => Promise<unknown>) {
    adapters.set(name, host); syncDraft();
    if (!saved.agents[name].noWindow && !alive(pidFile(name, '.view'))) launch(viewLauncher({ dir: run, name, cwd, node: process.execPath, entry: join(root, 'bin/peerloom.mjs'), path: process.env.PATH ?? '/usr/bin:/bin' }).script);
    void start().catch(() => { /* the stopped event has already said why */ });
  }
  function startCodex(name: string, resume: boolean) {
    const agent = saved.agents[name]; let adapter!: NativeAdapter;
    adapter = new NativeAdapter({ clientPath: agent.credential, participant: name, room: saved.room!.name, cwd: workspace(), cliPath: cli, codex: options.codexBinary, model: agent.model, effort: agent.effort, resume,
      waitSeconds: options.waitSeconds, controlIntervalMs: options.controlIntervalMs, onEvent: listen(name, resume, () => adapter) });
    begin(name, adapter, () => adapter.start(options.codex));
  }
  function startOwnedClaude(name: string, resume: boolean) {
    const agent = saved.agents[name]; let host!: ClaudeHost;
    host = new ClaudeHost({ clientPath: agent.credential, participant: name, room: saved.room!.name, cwd: workspace(), cliPath: realCli, claude: claudeBinary(), model: agent.model, effort: agent.effort,
      waitSeconds: options.waitSeconds, resume, onEvent: listen(name, resume, () => host) });
    begin(name, host, () => host.start());
  }
  const startHost = (name: string, resume = existsSync(hostState(name))) => saved.agents[name].kind === 'codex' ? startCodex(name, resume) : startOwnedClaude(name, resume);
  // Codex's host can only start while a run is running, and stops whenever the run's controls change.
  function stopCodexForControl(name: string, adapter: Host, reason: string) {
    stopping.add(adapter); void adapter.halt(reason).catch(error => bad(`${name} could not stop: ${clean(error.message)}`));
  }
  // A human turn may need an answer from this same prompt before it can finish. Schedule the restart without
  // blocking input; only an explicit Start/Resume grants it, and a later Pause/End/Kill/Quit cancels that grant.
  function scheduleCodexRestart(name: string, adapter: Host) {
    const token = Symbol(name); restarts.set(name, token);
    void adapter.finished.then(async () => {
      if (shuttingDown || restarts.get(name) !== token) return;
      const running = (await runState()).state === 'running';
      if (shuttingDown || restarts.get(name) !== token) return;
      restarts.delete(name);
      if (running && !adapters.has(name)) startHost(name);
    }).catch(error => { if (restarts.get(name) === token) { restarts.delete(name); bad(`${name} could not resume: ${clean(error.message)}`); } });
  }
  async function startIdleCodex(restartExisting = false) {
    if ((await runState()).state !== 'running') return;
    // A Claude host's wait simply goes on through new limits; only Codex's host is tied to the run's controls.
    for (const [name, agent] of Object.entries(saved.agents)) if (owns(name)) {
      const adapter = adapters.get(name);
      if (!adapter) startHost(name);
      // A host still stopping from a pause or end is restarted once it has stopped, whatever its kind (GPT, 022-gpt).
      else if (stopping.has(adapter) || (agent.kind === 'codex' && restartExisting)) { scheduleCodexRestart(name, adapter); stopCodexForControl(name, adapter, 'Run controls changed; resuming the same session'); }
    }
  }
  async function stopAgent(name: string, quiet = false) {
    const agent = saved.agents[name]; if (!agent) return;
    restarts.delete(name);
    if (owns(name)) { const adapter = adapters.get(name); if (adapter) { if (quiet) stoppedQuietly.add(name); await adapter.halt('Stopped by human', true); } stopWindow(pidFile(name, '.view')); }
    else { stopWindow(pidFile(name)); joining.delete(name); }
  }
  const stopAll = async () => { for (const name of Object.keys(saved.agents)) await stopAgent(name, true); };

  // From the page every answer comes with the request (`preset`), and the agent always runs in a session peerloom owns.
  // An agent in any other harness the registry enables (item 23): the hub joins it, the console keeps its credential
  // and shows it, and the human starts it in its own session with the line this returns. Nothing here runs it.
  function harnessFor(kind: string) {
    const harness = harnessOf(kind); if (!harness) throw new Error(`There is no harness called ${kind}. ${harnessList().filter(h => h.enabled).map(h => h.id).join(', ')} can be invited.`);
    if (!harness.probe.ok) throw new Error(`${harness.label} cannot be invited yet: ${harness.probe.missing ?? 'it has not been probed'}.`);
    // Only the external route is data; a harness peerloom must host needs a host class first (DeepSeek, 008-deepseek).
    if (!harness.routes.includes('external')) throw new Error(`${harness.label} runs only where peerloom hosts it, and peerloom has no host for it yet.`);
    return harness;
  }
  async function inviteExternal(kind: string, given?: string) {
    if (!owner) throw new Error('Make the room first: /create-room');
    const harness = harnessFor(kind); const base = harness.label.split(/\s+/)[0].replace(/[^A-Za-z0-9_-]/g, '') || 'Agent';
    let name = base; for (let n = 2; saved.agents[name]; n += 1) name = `${base}${n}`; name = given ?? name;
    if (!NAME.test(name)) throw new Error('A name is one word: letters, digits, - or _, starting with a letter'); if (saved.agents[name] || name.toLowerCase() === 'human' || name.toLowerCase() === 'owner') throw new Error(`${name} is already in this room`);
    const invited = await hubCall('invite', { requestId: key(), name, role: 'Builder', harness: harness.hubName });
    const joined = await request({ endpoint: invited.endpoint, token: invited.token }, 'join', { requestId: key(), token: invited.token });
    const path = join(credentials, `${name.toLowerCase()}.json`); saveCredential(path, joined);
    saved.agents[name] = { kind: harness.id, external: true, credential: path, participantId: joined.participantId }; persist();
    const next = `node ${quote(join(root, 'bin/peerloom.mjs'))} link --room ${quote(data)} ${name}`;
    ok(`${name} is invited. In its own session, have it run:  ${bold(next, colour)}`);
    say(dim(`  It prints ${name}'s instructions; ${name} then binds and waits for work by itself. Its approvals are ${harness.label}'s own; the console neither sees nor answers them. Credential: ${shownPath(path)}`, colour));
    joining.set(name, Infinity); project(lastView); return { next };
  }
  // ── One-paste join (item 24, slice B) ──
  // The page makes a join line; a session pastes it and claims it with `peerloom join`; the human approves the pairing
  // code on the page; approval runs the hub's invite and join, writes the agent's profile in the workspace, and the agent
  // is then in the room like any external one. The console keeps no copy of the agent's credential.
  const harnessRefusal = (id: string) => { try { harnessFor(id); return null; } catch (error: any) { return error.message as string; } };
  const freeName = (base: string) => { let name = base; for (let n = 2; saved.agents[name] || name.toLowerCase() === 'human' || name.toLowerCase() === 'owner'; n += 1) name = `${base}${n}`; return name; };
  // A pasted agent works in the room's workspace, which need not be the console's folder: its profile goes there, under
  // the workspace's own .agentlink, and the approved answer names that folder for the client (Codex, seq 55).
  const agentRoot = () => join(saved.room?.workspace ?? cwd, '.agentlink');
  const joinEffects: Effects = {
    chooseName: ({ name, harness }) => name && !saved.agents[name] ? name : freeName((harnessOf(harness)?.label ?? harness).split(/\s+/)[0].replace(/[^A-Za-z0-9_-]/g, '') || 'Agent'),
    agentId: (harness, seed) => {
      const prefix = (harness.toLowerCase().replace(/[^a-z]/g, '') + 'ag').slice(0, 6); const taken = new Set(Object.values(saved.agents).map(a => a.agentId));
      for (let at = 0; at + 4 <= seed.length; at += 4) { const id = `${prefix}-${seed.slice(at, at + 4)}`; if (!taken.has(id)) return id; }
      throw new Error('No free agent id for this join');
    },
    invite: ({ key: requestId, name, harness, ttlSeconds }) => hubCall('invite', { requestId, name, role: 'Builder', harness: harnessFor(harness).hubName, ttlSeconds }),
    join: ({ key: requestId, invited }) => request({ endpoint: invited.endpoint, token: invited.token }, 'join', { requestId, token: invited.token }),
    writeProfile: async profile => { const { writeProfile } = await import('./profiles.ts'); writeProfile(agentRoot(), profile); },
    record: ({ name, harness, participantId, agentId }) => {
      saved.agents[name] = { kind: harness, agentId, verify: 'pending', external: true, credential: join(agentRoot(), 'agents', agentId, 'credential.json'), participantId }; persist();
      joining.set(name, Infinity); project(lastView);
    },
  };
  function joinLine(body: any) {
    if (!owner) throw new Error('Make the room first: /create-room');
    const harness = body.harness === undefined || body.harness === '' ? undefined : harnessFor(String(body.harness)).id;
    const name = body.name === undefined || body.name === '' ? undefined : String(body.name).trim();
    if (name !== undefined && (!NAME.test(name) || saved.agents[name] || ['human', 'owner'].includes(name.toLowerCase()))) throw new Error(`${name} cannot be used: a name is one word, not already in this room`);
    const issued = joins().issue({ name, harness }); const origin = web?.origin ?? 'http://127.0.0.1';
    const line = `peerloom join ${origin}/j/${issued.ticket} --harness ${harness ?? 'HARNESS'}`;
    const ids = harnessList().filter(h => h.enabled && harnessOf(h.id)?.routes.includes('external')).map(h => h.id);
    // Cursor's Agent chat gets a /agentlink command in the room's workspace (item 25), so the human types /agentlink and
    // pastes the URL after it; every other harness gets the sentence.
    if (harness === 'cursor') { mkdirSync(dirname(cursorCommandPath()), { recursive: true }); writeFileSync(cursorCommandPath(), cursorCommand(), { mode: 0o644 }); }
    const paste = harness === 'cursor' ? `/agentlink ${origin}/j/${issued.ticket}`
      : `Join my Peerloom room: run \`${line}\`${harness ? '' : ` with HARNESS replaced by your harness id (${ids.join(', ')})`} and do what it prints. You are done only when you are listening for messages.`;
    web?.emit({ type: 'joins' }); return { line, paste, expiresAt: issued.expiresAt, ticketId: issued.ticketId };
  }
  const joinRoute = {
    help: (origin: string, path: string) => {
      const ids = harnessList().filter(h => h.enabled && harnessOf(h.id)?.routes.includes('external')).map(h => h.id);
      return `This is a Peerloom join line. In the agent's own session, run this one command:\n\n  peerloom join ${origin}${path} --harness HARNESS\n\nwith HARNESS one of: ${ids.join(', ')}. It shows a pairing code for the human to approve, then prints what to do next.\n`;
    },
    act: async (op: 'claim' | 'poll', ticket: string, body: Record<string, unknown>) => {
      const where = (answer: Record<string, unknown>) => answer.state === 'approved' ? { ...answer, workspace: saved.room?.workspace ?? cwd } : answer;
      if (op === 'poll') return where(joins().poll(ticket, body.secret));
      const claimed = joins().claim(ticket, { secret: body.secret, harness: body.harness, label: body.label }, harnessRefusal);
      web?.emit({ type: 'joins' }); return where(claimed);
    },
  };
  async function approveJoin(claimId: string, retry = false) {
    const done = await joins().approve(claimId, joinEffects, { retry }).finally(() => web?.emit({ type: 'joins' }));
    ok(`${done.name} joined. It runs in its own session; it starts listening by itself.`); return done;
  }
  async function invite(kind: 'claude' | 'codex', given?: string, preset?: { model?: string; effort?: string; allow: boolean }) {
    if (!owner) throw new Error('Make the room first: /create-room');
    const base = kind === 'claude' ? 'Claude' : 'Codex'; let fallback = base; for (let n = 2; saved.agents[fallback]; n += 1) fallback = `${base}${n}`;
    const name = given ?? (preset ? fallback : await ask('Name', fallback));
    if (!NAME.test(name)) throw new Error('A name is one word: letters, digits, - or _, starting with a letter'); if (saved.agents[name] || name.toLowerCase() === 'human' || name.toLowerCase() === 'owner') throw new Error(`${name} is already in this room`);
    let model: string | undefined; let effort: string | undefined; let allow: boolean | undefined;
    let app = false;
    if (preset) ({ model, effort, allow } = preset);
    else if (kind === 'claude') {
      const places = ['the Claude Code app: you type /agentlink in a session there', 'a terminal window opened for you']; const place = await choose('Where does it run', places);
      app = place !== places[1] && place.toLowerCase() !== 'terminal';
      if (app) allow = await confirm(`Let ${name} run the Peerloom CLI without asking each time? (adds allow rules for this checkout's CLI to ${shownPath(join(workspace(), '.claude/settings.local.json'))})`, true);
      else {
        model = await choose('Model', ['default', 'opus', 'sonnet', 'haiku', 'fable']); effort = await choose('Effort', ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
        allow = await confirm(`Let ${name} run the Peerloom CLI without asking each time? (this session only; nothing is written to your settings)`, true);
      }
    } else {
      const places = ['a session peerloom owns: it wakes by itself, with a window to watch and approvals here', 'the Codex app: a chat you open there listens for a while, inside one turn']; const place = await choose('Where does it run', places);
      app = place === places[1] || place.toLowerCase() === 'app';
    }
    if (kind === 'codex' && !app && !preset) {
      let models: CodexModel[] = []; try { models = await (options.codexModels ?? (() => codexModels(options.codexBinary, workspace())))(); } catch { say(dim('  Codex did not list its models; type a model name or keep its default.', colour)); }
      model = await choose('Model', ['default', ...models.map(m => m.model)]); const efforts = models.find(m => m.model === model)?.efforts ?? ['low', 'medium', 'high'];
      effort = await choose('Effort', ['default', ...efforts]);
      allow = await confirm(`Let ${name} run Peerloom room commands (fetch, send, respond and the like) without asking each time? Anything else it wants to run still asks`, true);
    }
    const invited = await hubCall('invite', { requestId: key(), name, role: 'Builder', harness: kind === 'claude' ? 'claude-code' : 'codex' });
    const joined = await request({ endpoint: invited.endpoint, token: invited.token }, 'join', { requestId: key(), token: invited.token });
    const path = join(credentials, `${name.toLowerCase()}.json`); saveCredential(path, joined);
    saved.agents[name] = { kind, ...(app ? { app } : {}), ...(preset ? { noWindow: true, ...(kind === 'claude' ? { owned: true } : {}) } : {}), model: model === 'default' ? undefined : model, effort: effort === 'default' ? undefined : effort, allow, credential: path, participantId: joined.participantId }; persist();
    if (app) {
      mkdirSync(join(skillPath(kind), '..'), { recursive: true }); writeFileSync(skillPath(kind), linkSkill(join(root, 'bin/peerloom.mjs'), data, kind), { mode: 0o644 });
      if (kind === 'claude' && allow && !projectAllow(workspace(), appRules(), true)) warn(`${shownPath(join(workspace(), '.claude/settings.local.json'))} is not readable as settings, so no allow rule was added: ${name} will ask before each command.`);
      ok(`${name} is invited. Credential: ${shownPath(path)}`); linkLine(name); joining.set(name, Infinity); return;
    }
    if (kind === 'claude' && !preset) { startClaude(name); return; }
    if ((await runState()).state === 'running') startHost(name, false);
    else ok(`${name} joined the room. Credential: ${shownPath(path)}\n  ${kind === 'codex' ? 'Its Codex session opens when you /start the run: the adapter only waits while a run is running.' : 'Its Claude session opens when you /start the run: peerloom only waits for it while a run is running.'}`);
  }

  // ── What arrives while the human is doing something else ──
  let polling = false; let lastSeen = 0; let primed = !owner; const budgetSaid = new Set<string>(); let quiet = false;
  // Before the hub is closed the prompt stops polling it and lets a poll under way finish. The polls share one
  // kept-alive connection; a request on it while the hub is closing keeps that connection in use, the next poll
  // reuses it before it can go idle, and the hub's close, which waits for every connection, then never ends.
  const quiesce = async () => { quiet = true; while (polling) await new Promise(ok => setTimeout(ok, 5)); };
  async function poll() {
    if (polling || quiet || !owner) return; polling = true;
    try {
      const view = await runState(); project(view);
      for (const [name, since] of joining) {
        const binding = view.bindings.find((b: any) => b.participantId === saved.agents[name]?.participantId);
        if (binding?.armed === 'waiting') { joining.delete(name); ok(`${name} joined and is armed. Credential: ${shownPath(saved.agents[name].credential)}`); }
        else if (Date.now() - since > 120_000) { joining.delete(name); warn(`${name} has not armed after two minutes. Look at its window; /status shows where it is.`); }
      }
      // A spent budget holds an agent's wait silently, and the agent cannot say so: it is the human's to raise.
      if (view.state === 'running') {
        const once = (what: string, text: string, soft = false) => { const mark = `${view.number}:${what}`; if (budgetSaid.has(mark)) return; budgetSaid.add(mark); if (soft) say(dim(`  ${text}`, colour)); else warn(text); };
        const raise = `/limits ${Math.min(500, view.limits.room * 2)} ${Math.min(200, view.limits.agent * 2)} doubles both.`;
        if (view.used.room >= view.limits.room) once(`room:${view.limits.room}`, `This run has used all ${view.limits.room} of its offers on agents' messages to each other: those now wait until you raise the limit; yours still get through. ${raise}`);
        else for (const [name, agent] of Object.entries(saved.agents)) { const used = view.used.agents[agent.participantId] ?? 0;
          if (used >= view.limits.agent) once(`${name}:${view.limits.agent}`, `${name} has been woken ${used} times this run by other agents, its limit: their messages to it now wait until you raise the limit; yours still reach it. ${raise}`);
          else if (view.limits.agent >= 8 && used >= view.limits.agent - 2) once(`${name}:near:${view.limits.agent}`, `${name} has ${view.limits.agent - used} wake${view.limits.agent - used === 1 ? '' : 's'} by other agents left in this run (${used} of ${view.limits.agent}). ${raise}`, true); }
      }
      const fresh = ((await hubCall('inbox')).messages as any[]).filter(m => !seenMail.has(m.id));
      for (const m of fresh) { seenMail.add(m.id); say(`${bold(clean(m.sender?.name ?? '?'), colour)} › ${clean(m.text)}`); }
      if (fresh.length) await hubCall('ack', { requestId: key(), messageIds: fresh.map(m => m.id) });
      // What the agents say to each other, shown so the human can follow it. It is theirs to acknowledge, not the human's.
      const fetched = await hubCall('history', { after: lastSeen, limit: 100 }); const said = fetched.messages as any[];
      // A reopened room does not replay its past at the prompt, however long it is; the page keeps its last 200 messages.
      if (!primed) { for (let batch = fetched; ; batch = await hubCall('history', { after: lastSeen, limit: 500 })) { for (const m of batch.messages) { lastSeen = Math.max(lastSeen, m.sequence); keepMessage(m, false); } if (!batch.hasMore) break; }
        primed = true; said.length = 0; if (page.messages.length) web?.emit({ type: 'reset' }); }
      for (const m of said) { lastSeen = Math.max(lastSeen, m.sequence); keepMessage(m, true); verifiedBy(m); if (m.sender?.kind !== 'agent' || m.messageKind !== undefined || m.recipientIds.includes(owner!.participantId)) continue;
        say(dim(`${clean(m.sender.name)} → ${m.recipientIds.map((id: string) => Object.entries(saved.agents).find(([, a]) => a.participantId === id)?.[0] ?? '?').join(', ')} › ${clean(m.text)}`, colour)); }
      await marks();
      await recommend(); await readMap();
      const owed = (await hubCall('requests', { filter: 'owed_to_me' })).requests as any[];
      const requests = JSON.stringify(owed.map(r => ({ id: r.collabRequestId, title: items.get(r.itemId)?.view.title ?? null, to: (r.respondentIds ?? []).map(nameOf), purpose: r.purpose, text: clean(r.text), state: r.state, accepted: !!r.accepted, targetSuperseded: !!r.targetSuperseded,
        responses: (r.responses ?? []).map((x: any) => ({ from: nameOf(x.respondentId), outcome: x.outcome, ...(x.verdict ? { verdict: x.verdict } : {}), text: clean(x.text) })) })));
      if (requests !== page.requests) { page.requests = requests; web?.emit({ type: 'requests' }); }
      // What agents are waiting on the human for (item 24, slice A): requests whose open slot is the human's.
      const asked = (await hubCall('requests', { filter: 'owed_by_me' })).requests as any[];
      // A review asks for a verdict on an exact revision, which the plain answer form cannot give: it is listed apart, so
      // the page never offers an answer the hub would refuse (Codex, seq 39).
      const entry = (r: any) => ({ id: r.collabRequestId, from: nameOf(r.requesterId), item: items.get(r.itemId)?.view.title ?? null, purpose: r.purpose, text: clean(r.text), at: r.at });
      const questions = JSON.stringify({ questions: asked.filter(r => r.purpose === 'answer' || r.purpose === 'decision').map(entry), reviews: asked.filter(r => r.purpose === 'review').map(r => ({ ...entry(r), target: r.target ?? null })) });
      if (questions !== page.questions) { page.questions = questions; web?.emit({ type: 'questions' }); }
      for (const r of owed) {
        if (r.state === 'open' || announced.has(r.collabRequestId)) continue; announced.add(r.collabRequestId);
        const who = (id: string) => Object.entries(saved.agents).find(([, a]) => a.participantId === id)?.[0] ?? id;
        for (const response of r.responses ?? []) say(`${bold(who(response.respondentId), colour)} ${response.outcome === 'answered' ? 'answered' : 'declined'} ${r.collabRequestId} › ${clean(response.text)}`);
        say(dim(`  /accept ${r.collabRequestId}   records that you accept it`, colour));
      }
    } catch { /* the hub is closing, or a call was refused; the next command will say so */ } finally { polling = false; }
  }
  const timer = setInterval(() => { void poll(); }, pollMs);

  // ── What the page is shown: the same room, as entries that change only when something did ──
  const nameOf = (id: string) => id === owner?.participantId ? 'human' : Object.entries(saved.agents).find(([, a]) => a.participantId === id)?.[0] ?? id;
  function keepMessage(m: any, announce: boolean) {
    // The hub's own ids travel with each message (item 24, slice C), so ticks and reactions attach to the message itself.
    const entry = keep(page.messages, { id: m.id, threadId: m.threadId, sequence: m.sequence, from: m.sender?.id === owner?.participantId ? 'human' : clean(m.sender?.name ?? '?'), to: (m.recipientIds ?? []).map(nameOf), text: clean(m.text), at: m.createdAt,
      kind: m.messageKind === undefined ? 'mail' : m.messageKind, noReply: m.noReply === true, receipts: [] as { to: string; state: string }[], reactions: [] as { by: string; emoji: string }[] }, 200);
    if (announce) web?.emit({ type: 'message', ...entry });
  }
  // Receipts, reactions and working lines (item 24, slice C), for the messages the page holds. The hub derives receipts;
  // the page is told only what changed, by message id, and nothing here is ever sent to an agent.
  async function marks() {
    if (hub.stateVersion < STATE_VERSION || !page.messages.length) return;
    const seen = await hubCall('receipts', { after: Math.max(0, page.messages[0].sequence - 1), limit: 200 });
    const byId = new Map((seen.messages as any[]).map(r => [r.messageId, r]));
    const updates = [];
    for (const entry of page.messages) {
      const r = byId.get(entry.id); if (!r) continue;
      entry.receipts = (r.recipients ?? []).map((x: any) => ({ to: nameOf(x.participantId), state: x.state })); entry.reactions = r.reactions.map((x: any) => ({ by: nameOf(x.by), emoji: x.emoji }));
      const text = JSON.stringify([entry.receipts, entry.reactions]); if (page.marks.get(entry.id) !== text) { page.marks.set(entry.id, text); updates.push({ id: entry.id, receipts: entry.receipts, reactions: entry.reactions }); }
    }
    for (const id of page.marks.keys()) if (!page.messages.some(m => m.id === id)) page.marks.delete(id);
    if (updates.length) web?.emit({ type: 'receipts', updates });
    const activity = JSON.stringify((seen.activity as any[]).map(a => ({ name: nameOf(a.participantId), state: a.state, ...(a.messageId ? { messageId: a.messageId } : {}), ...(a.text ? { text: clean(a.text) } : {}), at: a.at })));
    if (activity !== page.activity) { page.activity = activity; web?.emit({ type: 'activity', activity: JSON.parse(activity) }); }
  }
  const runEntry = (view: any) => view && { number: view.number, state: view.state, limits: { room: view.limits.room, agent: view.limits.agent }, used: { room: view.used.room, agents: Object.fromEntries(Object.entries(view.used.agents ?? {}).map(([id, n]) => [nameOf(id), n])) },
    capacity: view.caps ?? null };
  function agentEntryOf(name: string, view: any) {
    const agent = saved.agents[name]; const binding = view?.bindings?.find((b: any) => b.participantId === agent.participantId); const armed = binding?.armed ?? 'unknown';
    const where = agent.external ? 'external' : agent.app ? 'app' : owns(name) ? 'owned' : 'terminal';
    const session = (agent.app || agent.external ? armed === 'waiting' : running(name)) ? 'open' : 'closed';
    // What can be done with it follows from where it runs, never from its kind (item 23).
    const controls = { stop: where === 'owned' && session === 'open', relaunch: where === 'owned' && session === 'closed', tell: where === 'owned' && session === 'open', settings: where !== 'external' };
    return { name, ...(agent.agentId ? { agentId: agent.agentId } : {}), kind: agent.kind, label: harnessOf(agent.kind)?.label ?? agent.kind, where, model: agent.model ?? null, effort: agent.effort ?? null, trusted: !!agent.allow,
      session, armed, held: binding?.held ?? null, note: null as string | null, controls };
  }
  // Why an agent cannot take work now, in a line beside it; null when it can, or when the budget hold already says why.
  function hostNote(entry: ReturnType<typeof agentEntryOf>, runState: string | undefined) {
    if (entry.held) return null;
    if (entry.where === 'external') return entry.armed === 'waiting' ? null : `It runs in its own session, which peerloom does not run: start its wait there (peerloom link gives it the instructions).`;
    if (entry.where === 'app') return entry.armed === 'waiting' ? null : `It listens only while its chat in the ${entry.kind === 'codex' ? 'Codex' : 'Claude Code'} app is listening: start it there.`;
    if (entry.session === 'closed') return entry.where === 'owned' && runState !== 'running' ? 'Its session opens while the run is running.' : 'Its session is closed: relaunch it to give it work.';
    if (entry.armed === 'disarmed') return 'It stopped waiting after too many empty waits: reoffer it to start again.';
    return entry.armed === 'waiting' ? null : 'Its session is open but not yet waiting for work.';
  }
  // One word for where an agent stands (item 24), in the order that matters to the human: a hold or a waiting approval
  // explains silence before listening does. The join states before `joined` come from the join service.
  function stateOf(entry: ReturnType<typeof agentEntryOf>) {
    if (entry.session === 'closed' && entry.where !== 'external' && entry.where !== 'app') return 'stopped';
    if ([...approvals.values()].some(p => p.name === entry.name)) return 'blocked_approval';
    if (entry.held) return 'held';
    return entry.armed === 'waiting' ? saved.agents[entry.name]?.verify === 'done' ? 'verified' : 'listening' : 'joined';
  }
  function agentEntry(name: string, view: any) { const entry = agentEntryOf(name, view); entry.note = hostNote(entry, view?.state); return { ...entry, state: stateOf(entry) }; }
  // ── What next? and the recommendations it brings (item 21) ──
  // A What next item is the human's discussion item marked with this reference; the hub's own records say who owes it.
  const WHAT_NEXT = { provider: 'agentlink', ref: 'what-next' };
  const WHAT_NEXT_TEXT = 'What next? Please make a read-only assessment of this project: look at the code, the room and its open items, and change nothing. ' +
    `Then propose at most three pieces of work the human should consider, each with this command on your own credential file: node ${cliWord} suggest --client YOUR_CREDENTIAL_FILE --title 'Short title' --text '${PROPOSAL_EXAMPLE}' ` +
    `(the text is the proposal, JSON with exactly those keys; ${PROPOSAL_RULES}) A suggestion starts no work and wakes nobody. ` +
    `Read the project map too (node ${cliWord} map --client YOUR_CREDENTIAL_FILE): a part it is missing or gets wrong may be worth a suggestion. Do not edit the map in this assessment. ` +
    'Outside this request, when work you are given adds, removes or rewires a part of the project, update the map in the same turn with map-edit. ' +
    'Finally answer this request with respond --outcome answered, naming the item ID of each suggestion you posted. None is a valid answer: say so, or respond --outcome declined if you cannot look. Do not start any of the work.';
  const connected = (name: string) => { const entry = agentEntry(name, lastView); return entry.session === 'open' || entry.armed === 'waiting'; };

  // ── The project map (item 22) ──
  // The hub reads and writes agentlink-map.txt; the console shows it, checks it against the workspace when asked (and
  // again when it changes after a first check), and asks a lead to bring it up to date.
  const MAP_UPDATE = { provider: 'agentlink', ref: 'map-update' };
  const MAP_UPDATE_TEXT = 'Update the project map. Read it (map) and the workspace; change nothing except the map, and change the map only with map-edit, never by editing the file. ' +
    'Bring it up to date with the parts that matter (components, services, data stores, the UI, processes, outside systems) and how they connect, citing the main file or folder of each; remove what no longer exists. ' +
    `${mapHelp(verb => `node ${cliWord} ${verb} --client YOUR_CREDENTIAL_FILE`)} ` +
    'Finally answer this request with respond --outcome answered, saying what you added, changed and removed; or respond --outcome declined if you cannot.';
  const UNCHECKED = { state: 'unchecked' as 'unchecked' | 'checking' | 'done', forDigest: null as string | null, forMtimeMs: null as number | null, checkedAt: null as string | null, result: null as string | null, reason: null as string | null, sources: {} as Record<string, unknown>, coverage: null as unknown };
  // first: the digest when this console first read the map, so a hand edit before any agent's edit is still noticed.
  const mapped = { read: null as any, readError: null as string | null, check: { ...UNCHECKED }, update: null as any, errorsSaid: false, first: undefined as string | undefined, ownerName: undefined as string | undefined };
  let mapChecking: AbortController | null = null; let mapShown = '';
  function mapEntry() {
    if (!owner) return null; const read = mapped.read; const last = read?.lastEdit ?? null;
    // The author is whoever the hub authenticated: the owner is "human"; anyone else by the name it joined with (GPT, 012-gpt).
    const by = last ? (last.by === mapped.ownerName ? 'human' : clean(last.by)) : null;
    return { path: read?.path ?? join(workspace(), MAP_FILE), exists: !!read?.exists, digest: read?.digest ?? null, modifiedAt: read?.modifiedAt ?? null, mtimeMs: read?.mtimeMs ?? null,
      nodes: read?.nodes ?? [], flows: read?.flows ?? [], errors: read?.errors ?? [], readError: mapped.readError,
      updatedBy: by, updatedAt: last?.at ?? null, outside: !!read?.exists && (last ? read.digest !== last.digest : mapped.first !== undefined && read.digest !== mapped.first), check: mapped.check, update: mapped.update };
  }
  const emitMap = () => { const text = JSON.stringify(mapEntry()); if (text !== mapShown) { mapShown = text; web?.emit({ type: 'map' }); } };
  async function readMap() {
    if (!owner) return;
    try { const read = await hubCall('map'); const changed = !sameMap(read, mapped.read); mapped.read = read; mapped.readError = null; mapped.first ??= read.digest;
      if (mapped.ownerName === undefined) mapped.ownerName = ((await hubCall('room')).roster as any[]).find(p => p.id === owner!.participantId)?.name ?? '';
      if (!mapped.errorsSaid) { mapped.errorsSaid = true; if (read.errors.length) say(dim(`  The project map has ${read.errors.length} line${read.errors.length === 1 ? '' : 's'} in error; /map shows ${read.errors.length === 1 ? 'it' : 'them'}.`, colour)); }
      // A map that changed after it was checked is checked again; one nobody has looked at is left until someone does.
      if (changed && mapped.check.state !== 'unchecked') checkMapNow();
    } catch (error: any) { if (error?.code === 'hub_unreachable') return; mapped.readError = clean(String(error?.message ?? error).replace(/^[a-z_]+: /, '')); }
    emitMap();
  }
  // One check at a time, bounded by core/map.ts; its result is for the map as it was read when it started.
  // The map a check describes: its bytes, and its write time, which is the baseline "changed" is measured from (GPT, 018-gpt).
  const sameMap = (a: any, b: any) => !!a && !!b && a.digest === b.digest && a.mtimeMs === b.mtimeMs;
  function checkMapNow() {
    if (mapChecking || !mapped.read) return; const read = mapped.read; const controller = new AbortController(); mapChecking = controller;
    mapped.check = { ...mapped.check, state: 'checking' }; emitMap();
    void checkMap(workspace(), read, read.mtimeMs ?? (read.modifiedAt ? Date.parse(read.modifiedAt) : 0), { signal: controller.signal })
      .then(result => { if (mapChecking !== controller) return; mapped.check = { state: 'done', forDigest: read.digest, forMtimeMs: read.mtimeMs ?? null, checkedAt: result.checkedAt, result: result.state, reason: result.reason ?? null, sources: result.sources, coverage: result.coverage }; })
      .catch(error => { if (mapChecking !== controller) return; mapped.check = { ...UNCHECKED, state: 'done', forDigest: read.digest, forMtimeMs: read.mtimeMs ?? null, checkedAt: new Date().toISOString(), result: 'incomplete', reason: clean(String(error?.message ?? error)) }; })
      .finally(() => { if (mapChecking !== controller) return; mapChecking = null; emitMap(); if (mapped.read && !sameMap(mapped.read, read)) checkMapNow(); });
  }
  const forgetMap = () => { mapChecking?.abort(); mapChecking = null; mapped.read = null; mapped.readError = null; mapped.check = { ...UNCHECKED }; mapped.update = null; mapped.errorsSaid = false; mapped.first = undefined; mapped.ownerName = undefined; mapShown = ''; };
  // The latest Update map request and the lead's answer, from the hub's records.
  function mapUpdateFrom(views: any[]) {
    const latest = views.filter(v => v.ownerId === owner!.participantId && v.externalRefs?.some((r: any) => r.provider === MAP_UPDATE.provider && r.ref === MAP_UPDATE.ref)).at(-1);
    const asked = latest?.requests.find((r: any) => r.requesterId === owner!.participantId && r.purpose === 'answer'); const slot = asked?.slots[0];
    mapped.update = asked && slot ? { itemId: latest.itemId, collabRequestId: asked.collabRequestId, lead: nameOf(slot.respondentId), state: LEAD[slot.state] ?? slot.state,
      text: asked.responses.find((x: any) => x.respondentId === slot.respondentId)?.text ?? null, at: asked.at } : null;
    emitMap();
  }
  async function mapUpdate(lead: unknown, press = key()) {
    if (lead !== undefined && lead !== null && lead !== '' && typeof lead !== 'string') throw new Error('lead is an agent\'s name');
    const name = lead ? agentNamed(lead as string) : Object.keys(saved.agents).find(connected);
    if (!name) throw new Error('No agent is connected to ask. Name one, or open one first.');
    const item = await hubCall('item_open', { requestId: `${press}:item`, itemType: 'task', title: 'Update the project map', externalRefs: [MAP_UPDATE] });
    const asked = await hubCall('request', { requestId: `${press}:ask`, itemId: item.itemId, purpose: 'answer', to: [name], text: MAP_UPDATE_TEXT });
    ok(`Asked ${name} to bring the project map up to date (${item.itemId}).`);
    if (lastView?.state !== 'running') say(dim(`  The run is ${lastView?.state ?? 'not started'}: ${name} is asked once it runs.`, colour));
    await recommend(); return { itemId: item.itemId, collabRequestId: asked.collabRequestId, lead: name };
  }
  async function showMap() {
    await readMap(); const map = mapEntry()!; if (!map.exists) { say(`  There is no project map yet at ${shownPath(map.path)}. /map-update asks an agent to start one.`); return; }
    checkMapNow(); for (let waited = 0; mapChecking && waited < 3000; waited += 50) await new Promise(ok => setTimeout(ok, 50));
    const check = mapped.check; const sources = check.sources as Record<string, { state: string }>;
    say(`${bold('Project map', colour)} ${shownPath(map.path)} · ${map.nodes.length} node${map.nodes.length === 1 ? '' : 's'}, ${map.flows.length} flow${map.flows.length === 1 ? '' : 's'}${map.updatedBy ? ` · last changed by ${map.updatedBy}${map.outside ? ', then edited outside Peerloom' : ''}` : ''}`);
    for (const node of map.nodes) say(`  ${node.id.padEnd(16)} ${clean(node.label)} (${node.kind})${node.paths.length ? ` ${dim(node.paths.join(', '), colour)}` : ''}${sources[node.id] && sources[node.id].state !== 'present' && sources[node.id].state !== 'none' ? ` ${yellow(sources[node.id].state, colour)}` : ''}`);
    for (const flow of map.flows) say(`  ${flow.from} → ${flow.to}  ${dim(clean(flow.label), colour)}`);
    for (const error of map.errors) say(`  ${red(`line ${error.line}`, colour)} ${clean(error.reason)}: ${dim(clean(error.text), colour)}`);
    const coverage = check.coverage as any;
    if (check.state === 'done' && coverage) say(dim(`  Checked ${new Date(check.checkedAt!).toLocaleTimeString()}${check.result === 'incomplete' ? ` (incomplete: ${check.reason})` : ''}: ${coverage.uncited} of ${coverage.files} files are cited by no node${coverage.byArea.filter((a: any) => a.uncited).length ? ` (${coverage.byArea.filter((a: any) => a.uncited).map((a: any) => `${a.area} ${a.uncited}`).join(', ')})` : ''}. "changed" means changed since the map was last written.`, colour));
    else say(dim('  The check of cited paths has not finished; /map again shows it.', colour));
  }
  // A press of the page's button keeps its key on a retry; anything else gets a fresh one.
  const pressKey = (given: unknown) => typeof given === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(given) ? given : key();
  async function whatNext(leads: unknown, press = key()) {
    if (leads !== undefined && (!Array.isArray(leads) || leads.some(l => typeof l !== 'string'))) throw new Error('leads is a list of agent names');
    const names = [...new Set((leads as string[] | undefined)?.length ? (leads as string[]).map(agentNamed) : Object.keys(saved.agents).filter(connected))];
    if (!names.length) throw new Error('No agent is connected to ask. Name the agents to ask, or open one first.');
    const item = await hubCall('item_open', { requestId: `${press}:item`, itemType: 'discussion', title: 'What next?', externalRefs: [WHAT_NEXT] });
    const asked = await hubCall('request', { requestId: `${press}:ask`, itemId: item.itemId, purpose: 'answer', to: names, text: WHAT_NEXT_TEXT });
    ok(`Asked ${names.join(', ')} what to do next (${item.itemId}). Their suggestions appear on the page as they come.`);
    if (lastView?.state !== 'running') say(dim(`  The run is ${lastView?.state ?? 'not started'}: they are asked once it runs.`, colour));
    await recommend(); return { itemId: item.itemId, collabRequestId: asked.collabRequestId };
  }
  // Each item's full view is read again only when the hub's summary of it changed.
  const items = new Map<string, { summary: string; view: any }>(); let shown = '';
  const recommended = { whatNext: [] as any[], recommendations: [] as any[] };
  // A revision never changes, so its text is read once.
  const proposals = new Map<string, string>();
  const LEAD: Record<string, string> = { open: 'owed', responded: 'answered', declined: 'declined', withdrawn: 'withdrawn' };
  // A deleted room's items, cards and previews go with it (GPT, 017-gpt).
  const forgetRecommendations = () => { items.clear(); proposals.clear(); previews.clear(); recommended.whatNext = []; recommended.recommendations = []; shown = ''; upgraded = null; };
  async function recommend() {
    if (!owner) return;
    for (const summary of (await hubCall('items')).items as any[]) { const text = JSON.stringify(summary); if (items.get(summary.itemId)?.summary === text) continue;
      items.set(summary.itemId, { summary: text, view: (await hubCall('item', { itemId: summary.itemId })).item }); }
    const views = [...items.values()].map(i => i.view); const suggestions = new Map(views.filter(v => v.itemType === 'suggestion').map(v => [v.itemId, v]));
    recommended.whatNext = views.filter(v => v.itemType === 'discussion' && v.ownerId === owner!.participantId && v.externalRefs?.some((r: any) => r.provider === WHAT_NEXT.provider && r.ref === WHAT_NEXT.ref)).flatMap(v => {
      const asked = v.requests.find((r: any) => r.requesterId === owner!.participantId && r.purpose === 'answer'); if (!asked) return [];
      return [{ itemId: v.itemId, at: v.at, leads: asked.slots.map((slot: any) => { const said = asked.responses.find((x: any) => x.respondentId === slot.respondentId);
        // A lead's suggestions are the ones it names in its answer that are its own.
        const named = said ? [...new Set<string>(said.text.match(/\bit_[A-Za-z0-9_-]+/g) ?? [])].filter(id => suggestions.get(id)?.ownerId === slot.respondentId) : [];
        return { name: nameOf(slot.respondentId), state: LEAD[slot.state] ?? slot.state, suggestionIds: named }; }) }];
    });
    const cards = []; for (const v of suggestions.values()) cards.push(await card(v, views)); recommended.recommendations = cards;
    mapUpdateFrom(views);
    const text = JSON.stringify(recommended); if (text !== shown) { shown = text; web?.emit({ type: 'recommendations' }); }
  }
  const sameTarget = (a: any, b: any) => !!a && !!b && a.artifactId === b.artifactId && a.revision === b.revision && a.digest === b.digest;
  // One card is one suggestion's proposal at its latest revision; positions count only on that exact revision (R3 section 3).
  async function card(v: any, views: any[]) {
    const artifact = v.artifacts[0]; const head = artifact?.revisions.at(-1);
    const target = head ? { artifactId: artifact.artifactId, revision: head.revision, digest: head.contentDigest } : null;
    let payload = null; let payloadError: string | null = 'This suggestion has no proposal.'; let rawText: string | null = null;
    if (target) { const at = `${target.artifactId}:${target.revision}`; if (!proposals.has(at)) proposals.set(at, (await hubCall('revision', { artifactId: target.artifactId, revision: target.revision })).revision.contentInline);
      const text = proposals.get(at)!; ({ payload, error: payloadError } = parseProposal(text)); if (!payload) rawText = text; }
    const positions = v.requests.filter((r: any) => r.purpose === 'review' && sameTarget(r.target, target)).flatMap((r: any) => r.slots.map((slot: any) => {
      const said = r.responses.find((x: any) => x.respondentId === slot.respondentId);
      return { from: nameOf(slot.respondentId), state: slot.state === 'open' ? 'requested' : slot.state === 'responded' ? said?.verdict ?? 'answered' : slot.state, text: said?.text ?? '' }; }));
    // Dropped by its own author is a withdrawal; by the human, a dismissal.
    const disposition = v.state === 'dropped' ? (v.closure.by === v.ownerId ? 'withdrawn' : 'dismissed') : v.state;
    const task = v.adoption && views.find(t => t.itemId === v.adoption.taskItemId)?.requests.find((r: any) => r.collabRequestId === v.adoption.collabRequestId);
    return { itemId: v.itemId, title: v.title, author: nameOf(artifact?.authorId ?? v.ownerId), at: v.at, target, payload, payloadError: payload ? null : payloadError, rawText, positions, disposition,
      ...(v.adoption ? { adoption: { taskItemId: v.adoption.taskItemId, collabRequestId: v.adoption.collabRequestId, assignee: nameOf(v.adoption.assigneeId), target: v.adoption.target, at: v.adoption.at,
        assignment: task ? LEAD[task.slots[0]?.state] ?? task.slots[0]?.state : 'owed' } } : {}),
      ...(disposition === 'dismissed' || disposition === 'withdrawn' ? { dismissal: { by: nameOf(v.closure.by), reason: v.closure.reason, at: v.closure.at } } : {}) };
  }
  async function suggestionNamed(itemId: string) {
    let found = recommended.recommendations.find(r => r.itemId === itemId); if (!found) { await recommend(); found = recommended.recommendations.find(r => r.itemId === itemId); }
    return found ?? (() => { throw new Error(`There is no suggestion ${itemId}.`); })();
  }
  const current = (found: any, given: unknown) => { if (!found.target) throw new Error('This suggestion has no proposal to act on.');
    if (!sameTarget(given, found.target)) throw Object.assign(new Error(`The proposal changed since it was shown; its latest is revision ${found.target.revision}.`), { code: 'stale_revision' }); return found.target; };
  // Ask another agent for its position on the exact revision: a review request of the human's, so it spends no peer budget.
  async function askAbout(itemId: string, lead: unknown, given: unknown, press = key()) {
    const found = await suggestionNamed(itemId); const target = current(found, given); const name = agentNamed(typeof lead === 'string' ? lead : '');
    if (name === found.author) throw new Error(`${name} wrote this suggestion; ask another agent.`);
    const text = `The human asks for your position on the suggestion "${found.title}" (${itemId}) by ${found.author}. Read it with: revision --artifact ${target.artifactId} --revision ${target.revision}. Change nothing. ` +
      `Then respond --outcome answered --verdict approve or changes_requested, with --artifact ${target.artifactId} --revision ${target.revision} --digest ${target.digest} and your reasons in --text; or respond --outcome declined.`;
    const asked = await hubCall('request', { requestId: `${press}:ask`, itemId, purpose: 'review', to: [name], target, text });
    ok(`Asked ${name} for a position on ${itemId}.`); await recommend(); return { collabRequestId: asked.collabRequestId };
  }
  async function dismiss(itemId: string, reason: string, press = key()) {
    if (reason.length > 1000) throw new Error('A reason is at most 1,000 characters.');
    const found = await suggestionNamed(itemId);
    // The same press again reaches the hub, which answers it as it did the first time; any other on a closed card is refused.
    // Whatever is still owed on it is withdrawn first, so that no agent is woken to review a card the human set aside.
    const owed = found.disposition === 'open' ? ((await hubCall('item', { itemId })).item.requests as any[]).filter(r => r.state === 'open') : [];
    for (const r of owed) await hubCall('withdraw', { requestId: `${press}:withdraw:${r.collabRequestId}`, collabRequestId: r.collabRequestId, reason: 'dismissed by the human' });
    try { await hubCall('item_close', { requestId: `${press}:dismiss`, itemId, state: 'dropped', reason }); }
    catch (error) { if (found.disposition !== 'open') throw new Error(`This suggestion is already ${found.disposition}.`); throw error; }
    ok(`Dismissed ${itemId}.`); await recommend(); return { itemId, disposition: 'dismissed' };
  }
  // The human's confirmed task, exactly as previewed: the hub opens the task and its assignment in one step.
  async function adopt(itemId: string, body: any, press = key()) {
    const found = await suggestionNamed(itemId); const target = current(found, body.target); const assignee = agentNamed(typeof body.assignee === 'string' ? body.assignee : '');
    const done = await hubCall('adopt_suggestion', { requestId: `${press}:adopt`, itemId, target, assignee, task: body.task });
    await recommend(); const note = agentEntry(assignee, lastView).note; const held = lastView?.state === 'running' ? null : `The run is ${lastView?.state ?? 'not started'}: ${assignee} is offered the task once it runs.`;
    ok(`Adopted ${itemId}: task ${done.taskItemId} for ${assignee}.`); for (const line of [note, held]) if (line) say(dim(`  ${line}`, colour));
    return { itemId, taskItemId: done.taskItemId, collabRequestId: done.collabRequestId, assignee, note, held };
  }
  // ── Upgrading the workspace data (item 21; R3 section 6) ──
  // Only this console writes the data, so only it upgrades it: with nothing in flight, its hub closed, and the hub's own
  // backup, check and replace; then the hub is opened again on the result (or, if it failed, on the data as it was).
  let upgrading = false; let upgraded: { press: string; result: any } | null = null;
  // Agents waiting on the hub that this console does not own: the upgrade ends their waits.
  const outside = () => Object.keys(saved.agents).filter(name => !owns(name) && (saved.agents[name].app || saved.agents[name].external ? agentEntry(name, lastView).armed === 'waiting' : running(name)));
  // The hub writes its data as it works, so the bytes a preview was taken from are soon gone. The human confirms what a
  // preview said (the version, the rooms, the file and its backup); that is what must be unchanged once the hub is closed.
  const facts = (found: ReturnType<typeof inspectHubUpgrade>) => JSON.stringify([found.fromVersion, found.toVersion, found.statePath, found.backupPath, found.rooms]);
  const previews = new Map<string, string>();
  const upgradePreview = () => { const found = inspectHubUpgrade({ dataDir: data }); if (found.sourceDigest) previews.set(found.sourceDigest, facts(found));
    return { ...found, restarts: Object.keys(saved.agents).filter(name => owns(name) && running(name)), interrupts: outside() }; };
  const changed = () => Object.assign(new Error('The workspace data changed since the preview; look at a new preview.'), { code: 'upgrade_changed' });
  const they = (names: string[], one: string, many: string) => `${names.join(' and ')} ${names.length === 1 ? one : many}`;
  const digestOf = (path: string) => { try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; } };
  async function upgradeData(expectedDigest: unknown, press = key(), atPrompt = false) {
    if (upgraded?.press === press) return upgraded.result;
    // A command typed at the console that has not finished (it may be waiting at one of its questions) could go on to
    // start an agent under the upgrade, so the page's upgrade waits for it (GPT, 015-gpt). The console's own /upgrade is that command.
    if (!idle && !atPrompt) throw new Error('A command at the console is still under way (it may be asking something there): finish it first, then upgrade.');
    const preview = upgradePreview(); if (!preview.needed) throw new Error(`The workspace data is already version ${preview.fromVersion}; there is nothing to upgrade.`);
    const shown = typeof expectedDigest === 'string' ? previews.get(expectedDigest) : undefined; if (!shown || shown !== facts(preview)) throw changed();
    const asking = [...new Set([...approvals.values()].map(pending => pending.name))];
    if (asking.length) throw new Error(`${they(asking, 'is', 'are')} waiting for your answer: answer or deny ${asking.length === 1 ? 'it' : 'them'} first, then upgrade.`);
    // A host in a turn, or about to start one, is left to finish (GPT, 011-gpt).
    const busy = preview.restarts.filter(name => adapters.get(name)?.busy);
    if (busy.length) throw new Error(`${they(busy, 'is', 'are')} in the middle of a turn: let it finish, or stop it, then upgrade.`);
    // From the check above to these halts nothing waits, so no turn can start in between: a wake that comes later finds
    // its host stopping, and its work stays offered.
    upgrading = true; restarts.clear(); const halts = preview.restarts.map(name => stopAgent(name, true));
    try {
      await Promise.all(halts); await quiesce(); await hub.close();
      let result: any; let failure: any; let closed: ReturnType<typeof inspectHubUpgrade> | undefined;
      try { closed = inspectHubUpgrade({ dataDir: data }); if (facts(closed) !== shown) throw changed(); result = (options.upgradeHubData ?? upgradeHubData)({ dataDir: data, adminDir: store, expectedDigest: closed.sourceDigest }); } catch (error) { failure = error; }
      // Only data proved to be the bytes it was before the attempt is said to be unchanged (GPT, 011-gpt).
      const kept = !!failure && !!closed?.sourceDigest && digestOf(preview.statePath) === closed.sourceDigest;
      const backup = preview.backupPath && existsSync(preview.backupPath) && (!failure || !kept) ? preview.backupPath : null;
      try { await openHub(); } catch (error: any) { bad(`The hub could not open again: ${clean(error.message)}.${backup ? ` The data as it was is kept at ${shownPath(backup)}.` : ''} Quit, look at ${shownPath(preview.statePath)}, and start peerloom again.`); throw error; }
      quiet = false; web?.emit({ type: 'reset' });
      // Agents come back on their sessions only onto data known to be good, and only while the run runs (a pause stays).
      if ((!failure || kept) && (await runState()).state === 'running') for (const name of preview.restarts) if (!adapters.has(name)) startHost(name, true);
      if (failure) { const why = clean(String(failure.message).replace(/^[a-z_]+: /, '')).replace(/([^.])$/, '$1.');
        throw Object.assign(new Error(kept ? `The upgrade did not happen: ${why} The data is as it was, and the room is open again.`
          : `The upgrade stopped with an error: ${why} The data now reads as version ${hub.stateVersion}${backup ? `, and the data as it was is kept at ${shownPath(backup)}` : ''}. Check it before relaunching${preview.restarts.length ? ` ${preview.restarts.join(', ')}` : ' any agent'}.`), { code: failure.code, detail: failure.detail }); }
      ok(`Workspace data upgraded from version ${result.fromVersion} to ${result.toVersion}. The data as it was is kept at ${shownPath(result.backupPath)}.`);
      if (preview.interrupts.length) warn(`${they(preview.interrupts, 'was', 'were')} waiting on the hub, and the upgrade ended that wait: start ${preview.interrupts.length === 1 ? 'it' : 'them'} listening again.`);
      upgraded = { press, result: { ...result, restarted: preview.restarts, interrupted: preview.interrupts } }; return upgraded.result;
    } finally { upgrading = false; }
  }
  let lastView: any = null;
  // The one round trip that proves a pasted agent hears the room (item 24): once it first listens, it gets one welcome
  // from the human asking for one line back, and its first message in the room marks it verified. Sent once, keyed, so
  // a restart does not send it again; nothing more is asked of it.
  function welcome(view: any) {
    for (const [name, agent] of Object.entries(saved.agents)) {
      if (agent.verify !== 'pending' || agentEntryOf(name, view).armed !== 'waiting' || view?.state !== 'running') continue;
      agent.verify = 'sent'; persist();
      void hubCall('send', { requestId: `verify-${agent.agentId}`, to: agent.participantId, text: `Welcome to ${saved.room?.name ?? 'the room'}. Reply with one line to say you can hear the room; nothing else is needed.` })
        .catch((error: any) => { agent.verify = 'pending'; persist(); warn(`The welcome to ${name} could not be sent: ${clean(error.message)}`); });
    }
  }
  function verifiedBy(m: any) {
    const found = Object.entries(saved.agents).find(([, a]) => a.participantId === m.sender?.id && a.verify === 'sent'); if (!found) return;
    found[1].verify = 'done'; persist(); ok(`${found[0]} is verified: it answered in the room.`); project(lastView);
  }
  function project(view: any) {
    welcome(view);
    lastView = view; const run = JSON.stringify(runEntry(view)); if (run !== page.run) { page.run = run; web?.emit({ type: 'run', ...runEntry(view) }); }
    for (const name of Object.keys(saved.agents)) { const entry = agentEntry(name, view); const text = JSON.stringify(entry); if (page.agents.get(name) !== text) { page.agents.set(name, text); web?.emit({ type: 'agent', ...entry }); } }
  }
  const snapshot = async () => {
    const view = owner ? await runState().catch(() => lastView) : null;
    return { defaults: { workspace: workspace() }, room: owner && saved.room ? { name: saved.room.name, workspace: saved.room.workspace ?? cwd, objective: saved.room.objective ?? null } : null,
      run: owner ? runEntry(view) : null, agents: Object.keys(saved.agents).map(name => agentEntry(name, view)),
      approvals: [...approvals].map(([id, pending]) => ({ id, agent: pending.name, kind: isDecision(pending) ? 'approval' : pending.method === 'item/tool/requestUserInput' ? 'answer' : 'permission', method: pending.method, params: cleanDeep(pending.params), lines: pending.lines ?? [] })),
      messages: page.messages, requests: JSON.parse(page.requests), needsYou: JSON.parse(page.questions), activity: JSON.parse(page.activity), joins: owner ? joins().pending() : [], notices: page.notices, outputs: page.outputs, whatNext: recommended.whatNext, recommendations: recommended.recommendations, map: mapEntry(), harnesses: harnessList(),
      storeVersion: hub.stateVersion, upgrade: { needed: hub.stateVersion < STATE_VERSION } };
  };
  // The page's actions are the prompt's commands without their questions: every answer comes with the request.
  async function act(path: string, body: any): Promise<any> {
    const text = (value: unknown, what: string) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${what} is required`); return value.trim(); };
    if (shuttingDown) throw Object.assign(new Error('peerloom is stopping'), { status: 503, code: 'closing' });
    if (upgrading) throw Object.assign(new Error('peerloom is upgrading its data; try again in a moment'), { status: 503, code: 'upgrading' });
    const [first, second, verb] = path.split('/');
    const prompt = async (line: string) => { mirror = true; try { await handle(line); } finally { mirror = false; } };
    try {
      if (first === 'room' && !second) { await createRoom(text(body.name, 'A name'), text(body.workspace, 'A workspace'), typeof body.objective === 'string' ? body.objective.trim() : ''); return; }
      if (first === 'invite' && !second) { if (typeof body.kind !== 'string') throw new Error('kind is a harness id'); if (body.kind !== 'claude' && body.kind !== 'codex') return await inviteExternal(body.kind, text(body.name, 'A name')); await invite(body.kind, text(body.name, 'A name'), { model: body.model || undefined, effort: body.effort || undefined, allow: body.trusted === true }); return; }
      if (first === 'send' && !second) {
        const to = body.to === undefined ? undefined : Array.isArray(body.to) ? (body.to.length ? [...new Set(body.to.map((n: unknown) => agentNamed(text(n, 'to'))))] : (() => { throw new Error('to names at least one agent'); })()) : agentNamed(text(body.to, 'to'));
        if (body.noReply !== undefined && typeof body.noReply !== 'boolean') throw new Error('noReply is true or false'); if (body.post !== undefined && typeof body.post !== 'boolean') throw new Error('post is true or false');
        if (body.noReply && body.post) throw new Error('A post never asks for a reply; choose one');
        await sendText(text(body.text, 'Text'), to, { noReply: body.noReply === true, post: body.post === true }, pressKey(body.key)); return; }
      // The human's own reaction on a message (item 24, slice C): it wakes nobody.
      if (first === 'react' && !second) { if (hub.stateVersion < STATE_VERSION) throw Object.assign(new Error('Reactions need this room\'s data upgraded: /upgrade shows what that does.'), { code: 'upgrade_required' });
        return { reaction: await hubCall('react', { requestId: pressKey(body.key), messageId: text(body.messageId, 'messageId'), emoji: text(body.emoji, 'emoji'), ...(body.on === false ? { on: false } : {}) }) }; }
      if (first === 'approvals' && second && !verb) { await answer(second, body.result !== undefined ? { result: body.result } : { decision: body.decision === 'accept' ? 'accept' : body.decision === 'decline' ? 'decline' : (() => { throw new Error('decision is accept or decline'); })() }); return; }
      if (first === 'run' && !second) { const ops: Record<string, Parameters<typeof control>[0]> = { start: 'run_start', pause: 'run_pause', resume: 'run_resume', end: 'run_end', limits: 'run_limits' }; const op = ops[body.op];
        if (!Object.hasOwn(ops, body.op)) throw new Error('op is start, pause, resume, end or limits'); const limits = body.limits === undefined ? (op === 'run_start' ? RUN_LIMITS : undefined) : limitsFrom(`${body.limits.room ?? ''} ${body.limits.agent ?? ''}`);
        if (op === 'run_limits' && !limits) throw new Error('limits are required'); await control(op, { run_start: 'started', run_pause: 'paused', run_resume: 'resumed', run_end: 'ended', run_limits: 'now has new limits' }[op], limits); return; }
      if (first === 'agents' && second && verb && !path.split('/')[3]) { const name = agentNamed(decodeURIComponent(second));
        if (saved.agents[name].external && ['stop', 'relaunch', 'tell', 'trust'].includes(verb)) throw new Error(notOurs(name));
        if (verb === 'stop') { if (!running(name)) throw new Error(`${name} is not open`); await stopAgent(name, true); ok(`${name} stopped.`); project(lastView); return; }
        if (verb === 'relaunch') { await prompt(`/relaunch ${name}`); return; }
        if (verb === 'trust') { await prompt(`/${body.trusted === true ? 'trust' : 'untrust'} ${name}`); project(lastView); return; }
        if (verb === 'tell') { await prompt(`/tell ${name} ${text(body.text, 'Text')}`); return; } }
      if (first === 'what_next' && !second) return await whatNext(body.leads, pressKey(body.requestId));
      if (first === 'map' && second === 'check' && !verb) { if (!owner) throw new Error('There is no room in this folder yet.'); if (!mapped.read) await readMap(); checkMapNow(); return { map: mapEntry() }; }
      if (first === 'map' && second === 'update' && !verb) return await mapUpdate(body.lead, pressKey(body.requestId));
      if (first === 'upgrade' && !second) return body.confirm === true ? await upgradeData(body.expectedDigest, pressKey(body.requestId)) : { preview: upgradePreview() };
      if (first === 'suggestions' && second && verb && !path.split('/')[3]) { const itemId = decodeURIComponent(second); const press = pressKey(body.requestId);
        if (verb === 'ask') return await askAbout(itemId, body.lead, body.target, press);
        if (verb === 'dismiss') return await dismiss(itemId, text(body.reason, 'A reason'), press);
        if (verb === 'adopt') return await adopt(itemId, body, press); }
      if (first === 'join-line' && !second) return joinLine(body);
      if (first === 'join-approve' && !second) return { join: await approveJoin(text(body.claimId, 'claimId'), body.retry === true) };
      if (first === 'join-refuse' && !second) { const refused: any = joins().refuse(text(body.claimId, 'claimId')); web?.emit({ type: 'joins' });
        if (refused.kept?.participantId) warn(`${refused.kept.name} was refused after the hub had already made it; it stays in the room's roster with no credential anywhere but the hub's own record.`);
        return { join: refused }; }
      if (first === 'answer' && !second) { if (!owner) throw new Error('There is no room in this folder yet.');
        const outcome = body.outcome === 'declined' ? 'declined' : body.outcome === 'answered' || body.outcome === undefined ? 'answered' : (() => { throw new Error('outcome is answered or declined'); })();
        const asked = JSON.parse(page.questions).reviews.find((r: any) => r.id === body.requestId);
        if (asked) throw new Error('That is a review: it needs a verdict on the exact revision, which the answer form cannot give. Open it in Work.');
        return { response: await hubCall('respond', { requestId: pressKey(body.key), collabRequestId: text(body.requestId, 'requestId'), outcome, text: text(body.text, 'An answer') }) }; }
      if (first === 'accept' && !second) { await prompt(`/accept ${text(body.requestId, 'requestId')}`); return; }
    // The hub's own status is not the page's: a hub 401 is not the page's key being wrong. Only "no answer" is told apart.
    } catch (error: any) { const message = clean(String(error?.message ?? 'That did not work').replace(/^[a-z_]+: /, ''));
      throw Object.assign(new Error(message), error?.code === 'hub_unreachable' ? { status: 502, code: 'hub_unreachable' } : CONFLICTS.has(error?.code) ? { status: 409, code: error.code, ...(error.detail !== undefined ? { detail: error.detail } : {}) } : { status: 400, code: 'refused' }); }
    throw Object.assign(new Error(`${path} is not something the page can do`), { status: 404, code: 'unknown_action' });
  }
  // The prompt runs one command at a time and the page must too: two clicks must not both pass a check before either acts.
  let acting: Promise<unknown> = Promise.resolve();
  const actOnce = (path: string, body: any) => { const turn = acting.then(() => act(path, body)); acting = turn.catch(() => {}); return turn; };
  // Each harness's own list, or none: the page then offers its default and a free field, never a guessed catalogue.
  const models = async (kind: string | null) => ({ models: kind === 'codex' ? await (options.codexModels ?? (() => codexModels(options.codexBinary, workspace())))().catch(() => [])
    : kind === 'claude' ? await (options.claudeModels ?? (() => claudeModels(claudeBinary(), workspace())))().catch(() => []) : [] });

  // ── Commands ──
  const split = (text: string) => { const at = text.indexOf(' '); return at === -1 ? [text, ''] : [text.slice(0, at), text.slice(at + 1).trim()]; };
  const notOurs = (name: string) => `${name} runs in its own session (${harnessOf(saved.agents[name].kind)?.label ?? saved.agents[name].kind}), which peerloom does not run: it cannot stop, relaunch or speak to it directly. /send reaches it; /pause stops new work reaching it.`;
  // Exact names wherever a wrong guess would grant, stop or assign; a unique prefix only for who hears a message.
  const agentNamed = (text: string) => { const found = resolveName(text, Object.keys(saved.agents), { prefix: false }); if ('error' in found) throw new Error(found.error); return found.name; };
  const agentPicked = (text: string) => { const found = resolveName(text, Object.keys(saved.agents)); if ('error' in found) throw new Error(found.error); return found.name; };
  async function status() {
    if (!owner) { say('No room in this folder yet. /create-room makes one.'); return; }
    const view = await runState(); say(`${bold(saved.room!.name, colour)} · run ${view.number} ${view.state} · offers used ${view.used.room} of ${view.limits.room}`);
    if (!Object.keys(saved.agents).length) say(dim('  No agents yet. /invite claude or /invite-codex.', colour));
    for (const [name, agent] of Object.entries(saved.agents)) { const binding = view.bindings.find((b: any) => b.participantId === agent.participantId);
      say(`  ${name.padEnd(12)} ${agent.kind.padEnd(7)} ${(agent.app ? 'in the app' : agent.external ? 'its own harness' : agent.model ?? 'default model').padEnd(16)} ${agent.app || agent.external ? 'its own session' : running(name) ? 'session open' : 'session closed'} · ${HELD[binding?.held] ?? ARMED[binding?.armed ?? 'unknown']}`); }
    for (const [id, pending] of approvals) warn(`${pending.name} is waiting for ${replyHint(id, pending)}`);
  }
  // "OFFERS [PER_AGENT]" as typed after /start or /limits; nothing typed leaves the choice to the caller.
  function limitsFrom(text: string, fallback?: { room: number; agent: number }) {
    const [room, agent, extra] = text.split(/\s+/).filter(Boolean); if (!room) { if (fallback) return fallback; throw new Error('Use /limits OFFERS [PER_AGENT], for example /limits 200 60'); }
    if (extra || ![room, agent ?? '1'].every(value => /^\d{1,3}$/.test(value) && Number(value) >= 1)) throw new Error('Limits are whole numbers: offers for the whole run (up to 500), then per agent (up to 200)');
    return { room: Number(room), ...(agent ? { agent: Number(agent) } : {}) };
  }
  async function control(op: 'run_start' | 'run_pause' | 'run_resume' | 'run_end' | 'run_limits', done: string, limits?: { room: number; agent?: number }) {
    const result = await hubCall(op, { requestId: key(), ...(limits ? { limits } : {}) });
    ok(`Run ${result.number} ${done}${op === 'run_start' || op === 'run_limits' ? ` (${result.limits.room} offers, ${result.limits.agent} per agent).` : '.'}`); if (op === 'run_start') say(dim('  /limits OFFERS [PER_AGENT] changes that while it runs.', colour));
    if (op === 'run_start' || op === 'run_resume' || op === 'run_limits' && result.state === 'running') await startIdleCodex(true);
    else if (op === 'run_limits') { /* paused: the agents start again on /resume */ }
    else { restarts.clear(); for (const [name, adapter] of adapters) stopCodexForControl(name, adapter, `the run is ${result.state}`); }
  }
  // A page action under way finishes before the agents stop, and none starts after: it could otherwise open an agent that outlives the console.
  async function quit() { mapChecking?.abort(); shuttingDown = true; restarts.clear(); clearInterval(timer); await quiesce(); await acting.catch(() => {}); await web?.close(); await stopAll(); await hub.close(); }
  // Fenced, not only checked: the page and the prompt can both ask, and both would pass the check before either acts.
  let creatingRoom = false;
  async function createRoom(name: string, given: string, objective: string) {
    if (owner || creatingRoom) throw new Error(`This folder already has the room "${saved.room?.name ?? name}". /delete-room removes it.`);
    creatingRoom = true; try { await makeRoom(name, given, objective); } finally { creatingRoom = false; }
  }
  async function makeRoom(name: string, given: string, objective: string) {
    const workspace = realpathSync(resolve(cwd, given)); if (!statSync(workspace).isDirectory()) throw new Error('Workspace must be a directory');
    const admin = credential(hub.adminPath); const made = await request({ ...admin, endpoint: hub.endpoint }, 'create', { requestId: key(), name, workspace, ...(objective ? { objective } : {}) });
    mkdirSync(store, { recursive: true, mode: 0o700 }); saveCredential(join(store, 'room.json'), { dataDir: data }); saveCredential(ownerPath, made); owner = credential(ownerPath); saved.room = { name, workspace, ...(objective ? { objective } : {}) }; saved.agents = {}; persist();
    ok(`Room "${clean(name)}" created. Your credential: ${shownPath(ownerPath)}`); web?.emit({ type: 'room', name, workspace, objective: objective || null });
    // The project map starts as a template in the workspace; a map already there, or anything else by that name, is left alone.
    try { writeFileSync(join(workspace, MAP_FILE), MAP_TEMPLATE, { flag: 'wx', mode: 0o644 }); say(dim(`  Project map: ${shownPath(join(workspace, MAP_FILE))} (the agents keep it current; you can edit it too).`, colour)); }
    catch (error: any) { say(dim(error.code === 'EEXIST' ? `  Project map: ${shownPath(join(workspace, MAP_FILE))} is already there and is used as it is.` : `  The project map template could not be written (${clean(error.code ?? error.message)}); the agents can still start one.`, colour)); }
  }
  // `to` is one name, several (the page's @mentions), or none for every agent. A post is room text that wakes nobody;
  // noReply says the mail needs no answer (item 24, slice C).
  async function sendText(text: string, to?: string | string[], options: { noReply?: boolean; post?: boolean } = {}, requestId = key()) {
    const names = to === undefined ? [] : Array.isArray(to) ? to : [to];
    if (!names.length && !Object.keys(saved.agents).length) throw new Error('Nobody is in the room to hear that. /invite an agent first; /help lists commands.');
    if ((options.noReply || options.post) && hub.stateVersion < STATE_VERSION) throw Object.assign(new Error('Posts and "no reply needed" need this room\'s data upgraded: /upgrade shows what that does.'), { code: 'upgrade_required' });
    await hubCall('send', { requestId, ...(names.length ? { to: names.length === 1 ? names[0] : names } : {}), text, ...(options.noReply ? { noReply: true } : {}), ...(options.post ? { post: true } : {}) });
    say(dim(`  ${options.post ? 'posted' : 'sent'} ${names.length ? `to ${names.join(', ')}` : 'to everyone'}${options.noReply ? ', no reply needed' : ''}`, colour));
  }
  // An approval, or an explicit answer, given once to the agent that asked, from the prompt or the page.
  async function answer(id: string, given: { decision: 'accept' | 'decline' } | { result: unknown }) {
    const pending = approvals.get(id); if (!pending) throw new Error('Nothing is waiting with that id.');
    if ('decision' in given && !isDecision(pending)) throw new Error(`This request needs an explicit response: ${replyHint(id, pending)}`);
    // Taken out first: the agent's own "answered" event can arrive inside reply(), and must not be what the page is told.
    const { name } = pending; const adapter = adapters.get(name);
    if (!adapter) { drop(id, 'gone'); throw new Error(`${name}'s session is not open, so its request is gone.`); }
    // An answer the adapter refuses as malformed was never sent, so the request stays open for a correct one; it is put
    // back only while the same session holds it, never into one that stopped meanwhile.
    approvals.delete(id); try { adapter.reply(pending.id, 'decision' in given ? { decision: given.decision } : given.result); }
    catch (error) { if (adapters.get(name) === adapter) approvals.set(id, pending); else web?.emit({ type: 'approval_done', id, how: 'gone' }); throw error; }
    web?.emit({ type: 'approval_done', id, how: 'decision' in given ? given.decision === 'accept' ? 'approved' : 'denied' : 'answered' });
    say(dim('result' in given ? `  answered once for ${name}` : given.decision === 'accept' ? `  approved once for ${name}` : adapter instanceof ClaudeHost ? `  refused; ${name} goes on without it.` : `  refused; ${name} stops now. /relaunch ${name} opens it again.`, colour));
  }

  async function handle(line: string): Promise<boolean> {
    if (!line.trim()) return true;
    line = expandAlias(line.trimStart());
    // An upgrade from the page has stopped the hosts and closed the hub: nothing typed here may start anything meanwhile.
    if (upgrading) throw new Error('peerloom is upgrading its data; try again in a moment.');
    if (!line.startsWith('/')) { const route = routeLine(line, Object.keys(saved.agents), sticky); await sendText(route.text, route.to?.map(agentPicked)); return true; }
    const [command, rest] = split(line.trim());
    switch (command) {
      case '/help': say(bold('Commands', colour)); for (const [name, args, about] of COMMANDS) say(`  ${`${name} ${args}`.padEnd(30)} ${dim(about, colour)}`); say(dim('  Anything typed without a slash goes to every agent, or to those it @mentions, or to the /to recipient.', colour)); say(dim('  Short forms: /s send, /a approve, /d deny, /st status, /i invite, /p pause, /q quit. Tab completes commands, names and IDs.', colour)); break;
      case '/create-room': {
        if (owner) throw new Error(`This folder already has the room "${saved.room?.name}". /delete-room removes it.`);
        const name = await ask('Name', basename(cwd)); const workspace = await ask('Workspace', cwd); const objective = await ask('Objective (optional)');
        await createRoom(name, workspace, objective); say(dim('  Next: /invite claude, /invite-codex, then /start.', colour)); break;
      }
      case '/invite': { const [kind, name] = split(rest); if (!kind) throw new Error(`Use /invite HARNESS [NAME]: ${harnessList().filter(h => h.enabled).map(h => h.id).join(', ')}`); if (kind !== 'claude' && kind !== 'codex') { await inviteExternal(kind, name || undefined); break; } await invite(kind, name || undefined); break; }
      case '/invite-claude': await invite('claude', rest || undefined); break;
      case '/invite-codex': await invite('codex', rest || undefined); break;
      case '/start': await control('run_start', 'started', limitsFrom(rest, RUN_LIMITS)); break;
      case '/limits': await control('run_limits', 'now has new limits', limitsFrom(rest)); break;
      case '/pause': await control('run_pause', 'paused'); break;
      case '/resume': await control('run_resume', 'resumed'); break;
      case '/end': if (await confirm('End the run? Offers not yet taken up are closed.')) await control('run_end', 'ended'); else say('  Left as it was.'); break;
      case '/status': await status(); break;
      case '/board': case '/tasks': say(await board(owner ?? (() => { throw new Error('There is no room in this folder yet. /create-room makes one.'); })())); break;
      case '/send': { const [who, text] = split(rest); if (!text) throw new Error('Use /send NAME TEXT'); await sendText(text, agentPicked(who)); break; }
      case '/tell': { const [who, text] = split(rest); if (!text) throw new Error('Use /tell NAME TEXT'); const name = agentPicked(who); const adapter = adapters.get(name);
        if (saved.agents[name].external) throw new Error(notOurs(name));
        if (!adapter) throw new Error(saved.agents[name].app ? `${name} lives in its own app session; write to it there, or use /send` : saved.agents[name].kind === 'codex' ? `${name}'s session is not open` : `/tell reaches a Codex session only; type in ${name}'s own window, or use /send`);
        void adapter.submit(text).catch(error => bad(`${name} could not take that now: ${clean(error.message)}`)); say(dim(`  told ${name} directly`, colour)); break; }
      case '/approve': case '/deny': {
        const id = rest || onlyApproval([...approvals.keys()], approvalsSeen);
        if (!approvals.get(id)) throw new Error(approvals.size ? `Use ${command} ID with one of: ${[...approvals.keys()].join(', ')}` : 'Nothing is waiting for approval.');
        await answer(id, { decision: command === '/approve' ? 'accept' : 'decline' }); break;
      }
      case '/to': {
        if (!rest || rest.toLowerCase() === 'all') { sticky = ''; say('  Plain text now goes to every agent.'); }
        else { sticky = agentPicked(rest); say(`  Plain text now goes to ${sticky}. @Name in a line still picks for that line; /to all goes back to everyone.`); }
        rl.setPrompt(promptText(colour, sticky || undefined)); break;
      }
      case '/reply': {
        const [shellId, json] = split(rest); const pending = approvals.get(shellId);
        if (!pending) throw new Error('Use /reply ID JSON with a displayed pending request ID.');
        if (!json) throw new Error(`An explicit response is required: ${replyHint(shellId, pending)}`);
        await answer(shellId, { result: JSON.parse(json) }); break;
      }
      case '/map': await showMap(); break;
      case '/map-update': await mapUpdate(rest || undefined); break;
      case '/what-next': await whatNext(rest ? rest.split(/[,\s]+/).filter(Boolean) : undefined); break;
      case '/upgrade': { const preview = upgradePreview(); if (!preview.needed) { say(`  The workspace data is version ${preview.fromVersion}; there is nothing to upgrade.`); break; }
        say(`  This upgrades ${shownPath(preview.statePath)} from version ${preview.fromVersion} to ${preview.toVersion}, for the room${preview.rooms.length === 1 ? '' : 's'} ${preview.rooms.map(r => `"${clean(r.name)}"`).join(', ')}. The data as it is now is kept at ${shownPath(preview.backupPath!)}.`);
        if (preview.restarts.length) say(`  ${preview.restarts.join(', ')} stop${preview.restarts.length === 1 ? 's' : ''} for a moment and come${preview.restarts.length === 1 ? 's' : ''} back on the same session.`);
        if (preview.interrupts.length) say(`  ${preview.interrupts.join(', ')} ${preview.interrupts.length === 1 ? 'is' : 'are'} waiting on the hub; that wait ends, and ${preview.interrupts.length === 1 ? 'it needs' : 'they need'} to start listening again.`);
        if (await confirm('Back up and upgrade now?')) await upgradeData(preview.sourceDigest, key(), true); else say('  Left as it was.'); break; }
      case '/task': {
        if (!Object.keys(saved.agents).length) throw new Error('Invite an agent first.');
        const title = await ask('Title'); if (!title) throw new Error('A task needs a title.'); const who = agentNamed(await choose('Who does it', Object.keys(saved.agents)));
        const what = await ask('What should they do'); const others = Object.keys(saved.agents).filter(n => n !== who); const reviewer = others.length ? await choose('Reviewed by', ['nobody', ...others]) : 'nobody';
        const item = await hubCall('item_open', { requestId: key(), itemType: 'task', title });
        const text = `${what || title}${reviewer === 'nobody' ? '' : `\n\nBefore you answer: publish your result as a revision on item ${item.itemId}, request a review of that exact revision from ${reviewer}, and answer me once ${reviewer} has responded.`}`;
        const asked = await hubCall('request', { requestId: key(), itemId: item.itemId, purpose: 'answer', to: [who], text });
        ok(`Task ${item.itemId} given to ${who} as ${asked.collabRequestId}${reviewer === 'nobody' ? '' : `, to be reviewed by ${reviewer}`}. Their answer will appear here.`); break;
      }
      case '/accept': {
        const found = ((await hubCall('requests', { filter: 'owed_to_me' })).requests as any[]).find(r => r.collabRequestId === rest); if (!found) throw new Error('Use /accept REQUEST_ID with a request whose answer is waiting; /tasks lists them.');
        const ids = (found.responses ?? []).filter((r: any) => r.outcome === 'answered').map((r: any) => r.responseId); if (!ids.length) throw new Error('Nobody has answered that yet.');
        await hubCall('accept', { requestId: key(), collabRequestId: rest, responseIds: ids }); ok(`Accepted ${rest}.`); break;
      }
      case '/trust': case '/untrust': {
        const name = agentNamed(rest);
        if (saved.agents[name].external) { say(`  ${name}'s approvals are its own harness's; the console has nothing to allow or take back.`); break; }
        if (saved.agents[name].app && saved.agents[name].kind === 'codex') { say(`  ${name} runs in the Codex app, and its approvals are answered there; the console has nothing to allow or take back.`); break; }
        saved.agents[name].allow = command === '/trust'; persist();
        if (saved.agents[name].app) {
          const kept = Object.entries(saved.agents).some(([other, a]) => other !== name && a.app && a.kind === 'claude' && a.allow);
          if (command === '/trust' || !kept) { if (!projectAllow(workspace(), appRules(), command === '/trust')) throw new Error(`${shownPath(join(workspace(), '.claude/settings.local.json'))} is not readable as settings; change it by hand`); }
          ok(command === '/trust' ? `Sessions in this folder may run the Peerloom CLI without asking (${shownPath(join(workspace(), '.claude/settings.local.json'))}).` : kept ? `${name} is no longer marked trusted; the allow rules stay because another agent in the app uses them.` : `The Peerloom allow rules are removed from ${shownPath(join(workspace(), '.claude/settings.local.json'))}.`); break;
        }
        ok(command === '/trust' ? `${name} may run Peerloom room commands without asking.${saved.agents[name].kind === 'claude' && !owns(name) ? ` For Claude this takes effect when its session is next opened: /kill ${name}, then /relaunch ${name}.` : ''}` : `${name} will ask before every command${saved.agents[name].kind === 'claude' && !owns(name) ? ', from its next session' : ''}.`); break;
      }
      case '/reoffer': {
        // Work an agent fetched, or was woken for and dropped, is never offered twice by itself: that is the human's call.
        const name = agentNamed(rest); await hubCall('run_reoffer', { requestId: key(), participant: name }); ok(`${name}'s outstanding work will be offered again.`);
        if (!running(name)) await handle(`/relaunch ${name}`); break;
      }
      case '/relaunch': {
        const names = rest ? [agentNamed(rest)] : Object.keys(saved.agents).filter(n => !running(n)); if (!names.length) { say('  Every agent is already open.'); break; }
        for (const name of names) { if (running(name)) { say(`  ${name} is already open.`); continue; }
          if (saved.agents[name].external) { say(`  ${notOurs(name)} When it is armed again it is open here.`); continue; }
          if (saved.agents[name].app) { if ((await runState()).bindings.find((b: any) => b.participantId === saved.agents[name].participantId)?.armed === 'waiting') say(`  ${name} is armed in its app session.`); else linkLine(name); continue; }
          if (!owns(name)) startClaude(name); else if ((await runState()).state === 'running') startHost(name); else say(`  ${name} opens when the run is running: /start or /resume.`); }
        break;
      }
      case '/kill': { const name = agentNamed(rest); if (saved.agents[name].external) { say(`  ${notOurs(name)}`); break; } if (saved.agents[name].app) { say(`  ${name} runs in a ${saved.agents[name].kind === 'codex' ? 'Codex app chat' : 'Claude Code app session'}; stop it there. /pause stops new work reaching it.`); break; } if (!running(name)) { say(`  ${name} is not open.`); break; } if (await confirm(`Stop ${name}'s session? It stays in the room and can be relaunched.`)) { await stopAgent(name, true); ok(`${name} stopped.`); } else say('  Left running.'); break; }
      case '/clear': if (tty) out.write('\x1b[2J\x1b[3J\x1b[H'); else say('(cleared)'); break;
      case '/delete-room': {
        if (!owner) throw new Error('There is no room in this folder.'); const name = saved.room!.name;
        say(`  This stops every agent and deletes the room "${clean(name)}", its messages and all credentials in ${shownPath(data)}/.`);
        if (await ask('Type the room name to confirm') !== name) { say('  Not deleted.'); break; }
        // The link skill, the Cursor command and the allow rules were written for this room; they go with it.
        for (const kind of ['claude', 'codex'] as const) if (Object.values(saved.agents).some(a => a.app && a.kind === kind)) {
          try { if (readFileSync(skillPath(kind), 'utf8').includes(data)) rmSync(join(skillPath(kind), '..'), { recursive: true, force: true }); } catch { /* already gone */ }
          if (kind === 'claude') projectAllow(workspace(), appRules(), false);
        }
        // The Cursor command is the same text for every room, so it goes only if nobody has changed it.
        try { if (readFileSync(cursorCommandPath(), 'utf8') === cursorCommand()) rmSync(cursorCommandPath()); } catch { /* never made */ }
        // Only a confirmed deletion forgets the recipient and the lines typed for this room, file and memory both.
        sticky = ''; rl.setPrompt(promptText(colour)); (rl as any).history.length = 0;
        restarts.clear(); await quiesce(); await stopAll(); await hub.close(); rmSync(data, { recursive: true, force: true }); rmSync(store, { recursive: true, force: true }); saved = { agents: {} }; owner = null; for (const id of [...approvals.keys()]) drop(id, 'gone'); joining.clear(); seenMail.clear(); announced.clear(); lastSeen = 0; primed = true;
        page.messages.length = 0; page.notices.length = 0; page.outputs.length = 0; page.agents.clear(); page.requests = '[]'; page.activity = '[]'; page.marks.clear(); page.questions = '{"questions":[],"reviews":[]}'; page.run = ''; lastView = null; forgetRecommendations(); forgetMap(); await openHub(); quiet = false; web?.emit({ type: 'reset' }); ok('Room deleted. /create-room starts a new one.'); break;
      }
      case '/quit': case '/exit': { const open = Object.keys(saved.agents).filter(running); if (open.length && !await confirm(`Quit and stop ${open.join(', ')}? The room stays on disk.`, true)) { say('  Still here.'); break; } return false; }
      default: throw new Error(`${command} is not a command. /help lists them.`);
    }
    return true;
  }

  // ── Start ──
  if (options.web !== false) {
    try { web = await startWeb({ uiDir: options.uiDir ?? join(root, 'ui'), host: { snapshot, action: actOnce, models, join: joinRoute } }); }
    catch (error: any) { out.write(`The page could not start (${clean(error.message)}); the prompt works without it.\n`); }
  }
  // An approval the last console stopped in the middle of carries on to the same identity (item 24).
  if (owner) for (const claimId of joins().unfinished()) void approveJoin(claimId).catch((error: any) => warn(`A join approval could not finish: ${clean(error.message)}`));
  if (tty) out.write('\n');
  details(out, [['Folder', cwd], ['Hub', hub.endpoint], ['Room', owner ? saved.room?.name ?? 'yes' : 'none yet']], owner ? '/status shows the room, /help the commands.' : '/create-room makes one, /help lists commands.');
  { const user = userHarnesses();
    if (user.loaded.length) say(dim(`  Your harnesses from ${shownPath(user.path!)}: ${user.loaded.join(', ')}.`, colour));
    for (const problem of user.errors) warn(`Harness registry: ${clean(problem)}`); }
  if (!installed(CLI)) say(dim(`  ${CLI} is not installed on this PATH, so agents cannot run the lines this room gives them. Run npm link in ${root} once.`, colour));
  if (!tty) say(owner ? `Peerloom · room "${saved.room?.name}" in ${cwd}` : `Peerloom · no room in ${cwd} yet. /create-room makes one.`);
  if (web) say(`Page: ${web.url}`);
  if (owner && hub.stateVersion < STATE_VERSION) say(dim(`  This room's data is version ${hub.stateVersion}: ${hub.stateVersion < 5 ? 'suggestions can be adopted, and ' : ''}reactions, receipts and posts work once it is upgraded. /upgrade shows what that does.`, colour));
  try {
    if (owner && Object.keys(saved.agents).length) { await status(); if (await confirm('Open the agents again?', true)) await handle('/relaunch'); }
    for (;;) {
      idle = true; approvalsSeen = [...approvals.keys()]; syncDraft(); if (tty) rl.prompt(); const line = await nextLine(); idle = false; syncDraft(); if (line === null) break;
      try { if (!await handle(line)) break; if (approvals.size && line.trim() && !/^\/(approve|deny|reply|status)\b/.test(line.trim())) for (const [id, pending] of approvals) say(dim(`  (${pending.name} is still waiting: ${replyHint(id, pending)})`, colour)); } catch (error: any) { if (error.message === 'input closed') break; bad(clean(error.message?.replace(/^[a-z_]+: /, '') ?? 'That did not work.')); }
    }
  } catch (error: any) { if (error.message !== 'input closed') throw error; }
  finally { await quit(); closed = true; input.off('keypress', keypress); rl.close(); out.write(owner ? 'Hub stopped. The room is kept in .agentlink; run peerloom here to come back.\n' : 'Hub stopped.\n'); }
}

// `peerloom link --room DIR [--for claude|codex] [NAME]`: what the link skill runs inside a session in the app. It
// prints the opening for the agent the human invited there, and nothing secret: the credential is named by path only.
// Each app's skill says which app it is, so one room can have an agent in each without either needing a name.
export function linkText(dataDir: string, given?: string, kind?: 'claude' | 'codex') {
  let saved: Saved; try { saved = JSON.parse(readFileSync(join(dataDir, 'shell.json'), 'utf8')); } catch { throw new Error(`There is no Peerloom room at ${dataDir}. Run peerloom in the room's folder and /invite claude.`); }
  const invited = Object.entries(saved.agents ?? {}).filter(([, a]) => (a.app || a.external) && (!kind || a.kind === kind));
  if (!invited.length) throw new Error(`Nobody is invited to join from the ${kind === 'codex' ? 'Codex app' : kind === 'claude' ? 'Claude Code app' : kind ? `${harnessOf(kind)?.label ?? kind} session` : 'app'}. In the peerloom console: /invite ${kind ?? 'claude'}`);
  const found = given ? invited.filter(([name]) => name.toLowerCase() === given.toLowerCase()) : invited;
  if (found.length !== 1) throw new Error(given ? `${given} is not invited ${invited.some(([, a]) => a.external) ? 'to join from its own session or an app' : 'from the app'}. Invited: ${invited.map(([name]) => name).join(', ')}` : `More than one agent is invited from the app: ${invited.map(([name]) => name).join(', ')}. Ask the human which one this session is, then run the same command with that name at the end.`);
  const [name, agent] = found[0];
  if (agent.external) return externalOpening(name, saved.room?.name ?? 'the room', agent.credential, cli, harnessOf(agent.kind)?.label ?? agent.kind);
  return (agent.kind === 'codex' ? codexAppOpening : claudeOpening)(name, saved.room?.name ?? 'the room', agent.credential, cli);
}

export async function main(args: string[]) {
  if (args[0] === 'link') {
    try {
      const rest = args.slice(3); let kind: 'claude' | 'codex' | undefined;
      if (rest[0] === '--for') { if (rest[1] !== 'claude' && rest[1] !== 'codex') throw new Error('--for takes claude or codex'); kind = rest[1]; rest.splice(0, 2); }
      if (args[1] !== '--room' || !args[2] || rest.length > 1) throw new Error('Use: peerloom link --room DIR [--for claude|codex] [NAME]');
      console.log(linkText(resolve(args[2]), rest[0], kind));
    }
    catch (error: any) { console.error(error.message); process.exitCode = 1; }
    return;
  }
  if (args[0] === 'view' && args[1]) { await view(join(process.cwd(), '.agentlink/run', `${args[1].toLowerCase()}.log`), text => process.stdout.write(text)); return; }
  if (args[0] === '--help' || args[0] === 'help') { console.log('peerloom            open the session shell for the room in this folder\npeerloom view NAME  follow one agent\'s activity (opened for you by /invite-codex)\nInside the shell, /help lists the commands. The one-shot CLI is node core/cli.ts help.'); return; }
  if (args.length) { console.error(`peerloom takes no arguments here (got ${args[0]}). Run it bare, then type /help.`); process.exitCode = 1; return; }
  // AGENTLINK_UI names another folder for the page's three files, for trying a page that is not in this checkout yet.
  await runShell({ uiDir: process.env.AGENTLINK_UI || undefined });
}
