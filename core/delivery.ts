// Pull delivery: what an agent should be told about, the durable offer that tells it, and the human's control of
// the run. Pure: no file or network access and no timers. The server owns connections and time; every decision
// about whether a wait is answered, held or refused is made here, from the session alone.
import { DomainError, project } from './collab.ts';
import { conversation } from './quiet.ts';

const fail = (status: number, code: string, message: string, detail?: unknown): never => { throw new DomainError(status, code, message, detail); };

export const OPERATIONS: Record<string, { mutating: boolean; owner?: true }> = {
  bind: { mutating: true }, confirm: { mutating: true },
  run_start: { mutating: true, owner: true }, run_pause: { mutating: true, owner: true }, run_resume: { mutating: true, owner: true }, run_end: { mutating: true, owner: true },
  run_limits: { mutating: true, owner: true }, run_reoffer: { mutating: true, owner: true }, run_rearm: { mutating: true, owner: true },
  fetch: { mutating: false }, run: { mutating: false },
};

type Actor = { id: string; name: string; kind: string; role: string };
type Env = { now(): string; id(prefix: string): string };
type Kind = 'slot' | 'response' | 'withdrawal' | 'human_message' | 'agent_message';
type Unit = { kind: Kind; id: string };
type Limits = { room: number; agent: number; emptyWaits: number };
type Run = { number: number; state: 'idle' | 'running' | 'paused' | 'ended'; control: number; limits: Limits };
type Offer = { wakeId: string; participantId: string; bindingGeneration: number; run: number; control: number; epoch: number; units: Unit[]; changesAt: number; preparedAt: string; attemptId?: string; confirmedAt?: string; closed?: { at: string; reason: 'new_run' | 'rebound' | 'reoffered' } };
type Control = { seq: number; type: 'start' | 'pause' | 'resume' | 'end' | 'limits'; by: string; at: string; run: number; control: number; limits: Limits };
type Grant = { seq: number; type: 'reoffer' | 'rearm'; participantId: string; by: string; at: string; run: number };
type Delivery = { changes: number; run: Run; bindings: Record<string, { generation: number; label: string; activatedAt: string }>; epochs: Record<string, number>; controls: Control[]; grants: Grant[]; empties: Record<string, number>; offers: Offer[] };
export type Hold = 'none' | 'not_running' | 'budget_room' | 'budget_agent' | 'storage';

const DEFAULTS: Limits = { room: 40, agent: 12, emptyWaits: 30 };
const RANGES: Record<keyof Limits, number> = { room: 500, agent: 200, emptyWaits: 1000 };
export const CAPS = { unitsPerOffer: 5, offers: 2000, grants: 500, controls: 1000 };

// ── Shapes ────────────────────────────────────────────────────────────────────────────────
type Check = (value: any) => boolean;
const text = (max: number): Check => v => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const whole = (min: number, max: number): Check => v => Number.isInteger(v) && v >= min && v <= max;
const ident = (prefix: string): Check => v => typeof v === 'string' && v.length <= 100 && v.startsWith(`${prefix}_`) && v.length > prefix.length + 1;
const object = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => v => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  for (const key of Object.keys(v)) if (!Object.hasOwn(required, key) && !Object.hasOwn(optional, key)) fail(400, 'unknown_field', `Unknown field: ${key}`);
  for (const [key, ok] of Object.entries(required)) if (v[key] === undefined || !ok(v[key])) fail(400, 'invalid_field', `${key} is missing or invalid`);
  for (const [key, ok] of Object.entries(optional)) if (v[key] !== undefined && !ok(v[key])) fail(400, 'invalid_field', `${key} is invalid`);
  return true;
};
const limits = object({}, { room: whole(1, RANGES.room), agent: whole(1, RANGES.agent), emptyWaits: whole(1, RANGES.emptyWaits) });
const key = text(200);
const generation = whole(1, Number.MAX_SAFE_INTEGER);
const BODIES: Record<string, Check> = {
  bind: object({ requestId: key, label: text(100) }),
  confirm: object({ requestId: key, generation, wakeId: ident('wk') }),
  run_start: object({ requestId: key }, { limits }),
  run_pause: object({ requestId: key }), run_resume: object({ requestId: key }), run_end: object({ requestId: key }),
  run_limits: object({ requestId: key, limits }),
  run_reoffer: object({ requestId: key, participant: text(100) }), run_rearm: object({ requestId: key, participant: text(100) }),
  fetch: object({ generation, wakeId: ident('wk') }),
  run: object({}),
  wait: object({ generation, timeoutSeconds: whole(1, 3300) }, { attemptId: text(200) }),
};

