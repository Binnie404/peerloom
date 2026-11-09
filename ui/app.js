// The page is a view of the local console. It never talks to the protocol hub or receives its credentials.
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const esc = escapeHTML;
const human = name => ['human', 'owner'].includes(String(name).toLowerCase());
const nameOf = value => typeof value === 'object' && value !== null ? String(value.name ?? value.id ?? '') : String(value ?? '');
const namesOf = value => (Array.isArray(value) ? value : value ? [value] : []).map(nameOf);
const labelOf = value => human(nameOf(value)) ? 'You' : nameOf(value);
const clock = at => { const d = new Date(at); return Number.isNaN(d.valueOf()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
const requestId = request => String(request.id ?? request.collabRequestId ?? '');
const readyToAccept = request => ['settled', 'answered'].includes(request.state) && !request.accepted && !request.targetSuperseded && (request.responses ?? []).some(response => response.outcome === 'answered' || response.outcome === undefined);
const closedRequest = request => !!request.accepted || !!request.targetSuperseded || ['settled', 'answered', 'declined', 'withdrawn', 'closed'].includes(request.state);
const budgetHolds = new Set(['budget_room', 'budget_agent']);
const icon = (paths, size = '') => `<svg class="i${size ? ` s${size}` : ''}" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  room: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', work: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  map: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>', recommendations: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6M10 22h4"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>', eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>', terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  check: '<path d="M20 6 9 17l-5-5"/>', zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>', plus: '<path d="M5 12h14M12 5v14"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>',
  minus: '<path d="M5 12h14"/>', down: '<path d="M12 5v14M19 12l-7 7-7-7"/>', sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>', max: '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>', min: '<path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>',
};

// Thread colours are assigned in join order; you are always thread 0 (the handoff's tokens --t0 … --t5).
export function threadOf(agents = [], name) {
  if (human(nameOf(name))) return 0;
  const index = (agents ?? []).findIndex(agent => String(agent.name) === nameOf(name));
  return index === -1 ? 'n' : 1 + (index % 5);
}
const tc = (agents, name) => `c${threadOf(agents, name)}`;

// A path in inline code links to the map part that cites it: exactly, or under a cited folder (a path ending in /).
export function nodeForPath(map, path) {
  const wanted = String(path ?? '').trim(); if (!wanted) return null;
  return (map?.nodes ?? []).find(node => (node.paths ?? []).some(p => p === wanted || (String(p).endsWith('/') && wanted.startsWith(p)))) ?? null;
}
// Message text: `code` in mono (a file link when the map cites it), @mentions of the crew in their colour, the rest as data.
export function richText(text, { agents = [], map = null } = {}) {
  const names = new Map((agents ?? []).map(agent => [String(agent.name).toLowerCase(), String(agent.name)]));
  const plain = value => esc(value).replace(/@([A-Za-z][A-Za-z0-9_-]{0,31})/g, (whole, word) => { const name = names.get(word.toLowerCase()); return name ? `<span class="mention ${tc(agents, name)}">@${esc(name)}</span>` : whole; });
  return String(text ?? '').split(/`([^`\n]+)`/).map((part, i) => {
    if (i % 2 === 0) return plain(part);
    const node = nodeForPath(map, part);
    return node ? `<button type="button" class="file-link" data-map-path="${esc(node.id)}" title="Show on the map">${esc(part)}</button>` : `<code>${esc(part)}</code>`;
  }).join('');
}

// One word for where a crew member stands (item 24). A console from before the state field sends none, and then the
// older armed/held wording below is used unchanged.
const AGENT_STATES = { verified: 'Verified · listening', listening: 'Listening', joined: 'Joined · not listening yet', held: 'Held', blocked_approval: 'Blocked · waiting for your approval', stopped: 'Stopped' };
export function agentStateLabel(agent) { return Object.hasOwn(AGENT_STATES, agent?.state) ? AGENT_STATES[agent.state] : null; }
// Slice C: a receipt says only what the client did, never that a model read anything; a post is quiet and gets no
// ticks; reactions are a small bounded set and never a delivery.
const RECEIPT_WORDS = { stored: '✓ Stored', fetched: '✓✓ Fetched', acknowledged: '✓✓ Acknowledged' };
const REACTIONS = ['👍', '👀', '✅', '🎉', '❌'];
export function renderReceipts(message) {
  const receipts = Array.isArray(message?.receipts) ? message.receipts : [];
  if (!receipts.length || (message?.kind ?? 'mail') === 'post') return '';
  return `<div class="message-receipts">${receipts.map(receipt => `<span class="receipt receipt-${esc(receipt.state)}" title="${esc(`${labelOf(receipt.to)}: ${RECEIPT_WORDS[receipt.state] ?? receipt.state}`)}">${esc(labelOf(receipt.to))} ${esc(RECEIPT_WORDS[receipt.state] ?? receipt.state)}</span>`).join('')}</div>`;
}
// Pills for the reactions given (one dot per reactor, in their colour), and a quick bar that shows on hover or focus.
export function renderReactions(message, agents = []) {
  const id = message?.id === undefined || message?.id === null ? '' : String(message.id);
  const list = Array.isArray(message?.reactions) ? message.reactions.filter(reaction => REACTIONS.includes(reaction?.emoji)) : [];
  const button = (emoji, cls, inner) => {
    const all = list.filter(reaction => reaction.emoji === emoji); const mine = all.some(reaction => human(reaction.by));
    const title = all.length ? all.map(reaction => nameOf(reaction.by)).join(', ') : `React ${emoji}`;
    return `<button type="button" class="${cls}${mine ? ' mine' : ''}" data-action="react" data-id="${esc(id)}" data-emoji="${esc(emoji)}" data-on="${mine ? 'false' : 'true'}" title="${esc(title)}"${id ? '' : ' disabled'}>${inner(all)}</button>`;
  };
  const pills = REACTIONS.filter(emoji => list.some(reaction => reaction.emoji === emoji)).map(emoji => button(emoji, 'reaction', all => `<span class="emoji">${esc(emoji)}</span><span class="reactors" aria-hidden="true">${all.map(reaction => `<span class="dot ${tc(agents, reaction.by)}"></span>`).join('')}</span><span class="sr-only reaction-count">${all.length}</span>`)).join('');
  return `<div class="message-reactions">${pills}</div><div class="quick" role="group" aria-label="React">${REACTIONS.map(emoji => button(emoji, 'quick-react', () => esc(emoji))).join('')}</div>`;
}
// The working/blocked line on a crew member comes from the snapshot's activity, linked to the latest message when there is one.
export function activityOf(activity = [], name) { return (activity ?? []).find(entry => String(entry?.name) === String(name)) ?? null; }
export function renderAgentWork(activity, name) {
  const doing = activityOf(activity, name); if (!doing) return '';
  const blocked = doing.state === 'blocked';
  return `<div class="agent-work ${blocked ? 'blocked' : 'working'}" data-activity="${esc(doing.state)}"${doing.messageId ? ` data-message-id="${esc(doing.messageId)}"` : ''}>${blocked ? `blocked: ${esc(doing.text ?? 'waiting on you')}` : `working on ${esc(doing.text ?? 'the task')}`}</div>`;
}
// @mentions in the composer address the named agents; names are matched case-insensitively against the crew.
export function mentionedNames(text, agents = []) {
  const names = new Map((agents ?? []).map(agent => [String(agent.name).toLowerCase(), String(agent.name)])); const found = new Map();
  for (const match of String(text ?? '').matchAll(/@([A-Za-z][A-Za-z0-9_-]{0,31})/g)) { const name = names.get(match[1].toLowerCase()); if (name) found.set(name, true); }
  return [...found.keys()];
}
// When the text mentions agents, they are the recipients; the To choice is shown as overridden and disabled so the
// composer never displays a different choice from the one it will use.
export function composerMentionRoute(text, agents = []) {
  const names = mentionedNames(text, agents);
  return { names, disabled: names.length > 0 };
}
// What the composer sends: mentions choose the recipients; otherwise the selected recipient, and empty means all agents.
// A quiet post cannot also ask for an answer.
export function composerPlan({ text, recipient = '', agents = [], noReply = false, post = false } = {}) {
  if (post && noReply) throw new Error('A quiet post cannot also ask for an answer.');
  const mentioned = mentionedNames(text, agents);
  const to = mentioned.length ? mentioned : (recipient ? [recipient] : []);
  return { text: String(text ?? '').trim(), ...(to.length ? { to: to.length === 1 ? to[0] : to } : {}), ...(noReply ? { noReply: true } : {}), ...(post ? { post: true } : {}) };
}

// Harnesses the page knew before the console said (item 23); any other kind takes its label from the console.
const KNOWN_HARNESSES = { claude: 'Claude Code', codex: 'Codex' };
const WHERE = { owned: 'hosted here', app: 'native app', external: 'its own session', terminal: 'terminal' };
// What the console says can be done with an agent. A console from before item 23 sends no controls: derive them as then.
function agentControls(agent) {
  if (agent.controls) return agent.controls;
  const here = agent.where === 'owned'; const open = agent.session === 'open';
  return { stop: here && open, relaunch: here && !open, tell: here && open, settings: true };
}
// The composer's recipient (item 24 decision 3): one named agent by default, and Everyone is a deliberate choice.
// A human send with no recipient is the console's own broadcast, so '' means Everyone and is never the starting point.
export function recipientChoices(agents = []) {
  return [...(agents ?? []).map(agent => ({ value: String(agent.name), label: String(agent.name) })), { value: '', label: 'Everyone' }];
}
export function defaultRecipient(agents = [], selected = undefined) {
  const names = (agents ?? []).map(agent => String(agent.name));
  if (selected === '' || names.includes(selected)) return selected;
  return names[0] ?? '';
}
// The short word beside a crew member: what it is doing, else where it stands.
export function agentStatus(agent, runState, activity = []) {
  const doing = activityOf(activity, agent.name);
  if (doing?.state === 'blocked') return ['blocked', 'blocked'];
  if (agent.state === 'stopped' || (!agent.state && agent.session !== 'open' && agent.where === 'owned')) return ['stopped', 'stopped'];
  if (runState === 'running' && budgetHolds.has(agent.held)) return ['held', 'held'];
  if (doing) return ['working', 'working'];
  if (agent.state === 'held') return ['held', 'held'];
  if (agent.state === 'joined') return ['joining', 'idle'];
  if (runState === 'paused') return ['paused', 'idle'];
  return [agent.session === 'open' || agent.state ? 'idle' : 'closed', 'idle'];
}

// A crew member in the sidebar: a row (dot, name, a count of its approvals or a status word) that focuses its lane, and
// a detail block with its model, where it runs, what it is doing and its controls.
export function renderAgentCard(agent, runState, activity = [], { agents = [agent], badge = 0, focused = false } = {}) {
  const known = Object.hasOwn(KNOWN_HARNESSES, agent.kind); const kind = known ? agent.kind : 'other';
  const can = agentControls(agent); const name = esc(agent.name); const state = agentStateLabel(agent);
  const [word, tone] = agentStatus(agent, runState, activity);
  const buttons = `${can.tell ? `<button class="first" data-action="tell" data-name="${name}" title="Into its session">Message</button>` : `<button class="first" type="button" data-compose="${name}" title="In the room">Message</button>`}${can.stop ? `<button class="stop-control" data-action="stop" data-name="${name}">Stop</button>` : ''}${can.relaunch ? `<button data-action="relaunch" data-name="${name}">Relaunch</button>` : ''}${can.settings ? `<button data-action="agent-settings" data-name="${name}">Settings</button>` : ''}`;
  const model = [agent.model, agent.effort].filter(Boolean).join(' · ');
  const doing = activityOf(activity, agent.name);
  return `<div class="agent${word === 'stopped' ? ' stopped' : ''}${focused ? ' focused' : ''}" data-agent="${name}" data-kind="${esc(kind)}"${agent.state ? ` data-state="${esc(agent.state)}"` : ''}><button type="button" class="agent-row" data-focus-agent="${name}" aria-expanded="${focused}"${doing?.text ? ` title="${esc(doing.text)}"` : ''}><span class="dot ${tc(agents, agent.name)}" aria-hidden="true"></span><span class="agent-nm">${name}</span>${badge ? `<span class="badge" title="${esc(`${badge} waiting for your approval`)}">${esc(badge)}</span>` : `<span class="agent-st ${tone === 'idle' ? '' : esc(tone)}">${esc(word)}</span>`}</button><div class="agent-detail"><div class="agent-meta">${model ? `${esc(model)} · ` : ''}${esc(agent.label ?? KNOWN_HARNESSES[agent.kind] ?? agent.kind)} · ${esc(WHERE[agent.where] ?? 'terminal')}${agent.agentId ? ` · ${esc(agent.agentId)}` : ''}<br><span class="agent-activity${runState === 'running' && budgetHolds.has(agent.held) ? ' budget-held' : ''}"${state ? ` data-state="${esc(agent.state)}"` : ''}>${esc(agentWaitLabel(agent, runState))}</span>${agent.note ? `<br>${esc(agent.note)}` : ''}</div>${renderAgentWork(activity, agent.name)}<div class="agent-controls">${buttons}</div></div></div>`;
}
// The invite form's choices: the console's harness list, or Claude Code and Codex from a console before item 23. A name
// is the label's first word, made free in this room.
export function inviteChoices(harnesses, agents) {
  const list = harnesses ?? [{ id: 'claude', label: 'Claude Code', routes: ['owned'], enabled: true, reason: null }, { id: 'codex', label: 'Codex', routes: ['owned'], enabled: true, reason: null }];
  const taken = new Set((agents ?? []).map(a => String(a.name).toLowerCase()));
  return list.map(h => { const base = String(h.label).split(/\s+/)[0].replace(/[^A-Za-z0-9_-]/g, '') || 'Agent'; let name = base; for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}${n}`;
    return { id: h.id, label: h.label, enabled: !!h.enabled, reason: h.reason ?? null, external: !h.routes?.includes('owned'), name }; });
}

export function agentWaitLabel(agent, runState) {
  if (runState === 'running' && budgetHolds.has(agent.held)) return agent.held === 'budget_room' ? 'Held: room wake budget spent' : 'Held: agent wake budget spent';
  const state = agentStateLabel(agent); if (state) return state;
  return ({ waiting: 'Waiting for work', not_armed: 'Not waiting', disarmed: 'Wait allowance reached', unknown: 'Not bound yet' })[agent.armed] ?? agent.armed ?? 'Not bound yet';
}

// A full counter alone does not mean work is blocked. The hub names a hold only when eligible peer work is held.
export function budgetAttention(state) {
  if (state.run?.state !== 'running') return null;
  const agents = (state.agents ?? []).filter(agent => budgetHolds.has(agent.held));
  if (!agents.length) return null;
  const run = state.run;
  const used = name => run.used?.agents?.[name] ?? 0;
  const increase = (limit, count, cap) => Math.min(cap, Math.max(limit + 1, Math.ceil(limit * 1.5), count + 1));
  const limits = { room: increase(run.limits.room, run.used?.room ?? 0, 500), agent: increase(run.limits.agent, Math.max(0, ...agents.map(agent => used(agent.name))), 200) };
  const canExtend = limits.room > (run.used?.room ?? 0) && agents.every(agent => limits.agent > used(agent.name));
  return { agents, limits, canExtend };
}

export function renderBudgetAttention(state) {
  const attention = budgetAttention(state);
  if (!attention) return '';
  const run = state.run; const names = attention.agents.map(agent => agent.name);
  const roomHeld = attention.agents.some(agent => agent.held === 'budget_room');
  const title = roomHeld ? 'The room reached its peer-wake limit' : `${names.join(' and ')} reached ${names.length === 1 ? 'its' : 'their'} peer-wake limit`;
  const extendBy = roomHeld ? attention.limits.room - run.limits.room : attention.limits.agent - run.limits.agent;
  return `<div class="need amber budget-card" data-budget-card><div class="need-top amber">${icon(ICONS.zap, 13)}Budget hold</div><h3>${esc(title)}</h3><p>Wakes from other agents to ${esc(names.join(', '))} are held. Work you send still goes through.</p><ul class="budget-holds">${attention.agents.map(agent => `<li><strong>${esc(agent.name)}</strong> · ${agent.held === 'budget_room' ? `Room limit: ${esc(run.used?.room ?? 0)} / ${esc(run.limits.room)}` : `Agent limit: ${esc(run.used?.agents?.[agent.name] ?? 0)} / ${esc(run.limits.agent)}`}</li>`).join('')}</ul>${!attention.canExtend ? '<p class="budget-boundary">A required limit is already at its maximum. You can pause or end this run.</p>' : ''}<div class="need-actions"><button data-action="limits">Set limits</button><button class="go" data-action="extend-budget" data-blocked="${!attention.canExtend}"${!attention.canExtend ? ' disabled' : ''}>Extend${attention.canExtend && extendBy > 0 ? ` +${esc(extendBy)}` : ''}</button></div><div class="need-actions one"><button data-action="run" data-op="pause">Pause the run instead</button></div></div>`;
}

// Room record capacity for this run (item 24): lifetime offers, grants and control actions, not the adjustable wake
// budget. A console from before the field sends none, and then nothing is said.
export function renderCapacity(run) {
  const capacity = run?.capacity;
  if (!capacity || typeof capacity !== 'object') return '';
  const parts = [['offers', 'offers'], ['grants', 'grants'], ['controls', 'controls']].flatMap(([key, label]) => {
    const value = capacity[key];
    if (!value || typeof value !== 'object') return [];
    const used = Number(value.used); const cap = Number(value.cap);
    if (!Number.isFinite(used) || !Number.isFinite(cap)) return [];
    return [`${label} ${used} / ${cap}`];
  });
  if (!parts.length) return '';
  return `<span class="capacity" title="Room records kept for this run: offers, grants and control actions. These are lifetime caps, not the wake budget.">Capacity: ${esc(parts.join(' · '))}</span>`;
}
// The peer-wake card at the foot of the sidebar: used of the run's limit, one bar segment per agent in its colour.
export function renderWakes(run, agents = []) {
  if (!run?.limits) return '';
  const used = Number(run.used?.room ?? 0); const limit = Number(run.limits.room) || 1;
  const by = (agents ?? []).map(agent => ({ name: agent.name, n: Number(run.used?.agents?.[agent.name] ?? 0), agent })).filter(entry => entry.n > 0);
  const held = (agents ?? []).filter(agent => run.state === 'running' && budgetHolds.has(agent.held));
  const warn = held.length > 0 || used / limit >= 0.8;
  const warning = held.length ? `${held.map(agent => agent.name).join(', ')} at limit · peer work held` : used / limit >= 0.8 ? `${limit - used} peer wake${limit - used === 1 ? '' : 's'} left this run` : '';
  return `<span class="wakes-label">Peer wakes</span><span class="wakes-num"><b class="${warn ? 'warn' : ''}">${esc(used)}</b><span>of ${esc(limit)} this run</span></span><span class="wakes-bar" aria-hidden="true">${by.map(entry => `<span class="${tc(agents, entry.name)}" data-flex="${esc(entry.n)}" title="${esc(`${entry.name}: ${entry.n}`)}"></span>`).join('')}<span class="rest" data-flex="${esc(Math.max(0, limit - used))}"></span></span>${by.length ? `<span class="wakes-legend">${by.map(entry => `<span><span class="dot ${tc(agents, entry.name)}"></span>${esc(entry.name)} ${esc(entry.n)}</span>`).join('')}</span>` : ''}${warning ? `<span class="wakes-warn">${icon(ICONS.alert, 12)}${esc(warning)}</span>` : ''}${renderCapacity(run) ? `<span class="wakes-label">${renderCapacity(run)}</span>` : ''}`;
}

// Fetch streams can split both an SSE frame and a UTF-8 character. Keep one decoder across reads.
export class EventStreamParser {
  buffer = '';
  decoder = new TextDecoder();
  push(bytes, final = false) {
    this.buffer += this.decoder.decode(bytes, { stream: !final });
    if (this.buffer.length > 2_000_000) throw new Error('The event stream sent an oversized frame.');
    const events = [];
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(this.buffer))) {
      const block = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const data = [];
      let id;
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const key = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (key === 'data') data.push(value);
        if (key === 'id' && /^\d+$/.test(value)) id = Number(value);
      }
      if (data.length) events.push({ id, data: JSON.parse(data.join('\n')) });
    }
    return events;
  }
}

export function applyRoomEvent(current, event) {
  const next = { ...current };
  if (event.type === 'message') {
    const { type, ...message } = event;
    const messages = new Map((current.messages ?? []).map(m => [m.sequence, m]));
    messages.set(message.sequence, message);
    next.messages = [...messages.values()].sort((a, b) => a.sequence - b.sequence).slice(-200);
  } else if (event.type === 'agent') {
    const { type, ...agent } = event;
    const agents = current.agents ?? [];
    next.agents = agents.some(a => a.name === agent.name)
      ? agents.map(a => a.name === agent.name ? agent : a)
      : [...agents, agent];
  } else if (event.type === 'approval') {
    const { type, ...approval } = event;
    next.approvals = [...(current.approvals ?? []).filter(a => String(a.id) !== String(approval.id)), approval];
  } else if (event.type === 'approval_done') {
    next.approvals = (current.approvals ?? []).filter(a => String(a.id) !== String(event.id));
  } else if (event.type === 'run') {
    const { type, ...run } = event;
    next.run = run;
  } else if (event.type === 'receipts') {
    const updates = new Map((event.updates ?? []).map(update => [String(update.id), update]));
    next.messages = (current.messages ?? []).map(message => updates.has(String(message.id))
      ? { ...message, receipts: updates.get(String(message.id)).receipts ?? message.receipts, reactions: updates.get(String(message.id)).reactions ?? message.reactions }
      : message);
  } else if (event.type === 'activity') {
    next.activity = Array.isArray(event.activity) ? event.activity : [];
  }
  return next;
}

// A message on the loom: a knot in the author's thread colour, the meta row, the text, then ticks and reactions.
export function renderMessage(message, agents = [], { map = null, focus = '', queued = false } = {}) {
  const from = nameOf(message.from);
  const agent = (agents ?? []).find(a => a.name === from);
  const to = namesOf(message.to).map(labelOf).join(', ');
  const quiet = (message.kind ?? 'mail') === 'post';
  const lane = !focus || from === focus || namesOf(message.to).includes(focus);
  const tags = `${quiet ? '<span class="tag post-marker">quiet</span>' : ''}${message.noReply ? '<span class="tag no-reply">no reply needed</span>' : ''}${queued ? '<span class="tag queued">queued</span>' : ''}`;
  return `<article class="message${quiet ? ' quiet-post' : ''}${lane ? '' : ' dim'}"${message.id ? ` data-message-id="${esc(message.id)}"` : ''} data-sequence="${esc(message.sequence)}" data-kind="${esc(message.kind ?? 'mail')}"><span class="gutter" aria-hidden="true"><span class="knot ${tc(agents, from)}"></span></span><div class="message-content"><div class="message-meta"><b class="author ${tc(agents, from)}">${esc(labelOf(from) || 'Room')}</b>${to ? `<span class="to">→ ${esc(to)}</span>` : ''}<time datetime="${esc(message.at)}">${esc(clock(message.at))}</time>${agent ? `<span class="harness">${esc(agent.label ?? KNOWN_HARNESSES[agent.kind] ?? agent.kind)}</span>` : ''}${tags}</div><div class="message-text">${richText(message.text, { agents, map })}</div>${quiet ? '' : renderReceipts(message)}${queued ? '' : renderReactions(message, agents)}</div></article>`;
}

function permissionLines(profile) {
  if (!profile || typeof profile !== 'object') return [];
  const lines = [];
  if (profile.network?.enabled) lines.push('Network access');
  const fs = profile.fileSystem ?? profile.filesystem;
  if (fs) {
    for (const access of ['read', 'write']) for (const path of fs[access] ?? []) lines.push(`${access === 'read' ? 'Read' : 'Write'}: ${typeof path === 'string' ? path : JSON.stringify(path)}`);
    for (const entry of fs.entries ?? []) lines.push(`${entry.access}: ${entry.path?.path ?? entry.path?.pattern ?? entry.path?.value?.kind ?? JSON.stringify(entry.path)}`);
  }
  if (!lines.length && Object.keys(profile).length) lines.push(JSON.stringify(profile, null, 2));
  return lines;
}
const approvalCommand = approval => String(approval.command ?? approval.params?.command ?? approval.params?.input?.command ?? '');

// A native request in Needs you: a command to allow or deny, access to grant for this turn, or questions to answer.
export function renderApproval(approval, drafts = {}, { agents = [], first = false } = {}) {
  const id = String(approval.id); const who = approval.agent ?? 'An agent';
  const verb = approval.kind === 'answer' ? 'needs an answer' : approval.kind === 'permission' ? 'requests access' : 'wants to run';
  const reason = approval.reason ?? approval.params?.reason ?? '';
  const lines = (approval.lines ?? []).filter(line => typeof line === 'string').join('\n');
  const command = approvalCommand(approval); const cwd = approval.params?.cwd ?? '';
  const header = `<div class="need amber" data-approval-id="${esc(id)}"><div class="need-top"><span class="dot ${tc(agents, who)}"></span>${esc(who)} ${esc(verb)}</div>${command ? `<div class="cmd">${esc(command)}</div>` : ''}${cwd ? `<div class="cwd">in ${esc(cwd)}</div>` : ''}${reason ? `<p>${esc(reason)}</p>` : ''}${lines && lines !== command ? `<details${!command && approval.kind === 'approval' ? ' open' : ''}><summary>Request details</summary><pre>${esc(lines)}</pre></details>` : ''}`;
  if (approval.kind === 'answer' && Array.isArray(approval.params?.questions)) {
    const fields = approval.params.questions.map((question, index) => {
      const selected = drafts[question.id] ?? '';
      const options = question.options ?? [];
      const label = question.question ?? question.header ?? question.id;
      const fieldId = `q-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}-${index}`;
      const input = options.length && !question.isOther
        ? `<select id="${esc(fieldId)}" name="answer-${index}" data-question-id="${esc(question.id)}" required><option value="" disabled${!selected ? ' selected' : ''}>Choose an answer</option>${options.map(option => `<option value="${esc(option.label)}"${selected === option.label ? ' selected' : ''}>${esc(option.label)}${option.description ? ` — ${esc(option.description)}` : ''}</option>`).join('')}</select>`
        : `<input id="${esc(fieldId)}" name="answer-${index}" data-question-id="${esc(question.id)}" type="${question.isSecret ? 'password' : 'text'}" value="${esc(selected)}"${options.length ? ` list="${esc(fieldId)}-options"` : ''} required autocomplete="off">${options.length ? `<datalist id="${esc(fieldId)}-options">${options.map(option => `<option value="${esc(option.label)}">${esc(option.description ?? '')}</option>`).join('')}</datalist>` : ''}`;
      return `<label class="question-label" for="${esc(fieldId)}">${esc(label)}</label>${input}`;
    }).join('');
    return `${header}<form data-question-form="${esc(id)}">${fields}<div class="need-actions one"><button type="submit" class="go">Send answers</button></div></form></div>`;
  }
  if (approval.kind === 'permission') {
    const profile = approval.params?.permissions;
    const permissions = permissionLines(profile);
    return `${header}${permissions.length ? `<ul class="permission-list">${permissions.map(line => `<li>${esc(line)}</li>`).join('')}</ul>` : '<p>The agent has not supplied a readable access request.</p>'}<p>Access is limited to this turn.</p><div class="need-actions${profile && Object.keys(profile).length ? '' : ' one'}"><button data-action="deny-permission" data-id="${esc(id)}">Decline</button>${profile && Object.keys(profile).length ? `<button class="go" data-action="grant-permission" data-id="${esc(id)}">Allow access</button>` : ''}</div></div>`;
  }
  if (approval.kind === 'answer') return `${header}<p>This request needs a structured answer. Its question details are not available; check the local console.</p></div>`;
  return `${header}<div class="need-actions"><button data-action="deny" data-id="${esc(id)}">Deny${first ? '<kbd>D</kbd>' : ''}</button><button class="go" data-action="approve" data-id="${esc(id)}">Allow${first ? '<kbd>A</kbd>' : ''}</button></div></div>`;
}
// The same command approval inline in the conversation, so it stays reachable when the right rail is hidden.
export function renderApprovalBubble(approval, agents = []) {
  const id = esc(String(approval.id)); const who = approval.agent ?? 'An agent';
  const command = approvalCommand(approval) || (approval.kind === 'permission' ? 'Access for this turn' : 'A request');
  const actions = approval.kind === 'approval' ? `<div class="b-actions"><button class="btn" data-action="deny" data-id="${id}">Deny</button><button class="btn inverted" data-action="approve" data-id="${id}">Allow</button></div>` : `<span class="st open">In Needs you</span>`;
  return `<article class="message" data-approval-bubble="${id}"><span class="gutter" aria-hidden="true"><span class="knot ${tc(agents, who)}"></span></span><div class="message-content"><div class="message-meta"><b class="author ${tc(agents, who)}">${esc(who)}</b></div><div class="bubble pending">${icon(ICONS.terminal)}<div><div class="b-title">Waiting for your approval</div><div class="b-target">${esc(command)}</div></div>${actions}</div></div></article>`;
}

// An agent's own question for the human (item 24, slice A). Answer and Decline both go through /api/answer with one
// idempotency key per answer, so a retry after a lost response never records a second one.
export function renderNeedsQuestion(question, draft = '') {
  const raw = String(question?.id ?? ''); const id = esc(raw);
  const fieldId = `needs-${raw.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const from = esc(labelOf(question?.from));
  const item = question?.item ? `<p class="needs-item">${esc(question.item)}</p>` : '';
  const purpose = question?.purpose ? `<span>${esc(question.purpose)}</span>` : '';
  const when = question?.at ? `<time datetime="${esc(question.at)}">${esc(clock(question.at))}</time>` : '';
  return `<div class="need amber needs-question" data-needs-id="${id}"><div class="need-top">Question for you</div><h3>${from} needs an answer</h3>${item}<p>${esc(question?.text ?? '')}</p><form data-needs-form="${id}"><label class="sr-only" for="${esc(fieldId)}">Your answer</label><textarea id="${esc(fieldId)}" name="text" rows="3" maxlength="32000" placeholder="Type your answer, or decline">${esc(draft)}</textarea><div class="need-actions"><button type="submit" name="outcome" value="declined">Decline</button><button type="submit" class="go" name="outcome" value="answered">Send answer</button></div></form><div class="need-meta">${purpose}${purpose && when ? ' · ' : ''}${when}</div></div>`;
}

// A session waiting for the human to approve its pairing code (item 24, slice B). The code is the only thing the human
// compares, and Let in is the only action that creates the participant. Approving and reconciling states are shown
// honestly: a join the console is finishing gets no buttons, and a stopped approval can only be refused.
const RECONCILE_TEXT = 'This approval stopped too long ago to finish by itself; refuse it and send a new join line.';
export function renderJoinCard(join) {
  const id = esc(String(join?.claimId ?? ''));
  const label = esc(join?.label ?? 'A session'); const harness = esc(join?.harness ?? '');
  const state = typeof join?.state === 'string' ? join.state : 'claimed';
  const when = join?.at ?? join?.claimedAt;
  const expires = join?.expiresAt ? `Expires <time datetime="${esc(join.expiresAt)}">${esc(clock(join.expiresAt))}</time>` : '';
  const head = `<div class="need amber join-card" data-join-id="${id}" data-join-state="${esc(state)}"><div class="need-top"><span class="ring"></span>Wants to join${when ? ` · ${esc(clock(when))}` : ''}</div><h3>${label}${harness ? ` <span>· ${harness}</span>` : ''}</h3>`;
  if (state === 'approving') return `${head}<p class="join-note">This join is being approved. It finishes on its own; the code no longer needs checking.</p><div class="need-meta">${expires}</div></div>`;
  if (state === 'reconcile') { const why = typeof join?.note === 'string' && join.note ? join.note : typeof join?.detail === 'string' && join.detail ? join.detail : RECONCILE_TEXT; return `${head}<p class="join-note">${esc(why)}</p><div class="need-actions${join?.retry === true ? '' : ' one'}"><button data-action="join-refuse" data-id="${id}">Refuse</button>${join?.retry === true ? `<button class="go" data-action="join-retry" data-id="${id}">Retry</button>` : ''}</div><div class="need-meta">${expires}</div></div>`; }
  return `${head}<p class="join-code" aria-label="Pairing code">${esc(join?.pairingCode ?? '')}</p><p class="join-note">Check this matches the code in the agent’s session, then let it in. Letting it in adds it to this room.</p><div class="need-actions"><button data-action="join-refuse" data-id="${id}">Refuse</button><button class="go" data-action="join-approve" data-id="${id}">Let in</button></div><div class="need-meta">${expires}</div></div>`;
}

// A review request is not a question: it needs a verdict on an exact revision, which the page's answer form cannot give.
// The card names it and sends the human to Work, where the exact revision is reviewed and accepted (Codex, seq 39).
export function renderNeedsReview(review) {
  const id = esc(String(review?.id ?? ''));
  const from = esc(labelOf(review?.from));
  const item = review?.item ? `<p class="needs-item">${esc(review.item)}</p>` : '';
  const revision = review?.target?.revision !== undefined && review?.target?.revision !== null ? `Revision ${esc(review.target.revision)}` : '';
  const when = review?.at ? `<time datetime="${esc(review.at)}">${esc(clock(review.at))}</time>` : '';
  return `<div class="need needs-review" data-review-id="${id}"><div class="need-top">${icon(ICONS.eye, 13)}Review needed</div><h3>${from} asks for a verdict</h3>${item}<p>${esc(review?.text ?? '')}</p><div class="need-actions one"><button data-view="work">Review: open it in Work</button></div><div class="need-meta">${revision}${revision && when ? ' · ' : ''}${when}</div></div>`;
}

export function confirmedTask({ outcome, scope, acceptanceText }) {
  const acceptance = String(acceptanceText ?? '').split(/\r?\n/).map(v => v.trim()).filter(Boolean);
  outcome = String(outcome ?? '').trim(); scope = String(scope ?? '').trim();
  if (!outcome || outcome.length > 2000 || !scope || scope.length > 2000 || !acceptance.length || acceptance.length > 10 || acceptance.some(v => v.length > 500)) throw new Error('Add an outcome, scope and 1–10 acceptance criteria (one per line, up to 500 characters each).');
  return { outcome, scope, acceptance };
}

// Work requests: who it is from, what it targets, one slot per recipient with its verdict, and Accept when answered.
const VERDICTS = { approve: ['approve', 'approve'], approved: ['approve', 'approve'], changes_requested: ['object', 'object'], object: ['object', 'object'], declined: ['declined', 'declined'], withdrawn: ['withdrawn', 'waiting'] };
export function requestSlots(request) {
  const responses = request.responses ?? [];
  const names = namesOf(request.to).filter(name => !human(name));
  const slots = names.map(name => {
    const response = responses.find(r => [r.from, r.agent, r.respondent].map(nameOf).includes(name));
    if (!response) return { name, verdict: 'waiting', tone: 'waiting', answered: false };
    const [verdict, tone] = VERDICTS[response.verdict] ?? VERDICTS[response.outcome] ?? ['answered', 'answered'];
    return { name, verdict, tone, answered: true };
  });
  for (const response of responses) { const name = nameOf(response.from ?? response.agent ?? response.respondent ?? ''); if (name && !slots.some(slot => slot.name === name)) { const [verdict, tone] = VERDICTS[response.verdict] ?? VERDICTS[response.outcome] ?? ['answered', 'answered']; slots.push({ name, verdict, tone, answered: true }); } }
  return slots;
}
export function requestState(request) {
  if (request.accepted) return ['Accepted', 'closed'];
  if (request.targetSuperseded) return ['Superseded', 'closed'];
  if (readyToAccept(request)) return ['Ready to accept', 'ready'];
  if (closedRequest(request)) return [String(request.state ?? 'Closed').replace(/^./, c => c.toUpperCase()), 'closed'];
  return ['Open', 'open'];
}
const requestTarget = request => request.target?.path ?? request.target?.artifactId ?? request.title ?? request.text ?? `Request to ${namesOf(request.to).join(', ') || 'the crew'}`;
export function renderWorkCard(request, agents = [], { compact = false } = {}) {
  const [stateText, tone] = requestState(request); const slots = requestSlots(request); const id = requestId(request);
  const code = !!(request.target?.path ?? request.target?.artifactId);
  const rev = request.target?.revision !== undefined && request.target?.revision !== null ? `R${request.target.revision}` : '';
  const from = request.from ? nameOf(request.from) : '';
  const meta = `<span>${esc(request.purpose ? String(request.purpose).replace(/^./, c => c.toUpperCase()) : 'Request')} · ${esc(id)}</span>${from ? `<span>from <span class="ink ${tc(agents, from)}">${esc(labelOf(from))}</span>${request.at ? ` · ${esc(clock(request.at))}` : ''}</span>` : ''}`;
  const slotList = `<div class="slot-list">${slots.map(slot => `<span class="slot-item"><span class="dot ${tc(agents, slot.name)}"></span>${esc(slot.name)}<span class="v v-${esc(slot.tone)}">${esc(slot.verdict)}</span></span>`).join('')}</div>`;
  if (compact) return `<div class="card open-card" data-request-id="${esc(id)}"><div class="work-meta">${meta}<span class="st-open">${esc(stateText)}</span></div><div class="work-target">${esc(requestTarget(request))}${rev ? ` <span>${esc(rev)}</span>` : ''}</div>${slotList}</div>`;
  const details = `${request.title && request.text && request.title !== request.text ? `<p>${esc(request.text)}</p>` : ''}${(request.responses ?? []).map(response => `<div class="work-response"><strong>${esc(labelOf(response.from ?? response.agent ?? response.respondent ?? response.respondentId ?? 'Response'))}${response.verdict ? ` · ${esc(String(response.verdict).replaceAll('_', ' '))}` : ''}</strong>${esc(response.text)}</div>`).join('')}${request.targetSuperseded ? '<p>This revision has been superseded. A new review is needed.</p>' : ''}`;
  return `<article class="card work-card" data-request-id="${esc(id)}"><div><div class="work-meta">${meta}</div><div class="work-target${code ? ' code' : ''}">${esc(requestTarget(request))}${rev ? ` <span>${esc(rev)}</span>` : ''}</div>${slotList}</div><div class="work-side"><span class="work-state ${esc(tone)}">${esc(stateText)}</span>${readyToAccept(request) ? `<button class="btn inverted" data-action="accept" data-id="${esc(id)}">Accept</button>` : ''}</div>${details ? `<details class="work-more"><summary>Request and responses</summary>${details}</details>` : ''}</article>`;
}
export function renderWorkGroups(requests = [], agents = []) {
  if (!requests.length) return '<p class="empty">No requests in this room yet. Structured requests and their results appear here as the crew works.</p>';
  const groups = [['Ready to accept', requests.filter(readyToAccept)], ['Open', requests.filter(r => !readyToAccept(r) && !closedRequest(r))], ['Closed', requests.filter(r => !readyToAccept(r) && closedRequest(r))]];
  return groups.filter(([, list]) => list.length).map(([title, list]) => `<section class="group"><div class="group-title">${esc(title)} · ${list.length}</div>${list.map(request => renderWorkCard(request, agents)).join('')}</section>`).join('');
}

const STANCES = { approve: ['agree', 'agree'], changes_requested: ['Has concerns', 'disagree'], requested: ['asked', 'asked'], declined: ['declined review', 'unsure'], withdrawn: ['withdrawn', 'unsure'] };
export function renderRecommendations(state) {
  const items = state.recommendations ?? []; const agents = state.agents ?? [];
  if (!items.length) return '<p class="empty">No open recommendations. Ask the crew what’s next: their proposals and independent positions appear here for you to consider.</p>';
  const field = (label, value) => `<div class="rec-field"><strong>${esc(label)}</strong><p>${esc(value)}</p></div>`;
  return items.map(item => {
    const p = item.payload; const open = item.disposition === 'open';
    const valid = Boolean(p && p.v === 1 && Array.isArray(p.acceptance) && Array.isArray(p.evidence) && item.target?.artifactId && item.target?.digest);
    const adoption = item.adoption; const author = nameOf(item.author);
    const blocked = !valid || !open || Number(state.storeVersion ?? 0) < 5;
    const askBlocked = !valid || !agents.some(a => a.name !== author);
    const positions = (item.positions ?? []).map(position => { const [stance, tone] = STANCES[position.state] ?? [position.state, 'unsure']; const from = nameOf(position.from);
      return `<div class="position${position.state === 'changes_requested' ? ' objection' : ''}"><span class="dot ${tc(agents, from)}"></span><span class="nm">${esc(from)}</span><span class="stance v-${esc(tone)}">${esc(stance)}</span><span class="note">${esc(position.text ?? '')}</span></div>`; }).join('');
    const why = valid ? p.why ?? p.gap ?? p.outcome : '';
    return `<article class="card rec" data-suggestion="${esc(item.itemId)}"><div class="rec-from">${valid && p.kind === 'idea' ? 'Idea' : valid ? 'Gap' : 'Proposal needs correction'} · From <span class="ink ${tc(agents, author)}">${esc(author)}</span>${item.target ? ` · Revision ${esc(item.target.revision)}` : ''}${open ? '' : ` · ${esc(item.disposition)}`}</div><h3>${esc(item.title)}</h3>${valid ? `${why ? `<p class="rec-why">${esc(why)}</p>` : ''}<details><summary>Outcome, scope, evidence and acceptance</summary>${field('Gap or opportunity', p.gap)}${field('Proposed outcome', p.outcome)}${field('Why now', p.why)}${field('Expected payoff', p.payoff)}${field('Scope', p.scope)}<div class="rec-field"><strong>Estimated effort · impact</strong><p>${esc(p.effort)} · ${esc(p.impact)}</p></div><div class="rec-field"><strong>Acceptance criteria</strong><ul>${p.acceptance.map(v => `<li>${esc(v)}</li>`).join('')}</ul></div><div class="rec-field"><strong>Evidence</strong>${p.evidence.length ? `<ul>${p.evidence.map(v => `<li>${esc(v)}</li>`).join('')}</ul>` : '<p>No evidence supplied.</p>'}</div></details>` : `<p class="rec-error">${esc(item.payloadError || 'The proposal format needs correction before it can become a task.')}</p><details open><summary>Original proposal</summary><pre>${esc(item.rawText ?? 'Original text is not available from the host.')}</pre></details>`}${positions ? `<div class="positions">${positions}</div>` : '<p class="rec-note">No independent position yet.</p>'}${adoption ? `<div class="adoption"><strong>Task created for ${esc(nameOf(adoption.assignee))}</strong><p>${esc(({ owed: 'Awaiting the agent’s response. Delivery follows the run and session controls.', answered: 'The agent answered. Review its result in Work requests.', declined: 'The agent declined the assignment.', withdrawn: 'This assignment was withdrawn.' })[adoption.assignment] ?? 'Assignment saved. Its delivery follows the run and agent session controls.')}</p><code>${esc(adoption.taskItemId)}</code></div>` : ''}${item.dismissal ? `<p class="rec-note">${esc(nameOf(item.dismissal.by))}: ${esc(item.dismissal.reason)}</p>` : ''}${open ? `<div class="rec-actions"><button class="btn inverted" data-action="adopt-suggestion" data-id="${esc(item.itemId)}" data-blocked="${blocked}"${blocked ? ' disabled' : ''}>Make it a task</button><button class="btn" data-action="ask-position" data-id="${esc(item.itemId)}" data-blocked="${askBlocked}"${askBlocked ? ' disabled' : ''}>Ask another agent</button><button class="btn push" data-action="dismiss-suggestion" data-id="${esc(item.itemId)}">Dismiss</button></div>${valid && Number(state.storeVersion ?? 0) < 5 ? '<p class="rec-note">Review the saved-data upgrade before creating a task.</p>' : ''}` : ''}<p class="ref">${esc(item.itemId)}${item.target ? ` · ${esc(item.target.artifactId)} R${esc(item.target.revision)} · ${esc(item.target.digest)}` : ''}</p></article>`;
  }).join('');
}

export function renderWhatNext(batches = []) {
  return (batches ?? []).slice(-5).reverse().map(batch => `<div class="card what-next-batch"><strong>Project assessment</strong><time datetime="${esc(batch.at)}">${esc(clock(batch.at))}</time><ul>${(batch.leads ?? []).map(lead => `<li>${esc(lead.name)} · ${esc(({ owed: 'Waiting for a response', answered: 'Answered', declined: 'Declined', withdrawn: 'Request withdrawn' })[lead.state] ?? lead.state)}${lead.suggestionIds?.length ? ` · ${esc(lead.suggestionIds.length)} suggestion references` : ''}</li>`).join('')}</ul></div>`).join('');
}

const sourceLabels = { none: 'No cited paths', present: 'Present at last check', missing: 'Missing or excluded', changed: 'Changed since the map was last updated', unchecked: 'Unchecked' };
const mapCheckCurrent = map => map.check?.forDigest === map.digest && map.check?.forMtimeMs === map.mtimeMs;
const checkedSource = (map, node) => map.check && mapCheckCurrent(map) ? map.check.sources?.[node.id] : null;

export function mapSelection(map, query = '') {
  const nodes = map?.nodes ?? []; const flows = map?.flows ?? []; const needle = query.trim().toLocaleLowerCase();
  if (!needle) return { nodes, flows };
  const matched = new Set(nodes.filter(n => [n.id, n.label, n.kind, ...(n.paths ?? [])].some(v => String(v).toLocaleLowerCase().includes(needle))).map(n => n.id));
  const context = new Set(matched);
  for (const flow of flows) if (matched.has(flow.from) || matched.has(flow.to)) { context.add(flow.from); context.add(flow.to); }
  return { nodes: nodes.filter(n => context.has(n.id)), flows: flows.filter(f => context.has(f.from) && context.has(f.to)) };
}

// A bounded breadth-first layout for the canvas: 170×52 parts in up to five ranks. Cycles/disconnected components get a
// deterministic root; links keep their actual direction. All entries remain available in the list, beyond this bound.
export const NODE_W = 170; export const NODE_H = 52;
export function layoutMap(map, query = '') {
  const selected = mapSelection(map, query); const nodes = selected.nodes.slice(0, 80); const ids = new Set(nodes.map(n => n.id));
  const flows = selected.flows.filter(f => ids.has(f.from) && ids.has(f.to)).slice(0, 240);
  const incoming = new Set(flows.map(f => f.to)); const outgoing = new Map(nodes.map(n => [n.id, []]));
  for (const flow of flows) outgoing.get(flow.from)?.push(flow.to);
  const ranks = new Map();
  const walk = root => { if (ranks.has(root)) return; ranks.set(root, 0); const queue = [root]; for (let i = 0; i < queue.length; i++) for (const to of outgoing.get(queue[i]) ?? []) if (!ranks.has(to)) { ranks.set(to, Math.min(4, ranks.get(queue[i]) + 1)); queue.push(to); } };
  nodes.filter(n => !incoming.has(n.id)).forEach(n => walk(n.id)); nodes.forEach(n => walk(n.id));
  const rows = [0, 0, 0, 0, 0];
  const placed = nodes.map(n => { const rank = ranks.get(n.id); return { ...n, x: 30 + rank * 230, y: 30 + rows[rank]++ * 104 }; });
  return { nodes: placed, flows, width: Math.max(300, ...placed.map(n => n.x + NODE_W + 30)), height: Math.max(200, ...placed.map(n => n.y + NODE_H + 30)), totalNodes: selected.nodes.length, totalFlows: selected.flows.length };
}
const nodeStatus = (map, node) => checkedSource(map, node)?.state ?? ((node.paths ?? []).length ? 'unchecked' : 'none');

function nodeCard(map, node) {
  const source = checkedSource(map, node); const paths = source?.paths ?? (node.paths ?? []).map(path => ({ path, state: 'unchecked' }));
  return `<article class="card map-node-card"><div><span class="map-kind">${esc(node.kind)}</span><code class="ref">${esc(node.id)}</code></div><h3>${esc(node.label)}</h3><p class="map-source s-${esc(source?.state ?? 'unchecked')}" data-source="${esc(source?.state ?? 'unchecked')}">${esc(sourceLabels[source?.state ?? (paths.length ? 'unchecked' : 'none')])}</p>${paths.length ? `<ul class="map-paths">${paths.map(p => `<li><code>${esc(p.path)}</code><span>${esc(sourceLabels[p.state] ?? sourceLabels.unchecked)}</span></li>`).join('')}</ul>` : '<p class="map-note">This part has no cited files or folders.</p>'}</article>`;
}
// The popover for the selected part: its path, owner, status, flows, and Ask. The page positions it beside the part.
function nodePopover(map, node, agents) {
  const flows = (map.flows ?? []).filter(f => f.from === node.id || f.to === node.id); const status = nodeStatus(map, node);
  const owner = node.owner ? nameOf(node.owner) : '';
  return `<div class="pop node-pop" id="map-node-detail" tabindex="-1" data-pop-for="${esc(node.id)}"><h3>${esc(node.label)}</h3><div class="n-path">${esc((node.paths ?? []).join(', ') || node.id)}</div><div class="rows"><div><span>Owner</span>${owner ? `<span class="dot ${tc(agents, owner)}"></span>${esc(owner)}` : 'Not recorded'}</div><div><span>Status</span><span class="s-${esc(status)}">${esc(sourceLabels[status])}</span></div><div><span>Flows</span>${esc(flows.length)}</div></div>${flows.length ? `<details><summary>Connected flows</summary><ul class="map-connections">${flows.map(f => `<li><code>${esc(f.from)} → ${esc(f.to)}</code><span>${esc(f.label)}</span></li>`).join('')}</ul></details>` : ''}<button class="btn primary" data-map="ask" data-id="${esc(node.id)}">${icon(ICONS.room, 13)}Ask ${esc(owner || 'an agent')}</button></div>`;
}

// The canvas: a 2D world of parts and flows the page pans and zooms. Positions travel as data and are applied with
// CSSOM, because the page's CSP allows no style attributes.
export function renderMapFlow(map, query = '', { selected = '', agents = [] } = {}) {
  const graph = layoutMap(map, query); if (!graph.nodes.length) return '<p class="map-note">No parts match this search.</p>';
  const positions = new Map(graph.nodes.map(n => [n.id, n]));
  const touches = f => selected && (f.from === selected || f.to === selected);
  const centre = n => [n.x + NODE_W / 2, n.y + NODE_H / 2];
  const lines = graph.flows.map(f => { const [x1, y1] = centre(positions.get(f.from)); const [x2, y2] = centre(positions.get(f.to)); return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"${touches(f) ? ' class="on"' : ''}/>`; }).join('');
  const labels = graph.flows.filter(f => f.from !== f.to).map(f => { const [x1, y1] = centre(positions.get(f.from)); const [x2, y2] = centre(positions.get(f.to)); return `<span class="edge-label${touches(f) ? ' on' : ''}" data-x="${(x1 + x2) / 2}" data-y="${(y1 + y2) / 2}" title="${esc(f.label)}">${esc(String(f.label).length > 25 ? String(f.label).slice(0, 24) + '…' : f.label)}</span>`; }).join('');
  const nodes = graph.nodes.map(n => { const status = nodeStatus(map, n); const owner = n.owner ? nameOf(n.owner) : '';
    return `<button type="button" class="map-node${status === 'changed' ? ' changed' : status === 'missing' ? ' missing' : ''}${n.id === selected ? ' selected' : ''}" data-map-node="${esc(n.id)}" data-x="${n.x}" data-y="${n.y}" aria-label="Inspect ${esc(n.label)}" title="${esc(n.label)} · ${esc(n.kind)}"><span class="n-label"><span>${esc(n.label)}</span>${owner ? `<span class="dot ${tc(agents, owner)}" title="${esc(owner)}"></span>` : ''}</span><span class="n-path">${esc((n.paths ?? [])[0] ?? n.kind)}</span></button>`; }).join('');
  const chosen = graph.nodes.find(n => n.id === selected);
  return `${graph.totalNodes > graph.nodes.length || graph.totalFlows > graph.flows.length ? `<p class="map-bound">Showing ${graph.nodes.length} of ${graph.totalNodes} parts and ${graph.flows.length} of ${graph.totalFlows} flows. Search for a part to narrow the view, or use List for every entry.</p>` : ''}<div class="map-canvas" id="map-canvas" tabindex="0" role="region" aria-label="Project map: ${graph.nodes.length} parts and ${graph.flows.length} flows. Drag to pan, scroll to zoom; Tab to a part and press Enter for details."><div class="map-world" id="map-world" data-w="${graph.width}" data-h="${graph.height}"><svg viewBox="0 0 ${graph.width} ${graph.height}" width="${graph.width}" height="${graph.height}" aria-hidden="true">${lines}</svg>${labels}${nodes}</div><div class="map-legend" aria-hidden="true"><span><i class="changed"></i>Changed this run</span><span><i></i>Present</span><span>Drag to pan · scroll to zoom</span></div><div class="map-controls" data-map-controls><button type="button" data-map="out" title="Zoom out" aria-label="Zoom out">${icon(ICONS.minus, 14)}</button><span class="pct" id="map-pct">100%</span><button type="button" data-map="in" title="Zoom in" aria-label="Zoom in">${icon(ICONS.plus, 14)}</button><span class="sep"></span><button type="button" data-map="fit" title="Fit to view">Fit</button><button type="button" data-map="full" id="map-full" title="Full screen (F)" aria-label="Full screen">${icon(ICONS.max, 14)}</button></div>${chosen ? nodePopover(map, chosen, agents) : ''}</div>`;
}

export function renderProjectMap(map, { mode = 'flow', query = '', selected = '', agents = [] } = {}) {
  if (!map) return '<p class="map-note">Create a room to start its project map.</p>';
  const selection = mapSelection(map, query); const check = map.check ?? {}; const current = mapCheckCurrent(map);
  const checked = check.checkedAt ? new Date(check.checkedAt).toLocaleString() : null;
  const coverage = check.coverage;
  const sourceSummary = !current ? 'Unchecked for this version of the map.' : check.state === 'checking' ? 'Checking cited paths…' : `Last checked ${checked ?? 'time unavailable'}.${check.result === 'incomplete' ? ` Check incomplete: ${check.reason ?? 'a bound was reached'}.` : ''}`;
  const update = map.update;
  const editedAt = map.outside ? map.modifiedAt : map.updatedAt;
  const warnings = `${map.readError ? `<div class="map-warning" role="status"><strong>The map could not be read.</strong><p>${esc(map.readError)}</p><p>The last readable view is shown.</p></div>` : ''}${update ? `<div class="map-update-status" role="status"><strong>Update requested from ${esc(update.lead)}</strong><span>${esc({ owed: 'Waiting for a response', answered: 'Answered', declined: 'Declined', withdrawn: 'Withdrawn' }[update.state] ?? update.state)}</span>${update.text ? `<p>${esc(update.text)}</p>` : ''}</div>` : ''}`;
  const extra = `<div class="map-extra"><div class="map-file"><code>${esc(map.path)}</code><span>${map.outside ? 'Edited outside Peerloom' : map.updatedBy ? `Updated by ${esc(map.updatedBy)}` : map.exists ? 'Project file' : 'Not created yet'}${editedAt ? ` · ${esc(new Date(editedAt).toLocaleString())}` : ''}</span></div><div class="map-health"><section class="card"><h3>Cited sources</h3><p>${esc(sourceSummary)}</p><small>Checks path presence and file timestamps. A folder’s presence does not check its contents.</small></section><section class="card"><h3>Inventory coverage</h3>${coverage ? `<p>${coverage.uncited} of ${coverage.files} inventoried files are uncited.${!current ? ' Previous check; the map has changed.' : ''}</p><small>${coverage.state === 'complete' ? 'Inventory finished within the check bounds.' : `Incomplete: ${esc(coverage.reason ?? 'a check bound was reached')}`}</small><details><summary>Coverage by folder</summary><ul>${(coverage.byArea ?? []).map(a => `<li><code>${esc(a.area === '.' ? 'Root files' : a.area)}</code><span>${a.uncited} / ${a.files} uncited</span></li>`).join('')}</ul></details>` : `<p>${check.state === 'checking' ? 'Checking the workspace…' : 'Not checked yet.'}</p>`}<small>Inventory coverage does not establish that the map describes every relevant part.</small></section></div>${map.errors?.length ? `<details class="map-errors" open><summary>${map.errors.length} map ${map.errors.length === 1 ? 'line needs' : 'lines need'} attention</summary><p>These lines are kept in the file. Valid parts remain usable.</p><ul>${map.errors.map(e => `<li><strong>Line ${e.line}: ${esc(e.reason)}</strong><code>${esc(e.text)}</code></li>`).join('')}</ul></details>` : ''}</div>`;
  if (!map.nodes?.length) return `${warnings}<div class="map-empty"><h3>Your project, connected.</h3><p>This room has no map yet. Update map asks an agent to draw the project’s parts and the flows between them.</p><p>You can also edit agentlink-map.txt in the project folder.</p></div>${extra}`;
  const tools = `<div class="map-tools"><div class="map-mode" role="group" aria-label="Map display"><button type="button" data-map="mode" data-mode="flow" aria-pressed="${mode === 'flow'}">Canvas</button><button type="button" data-map="mode" data-mode="list" aria-pressed="${mode === 'list'}">List</button></div><span>${selection.nodes.length} ${selection.nodes.length === 1 ? 'part' : 'parts'} · ${selection.flows.length} ${selection.flows.length === 1 ? 'flow' : 'flows'}</span><form id="map-search-form" class="map-search" role="search"><label class="sr-only" for="map-query">Find a part</label><input id="map-query" name="query" type="search" maxlength="120" value="${esc(query)}" placeholder="Find a part, kind or path"><button class="btn outline" type="submit">Find</button></form></div>`;
  const body = mode === 'flow' ? renderMapFlow(map, query, { selected, agents }) : `<div class="map-node-list">${selection.nodes.map(n => nodeCard(map, n)).join('') || '<p class="map-note">No parts match this search.</p>'}</div><section class="map-flow-list"><h3>Flows</h3><ul>${selection.flows.map(f => `<li><code>${esc(f.from)} → ${esc(f.to)}</code><span>${esc(f.label)}</span></li>`).join('') || '<li>No flows in this view.</li>'}</ul></section>`;
  return `${warnings}${tools}${body}${extra}`;
}

// What the human must decide, across the room: the tab title and the favicon dot count these.
export function needsCount(state) {
  return (state.approvals ?? []).length + (state.joins ?? []).length + (state.needsYou?.questions ?? []).length + (state.needsYou?.reviews ?? []).length + (state.requests ?? []).filter(readyToAccept).length + (budgetAttention(state) ? 1 : 0);
}

if (typeof document !== 'undefined') initializePage();

function initializePage() {
  const $ = selector => document.querySelector(selector);
  const dialog = $('#dialog');
  const key = 'agentlink.browser-control';
  let token = new URLSearchParams(location.hash.slice(1)).get('k') ?? '';
  try {
    if (token) sessionStorage.setItem(key, token);
    else token = sessionStorage.getItem(key) ?? '';
  } catch { /* A restricted browser can still use the original launch link. */ }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  let state = { room: null, agents: [], messages: [], approvals: [], requests: [], eventId: 0 };
  let connected = false;
  const VIEWS = [['room', 'Conversation'], ['work', 'Work'], ['map', 'Map'], ['recommendations', 'Ideas'], ['activity', 'Activity']];
  const ui = { view: 'room', crewOpen: true, focusAgent: '', recipient: undefined, post: false, noReply: false, mention: null, mentionIndex: 0, toOpen: false, connOpen: false,
    unseen: 0, atBottom: true, seenCount: 0, mapMode: 'flow', mapQuery: '', mapSelected: '', mapView: null, mapFull: false, askNode: '', askAgent: '', lastEventAt: null };
  const asks = new Map();
  const outbox = [];
  let stopped = false;
  let lastEventId = 0;
  let refreshTimer;
  let toastTimer;
  let activeController;
  let dialogHandler;
  let retryWait;
  const logs = [];
  const questionDrafts = new Map();
  const needsDrafts = new Map();
  const needsKeys = new Map();
  const pageKey = () => globalThis.crypto?.randomUUID?.() ?? `page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // One idempotency key per distinct answer, so pressing Send again after a lost response records one response.
  const needsKey = (id, outcome, value) => { const signature = JSON.stringify([id, outcome, value]); const entry = needsKeys.get(id); if (entry?.signature === signature) return entry.key; const next = { signature, key: pageKey() }; needsKeys.set(id, next); return next.key; };
  const rendered = new Map();
  const pending = new Set();
  const setHTML = (selector, html) => { if (rendered.get(selector) === html) return false; rendered.set(selector, html); $(selector).innerHTML = html; return true; };
  const text = (selector, value) => { $(selector).textContent = String(value ?? ''); };
  const agents = () => state.agents ?? [];
  const runState = () => state.run?.state ?? 'idle';

  // ── Theme: persisted per browser; dark by default ──
  let theme = 'dark';
  try { theme = localStorage.getItem('peerloom-theme') === 'light' ? 'light' : 'dark'; } catch { /* storage may be blocked */ }
  function applyTheme() {
    document.documentElement.dataset.theme = theme;
    const next = theme === 'dark' ? 'light' : 'dark'; const button = $('#theme-button');
    button.innerHTML = icon(theme === 'dark' ? ICONS.sun : ICONS.moon); button.title = `Switch to ${next} theme`; button.setAttribute('aria-label', `Switch to ${next} theme`);
  }
  applyTheme();

  function toast(message, error = false) {
    clearTimeout(toastTimer);
    const box = $('#toast');
    box.textContent = message;
    box.classList.toggle('error', error);
    box.hidden = false;
    toastTimer = setTimeout(() => { box.hidden = true; }, error ? 8000 : 2600);
  }
  async function copyText(value) {
    if (!value) return;
    try { if (typeof navigator !== 'undefined' && navigator.clipboard) { await navigator.clipboard.writeText(value); toast('Copied.'); return; } } catch { /* fall back to selecting the text */ }
    const area = document.createElement('textarea'); area.value = value; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.append(area); area.select();
    let copied = false; try { copied = document.execCommand('copy'); } catch { copied = false; }
    toast(copied ? 'Copied.' : 'Copy failed. Select the line and copy it.', !copied);
    area.remove();
  }
  function connection(online, message = '') {
    const was = connected; connected = online;
    $('#user').classList.toggle('offline', !online);
    $('#banner').hidden = online;
    text('#banner-title', message ? message : 'Reconnecting to the hub.');
    text('#banner-text', message ? '' : 'Anything you send is kept and delivered when it’s back.');
    for (const element of document.querySelectorAll('button[data-action], #dialog button[type="submit"]')) element.disabled = !online || element.dataset.blocked === 'true';
    renderHub();
    if (online && !was && outbox.length) void flushOutbox();
  }
  async function api(path, payload) {
    const response = await fetch(path, { method: payload === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    let body;
    try { body = await response.json(); } catch { throw new Error('The local host returned an unreadable response.'); }
    if (!response.ok || body.ok === false) {
      const error = new Error(body.error?.message ?? `The local host refused this action (${response.status}).`);
      error.status = response.status;
      error.code = body.error?.code;
      throw error;
    }
    return body;
  }
  async function refresh() {
    const snapshot = await api('/api/state');
    state = { agents: [], messages: [], approvals: [], requests: [], ...snapshot }; ui.loaded = true;
    lastEventId = Number.isSafeInteger(snapshot.eventId) ? snapshot.eventId : lastEventId;
    for (const notice of snapshot.notices ?? []) addLog(notice.level ?? 'info', 'Hub', notice.text ?? '', notice.at, `notice:${notice.id}`);
    for (const output of snapshot.outputs ?? []) addLog('output', output.agent ?? 'Agent', output.text ?? '', output.at, `output:${output.id}`);
    render();
  }
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh().catch(error => toast(error.message, true)); }, 100);
  }
  function addLog(type, who, message, at = new Date().toISOString(), id) {
    if (id !== undefined && logs.some(log => log.id === id)) return;
    logs.push({ type, who, message, at, id });
    if (logs.length > 200) logs.shift();
    renderActivity(); if (ui.askNode) renderAsk();
  }
  function receive(frame) {
    if (frame.id !== undefined && frame.id <= lastEventId) return;
    const event = frame.data;
    if (!event || typeof event !== 'object') return;
    if (event.type === 'reset') return 'reset';
    ui.lastEventAt = new Date();
    state = applyRoomEvent(state, event);
    if (frame.id !== undefined) { lastEventId = frame.id; state.eventId = frame.id; }
    if (event.type === 'output') addLog('output', event.agent ?? 'Agent', event.text ?? '', event.at, `output:${event.id ?? frame.id}`);
    if (event.type === 'notice') {
      addLog(event.level ?? 'info', 'Hub', event.text ?? '', event.at, `notice:${event.id ?? frame.id}`);
      if (event.level === 'warn' || event.level === 'error') toast(event.text, event.level === 'error');
    }
    if (event.type === 'answered') { addLog('answered', 'Hub', event.text ?? event.id ?? 'A result is ready: open Work to review it.', event.at, frame.id); scheduleRefresh(); }
    if (event.type === 'requests' || event.type === 'questions' || event.type === 'joins' || event.type === 'recommendations' || event.type === 'room' || event.type === 'map') scheduleRefresh();
    if (['message', 'agent', 'approval', 'approval_done', 'run', 'receipts', 'activity'].includes(event.type)) render();
  }
  async function follow() {
    if (!token) { connection(false, 'Open the browser link printed by peerloom. That link connects this page to your local room.'); return; }
    while (!stopped) {
      activeController = new AbortController();
      try {
        await refresh();
        const response = await fetch('/api/events', { headers: { Authorization: `Bearer ${token}`, 'Last-Event-ID': String(lastEventId) }, cache: 'no-store', signal: activeController.signal });
        if (!response.ok || !response.body) {
          const error = new Error('The event connection was interrupted.');
          error.status = response.status;
          throw error;
        }
        connection(true); ui.lastEventAt = new Date();
        const parser = new EventStreamParser();
        const reader = response.body.getReader();
        let reset = false;
        try {
          while (!stopped && !reset) {
            const { value, done } = await reader.read();
            for (const event of parser.push(value, done)) if (receive(event) === 'reset') { reset = true; break; }
            if (done) throw new Error('The local host disconnected. Reconnecting…');
          }
        } finally { await reader.cancel().catch(() => {}); }
        if (reset) continue;
      } catch (error) {
        if (stopped) return;
        connection(false, error.status === 401 || error.status === 403 ? 'This launch link has expired. Open the browser link printed by the running peerloom console.' : undefined);
        await new Promise(resolve => { retryWait = resolve; setTimeout(resolve, 2000); });
      }
    }
  }

  // ── Sidebar ──
  function renderSide() {
    const room = state.room; const run = state.run; const rs = runState();
    const badge = name => (state.approvals ?? []).filter(a => a.agent === name).length;
    const crew = ui.crewOpen && room ? `<div class="crew">${agents().map(agent => renderAgentCard(agent, rs, state.activity ?? [], { agents: agents(), badge: badge(agent.name), focused: ui.focusAgent === agent.name })).join('')}<button class="side-add" data-action="invite">${icon(ICONS.plus, 12)}Invite agent</button></div>` : '';
    const label = !run ? 'Not started' : rs === 'running' ? `Run ${run.number}` : rs === 'paused' ? 'Paused' : rs === 'ended' ? 'Ended' : `Run ${run.number}`;
    const rooms = room ? `<div><button type="button" class="room-row active${ui.crewOpen ? ' open' : ''}" data-room-toggle aria-expanded="${ui.crewOpen}" title="${esc(room.workspace ?? '')}"><span class="dot ${rs === 'running' ? 'running' : 'idle'}"></span><span class="room-name">${esc(room.name)}</span><span class="room-run">${esc(label)}</span><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>${crew}</div>` : '';
    setHTML('#rooms', `${rooms}<button class="side-add room" data-action="create-room">${icon(ICONS.plus, 14)}New room</button>`);
    const wakes = $('#wakes'); wakes.hidden = !run?.limits;
    if (setHTML('#wakes', renderWakes(run, agents()))) for (const segment of wakes.querySelectorAll('[data-flex]')) segment.style.flex = segment.dataset.flex;
  }
  function renderHub() {
    const pop = $('#hub-pop'); pop.hidden = !ui.connOpen; $('#conn-button').setAttribute('aria-expanded', String(ui.connOpen));
    $('#conn-button').title = `${connected ? 'Connected' : 'Reconnecting'} to the local hub`;
    if (!ui.connOpen) return;
    pop.innerHTML = `<h3>Local hub</h3><div class="kv"><span>Status</span><span class="${connected ? 'ok' : 'warn'}">${connected ? 'Connected' : 'Reconnecting'}</span></div><div class="kv"><span>Address</span><span class="mono">${esc(location.host)}</span></div><div class="kv"><span>Last event</span><span>${esc(ui.lastEventAt ? clock(ui.lastEventAt) : '—')}</span></div><div class="kv"><span>Store</span><span>${state.storeVersion !== undefined ? `Version ${esc(state.storeVersion)}` : '—'}</span></div><hr><p>Rooms and messages stay on this machine.</p>`;
  }

  // ── Header, room line, title and favicon ──
  let faviconMark; let faviconShown;
  function renderFavicon(count) {
    const want = count > 0 ? 'dot' : 'plain'; if (faviconShown === want) return; faviconShown = want;
    const link = $('#favicon');
    if (!count) { link.href = '/mark.svg'; return; }
    const draw = () => { try { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64; const g = canvas.getContext('2d'); g.drawImage(faviconMark, 0, 0, 64, 64);
      g.beginPath(); g.arc(50, 14, 8, 0, Math.PI * 2); g.fillStyle = '#0E0A15'; g.fill(); g.beginPath(); g.arc(50, 14, 6, 0, Math.PI * 2); g.fillStyle = '#F5B14C'; g.fill(); link.href = canvas.toDataURL('image/png'); } catch { /* the plain mark stays */ } };
    if (faviconMark?.complete) draw(); else { faviconMark = new Image(); faviconMark.onload = () => { if (faviconShown === 'dot') draw(); }; faviconMark.src = '/mark.svg'; }
  }
  function renderHead() {
    const room = state.room; const run = state.run; const rs = runState();
    const counts = { work: (state.requests ?? []).filter(r => !closedRequest(r) || readyToAccept(r)).length, recommendations: (state.recommendations ?? []).filter(item => item.disposition === 'open').length };
    setHTML('#views', VIEWS.map(([view, label], i) => `<button type="button" class="view-tab${ui.view === view ? ' active' : ''}" id="tab-${view}" role="tab" aria-selected="${ui.view === view}" aria-controls="view-${view}" data-view="${view}" title="${label}${counts[view] ? ` · ${counts[view]}` : ''} (${i + 1})">${icon(ICONS[view])}<span class="nav-label">${label}</span>${counts[view] ? `<span class="count">${counts[view]}</span>` : ''}</button>`).join(''));
    $('#setup').hidden = !ui.loaded || Boolean(room); $('#room-line').hidden = !room;
    for (const [view] of VIEWS) $(`#view-${view}`).hidden = !room || ui.view !== view;
    text('#room-title', room?.name ?? ''); text('#room-objective', room?.objective || room?.workspace || '');
    $('#run-text').innerHTML = room ? `<span class="run-dot ${esc(rs)}"></span>${!run ? 'No run yet' : `Run ${esc(run.number)} ${esc(rs === 'running' ? 'running' : rs)}`}` : '';
    const group = $('#run-group'); group.hidden = !room; $('#invite-button').hidden = !room;
    const next = run ? (rs === 'ended' ? run.number + 1 : run.number) : 1;
    const pause = '<svg viewBox="0 0 24 24"><rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/></svg>'; const play = '<svg viewBox="0 0 24 24"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
    setHTML('#run-group', rs === 'running' ? `<button data-action="run" data-op="pause" title="Hold new work. Work already underway may continue. (P)">${pause}Pause</button><button class="end" data-action="end">${'<svg viewBox="0 0 24 24"><rect width="16" height="16" x="4" y="4" rx="2"/></svg>'}End</button>`
      : rs === 'paused' ? `<button data-action="run" data-op="resume" title="Resume (P)">${play}Resume</button><button class="end" data-action="end"><svg viewBox="0 0 24 24"><rect width="16" height="16" x="4" y="4" rx="2"/></svg>End</button>`
        : `<button data-action="run" data-op="start">${play}Start run${run ? ` ${esc(next)}` : ''}</button>`);
    const needs = needsCount(state);
    document.title = `${needs ? `(${needs}) ` : ''}${room?.name ?? 'Your room'} · Peerloom`;
    renderFavicon(needs);
  }

  // ── Conversation ──
  function renderMessages() {
    const container = $('#conversation');
    const messages = state.messages ?? [];
    const focus = ui.focusAgent && agents().some(a => a.name === ui.focusAgent) ? ui.focusAgent : '';
    setHTML('#lane', focus ? `<div class="lane-chip"><span class="dot ${tc(agents(), focus)}"></span>Showing ${esc(focus)}’s lane<button type="button" data-clear-focus>Clear</button></div>` : '');
    let previousDay;
    const items = messages.map(message => {
      const date = new Date(message.at);
      const day = Number.isNaN(date.valueOf()) ? '' : date.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
      const divider = day && previousDay && day !== previousDay ? `<div class="sys${focus ? ' dim' : ''}"><span class="gutter"><span></span></span><span class="sys-text">${esc(day)}</span></div>` : '';
      previousDay = day;
      return divider + renderMessage(message, agents(), { map: state.map, focus });
    });
    const queued = outbox.map(entry => renderMessage({ sequence: `local-${entry.id}`, from: 'human', to: entry.body.to ?? [], text: entry.body.text, at: entry.at, kind: entry.body.post ? 'post' : 'mail', noReply: entry.body.noReply }, agents(), { map: state.map, focus, queued: true }));
    const bubbles = (state.approvals ?? []).map(approval => renderApprovalBubble(approval, agents()));
    const typing = (state.activity ?? []).filter(entry => entry.state !== 'blocked' && agents().some(a => a.name === entry.name)).map(entry => `<div class="typing${focus && focus !== entry.name ? ' dim' : ''}"><span class="gutter"><span class="knot hollow ${tc(agents(), entry.name)}"></span></span><span class="dots" aria-hidden="true"><span></span><span></span><span></span></span><span>${esc(entry.name)} is ${entry.text ? `working on ${esc(entry.text)}` : 'working'}</span></div>`);
    const empty = !messages.length && !queued.length ? `<div class="sys"><span class="gutter"><span></span></span><span class="sys-text">${agents().length ? 'Give your crew a starting point: send a task or a question below.' : 'There’s room for your crew. Invite an agent, start a run, and send your first task.'}</span></div>` : '';
    const html = empty + items.join('') + queued.join('') + bubbles.join('') + typing.join('');
    const first = !rendered.has('#messages');
    const count = messages.length;
    if (setHTML('#messages', html)) {
      if (first || ui.atBottom || ui.forceBottom) { container.scrollTop = container.scrollHeight; ui.unseen = 0; }
      else if (count > ui.seenCount) ui.unseen += count - ui.seenCount;
      ui.forceBottom = false;
    }
    ui.seenCount = count;
    const pill = $('#unseen'); pill.hidden = !ui.unseen;
    if (ui.unseen) pill.innerHTML = `${icon(ICONS.down, 13)}${ui.unseen} new message${ui.unseen === 1 ? '' : 's'}`;
  }
  function renderComposer() {
    const field = $('#message-text'); const room = state.room;
    ui.recipient = defaultRecipient(agents(), ui.recipient);
    const { names, disabled } = composerMentionRoute(field.value, agents());
    const to = $('#to-button'); to.disabled = disabled || !agents().length;
    const target = disabled ? names : ui.recipient ? [ui.recipient] : [];
    to.innerHTML = `<span class="dot ${target.length === 1 ? tc(agents(), target[0]) : 'c0'}"></span>To ${esc(disabled ? names.map(n => `@${n}`).join(', ') : ui.recipient || 'Everyone')}${disabled ? '' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>'}`;
    to.title = disabled ? 'The mentions choose who receives this' : 'Choose who receives this';
    to.setAttribute('aria-expanded', String(ui.toOpen));
    const menu = $('#to-menu'); menu.hidden = !ui.toOpen || disabled;
    if (!menu.hidden) menu.innerHTML = recipientChoices(agents()).map(choice => `<button type="button" class="menu-item" role="option" aria-selected="${choice.value === ui.recipient}" data-to="${esc(choice.value)}"><span class="dot ${choice.value ? tc(agents(), choice.value) : 'c0'}"></span><span class="grow">${esc(choice.label)}</span><span class="check">${choice.value === ui.recipient ? '✓' : ''}</span></button>`).join('');
    field.placeholder = ui.recipient && !disabled ? `Message ${ui.recipient}…` : 'Give the crew a task, ask a question, or share an update…';
    field.disabled = !room;
    $('#post-toggle').setAttribute('aria-pressed', String(ui.post)); $('#noreply-toggle').setAttribute('aria-pressed', String(ui.noReply));
    $('#message-form').classList.toggle('has-draft', Boolean(field.value.trim()));
  }

  // ── Needs you and open work ──
  function renderNeeds() {
    const approvals = state.approvals ?? [];
    const joins = state.joins ?? [];
    const questions = state.needsYou?.questions ?? [];
    const reviews = state.needsYou?.reviews ?? [];
    const ready = (state.requests ?? []).filter(readyToAccept);
    const budget = renderBudgetAttention(state);
    const count = needsCount(state); const pill = $('#needs-count'); pill.hidden = !count; pill.textContent = String(count);
    const focused = document.activeElement;
    const focusedQuestion = focused?.closest?.('[data-question-form]') ? { form: focused.closest('[data-question-form]').dataset.questionForm, name: focused.name, start: focused.selectionStart, end: focused.selectionEnd } : null;
    const focusedNeeds = focused?.closest?.('[data-needs-form]') ? { form: focused.closest('[data-needs-form]').dataset.needsForm, start: focused.selectionStart, end: focused.selectionEnd } : null;
    // Typing a draft does not itself change the request. Avoid replacing an active form on unrelated room events.
    const signature = JSON.stringify([approvals, joins, questions, reviews, ready.map(requestId), budget, agents().map(a => a.name)]);
    if (rendered.get('needs-signature') === signature) return;
    rendered.set('needs-signature', signature);
    const firstDecision = approvals.find(a => a.kind === 'approval');
    const accept = ready.map(request => `<div class="need accept-card"><div><small>Ready to accept · ${esc(requestId(request))}</small><span class="mono">${esc(requestTarget(request))}</span></div><button class="btn outline" data-action="accept" data-id="${esc(requestId(request))}">Accept</button></div>`);
    const cards = [budget, ...joins.map(renderJoinCard), ...approvals.map(approval => renderApproval(approval, questionDrafts.get(String(approval.id)), { agents: agents(), first: approval === firstDecision })), ...questions.map(question => renderNeedsQuestion(question, needsDrafts.get(String(question.id)))), ...reviews.map(renderNeedsReview), ...accept];
    setHTML('#needs-list', cards.join('') || '<p class="all-clear">Nothing right now. The crew works when there’s work.</p>');
    if (focusedQuestion) {
      const form = [...document.querySelectorAll('[data-question-form]')].find(candidate => candidate.dataset.questionForm === focusedQuestion.form);
      const input = form?.elements.namedItem(focusedQuestion.name);
      if (input) { input.focus({ preventScroll: true }); if (input.setSelectionRange && focusedQuestion.start !== null) input.setSelectionRange(focusedQuestion.start, focusedQuestion.end); }
    }
    if (focusedNeeds) {
      const form = [...document.querySelectorAll('[data-needs-form]')].find(candidate => candidate.dataset.needsForm === focusedNeeds.form);
      const input = form?.querySelector('textarea[name="text"]');
      if (input) { input.focus({ preventScroll: true }); if (input.setSelectionRange && focusedNeeds.start !== null) input.setSelectionRange(focusedNeeds.start, focusedNeeds.end); }
    }
    for (const id of questionDrafts.keys()) if (!approvals.some(a => String(a.id) === id)) questionDrafts.delete(id);
    for (const id of needsDrafts.keys()) if (!questions.some(question => String(question.id) === id)) needsDrafts.delete(id);
  }
  function renderOpenWork() {
    const open = (state.requests ?? []).filter(r => !readyToAccept(r) && !closedRequest(r));
    setHTML('#open-work', open.slice(0, 6).map(request => renderWorkCard(request, agents(), { compact: true })).join('') || '<p class="all-clear">No open requests.</p>');
  }
  function renderWork() { setHTML('#work-list', renderWorkGroups(state.requests ?? [], agents())); }
  function renderActivity() {
    setHTML('#activity-list', [...logs].reverse().map(log => { const who = log.who === 'Hub' ? 'Hub' : nameOf(log.who);
      return `<div class="act-row"><time datetime="${esc(log.at)}">${esc(clock(log.at))}</time><span class="act-who ${who === 'Hub' ? 'cn' : tc(agents(), who)}"><span class="dot"></span>${esc(who)}</span><span class="act-text${log.type === 'warn' || log.type === 'error' ? ` ${esc(log.type)}` : ''}">${richText(log.message, { agents: agents(), map: state.map })}</span></div>`; }).join('') || '<p class="empty">A quiet room. Session output and hub updates from this visit appear here.</p>');
  }
  function renderSuggestions() {
    setHTML('#recommendation-list', renderRecommendations(state));
    setHTML('#what-next-status', renderWhatNext(state.whatNext));
    const upgrade = state.room && (state.upgrade?.needed || Number(state.storeVersion ?? 5) < 5);
    setHTML('#upgrade-attention', upgrade ? '<div class="card rec"><h3>Enable task adoption for this workspace</h3><p class="rec-why">Your saved data needs an upgrade. Review the backup and affected rooms before continuing.</p><div class="rec-actions"><button class="btn inverted" data-action="upgrade-data">Review upgrade</button></div></div>' : '');
  }
  function render() {
    renderSide(); renderHead(); renderMessages(); renderComposer(); renderNeeds(); renderOpenWork(); renderWork(); renderActivity(); renderSuggestions(); renderMapView(); renderHub();
    for (const button of document.querySelectorAll('button[data-action]')) button.disabled = !connected || button.dataset.blocked === 'true';
  }

  // ── Map: canvas, pan and zoom, node popover, Ask panel ──
  const ZMIN = 0.4; const ZMAX = 2.5;
  function renderMapView() {
    const map = state.map; const check = map?.check;
    text('#map-sub', `The project’s parts and the flows between them.${check?.checkedAt ? ` Checked at ${clock(check.checkedAt)}.` : ''}`);
    const checking = check?.state === 'checking';
    const button = $('#map-check'); button.textContent = checking ? 'Checking…' : 'Check now'; button.dataset.blocked = String(checking || !state.room); button.disabled = !connected || checking || !state.room;
    const fresh = setHTML('#project-map', renderProjectMap(map, { mode: ui.mapMode, query: ui.mapQuery, selected: ui.mapSelected, agents: agents() }));
    if (fresh) layoutCanvas();
  }
  function layoutCanvas() {
    const canvas = $('#map-canvas'); const world = $('#map-world'); if (!canvas || !world) return;
    canvas.classList.toggle('full', ui.mapFull);
    $('#map-full').innerHTML = icon(ui.mapFull ? ICONS.min : ICONS.max, 14); $('#map-full').title = ui.mapFull ? 'Exit full screen (Esc)' : 'Full screen (F)';
    world.style.width = `${world.dataset.w}px`; world.style.height = `${world.dataset.h}px`;
    for (const element of world.querySelectorAll('[data-x]')) { element.style.left = `${element.dataset.x}px`; element.style.top = `${element.dataset.y}px`; }
    if (!ui.mapView) fitMap(false); else applyMapView(false);
    if (ui.askNode) { canvas.append(askPanel()); renderAsk(); }
  }
  function fitMap(ease = true) {
    const canvas = $('#map-canvas'); const world = $('#map-world'); if (!canvas || !world || !canvas.clientWidth) return;
    const w = Number(world.dataset.w); const h = Number(world.dataset.h); const W = canvas.clientWidth; const H = canvas.clientHeight;
    const z = Math.min(ZMAX, Math.max(ZMIN, Math.min((W - 48) / w, (H - 48) / h)));
    ui.mapView = { z, x: (W - w * z) / 2, y: Math.max(24, (H - h * z) / 2) }; applyMapView(ease);
  }
  function applyMapView(ease) {
    const canvas = $('#map-canvas'); const world = $('#map-world'); if (!canvas || !world || !ui.mapView) return;
    const { x, y, z } = ui.mapView;
    world.classList.toggle('ease', ease); world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    canvas.style.backgroundSize = `${22 * z}px ${22 * z}px`; canvas.style.backgroundPosition = `${x}px ${y}px`;
    const pct = $('#map-pct'); if (pct) pct.textContent = `${Math.round(z * 100)}%`;
    const pop = canvas.querySelector('.node-pop'); const node = pop && world.querySelector(`[data-map-node="${CSS.escape(pop.dataset.popFor)}"]`);
    if (pop && node) { const nx = Number(node.dataset.x); const ny = Number(node.dataset.y); let left = x + (nx + NODE_W) * z + 10; if (left + 250 > canvas.clientWidth - 12) left = x + nx * z - 260;
      pop.style.left = `${Math.max(12, left)}px`; pop.style.top = `${Math.min(Math.max(12, y + ny * z), Math.max(12, canvas.clientHeight - pop.offsetHeight - 12))}px`; }
  }
  function zoomBy(factor, cx, cy) {
    const canvas = $('#map-canvas'); if (!canvas || !ui.mapView) return;
    const { x, y, z } = ui.mapView; const next = Math.min(ZMAX, Math.max(ZMIN, z * factor)); if (next === z) return;
    const px = cx ?? canvas.clientWidth / 2; const py = cy ?? canvas.clientHeight / 2;
    ui.mapView = { z: next, x: px - (px - x) * (next / z), y: py - (py - y) * (next / z) }; applyMapView(cx === undefined);
  }
  function setMapFull(full) { ui.mapFull = full; const canvas = $('#map-canvas'); if (canvas) { canvas.classList.toggle('full', full); $('#map-full').innerHTML = icon(full ? ICONS.min : ICONS.max, 14); requestAnimationFrame(() => fitMap(false)); } }
  function selectNode(id) { ui.mapSelected = id; renderMapView(); }
  let drag = null; let dragged = false;
  document.addEventListener('pointerdown', event => {
    const canvas = event.target.closest?.('#map-canvas'); if (!canvas || event.button !== 0 || event.target.closest('[data-map-controls], .node-pop, .ask')) return;
    drag = { x: event.clientX, y: event.clientY, view: { ...ui.mapView }, id: event.pointerId }; dragged = false;
  });
  document.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x; const dy = event.clientY - drag.y;
    if (!dragged && Math.hypot(dx, dy) < 4) return;
    if (!dragged) { dragged = true; $('#map-canvas')?.classList.add('dragging'); $('#map-canvas')?.setPointerCapture?.(event.pointerId); }
    ui.mapView = { ...drag.view, x: drag.view.x + dx, y: drag.view.y + dy }; applyMapView(false);
  });
  const endDrag = () => { if (!drag) return; drag = null; $('#map-canvas')?.classList.remove('dragging'); setTimeout(() => { dragged = false; }, 0); };
  document.addEventListener('pointerup', endDrag); document.addEventListener('pointercancel', endDrag);
  document.addEventListener('wheel', event => {
    const canvas = event.target.closest?.('#map-canvas'); if (!canvas || event.target.closest('.ask, .node-pop')) return;
    event.preventDefault(); const rect = canvas.getBoundingClientRect(); zoomBy(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  window.addEventListener('resize', () => { if (ui.view === 'map') fitMap(false); });

  let askElement;
  function askPanel() {
    if (askElement) return askElement;
    askElement = document.createElement('div'); askElement.className = 'ask'; askElement.setAttribute('role', 'dialog');
    askElement.innerHTML = `<div class="ask-head"><span class="dot" id="ask-dot"></span><div><b id="ask-title"></b><small id="ask-sub"></small><select id="ask-agent" aria-label="Ask which agent" hidden></select></div><button type="button" class="icon-btn" data-map="close-ask" aria-label="Close">${icon(ICONS.x, 14)}</button></div><div class="ask-body" id="ask-body"></div><div class="ask-foot"><form class="ask-input" id="ask-form"><label class="sr-only" for="ask-text">Your question</label><textarea id="ask-text" rows="1" maxlength="32000"></textarea><button type="submit" class="send" aria-label="Send"><svg viewBox="0 0 24 24"><path d="m5 12 7-7 7 7M12 19V5"/></svg></button></form><div class="ask-note" id="ask-note"></div></div>`;
    askElement.querySelector('#ask-agent').addEventListener('change', event => { ui.askAgent = event.target.value; renderAsk(); });
    askElement.querySelector('#ask-text').addEventListener('input', event => askElement.querySelector('#ask-form').classList.toggle('has-draft', Boolean(event.target.value.trim())));
    askElement.querySelector('#ask-text').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); askElement.querySelector('#ask-form').requestSubmit(); } });
    return askElement;
  }
  // Ask goes to the agent's own session (POST tell), never into the room; its answer is that session's output.
  const askable = () => agents().filter(agent => agentControls(agent).tell);
  function renderAsk() {
    if (!askElement || !ui.askNode) return;
    const node = (state.map?.nodes ?? []).find(n => n.id === ui.askNode); if (!node) return;
    const owner = node.owner ? nameOf(node.owner) : ''; const choices = askable();
    if (!choices.some(a => a.name === ui.askAgent)) ui.askAgent = choices.find(a => a.name === owner)?.name ?? choices[0]?.name ?? '';
    const name = ui.askAgent; const select = askElement.querySelector('#ask-agent');
    select.hidden = choices.length < 2 || (owner && name === owner);
    select.innerHTML = choices.map(a => `<option value="${esc(a.name)}"${a.name === name ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
    askElement.querySelector('#ask-dot').className = `dot ${name ? tc(agents(), name) : 'cn'}`;
    askElement.querySelector('#ask-title').textContent = name ? `Ask ${name}` : 'Ask an agent';
    askElement.querySelector('#ask-sub').textContent = `${node.label} · ${(node.paths ?? []).join(', ') || node.id}`;
    const thread = asks.get(`${node.id}:${name}`) ?? [];
    const since = thread.length ? thread[0].at : null;
    const replies = since ? logs.filter(log => log.type === 'output' && nameOf(log.who) === name && log.at >= since).map(log => ({ who: name, text: log.message, at: log.at })) : [];
    const all = [...thread, ...replies].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const waiting = thread.length && !replies.some(reply => reply.at >= thread.at(-1).at) && Date.now() - new Date(thread.at(-1).at).valueOf() < 120_000;
    askElement.querySelector('#ask-body').innerHTML = !name ? '<p class="ask-empty">No agent session here can take a direct question. A hosted agent with an open session can.</p>'
      : `${all.length ? '' : `<p class="ask-empty">${esc(owner && owner === name ? `${name} owns ${node.label}. ` : '')}Ask ${esc(name)} how ${esc(node.label)} works, what changed this run, or what depends on it.</p>`}${all.map(entry => `<div class="ask-msg"><div class="who ${tc(agents(), entry.who)}"><span class="dot"></span><b>${esc(labelOf(entry.who))}</b><time>${esc(clock(entry.at))}</time></div><div class="rich">${richText(entry.text, { agents: agents(), map: state.map })}</div></div>`).join('')}${waiting ? `<div class="typing"><span class="dots"><span></span><span></span><span></span></span>${esc(name)} is looking</div>` : ''}`;
    askElement.querySelector('#ask-text').placeholder = name ? `Ask ${name} about ${node.label}…` : '';
    askElement.querySelector('#ask-text').disabled = !name;
    askElement.querySelector('#ask-note').textContent = name ? `Only ${name} sees this: it goes to its session, not the room. ↵ to send` : '';
    const body = askElement.querySelector('#ask-body'); body.scrollTop = body.scrollHeight;
  }
  function openAsk(id) { ui.askNode = id; ui.mapSelected = ''; renderMapView(); const canvas = $('#map-canvas'); if (canvas) { canvas.append(askPanel()); renderAsk(); askElement.querySelector('#ask-text').focus(); } }
  function closeAsk() { ui.askNode = ''; askElement?.remove(); }
  document.addEventListener('submit', event => {
    if (event.target.id !== 'ask-form') return; event.preventDefault();
    const field = askElement.querySelector('#ask-text'); const question = field.value.trim(); const name = ui.askAgent;
    const node = (state.map?.nodes ?? []).find(n => n.id === ui.askNode); if (!question || !name || !node) return;
    const keyName = `${node.id}:${name}`; const at = new Date().toISOString();
    void act(`/api/agents/${encodeURIComponent(name)}/tell`, { text: `A question from the human about the project map part "${node.label}" (${(node.paths ?? []).join(', ') || node.id}): ${question}` })
      .then(() => { asks.set(keyName, [...(asks.get(keyName) ?? []), { who: 'human', text: question, at }]); field.value = ''; askElement.querySelector('#ask-form').classList.remove('has-draft'); renderAsk(); })
      .catch(error => toast(error.message, true));
  }, true);

  async function checkMapView() {
    if (!connected || !state.room || pending.has('map-check') || state.map?.check?.state === 'checking') return;
    pending.add('map-check');
    try { const result = await api('/api/map/check', {}); if (result.map) { state.map = result.map; renderMapView(); } }
    catch (error) { toast(error.message, true); }
    finally { pending.delete('map-check'); }
  }
  function selectView(view) {
    if (!VIEWS.some(([v]) => v === view)) return;
    const openingMap = view === 'map' && ui.view !== 'map';
    ui.view = view; ui.toOpen = false; renderHead(); renderComposer();
    if (view === 'map') requestAnimationFrame(() => { if (!ui.mapView) fitMap(false); else applyMapView(false); });
    if (openingMap) void checkMapView();
  }
  function showMapNode(id) { ui.mapMode = 'flow'; ui.mapQuery = ''; ui.mapSelected = id; ui.mapView = null; selectView('map'); renderMapView(); }

  // ── Dialogs ──
  function showDialog(title, intro, fields, handler, button = 'Continue') {
    dialogHandler = handler;
    $('#dialog-content').innerHTML = `<h2 id="dialog-title">${esc(title)}</h2>${intro ? `<p class="dialog-intro">${esc(intro)}</p>` : ''}<form id="dialog-form">${fields}<div id="dialog-error" class="dialog-error" role="alert" hidden></div><div class="dialog-footer"><button class="btn lg" type="button" data-close-dialog>Cancel</button><button class="btn primary lg" type="submit">${esc(button)}</button></div></form>`;
    if (!dialog.open) dialog.showModal();
  }
  function keysDialog() {
    const rows = [['Switch view', ['1', '–', '5']], ['Write a message', ['/']], ['Allow or deny the oldest approval', ['A', 'D']], ['Pause or resume the run', ['P']], ['Invite an agent', ['I']], ['Full-screen map (in Map)', ['F']], ['Send from the composer', ['⌘', '↵']], ['Close a dialog, popover or the map’s full screen', ['Esc']], ['This sheet', ['?']]];
    dialogHandler = async () => {};
    $('#dialog-content').innerHTML = `<h2 id="dialog-title">Keyboard shortcuts</h2><p class="dialog-intro">They work when you are not typing, and never with a modifier held.</p><div class="keys">${rows.map(([what, keys]) => `<div><span>${esc(what)}</span><span>${keys.map(k => `<kbd class="k">${esc(k)}</kbd>`).join('')}</span></div>`).join('')}</div><div class="dialog-footer"><button class="btn primary lg" type="button" data-close-dialog>Done</button></div>`;
    if (!dialog.open) dialog.showModal();
  }
  function inviteDialog() {
    const choices = inviteChoices(state.harnesses, state.agents); const first = choices.find(c => c.enabled) ?? choices[0];
    const rows = choices.map(c => `<label class="choice"><input type="radio" name="kind" value="${esc(c.id)}"${c.enabled ? '' : ' disabled'}${c === first ? ' checked' : ''}><span class="radio"></span><span class="grow"><b>${esc(c.label)}</b><small>${esc(c.enabled ? (c.external ? 'Runs in its own session, which you start' : 'Hosted here by the console') : c.reason ?? 'Not available')}</small></span>${agents().some(a => a.kind === c.id) ? '<span class="in-room">In room</span>' : ''}</label>`).join('') + '<label class="choice"><input type="radio" name="kind" value="__join__"><span class="radio"></span><span class="grow"><b>Any agent</b><small>Paste a join line into its session</small></span></label>';
    const joinHarnesses = (state.harnesses ?? []).filter(h => h.enabled && (h.routes ?? []).includes('external')).map(h => `<option value="${esc(h.id)}">${esc(h.label ?? h.id)}</option>`).join('');
    showDialog('Invite an agent', 'Choose the agent and where it runs. Its messages, decisions and controls stay in this window.', `<div class="choices" id="invite-kinds">${rows}</div><div class="field"><label for="invite-name">Name in this room</label><input id="invite-name" name="name" required maxlength="32" pattern="[A-Za-z][A-Za-z0-9_-]*" value="${esc(first?.name ?? 'Agent')}"></div><div id="invite-hosted"><div class="field-row"><div class="field"><label for="invite-model">Model</label><input id="invite-model" name="model" list="model-options" placeholder="Native default" maxlength="64"><datalist id="model-options"></datalist></div><div class="field"><label for="invite-effort">Reasoning effort</label><input id="invite-effort" name="effort" placeholder="Native default" maxlength="64"></div></div><label class="check-field"><input type="checkbox" name="trusted" checked><span>Allow room commands automatically<small>Other commands and requested access still need approval.</small></span></label></div><p id="invite-external" class="dialog-intro" hidden>This agent runs in its own session, which you start. The console does not host it or see its approvals; after inviting, you get the line to give it there.</p><div id="invite-join" hidden><p class="dialog-intro">One paste for any enabled harness: the agent fetches this line in its own session, shows a pairing code, and you let it in from Needs you. Nothing joins the room until you do.</p><div class="field"><label for="invite-join-harness">Harness (optional)</label><select id="invite-join-harness" name="join-harness"><option value="">Let the agent declare it</option>${joinHarnesses}</select></div></div>`, async form => {
      const data = new FormData(form); const kind = String(data.get('kind') ?? '');
      if (kind === '__join__') {
        const harness = String(data.get('join-harness') ?? '').trim(); const wanted = String(data.get('name') ?? '').trim();
        const result = await act('/api/join-line', { ...(harness ? { harness } : {}), ...(wanted ? { name: wanted } : {}) });
        const paste = String(result?.paste ?? result?.line ?? '');
        showDialog('Paste this into the agent', 'It shows a pairing code. Check that code in the agent’s session, then let it in from Needs you.', `<pre id="join-paste">${esc(paste)}</pre><div class="copy-row"><button type="button" class="btn outline" data-copy-target="join-paste">Copy line</button></div>`, async () => {}, 'Done');
        return;
      }
      const choice = choices.find(c => c.id === kind);
      const model = String(data.get('model') ?? '').trim(); const effort = String(data.get('effort') ?? '').trim();
      const result = await act('/api/invite', { kind, name: String(data.get('name')).trim(), ...(choice?.external ? {} : { trusted: data.has('trusted'), ...(model ? { model } : {}), ...(effort ? { effort } : {}) }) });
      if (result?.next) showDialog('Start it in its own session', 'It joined the room. In its own session, give it this; it then waits for work by itself.', `<pre id="invite-next">${esc(result.next)}</pre><div class="copy-row"><button type="button" class="btn outline" data-copy-target="invite-next">Copy</button></div>`, async () => {}, 'Done');
      else toast('Agent invited. It appears under the room.');
    }, 'Invite');
    const models = async kind => {
      try {
        const result = await api(`/api/models?kind=${encodeURIComponent(kind)}`);
        if (!dialog.open || $('#invite-kinds input:checked')?.value !== kind) return;
        const list = Array.isArray(result) ? result : result.models ?? [];
        $('#model-options').innerHTML = list.map(model => `<option value="${esc(typeof model === 'string' ? model : model.model ?? model.id)}">${esc(typeof model === 'string' ? model : model.name ?? model.displayName ?? '')}</option>`).join('');
      } catch { /* Empty model field always uses the harness's own default. */ }
    };
    // An external harness has no model, effort or trust to set here: the human runs it. A join line is for any enabled
    // external harness, or for the agent to declare its own; nothing here opens a session.
    const show = id => {
      const join = id === '__join__'; const choice = choices.find(c => c.id === id);
      $('#invite-name').required = !join; $('#invite-name').value = join ? '' : choice?.name ?? 'Agent'; $('#invite-name').placeholder = join ? 'Automatic: named after the harness' : '';
      $('#invite-hosted').hidden = join || !!choice?.external;
      $('#invite-external').hidden = join || !choice?.external;
      $('#invite-join').hidden = !join;
      $('#invite-model').value = ''; $('#invite-effort').value = ''; $('#model-options').replaceChildren(); if (!join && !choice?.external) void models(id);
    };
    $('#invite-kinds').addEventListener('change', event => show(event.target.value));
    show(first?.id);
  }
  function roomDialog() {
    showDialog('Create a room', 'Choose the project folder the crew should work in. The room and its conversation are saved on this machine.', `<div class="field"><label for="create-name">Room name</label><input id="create-name" name="name" required maxlength="100" placeholder="e.g. Peerloom development"></div><div class="field"><label for="create-workspace">Project folder</label><input id="create-workspace" name="workspace" required value="${esc(state.defaults?.workspace ?? '')}" placeholder="/path/to/your/project" autocomplete="off"></div><div class="field"><label for="create-objective">What are you working toward?</label><textarea id="create-objective" name="objective" rows="3" maxlength="4096" placeholder="Describe the outcome you want the crew to achieve."></textarea></div>`, async form => {
      const data = new FormData(form);
      const objective = String(data.get('objective')).trim();
      await act('/api/room', { name: String(data.get('name')).trim(), workspace: String(data.get('workspace')).trim(), ...(objective ? { objective } : {}) });
      toast('Room created. Invite your first agent.');
    }, 'Create room');
  }
  async function act(path, payload = {}) {
    if (!connected) throw new Error('Wait for the local host to reconnect before sending an action.');
    const result = await api(path, payload);
    try { await refresh(); }
    catch { toast('The action was accepted. Reconnecting to refresh the room…'); scheduleRefresh(); }
    return result;
  }
  async function perform(button) {
    const action = button.dataset.action;
    const name = button.dataset.name;
    const id = button.dataset.id;
    const route = name ? `/api/agents/${encodeURIComponent(name)}` : '';
    const actionKey = () => globalThis.crypto?.randomUUID?.() ?? `page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const retryBody = handler => {
      let previous; let key;
      return async form => { const body = handler(form); const signature = JSON.stringify(body); if (signature !== previous) { previous = signature; key = actionKey(); } return { ...body, requestId: key }; };
    };
    if (action === 'map-check') return checkMapView();
    if (action === 'map-update') {
      const open = agents().filter(a => a.session === 'open');
      if (!open.length) throw new Error('Open an agent session before asking it to update the map.');
      const bodyFor = retryBody(form => ({ lead: String(new FormData(form).get('lead')) }));
      return showDialog('Update the project map', 'Ask one agent to inspect the project and update agentlink-map.txt. This uses its provider allowance. The request queues while the run is paused.', `<div class="field"><label for="map-lead">Agent</label><select id="map-lead" name="lead">${open.map(a => `<option value="${esc(a.name)}">${esc(a.name)}</option>`).join('')}</select></div>`, async form => { await act('/api/map/update', await bodyFor(form)); toast('Map update requested. Its response will appear on the map.'); }, 'Ask to update');
    }
    if (action === 'what-next') {
      if (!agents().some(agent => agent.session === 'open')) throw new Error('Open an agent session before asking for recommendations.');
      const bodyFor = retryBody(form => { const leads = new FormData(form).getAll('lead').map(String); if (!leads.length) throw new Error('Choose at least one open agent session.'); return { leads }; });
      return showDialog('What should we do next?', 'Ask the selected agents to assess this project and post up to three suggestions each. This uses their provider allowance. Requests queue while the run is paused.', agents().map(agent => `<label class="check-field"><input type="checkbox" name="lead" value="${esc(agent.name)}"${agent.session === 'open' ? ' checked' : ' disabled'}><span>${esc(agent.name)}<small>${esc(agent.note || (agent.session === 'open' ? 'Session open' : agent.hostNote || 'Open this session first'))}</small></span></label>`).join(''), async form => { await act('/api/what_next', await bodyFor(form)); selectView('recommendations'); toast('Assessment requested. Each agent’s response will appear here.'); }, 'Ask selected agents');
    }
    if (action === 'upgrade-data') {
      const response = await act('/api/upgrade', { confirm: false });
      const preview = response.preview ?? response.upgrade?.preview;
      if (!preview?.needed || typeof preview.sourceDigest !== 'string' || !preview.backupPath) throw new Error('No actionable upgrade preview is available. Refresh the room and try again.');
      const requestId = actionKey();
      return showDialog('Upgrade local workspace data', 'Delivery is interrupted while the saved data is backed up and upgraded. Active work must finish or be stopped first. A paused run stays paused.', `<div class="field"><strong>Affected rooms</strong><ul>${(preview.rooms ?? []).map(room => `<li>${esc(room.name)}</li>`).join('')}</ul><strong>Data file</strong><code>${esc(preview.statePath)}</code><strong>Protected backup</strong><code>${esc(preview.backupPath)}</code>${preview.restarts?.length ? `<strong>Owned sessions to restart</strong><ul>${preview.restarts.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}${preview.interrupts?.length ? `<strong>External agents that will stop listening</strong><ul>${preview.interrupts.map(n => `<li>${esc(n)}</li>`).join('')}</ul><p>Start these agents listening again after the upgrade.</p>` : ''}</div>`, async () => { await act('/api/upgrade', { confirm: true, expectedDigest: preview.sourceDigest, requestId }); toast('Workspace data upgraded. Review the run and agent status before continuing.'); }, 'Back up and upgrade');
    }
    if (['adopt-suggestion', 'ask-position', 'dismiss-suggestion'].includes(action)) {
      const item = (state.recommendations ?? []).find(candidate => candidate.itemId === id);
      if (!item || item.disposition !== 'open') throw new Error('This suggestion is no longer open. Refresh to see its current state.');
      const path = `/api/suggestions/${encodeURIComponent(id)}`;
      if (action === 'dismiss-suggestion') {
        const bodyFor = retryBody(form => ({ reason: String(new FormData(form).get('reason') ?? '').trim() }));
        return showDialog('Dismiss this suggestion?', item.title, '<div class="field"><label for="dismiss-reason">Reason</label><textarea id="dismiss-reason" name="reason" maxlength="1000" rows="3" required></textarea></div>', async form => { await act(`${path}/dismiss`, await bodyFor(form)); toast('Suggestion dismissed.'); }, 'Dismiss');
      }
      if (!item.payload || !item.target) throw new Error('The proposal must be corrected before using this action.');
      const target = { ...item.target };
      if (action === 'ask-position') {
        const leads = agents().filter(agent => agent.name !== nameOf(item.author));
        if (!leads.length) throw new Error('Invite another agent for an independent position.');
        const bodyFor = retryBody(form => ({ target, lead: String(new FormData(form).get('lead')) }));
        return showDialog('Ask for an independent position', `Review revision ${target.revision} of “${item.title}”. The response stays attached to this exact proposal.`, `<div class="field"><label for="review-lead">Agent</label><select id="review-lead" name="lead">${leads.map(lead => `<option value="${esc(lead.name)}">${esc(lead.name)}${lead.session !== 'open' ? ' · session needs opening' : ''}</option>`).join('')}</select></div>`, async form => { await act(`${path}/ask`, await bodyFor(form)); toast('Position requested. Delivery follows the run controls.'); }, 'Request position');
      }
      if (Number(state.storeVersion ?? 0) < 5) throw new Error('Review the saved-data upgrade before creating a task.');
      if (!agents().length) throw new Error('Invite an agent to assign this task.');
      const p = item.payload;
      const bodyFor = retryBody(form => { const data = new FormData(form); return { target, assignee: String(data.get('assignee')), task: confirmedTask({ outcome: data.get('outcome'), scope: data.get('scope'), acceptanceText: data.get('acceptance') }) }; });
      return showDialog('Make it a task', 'Review the exact work you are authorizing. Independent concerns remain visible. Assignment is saved now; delivery follows the run controls and the chosen agent’s session.', `<p class="dialog-intro">${esc(item.title)} · revision ${esc(target.revision)}</p>${(item.positions ?? []).filter(position => position.state === 'changes_requested').map(position => `<div class="adoption"><strong>${esc(nameOf(position.from))} has concerns</strong><p>${esc(position.text)}</p></div>`).join('')}<div class="field"><label for="task-assignee">Assign to</label><select id="task-assignee" name="assignee">${agents().map(agent => `<option value="${esc(agent.name)}">${esc(agent.name)}${agent.session !== 'open' ? ' · session needs opening' : ''}</option>`).join('')}</select><small>A closed session must be relaunched before it can receive work.</small></div><div class="field"><label for="task-outcome">Outcome</label><textarea id="task-outcome" name="outcome" rows="3" maxlength="2000" required>${esc(p.outcome)}</textarea></div><div class="field"><label for="task-scope">Scope</label><textarea id="task-scope" name="scope" rows="3" maxlength="2000" required>${esc(p.scope)}</textarea></div><div class="field"><label for="task-acceptance">Acceptance criteria, one per line</label><textarea id="task-acceptance" name="acceptance" rows="4" maxlength="5010" required>${esc(p.acceptance.join('\n'))}</textarea></div>`, async form => { const result = await act(`${path}/adopt`, await bodyFor(form)); toast(`Task saved${result.taskItemId ? `: ${result.taskItemId}` : ''}. Delivery follows the run controls.`); }, 'Create and assign');
    }
    if (action === 'create-room') return roomDialog();
    if (action === 'invite') return inviteDialog();
    if (action === 'run') return act('/api/run', { op: button.dataset.op });
    if (action === 'limits' || action === 'extend-budget') {
      const attention = budgetAttention(state);
      if (action === 'extend-budget' && !attention) return toast('The budget hold has cleared.');
      if (action === 'extend-budget' && !attention.canExtend) throw new Error('A required wake limit is already at its maximum.');
      const limits = action === 'extend-budget' ? attention.limits : state.run?.limits ?? { room: 120, agent: 40 };
      return showDialog(action === 'extend-budget' ? 'Extend the peer-wake budget' : 'Peer-wake budget', 'Only wakes one agent causes another spend this budget. Work you send is free against it. This keeps the current run.', `<div class="field-row"><div class="field"><label for="limit-room">Whole run</label><input id="limit-room" name="room" type="number" min="1" max="500" required value="${esc(limits.room)}"></div><div class="field"><label for="limit-agent">Per agent</label><input id="limit-agent" name="agent" type="number" min="1" max="200" required value="${esc(limits.agent)}"></div></div>`, form => { const data = new FormData(form); return act('/api/run', { op: 'limits', limits: { room: Number(data.get('room')), agent: Number(data.get('agent')) } }); }, 'Save limits');
    }
    if (action === 'end') return showDialog(`End run ${state.run?.number ?? ''}?`.replace(' ?', '?'), 'No further work will be offered in this run. Work already underway may still need your attention; use Stop on an agent to end its session.', '', () => act('/api/run', { op: 'end' }), 'End run');
    if (action === 'stop') return showDialog(`Stop ${name}?`, 'This ends the session the console hosts, including work underway. The room and its conversation stay saved. You can relaunch the agent later.', '', () => act(`${route}/stop`), 'Stop');
    if (action === 'relaunch') return act(`${route}/relaunch`);
    if (action === 'tell') return showDialog(`Message ${name}’s session`, 'This goes directly into the agent’s session. Use the room composer when you want the message in the shared conversation.', '<div class="field"><label for="session-message">Your message</label><textarea id="session-message" name="text" rows="4" maxlength="32000" required></textarea></div>', form => act(`${route}/tell`, { text: String(new FormData(form).get('text')).trim() }), 'Send to session');
    if (action === 'agent-settings') {
      const agent = agents().find(candidate => candidate.name === name);
      return showDialog(`${name}’s permissions`, agent?.where === 'owned' ? 'This only covers this agent’s own room commands. Other tools and access requests still need approval.' : 'This agent runs outside the console. Its native session may handle approvals separately.', `<label class="check-field"><input type="checkbox" name="trusted"${agent?.trusted ? ' checked' : ''}><span>Allow room commands automatically<small>Changes may apply when the session is next started.</small></span></label>`, form => act(`${route}/trust`, { trusted: new FormData(form).has('trusted') }), 'Save');
    }
    if (action === 'approve' || action === 'deny') return act(`/api/approvals/${encodeURIComponent(id)}`, { decision: action === 'approve' ? 'accept' : 'decline' });
    if (action === 'grant-permission' || action === 'deny-permission') {
      const approval = state.approvals.find(candidate => String(candidate.id) === id);
      if (!approval) throw new Error('This access request has already been resolved.');
      return act(`/api/approvals/${encodeURIComponent(id)}`, { result: { permissions: action === 'grant-permission' ? approval.params.permissions : {}, scope: 'turn' } });
    }
    if (action === 'react') {
      const messageId = id; const emoji = button.dataset.emoji; const on = button.dataset.on !== 'false';
      try { await act('/api/react', { messageId, emoji, ...(on ? {} : { on: false }) }); }
      catch (error) { if (error.code === 'upgrade_required') toast('Upgrade this room’s saved data before using reactions.', true); else toast(error.message, true); }
      return;
    }
    if (action === 'join-approve') { const result = await act('/api/join-approve', { claimId: id }); const joined = result?.join?.name; toast(joined ? `${joined} joined. Start it listening in its own session.` : 'Let in.'); return; }
    if (action === 'join-retry') { const result = await act('/api/join-approve', { claimId: id, retry: true }); const joined = result?.join?.name; toast(joined ? `${joined} joined after a retry. Start it listening in its own session.` : 'Join retried.'); return; }
    if (action === 'join-refuse') { await act('/api/join-refuse', { claimId: id }); toast('Join refused.'); return; }
    if (action === 'accept') { await act('/api/accept', { requestId: id }); toast('Result accepted.'); }
  }
  function press(button) {
    if (!button || button.disabled) return;
    const key = `${button.dataset.action}:${button.dataset.name ?? button.dataset.id ?? ''}:${button.dataset.emoji ?? ''}`;
    if (pending.has(key)) return;
    pending.add(key); button.disabled = true;
    void Promise.resolve().then(() => perform(button)).catch(error => toast(error.message, true)).finally(() => { pending.delete(key); if (button.isConnected) button.disabled = !connected || button.dataset.blocked === 'true'; });
  }
  document.addEventListener('click', event => {
    const target = event.target;
    if (!target.closest('#hub-pop, #conn-button') && ui.connOpen) { ui.connOpen = false; renderHub(); }
    if (!target.closest('.to-wrap') && ui.toOpen) { ui.toOpen = false; renderComposer(); }
    const copy = target.closest('[data-copy-target]');
    if (copy) { void copyText(document.getElementById(copy.dataset.copyTarget)?.textContent ?? ''); return; }
    const mapButton = target.closest('[data-map]');
    if (mapButton) {
      const op = mapButton.dataset.map;
      if (op === 'in') zoomBy(1.25); else if (op === 'out') zoomBy(0.8); else if (op === 'fit') fitMap(); else if (op === 'full') setMapFull(!ui.mapFull);
      else if (op === 'mode') { ui.mapMode = mapButton.dataset.mode === 'list' ? 'list' : 'flow'; ui.mapView = null; closeAsk(); renderMapView(); }
      else if (op === 'ask') openAsk(mapButton.dataset.id); else if (op === 'close-ask') closeAsk();
      return;
    }
    const filePath = target.closest('[data-map-path]');
    if (filePath) { showMapNode(filePath.dataset.mapPath); return; }
    const mapNode = target.closest('[data-map-node]');
    if (mapNode) { if (!dragged) selectNode(ui.mapSelected === mapNode.dataset.mapNode ? '' : mapNode.dataset.mapNode); return; }
    if (target.closest('#map-canvas') && !target.closest('.node-pop, .ask, [data-map-controls]')) { if (!dragged && ui.mapSelected) selectNode(''); return; }
    if (target.closest('[data-close-dialog]')) return dialog.close();
    if (target.closest('[data-room-toggle]')) { ui.crewOpen = !ui.crewOpen; renderSide(); return; }
    if (target.closest('[data-clear-focus]')) { ui.focusAgent = ''; renderSide(); renderMessages(); return; }
    const agentRow = target.closest('[data-focus-agent]');
    if (agentRow) { const name = agentRow.dataset.focusAgent; ui.focusAgent = ui.focusAgent === name ? '' : name; renderSide(); if (ui.view !== 'room') selectView('room'); renderMessages(); return; }
    const compose = target.closest('[data-compose]');
    if (compose) { ui.recipient = compose.dataset.compose; ui.toOpen = false; selectView('room'); renderComposer(); $('#message-text').focus(); return; }
    const toOption = target.closest('[data-to]');
    if (toOption) { ui.recipient = toOption.dataset.to; ui.toOpen = false; renderComposer(); $('#message-text').focus(); return; }
    const view = target.closest('[data-view]');
    if (view) return selectView(view.dataset.view);
    press(target.closest('button[data-action]'));
  });
  $('#conn-button').addEventListener('click', () => { ui.connOpen = !ui.connOpen; renderHub(); });
  $('#keys-button').addEventListener('click', keysDialog);
  $('#theme-button').addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; try { localStorage.setItem('peerloom-theme', theme); } catch { /* not remembered */ } applyTheme(); });
  $('#retry-now').addEventListener('click', () => { activeController?.abort(); retryWait?.(); });
  $('#to-button').addEventListener('click', () => { ui.toOpen = !ui.toOpen; renderComposer(); });
  $('#post-toggle').addEventListener('click', () => { ui.post = !ui.post; if (ui.post) ui.noReply = false; renderComposer(); });
  $('#noreply-toggle').addEventListener('click', () => { ui.noReply = !ui.noReply; if (ui.noReply) ui.post = false; renderComposer(); });
  $('#unseen').addEventListener('click', () => { const c = $('#conversation'); c.scrollTop = c.scrollHeight; ui.unseen = 0; renderMessages(); });
  $('#conversation').addEventListener('scroll', () => { const c = $('#conversation'); ui.atBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 60; if (ui.atBottom && ui.unseen) { ui.unseen = 0; $('#unseen').hidden = true; } });
  document.addEventListener('input', event => {
    const questionForm = event.target.closest('[data-question-form]');
    if (questionForm) { const id = questionForm.dataset.questionForm; const drafts = questionDrafts.get(id) ?? {}; drafts[event.target.dataset.questionId] = event.target.value; questionDrafts.set(id, drafts); }
    const needsForm = event.target.closest('[data-needs-form]');
    if (needsForm) needsDrafts.set(needsForm.dataset.needsForm, event.target.value);
  });
  document.addEventListener('submit', event => {
    const form = event.target;
    if (form.id === 'map-search-form') { event.preventDefault(); ui.mapQuery = String(new FormData(form).get('query') ?? '').trim(); ui.mapView = null; renderMapView(); $('#map-query').focus(); return; }
    if (form.id === 'dialog-form') {
      event.preventDefault();
      const submit = form.querySelector('button[type="submit"]');
      if (submit.disabled) return;
      submit.disabled = true;
      $('#dialog-error').hidden = true;
      const mine = dialogHandler; void Promise.resolve().then(() => mine?.(form)).then(() => { if (dialogHandler === mine) dialog.close(); }).catch(error => { text('#dialog-error', error.message); $('#dialog-error').hidden = false; }).finally(() => { submit.disabled = !connected; });
    } else if (form.dataset.needsForm) {
      event.preventDefault();
      const id = form.dataset.needsForm;
      if (!(state.needsYou?.questions ?? []).some(question => String(question.id) === id)) return;
      const typed = String(new FormData(form).get('text') ?? '').trim();
      const outcome = event.submitter?.value === 'declined' ? 'declined' : 'answered';
      if (outcome === 'answered' && !typed) { toast('Type an answer, or decline the question.', true); return; }
      const reply = outcome === 'declined' ? (typed || 'Declined from the page.') : typed;
      const buttons = [...form.querySelectorAll('button[type="submit"]')];
      if (buttons.some(button => button.disabled)) return;
      for (const button of buttons) button.disabled = true;
      void act('/api/answer', { requestId: id, outcome, text: reply, key: needsKey(id, outcome, reply) })
        .then(() => { needsDrafts.delete(id); toast(outcome === 'declined' ? 'Question declined.' : 'Answer sent.'); })
        .catch(error => toast(error.message, true))
        .finally(() => { for (const button of buttons) if (button.isConnected) button.disabled = !connected; });
    } else if (form.dataset.questionForm) {
      event.preventDefault();
      const id = form.dataset.questionForm;
      const approval = state.approvals.find(a => String(a.id) === id);
      if (!approval) return;
      const data = new FormData(form);
      const answers = Object.fromEntries(approval.params.questions.map((question, index) => [question.id, { answers: [String(data.get(`answer-${index}`) ?? '')] }]));
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      void act(`/api/approvals/${encodeURIComponent(id)}`, { result: { answers } }).catch(error => toast(error.message, true)).finally(() => { if (submit.isConnected) submit.disabled = !connected; });
    }
  });

  // ── Sending: the composer's plan, kept in an outbox while the hub is unreachable and delivered on reconnect ──
  let outboxSeq = 0;
  async function flushOutbox() {
    while (outbox.length && connected) {
      const entry = outbox[0];
      try { await api('/api/send', entry.body); outbox.shift(); }
      catch (error) { if (error.status && error.status < 500 && error.status !== 502) { outbox.shift(); toast(`A queued message was not delivered: ${error.message}`, true); } else break; }
    }
    renderMessages(); scheduleRefresh();
  }
  $('#message-form').addEventListener('submit', event => {
    event.preventDefault();
    const field = $('#message-text');
    const message = field.value.trim();
    if (!message || !state.room || pending.has('send')) return;
    let body; try { body = composerPlan({ text: message, recipient: ui.recipient ?? '', agents: agents(), noReply: ui.noReply, post: ui.post }); }
    catch (error) { toast(error.message, true); return; }
    const sent = () => { if (field.value.trim() === message) field.value = ''; ui.post = false; ui.noReply = false; closeMentions(); ui.forceBottom = true; renderComposer(); field.focus(); };
    if (!connected) { outbox.push({ id: ++outboxSeq, body, at: new Date().toISOString() }); sent(); renderMessages(); toast('Kept. It is delivered when the hub is back.'); return; }
    pending.add('send'); $('#send-button').disabled = true;
    const paused = runState() === 'paused';
    void act('/api/send', body).then(() => { sent(); if (paused) toast('Queued. The crew sees it when the run resumes.'); })
      .catch(error => { if (error.code === 'upgrade_required') toast('Upgrade this room’s saved data before sending with receipts, posts or reactions.', true); else toast(error.message, true); })
      .finally(() => { pending.delete('send'); $('#send-button').disabled = false; });
  });
  // @mentions: the crew matching what follows the @, picked with the arrows and Enter or Tab; picking sets the recipient.
  const mentionPopup = $('#mention-popup');
  function closeMentions() { ui.mention = null; mentionPopup.hidden = true; }
  function mentionMatches() { return ui.mention ? agents().filter(agent => String(agent.name).toLowerCase().startsWith(ui.mention.q)).slice(0, 8) : []; }
  function updateMentions() {
    const field = $('#message-text'); const at = field.selectionStart ?? field.value.length; const before = field.value.slice(0, at);
    const match = /(^|\s)@([A-Za-z][A-Za-z0-9_-]*)?$/.exec(before);
    if (!match) { closeMentions(); return; }
    const q = (match[2] ?? '').toLowerCase(); if (ui.mention?.q !== q) ui.mentionIndex = 0;
    ui.mention = { q, start: at - (match[2] ?? '').length - 1, end: at };
    const matches = mentionMatches(); if (!matches.length) { closeMentions(); return; }
    ui.mentionIndex = Math.min(ui.mentionIndex, matches.length - 1);
    mentionPopup.innerHTML = `<div class="menu-head">Mention an agent · ↵ to pick</div>${matches.map((agent, i) => `<button type="button" class="menu-item${i === ui.mentionIndex ? ' active' : ''}" role="option" aria-selected="${i === ui.mentionIndex}" data-mention="${esc(agent.name)}"><span class="dot ${tc(agents(), agent.name)}"></span><span class="grow">${esc(agent.name)}</span><small>${esc(agent.model ?? agent.label ?? '')}</small></button>`).join('')}`;
    mentionPopup.hidden = false;
  }
  function pickMention(name) {
    const field = $('#message-text'); if (!ui.mention) return;
    const before = field.value.slice(0, ui.mention.start); const after = field.value.slice(ui.mention.end);
    const inserted = `${before}@${name} `; field.value = inserted + after; field.selectionStart = field.selectionEnd = inserted.length;
    ui.recipient = name; closeMentions(); renderComposer(); field.focus();
  }
  $('#message-text').addEventListener('input', () => { updateMentions(); renderComposer(); });
  $('#message-text').addEventListener('click', updateMentions);
  mentionPopup.addEventListener('mousedown', event => { const option = event.target.closest('[data-mention]'); if (!option) return; event.preventDefault(); pickMention(option.dataset.mention); });
  $('#message-text').addEventListener('blur', () => { setTimeout(closeMentions, 120); });
  $('#message-text').addEventListener('keydown', event => {
    const matches = mentionMatches();
    if (!mentionPopup.hidden && matches.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); ui.mentionIndex = (ui.mentionIndex + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length; updateMentions(); return; }
      if ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey) || event.key === 'Tab') { event.preventDefault(); pickMention(matches[ui.mentionIndex].name); return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMentions(); return; }
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('#message-form').requestSubmit(); }
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  $('#views').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = VIEWS.findIndex(([v]) => v === ui.view);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? VIEWS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length;
    selectView(VIEWS[next][0]); $(`#tab-${VIEWS[next][0]}`).focus();
  });
  // Bare keys only when not typing and with no modifier held, so nothing collides with the browser's own shortcuts.
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !dialog.open) {
      if (ui.connOpen) { ui.connOpen = false; renderHub(); return; }
      if (ui.toOpen) { ui.toOpen = false; renderComposer(); return; }
      if (ui.view === 'map' && ui.mapSelected) { selectNode(''); return; }
      if (ui.view === 'map' && ui.askNode) { closeAsk(); return; }
      if (ui.mapFull) { setMapFull(false); return; }
      if (ui.focusAgent) { ui.focusAgent = ''; renderSide(); renderMessages(); }
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || dialog.open) return;
    const typing = event.target.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
    if (typing || !state.room) return;
    const k = event.key;
    if (/^[1-5]$/.test(k)) { event.preventDefault(); selectView(VIEWS[Number(k) - 1][0]); return; }
    if (k === '/') { event.preventDefault(); selectView('room'); $('#message-text').focus(); return; }
    if (k === '?') { event.preventDefault(); keysDialog(); return; }
    const oldest = (state.approvals ?? []).find(a => a.kind === 'approval');
    if ((k === 'a' || k === 'd') && oldest) { event.preventDefault(); press(document.querySelector(`[data-action="${k === 'a' ? 'approve' : 'deny'}"][data-id="${CSS.escape(String(oldest.id))}"]`)); return; }
    if (k === 'p') { const run = document.querySelector('#run-group [data-op="pause"], #run-group [data-op="resume"]'); if (run) { event.preventDefault(); press(run); } return; }
    if (k === 'i') { event.preventDefault(); press($('#invite-button')); return; }
    if (k === 'f' && ui.view === 'map') { event.preventDefault(); setMapFull(!ui.mapFull); }
  });
  window.addEventListener('pagehide', () => { stopped = true; activeController?.abort(); clearTimeout(refreshTimer); });
  connection(false); renderHead();
  void follow();
}
