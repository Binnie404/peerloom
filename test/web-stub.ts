import { resolve } from 'node:path';
import { startWeb, type WebEvent } from '../core/web.ts';

// A stand-in console for building the page (item 17): the real web server and contract v0.1, with a made-up room
// whose agents talk on a timer. Nothing here touches a hub or a model.
//   node test/web-stub.ts [--ui DIR] [--port N]
// Ctrl-C stops it. Every action is accepted and shows up in the room the way the real console would show it.
const args = process.argv.slice(2); const arg = (name: string, fallback: string) => { const at = args.indexOf(`--${name}`); return at === -1 ? fallback : args[at + 1]; };
const now = () => new Date().toISOString(); let sequence = 0; let noticeId = 0; let outputId = 0; let approvalId = 0;
const state: any = {
  defaults: { workspace: process.cwd() },
  room: { name: 'stub-room', workspace: process.cwd(), objective: 'Try the page against contract v0.1' },
  run: { number: 1, state: 'running', limits: { room: 120, agent: 40 }, used: { room: 0, agents: { Claude: 0, Codex: 0 } } },
  agents: [
    { name: 'Claude', kind: 'claude', where: 'owned', model: 'opus', effort: 'high', trusted: true, session: 'open', armed: 'waiting' },
    { name: 'Codex', kind: 'codex', where: 'owned', model: 'gpt-6.1-sol', effort: 'high', trusted: true, session: 'open', armed: 'waiting' },
  ],
  approvals: [], messages: [], requests: [], notices: [], outputs: [],
};
const keep = (list: any[], entry: any, size: number) => { list.push(entry); if (list.length > size) list.shift(); return entry; };
let web: Awaited<ReturnType<typeof startWeb>>;
const tell = (event: WebEvent) => web.emit(event);
const message = (from: string, to: string[], text: string) => { state.run.used.room += 1; for (const name of to) if (name in state.run.used.agents) state.run.used.agents[name] += 1;
  tell({ type: 'message', ...keep(state.messages, { sequence: ++sequence, from, to, text, at: now() }, 200) }); tell({ type: 'run', ...state.run }); };
const notice = (level: string, text: string) => tell({ type: 'notice', ...keep(state.notices, { id: ++noticeId, level, text, at: now() }, 100) });
const agent = (name: string, change: any) => { const entry = state.agents.find((a: any) => a.name === name); if (!entry) throw Object.assign(new Error(`There is no agent called ${name}`), { status: 404, code: 'no_agent' }); Object.assign(entry, change); tell({ type: 'agent', ...entry }); return entry; };
const approval = (entry: any) => { state.approvals.push(entry); tell({ type: 'approval', ...entry }); };

const script: (() => void)[] = [
  () => message('Claude', ['Codex'], 'I have the server side; can you take the page?'),
  () => message('Codex', ['Claude'], "Yes. I'll build it against the stub."),
  () => approval({ id: String(approvalId++), agent: 'Codex', kind: 'approval', method: 'item/commandExecution/requestApproval', params: { command: 'npm test', reason: 'run the suite' }, lines: ['npm test', 'why: run the suite'] }),
  () => tell({ type: 'output', ...keep(state.outputs, { id: ++outputId, agent: 'Codex', text: 'Waiting for the human to allow npm test.', at: now() }, 100) }),
  () => approval({ id: String(approvalId++), agent: 'Codex', kind: 'answer', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q1', header: 'Branch', question: 'Which branch should I use?', options: [{ label: 'main' }, { label: 'codex/browser-control-room' }] }] }, lines: ['Which branch should I use?'] }),
  () => message('Claude', ['human'], 'Both of us are armed. Anything you want first?'),
  () => notice('warn', 'Codex has 2 wakes left in this run (38 of 40). /limits 240 80 doubles both.'),
];
const actions: Record<string, (body: any, name?: string) => any> = {
  room: body => { state.room = { name: body.name, workspace: body.workspace, objective: body.objective }; tell({ type: 'room', ...state.room }); },
  invite: body => { const entry = { name: body.name, kind: body.kind, where: 'owned', model: body.model ?? null, effort: body.effort ?? null, trusted: !!body.trusted, session: 'open', armed: 'unknown' }; state.agents.push(entry); tell({ type: 'agent', ...entry }); setTimeout(() => agent(body.name, { armed: 'waiting' }), 1500); },
  send: body => message('human', body.to ? [body.to] : state.agents.map((a: any) => a.name), String(body.text)),
  run: body => { state.run.state = { start: 'running', resume: 'running', pause: 'paused', end: 'ended', limits: state.run.state }[body.op as string] ?? state.run.state; if (body.limits) Object.assign(state.run.limits, body.limits); tell({ type: 'run', ...state.run }); },
  accept: () => { tell({ type: 'requests' }); },
  stop: (_, name) => { agent(name!, { session: 'closed', armed: 'not_armed' }); },
  relaunch: (_, name) => { agent(name!, { session: 'open', armed: 'waiting' }); },
  trust: (body, name) => { agent(name!, { trusted: !!body.trusted }); },
  tell: (body, name) => { tell({ type: 'output', ...keep(state.outputs, { id: ++outputId, agent: name, text: `(heard: ${body.text})`, at: now() }, 100) }); },
};
web = await startWeb({ uiDir: resolve(arg('ui', 'ui')), port: Number(arg('port', '0')), host: {
  snapshot: async () => structuredClone(state),
  models: async kind => ({ models: kind === 'codex' ? [{ model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high'], isDefault: true }] : [] }),
  action: async (path, body) => {
    const approved = path.match(/^approvals\/(.+)$/); const agentPath = path.match(/^agents\/([^/]+)\/(stop|relaunch|trust|tell)$/);
    if (approved) { const at = state.approvals.findIndex((a: any) => a.id === approved[1]); if (at === -1) throw Object.assign(new Error('Nothing is waiting with that id'), { status: 404, code: 'no_approval' });
      const [entry] = state.approvals.splice(at, 1); const how = body.result ? 'answered' : body.decision === 'accept' ? 'approved' : 'denied'; tell({ type: 'approval_done', id: entry.id, how }); notice('info', `${how} for ${entry.agent}`); return; }
    if (agentPath) return actions[agentPath[2]](body, agentPath[1]);
    if (!actions[path] || ['stop', 'relaunch', 'trust', 'tell'].includes(path)) throw Object.assign(new Error(`${path} is not an action`), { status: 404, code: 'unknown_action' });
    return actions[path](body);
  },
} });
let step = 0; const timer = setInterval(() => { script[step % script.length](); step += 1; }, 4000);
console.log(`Stub console serving ${resolve(arg('ui', 'ui'))}\nOpen: ${web.url}`);
process.once('SIGINT', () => { clearInterval(timer); void web.close().then(() => process.exit(0)); });