// ── Units ─────────────────────────────────────────────────────────────────────────────────
// Everything a participant could be told about that is still current, oldest first. Four kinds and no others:
// anything absent from this function can never end a wait.
function currentUnits(session: any, participantId: string) {
  const found: (Unit & { at: string; view: unknown })[] = [];
  const requests = project(session).items.flatMap((item: any) => item.requests);
  for (const r of requests) {
    if (r.slots.some((s: any) => s.respondentId === participantId && s.state === 'open')) found.push({ kind: 'slot', id: r.collabRequestId, at: r.at, view: r });
    if (r.requesterId !== participantId) continue;
    if (r.state === 'open' || r.state === 'settled') for (const x of r.responses) found.push({ kind: 'response', id: x.responseId, at: x.at, view: { request: r, response: x } });
    if (r.state !== 'accepted') for (const e of session.events) if (e.type === 'slots_withdrawn' && e.collabRequestId === r.collabRequestId && e.by !== participantId) found.push({ kind: 'withdrawal', id: `${r.collabRequestId}:${e.seq}`, at: e.at, view: { request: r, withdrawal: { by: e.by, respondentIds: e.respondentIds, reason: e.reason, at: e.at } } });
  }
  const acknowledged = new Set(session.participants.find((p: any) => p.id === participantId)?.ack ?? []);
  // Ordinary mail the recipient has not acknowledged, from the human or from another agent. Mail between agents was
  // passive until 9 October 2026; it wakes now so that agents can talk without the human relaying, and the run's
  // offer budgets are what bound an exchange. An agent's own message never wakes its sender.
  for (const m of session.messages) if (m.messageKind === undefined && m.sender.id !== participantId && m.recipientIds.includes(participantId) && !acknowledged.has(m.id)) found.push({ kind: m.sender.kind === 'human' ? 'human_message' : 'agent_message', id: m.id, at: m.createdAt, view: m });
  return found.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
const name = (unit: Unit) => `${unit.kind}:${unit.id}`;
const epochOf = (d: Delivery, participantId: string) => d.epochs[participantId] ?? 1;
// Covered means confirmed in the participant's current intake epoch. Earlier confirmations stay true and stop counting.
function eligibleUnits(session: any, participantId: string) {
  const d: Delivery = session.delivery;
  const covered = new Set(d.offers.filter(o => o.participantId === participantId && o.confirmedAt && o.epoch === epochOf(d, participantId)).flatMap(o => o.units.map(name)));
  return currentUnits(session, participantId).filter(unit => !covered.has(name(unit)));
}
// At either cap every grant and every control action except pause and end is refused.
const full = (d: Delivery) => d.grants.length >= CAPS.grants || d.controls.length >= CAPS.controls;
const pending = (d: Delivery, participantId: string) => d.offers.find(o => o.participantId === participantId && !o.confirmedAt && !o.closed);
// Who caused a unit, from the session's own records, never from text: a message's kind says so, and a request,
// response or withdrawal names its author. Only what an agent caused spends the run's budget (item 19), so the
// human's own messages and tasks always get through; an author the records cannot name is treated as an agent.
function causes(session: any) {
  const kindOf = new Map<string, string>(session.participants.map((p: any) => [p.id, p.kind]));
  let requests: any[] | undefined; const all = () => requests ??= project(session).items.flatMap((item: any) => item.requests);
  const by = (id: unknown) => kindOf.get(id as string) !== 'human';
  return (unit: Unit): boolean => {
    if (unit.kind === 'human_message') return false;
    if (unit.kind === 'agent_message') return true;
    if (unit.kind === 'slot') return by(all().find(r => r.collabRequestId === unit.id)?.requesterId);
    if (unit.kind === 'response') return by(all().flatMap(r => r.responses).find((x: any) => x.responseId === unit.id)?.respondentId);
    const [collabRequestId, seq] = unit.id.split(':');
    return by(session.events.find((e: any) => e.type === 'slots_withdrawn' && e.collabRequestId === collabRequestId && String(e.seq) === seq)?.by);
  };
}
// The run's spending: offers of this run that carried anything an agent caused.
const used = (d: Delivery, charged: (unit: Unit) => boolean) => {
  const now = d.offers.filter(o => o.run === d.run.number && o.units.some(charged)); const agents: Record<string, number> = {};
  for (const o of now) agents[o.participantId] = (agents[o.participantId] ?? 0) + 1;
  return { room: now.length, agents };
};
const spentFor = (d: Delivery, spent: ReturnType<typeof used>, participantId: string): Hold | null =>
  spent.room >= d.run.limits.room ? 'budget_room' : (spent.agents[participantId] ?? 0) >= d.run.limits.agent ? 'budget_agent' : null;

// ── Access ────────────────────────────────────────────────────────────────────────────────
function prepare(session: any, op: string, body: any): Delivery {
  if (!session.delivery) fail(409, 'upgrade_required', 'This store predates pull delivery; upgrade it explicitly first');
  if (!BODIES[op](body)) fail(400, 'invalid_field', 'Request must be a JSON object');
  return session.delivery;
}
const agentOnly = (actor: Actor) => { if (actor.kind !== 'agent') fail(403, 'agent_required', 'Only an agent binds, waits, fetches and confirms'); };
const ownerOnly = (actor: Actor) => { if (actor.kind !== 'human') fail(403, 'owner_required', 'Only the human owner controls the run'); };
function agentNamed(session: any, value: string) {
  const found = session.participants.find((p: any) => p.id === value || p.name.toLowerCase() === value.toLowerCase());
  if (!found || found.kind !== 'agent') fail(404, 'unknown_participant', `No agent named ${value} in this session`);
  return found.id as string;
}
// The caller's own offer under its current binding. Someone else's wake ID is simply unknown.
function ownOffer(d: Delivery, actor: Actor, body: { generation: number; wakeId: string }) {
  agentOnly(actor);
  const binding = d.bindings[actor.id];
  if (!binding || binding.generation !== body.generation) fail(409, 'stale_binding', 'This is not your current binding', { current: binding?.generation ?? null });
  const offer = d.offers.find(o => o.wakeId === body.wakeId && o.participantId === actor.id) ?? fail(404, 'unknown_wake', 'Unknown wakeId for this participant');
  if (offer.bindingGeneration !== body.generation) fail(409, 'stale_binding', 'That offer was prepared for an earlier binding', { current: binding.generation });
  if (offer.closed) fail(409, 'offer_closed', `That offer was closed (${offer.closed.reason}); its work is offered again if still current`, { reason: offer.closed.reason });
  return offer;
}

// ── Mutations ─────────────────────────────────────────────────────────────────────────────
export function apply(session: any, actor: Actor, op: string, body: any, env: Env): unknown {
  if (!OPERATIONS[op]?.mutating) fail(404, 'not_found', `Unknown operation ${op}`);
  const d = prepare(session, op, body); const at = env.now();
  const close = (offer: Offer | undefined, reason: 'new_run' | 'rebound' | 'reoffered') => { if (offer) offer.closed = { at, reason }; };

  if (op === 'bind') {
    agentOnly(actor);
    close(pending(d, actor.id), 'rebound');
    const next = (d.bindings[actor.id]?.generation ?? 0) + 1;
    d.bindings[actor.id] = { generation: next, label: body.label, activatedAt: at };
    return { generation: next };
  }
  if (op === 'confirm') {
    const offer = ownOffer(d, actor, body);
    offer.confirmedAt ??= at;
    return { wakeId: offer.wakeId, confirmedAt: offer.confirmedAt };
  }
  ownerOnly(actor);
  if (op === 'run_reoffer' || op === 'run_rearm') {
    const participantId = agentNamed(session, body.participant);
    if (full(d)) fail(409, 'storage', 'This room has reached its limit of grant or control records; export it and start a new room');
    if (op === 'run_reoffer') { d.epochs[participantId] = epochOf(d, participantId) + 1; close(pending(d, participantId), 'reoffered'); }
    else d.empties[participantId] = 0;
    d.grants.push({ seq: d.grants.length + 1, type: op === 'run_reoffer' ? 'reoffer' : 'rearm', participantId, by: actor.id, at, run: d.run.number });
    return { participantId, ...(op === 'run_reoffer' ? { epoch: d.epochs[participantId] } : { empties: 0 }) };
  }
  const type = op.slice(4) as Control['type'];
  const from: Record<string, string[]> = { start: ['idle', 'ended'], pause: ['running'], resume: ['paused'], end: ['running', 'paused'], limits: ['running', 'paused'] };
  if (!from[type].includes(d.run.state)) fail(409, 'run_state', `The run is ${d.run.state}`, { state: d.run.state });
  // Pause and end are always recorded: a room must stay stoppable when it is full.
  if (type !== 'pause' && type !== 'end' && full(d)) fail(409, 'storage', 'This room has reached its limit of grant or control records; export it and start a new room');
  if (type === 'start') {
    for (const offer of d.offers) if (!offer.confirmedAt && !offer.closed) close(offer, 'new_run');
    d.run.number += 1; d.empties = {}; d.run.limits = { ...DEFAULTS, ...(body.limits ?? {}) };
  }
  if (type === 'limits') d.run.limits = { ...d.run.limits, ...body.limits };
  d.run.state = type === 'start' || type === 'resume' ? 'running' : type === 'pause' ? 'paused' : type === 'end' ? 'ended' : d.run.state;
  d.run.control += 1;
  d.controls.push({ seq: d.controls.length + 1, type, by: actor.id, at, run: d.run.number, control: d.run.control, limits: { ...d.run.limits } });
  return { number: d.run.number, state: d.run.state, control: d.run.control, limits: d.run.limits };
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────────
export function read(session: any, actor: Actor, op: string, body: any, live: { waiting(participantId: string): boolean }): unknown {
  if (!OPERATIONS[op] || OPERATIONS[op].mutating) fail(404, 'not_found', `Unknown operation ${op}`);
  const d = prepare(session, op, body);
  if (op === 'fetch') {
    const offer = ownOffer(d, actor, body);
    const current = new Map(currentUnits(session, actor.id).map(unit => [name(unit), unit.view]));
    return { wakeId: offer.wakeId, confirmed: !!offer.confirmedAt, ...(offer.attemptId ? { attemptId: offer.attemptId } : {}), units: offer.units.map(unit => {
      const view: any = current.get(name(unit)) ?? staleView(session, unit);
      return { ...unit, current: current.has(name(unit)), sender: senderOf(session, unit, view), view };
    }), ...(session.marks ? { conversation: conversation(session, actor.id) } : {}) };
  }
  const agents = session.participants.filter((p: any) => p.kind === 'agent');
  const charged = causes(session); const spent = used(d, charged);
  // Held: it has work an agent caused, nothing already offered, and the budget for that work is spent. Only then.
  const heldOf = (id: string, armed: string, offer: Offer | undefined): Hold | null => {
    // In the order evaluate() decides: at the offer storage cap the hold is storage, which no limit releases.
    if (d.run.state !== 'running' || armed === 'disarmed' || armed === 'unknown' || offer || d.offers.length >= CAPS.offers) return null;
    const over = spentFor(d, spent, id); return over && eligibleUnits(session, id).some(charged) ? over : null;
  };
  return { number: d.run.number, state: d.run.state, control: d.run.control, limits: d.run.limits, used: spent, changes: d.changes,
    caps: { offers: { used: d.offers.length, cap: CAPS.offers }, grants: { used: d.grants.length, cap: CAPS.grants }, controls: { used: d.controls.length, cap: CAPS.controls } },
    bindings: agents.map((p: any) => {
      const binding = d.bindings[p.id]; const empties = d.empties[p.id] ?? 0;
      const armed = !binding ? 'unknown' : empties >= d.run.limits.emptyWaits ? 'disarmed' : live.waiting(p.id) ? 'waiting' : 'not_armed';
      const offer = pending(d, p.id);
      return { participantId: p.id, generation: binding?.generation ?? null, label: binding?.label ?? null, armed, empties, held: heldOf(p.id, armed, offer),
        pending: offer ? { wakeId: offer.wakeId, ...(offer.attemptId === undefined ? {} : { attemptId: offer.attemptId }) } : null };
    }) };
}
// A unit that is no longer current is still shown in full, with what its request has become: the exact response or
// withdrawal the offer named does not disappear because the requester has since accepted or the slot has closed.
function staleView(session: any, unit: Unit) {
  if (unit.kind === 'human_message' || unit.kind === 'agent_message') return session.messages.find((m: any) => m.id === unit.id);
  const requests = project(session).items.flatMap((item: any) => item.requests);
  if (unit.kind === 'slot') return requests.find((r: any) => r.collabRequestId === unit.id);
  if (unit.kind === 'response') { const request = requests.find((r: any) => r.responses.some((x: any) => x.responseId === unit.id)); return { request, response: request.responses.find((x: any) => x.responseId === unit.id) }; }
  const [collabRequestId, seq] = unit.id.split(':'); const e = session.events.find((x: any) => x.type === 'slots_withdrawn' && x.collabRequestId === collabRequestId && String(x.seq) === seq);
  return { request: requests.find((r: any) => r.collabRequestId === collabRequestId), withdrawal: { by: e.by, respondentIds: e.respondentIds, reason: e.reason, at: e.at } };
}
// Who wrote the thing a unit points at, taken from the session's own participant records and never from the text.
function senderOf(session: any, unit: Unit, view: any) {
  const id = unit.kind === 'slot' ? view.requesterId : unit.kind === 'response' ? view.response.respondentId : unit.kind === 'withdrawal' ? view.withdrawal.by : view.sender.id;
  const p = session.participants.find((x: any) => x.id === id);
  return { id, name: p.name, kind: p.kind, role: p.role };
}

// ── The wait ──────────────────────────────────────────────────────────────────────────────
export function checkWait(body: any): { generation: number; timeoutSeconds: number; attemptId?: string } {
  if (!BODIES.wait(body)) fail(400, 'invalid_field', 'Request must be a JSON object');
  return { generation: body.generation, timeoutSeconds: body.timeoutSeconds, ...(body.attemptId === undefined ? {} : { attemptId: body.attemptId }) };
}
const pointer = (session: any, offer: Offer) => ({ status: 'offer', wakeId: offer.wakeId, units: offer.units, more: eligibleUnits(session, offer.participantId).some(unit => !offer.units.some(u => name(u) === name(unit))) });

// One synchronous decision. `held` is true when re-checking a wait that is already registered.
export function evaluate(session: any, actor: Actor, generation: number, env: Env, held: boolean, attemptId?: string): { reply: Record<string, unknown>; changed: boolean } | { hold: Hold } {
  if (!session.delivery) fail(409, 'upgrade_required', 'This store predates pull delivery; upgrade it explicitly first');
  agentOnly(actor);
  const d: Delivery = session.delivery; const binding = d.bindings[actor.id];
  if (!binding || binding.generation !== generation) {
    if (held) return { reply: { status: 'superseded' }, changed: false };
    fail(409, 'stale_binding', 'This is not your current binding; bind first', { current: binding?.generation ?? null });
  }
  if ((d.empties[actor.id] ?? 0) >= d.run.limits.emptyWaits) return { reply: { status: 'disarmed' }, changed: false };
  if (d.run.state !== 'running') return { hold: 'not_running' };                      // checked before any offer, old or new
  // A retry of a keyed wait can recover only its own offer. Reusing a finished
  // attempt cannot accidentally prepare new work or charge the budget again.
  if (attemptId !== undefined) {
    const previous = d.offers.find(o => o.participantId === actor.id && o.bindingGeneration === generation && o.attemptId === attemptId);
    if (previous?.confirmedAt || previous?.closed) fail(409, 'attempt_finished', 'This wait attempt has already been confirmed or closed; start a fresh wait');
  }
  const waiting = pending(d, actor.id);
  if (waiting) {
    if (waiting.attemptId !== undefined && waiting.attemptId !== attemptId) fail(409, 'already_waiting', 'Another wait attempt owns the pending offer; explicitly recover that attempt');
    return { reply: pointer(session, waiting), changed: false };
  }
  const eligible = eligibleUnits(session, actor.id);
  if (!eligible.length) return { hold: 'none' };
  if (d.offers.length >= CAPS.offers) return { hold: 'storage' };
  // A spent budget holds what agents caused; what the human caused is still offered, and costs nothing.
  const charged = causes(session); const over = spentFor(d, used(d, charged), actor.id);
  const offered = over ? eligible.filter(unit => !charged(unit)) : eligible;
  if (!offered.length) return { hold: over! };
  const offer: Offer = { wakeId: env.id('wk'), participantId: actor.id, bindingGeneration: generation, run: d.run.number, control: d.run.control, epoch: epochOf(d, actor.id),
    units: offered.slice(0, CAPS.unitsPerOffer).map(({ kind, id }) => ({ kind, id })), changesAt: d.changes, preparedAt: env.now(), ...(attemptId === undefined ? {} : { attemptId }) };
  d.offers.push(offer); d.empties[actor.id] = 0;
  return { reply: pointer(session, offer), changed: true };
}

// The deadline of a held wait passed. Only a wait with nothing to offer is an empty return against this agent's
// allowance: one held by a spent budget, a pause or the storage cap had work, and counting it would disarm an agent
// for waiting on the human (item 19).
export function expire(session: any, actor: Actor, generation: number, hold: Hold): { reply: Record<string, unknown>; changed: boolean } {
  const d: Delivery = session.delivery;
  if (d.bindings[actor.id]?.generation !== generation) return { reply: { status: 'superseded' }, changed: false };
  if (hold !== 'none') return { reply: { status: 'timeout', held: hold }, changed: false };
  d.empties[actor.id] = (d.empties[actor.id] ?? 0) + 1;
  return { reply: { status: 'timeout', held: hold }, changed: true };
}

// ── Storage ───────────────────────────────────────────────────────────────────────────────
// The delivery record of a room nobody has started: no run, no bindings, nothing offered.
export function initial(): Delivery {
  return { changes: 0, run: { number: 0, state: 'idle', control: 0, limits: { ...DEFAULTS } }, bindings: {}, epochs: {}, controls: [], grants: [], empties: {}, offers: [] };
}
export function upgrade(session: any): void { session.delivery = initial(); }

// Refuses delivery state the rules above could not have produced. Throws a plain Error naming what is wrong; the
// caller stops without rewriting the file.
export function validate(session: any): void {
  const bad = (what: string): never => { throw new Error(`Delivery state is invalid: ${what}`); };
  const d = session.delivery;
  const count: Check = v => Number.isInteger(v) && v >= 0;
  const stamp: Check = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
  const record = (v: any, keys: string[], optional: string[] = []) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k) || optional.includes(k)) && keys.every(k => v[k] !== undefined);
  const limitsOk = (v: any) => record(v, ['room', 'agent', 'emptyWaits']) && (Object.keys(RANGES) as (keyof Limits)[]).every(k => Number.isInteger(v[k]) && v[k] >= 1 && v[k] <= RANGES[k]);
  if (!record(d, ['changes', 'run', 'bindings', 'epochs', 'controls', 'grants', 'empties', 'offers']) || !count(d.changes) || !record(d.run, ['number', 'state', 'control', 'limits']) ||
      !count(d.run.number) || !count(d.run.control) || !['idle', 'running', 'paused', 'ended'].includes(d.run.state) || !limitsOk(d.run.limits) ||
      !Array.isArray(d.controls) || !Array.isArray(d.grants) || !Array.isArray(d.offers) || [d.bindings, d.epochs, d.empties].some(m => !m || typeof m !== 'object' || Array.isArray(m))) bad('malformed delivery record');
  const kindOf = new Map<string, string>(session.participants.map((p: any) => [p.id, p.kind]));
  const agent = (id: any) => kindOf.get(id) === 'agent';
  for (const [id, b] of Object.entries(d.bindings) as [string, any][]) if (!agent(id) || !record(b, ['generation', 'label', 'activatedAt']) || !Number.isInteger(b.generation) || b.generation < 1 || !text(100)(b.label) || !stamp(b.activatedAt)) bad(`binding of ${id}`);
  for (const [id, n] of Object.entries(d.empties)) if (!agent(id) || !count(n)) bad(`empty-return count of ${id}`);
  // Controls are not capped here: pause and end are accepted past the cap by design.
  if (d.grants.length > CAPS.grants || d.offers.length > CAPS.offers) bad('a retention cap is exceeded');

  // Replaying the control history must reproduce the present run exactly.
  const replay: Run = { number: 0, state: 'idle', control: 0, limits: { ...DEFAULTS } }; const running = new Map<number, Control>();
  d.controls.forEach((c: any, index: number) => {
    if (!record(c, ['seq', 'type', 'by', 'at', 'run', 'control', 'limits']) || c.seq !== index + 1 || kindOf.get(c.by) !== 'human' || !stamp(c.at) || !limitsOk(c.limits)) bad(`control ${index + 1}`);
    const allowed: Record<string, string[]> = { start: ['idle', 'ended'], pause: ['running'], resume: ['paused'], end: ['running', 'paused'], limits: ['running', 'paused'] };
    if (!allowed[c.type]?.includes(replay.state)) bad(`control ${c.seq} (${c.type}) does not follow a ${replay.state} run`);
    // Past the cap only the two actions that are always accepted can have been recorded.
    if (index >= CAPS.controls && c.type !== 'pause' && c.type !== 'end') bad(`control ${c.seq} (${c.type}) was recorded beyond the retention cap`);
    if (c.type === 'start') replay.number += 1;
    replay.state = c.type === 'start' || c.type === 'resume' ? 'running' : c.type === 'pause' ? 'paused' : c.type === 'end' ? 'ended' : replay.state;
    replay.control += 1; replay.limits = c.limits;
    if (c.run !== replay.number || c.control !== replay.control) bad(`control ${c.seq} numbering`);
    if (replay.state === 'running') running.set(c.control, c);
  });
  if (replay.number !== d.run.number || replay.state !== d.run.state || replay.control !== d.run.control || (Object.keys(RANGES) as (keyof Limits)[]).some(k => replay.limits[k] !== d.run.limits[k])) bad('the run does not match its control history');

  const reoffers = new Map<string, number>();
  d.grants.forEach((g: any, index: number) => {
    if (!record(g, ['seq', 'type', 'participantId', 'by', 'at', 'run']) || g.seq !== index + 1 || !['reoffer', 'rearm'].includes(g.type) || !agent(g.participantId) || kindOf.get(g.by) !== 'human' || !stamp(g.at) || !count(g.run) || g.run > d.run.number) bad(`grant ${index + 1}`);
    if (g.type === 'reoffer') reoffers.set(g.participantId, (reoffers.get(g.participantId) ?? 0) + 1);
  });
  for (const [id, n] of Object.entries(d.epochs)) if (!agent(id) || n !== 1 + (reoffers.get(id) ?? 0)) bad(`intake epoch of ${id} does not match its grants`);
  for (const [id, n] of reoffers) if (d.epochs[id] !== 1 + n) bad(`intake epoch of ${id} does not match its grants`);

  // A unit is valid only if it exists, is of the stated kind, and this participant is its recipient.
  const requests = new Map<string, any>(project(session).items.flatMap((item: any) => item.requests).map((r: any) => [r.collabRequestId, r]));
  const owns = (participantId: string, unit: any): boolean => {
    if (!record(unit, ['kind', 'id']) || typeof unit.id !== 'string') return false;
    if (unit.kind === 'slot') return !!requests.get(unit.id)?.respondentIds.includes(participantId);
    if (unit.kind === 'response') return [...requests.values()].some(r => r.requesterId === participantId && r.responses.some((x: any) => x.responseId === unit.id));
    // The whole ID must be the one this event has; a real ID with anything appended names nothing.
    if (unit.kind === 'withdrawal') return session.events.some((e: any) => e.type === 'slots_withdrawn' && `${e.collabRequestId}:${e.seq}` === unit.id && e.by !== participantId && requests.get(e.collabRequestId)?.requesterId === participantId);
    if (unit.kind === 'human_message') return session.messages.some((m: any) => m.id === unit.id && m.sender.kind === 'human' && m.messageKind === undefined && m.recipientIds.includes(participantId));
    if (unit.kind === 'agent_message') return session.messages.some((m: any) => m.id === unit.id && m.sender.kind === 'agent' && m.sender.id !== participantId && m.messageKind === undefined && m.recipientIds.includes(participantId));
    return false;
  };
  const charged = causes(session);
  const wakeIds = new Set<string>(); const attempts = new Set<string>(); const open = new Set<string>(); const perRun = new Map<number, { room: number; agents: Map<string, number> }>();
  d.offers.forEach((o: any, index: number) => {
    const where = `offer ${index + 1}`;
    if (!record(o, ['wakeId', 'participantId', 'bindingGeneration', 'run', 'control', 'epoch', 'units', 'changesAt', 'preparedAt'], ['confirmedAt', 'closed', 'attemptId']) || !ident('wk')(o.wakeId) || wakeIds.has(o.wakeId) || !agent(o.participantId) || !stamp(o.preparedAt) || !count(o.changesAt)) bad(where);
    wakeIds.add(o.wakeId);
    if (o.attemptId !== undefined) {
      const attempt = JSON.stringify([o.participantId, o.bindingGeneration, o.attemptId]);
      if (!text(200)(o.attemptId) || attempts.has(attempt)) bad(`${where}: invalid or reused wait attempt`);
      attempts.add(attempt);
    }
    const binding = d.bindings[o.participantId]; const epoch = d.epochs[o.participantId] ?? 1;
    if (!binding || !Number.isInteger(o.bindingGeneration) || o.bindingGeneration < 1 || o.bindingGeneration > binding.generation || !Number.isInteger(o.epoch) || o.epoch < 1 || o.epoch > epoch) bad(`${where}: binding or epoch`);
    const prepared = running.get(o.control);
    if (!prepared || prepared.run !== o.run) bad(`${where}: not prepared under a running control of its run`);
    if (!Array.isArray(o.units) || o.units.length < 1 || o.units.length > CAPS.unitsPerOffer || o.units.some((unit: any) => !owns(o.participantId, unit))) bad(`${where}: a unit does not exist or belongs to someone else`);
    if (o.confirmedAt !== undefined && o.closed !== undefined) bad(`${where}: both confirmed and closed`);
    if (o.confirmedAt !== undefined && (!stamp(o.confirmedAt) || o.confirmedAt < o.preparedAt)) bad(`${where}: confirmation time`);
    if (o.closed !== undefined && (!record(o.closed, ['at', 'reason']) || !['new_run', 'rebound', 'reoffered'].includes(o.closed.reason) || !stamp(o.closed.at) || o.closed.at < o.preparedAt)) bad(`${where}: closure`);
    if (!o.confirmedAt && !o.closed) {
      if (open.has(o.participantId) || o.bindingGeneration !== binding.generation || o.epoch !== epoch || o.run !== d.run.number) bad(`${where}: a pending offer must be the only one, for the current binding, epoch and run`);
      open.add(o.participantId);
    }
    // Within budget at the limits in force when it was prepared; a later lowering is valid history. As `used()`
    // counts it: only an offer carrying something an agent caused was charged.
    if (!o.units.some(charged)) return;
    const tally = perRun.get(o.run) ?? { room: 0, agents: new Map<string, number>() }; perRun.set(o.run, tally);
    tally.room += 1; tally.agents.set(o.participantId, (tally.agents.get(o.participantId) ?? 0) + 1);
    if (tally.room > prepared.limits.room || tally.agents.get(o.participantId)! > prepared.limits.agent) bad(`${where}: beyond the limit in force when it was prepared`);
  });
}
