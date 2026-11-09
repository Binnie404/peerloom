import { DomainError } from './collab.ts';

// Quiet coordination (item 24, slice C): what an agent or the human can say about a message without sending one, and
// what the sender can see of what happened to it. Nothing here is ever a delivery unit, so nothing here wakes anyone or
// spends a run's budget; currentUnits in delivery.ts only counts ordinary mail, slots, responses and withdrawals.
//
// Storage seam: a session's marks are append-only records in `session.marks`. The current reactions and activity are a
// fold over them, so a later storage engine can keep the same records as rows and the same fold as a query. Receipts
// are not stored at all: stored, fetched and acknowledged are derived from the message, the delivery offers and the
// participant's acknowledgements the hub already keeps.
//
// The words are exact. Fetched means the recipient's client confirmed an offer that held the message; acknowledged means
// the recipient acknowledged it. Neither says a model read it, and neither settles a request: a structured request is
// answered with respond, whatever the receipts say.

export const REACTIONS = ['👍', '✅', '👀', '❌', '🎉'] as const;
export const ACTIVITY = ['working', 'blocked', 'done'] as const;
export const MARKS_CAP = 20_000;
type Reaction = { seq: number; type: 'reaction'; by: string; messageId: string; emoji: string; on: boolean; at: string };
type Activity = { seq: number; type: 'activity'; by: string; state: 'working' | 'blocked' | 'done'; messageId?: string; text?: string; at: string };
export type Mark = Reaction | Activity;
// A refusal here is a domain refusal like the collaboration ones: the hub rolls the mutation back and keeps serving,
// rather than treating it as a failed write (found by the slice C hub tests).
const fail = (status: number, code: string, message: string): never => { throw new DomainError(status, code, message); };

const marksOf = (session: any): Mark[] => session.marks ??= [];
function append(session: any, mark: Omit<Reaction, 'seq'> | Omit<Activity, 'seq'>) {
  const marks = marksOf(session); if (marks.length >= MARKS_CAP) fail(409, 'marks_full', 'This room has reached its limit of reactions and activity records; export it and start a new room');
  const full = { seq: marks.length + 1, ...mark } as Mark; marks.push(full); return full;
}
const visibleTo = (m: any, actor: { id: string; kind: string }) => actor.kind === 'human' || m.sender.id === actor.id || m.recipientIds.includes(actor.id);

// A reaction is set or removed, by its author, on a message the author can see. Setting it twice is one reaction.
export function react(session: any, actor: { id: string; kind: string }, body: any, at: string) {
  const m = session.messages.find((x: any) => x.id === body.messageId); if (!m || !visibleTo(m, actor)) fail(404, 'unknown_message', 'messageId must identify a message you sent or received');
  if (!REACTIONS.includes(body.emoji)) fail(400, 'invalid_reaction', `emoji is one of ${REACTIONS.join(' ')}`);
  const on = body.on === undefined ? true : body.on === true ? true : body.on === false ? false : fail(400, 'invalid_reaction', 'on is true or false');
  if (current(session).reactions.get(`${actor.id} ${m.id} ${body.emoji}`) === on || (!on && !current(session).reactions.has(`${actor.id} ${m.id} ${body.emoji}`))) return { messageId: m.id, emoji: body.emoji, on, changed: false };
  append(session, { type: 'reaction', by: actor.id, messageId: m.id, emoji: body.emoji, on, at }); return { messageId: m.id, emoji: body.emoji, on, changed: true };
}

// What an agent is doing, in one line beside it: working or blocked, optionally on one message; done clears it.
export function activity(session: any, actor: { id: string; kind: string }, body: any, at: string) {
  if (!ACTIVITY.includes(body.state)) fail(400, 'invalid_activity', 'state is working, blocked or done');
  if (body.messageId !== undefined) { const m = session.messages.find((x: any) => x.id === body.messageId); if (!m || !visibleTo(m, actor)) fail(404, 'unknown_message', 'messageId must identify a message you sent or received'); }
  if (body.text !== undefined && (typeof body.text !== 'string' || body.text.length > 200 || /[\u0000-\u001f\u007f]/.test(body.text))) fail(400, 'invalid_activity', 'text is one line of at most 200 characters');
  if (body.state === 'blocked' && !body.text) fail(400, 'invalid_activity', 'A blocked line says what it is blocked on');
  const mark = append(session, { type: 'activity', by: actor.id, state: body.state, ...(body.messageId ? { messageId: body.messageId } : {}), ...(body.text ? { text: body.text } : {}), at });
  return { participantId: actor.id, state: mark.state, ...(body.messageId ? { messageId: body.messageId } : {}), at };
}

// The fold: reactions currently on, and each participant's latest activity unless it was done.
export function current(session: any) {
  const reactions = new Map<string, boolean>(); const latest = new Map<string, Activity>();
  for (const mark of marksOf(session)) {
    if (mark.type === 'reaction') { const k = `${mark.by} ${mark.messageId} ${mark.emoji}`; if (mark.on) reactions.set(k, true); else reactions.delete(k); }
    else latest.set(mark.by, mark);
  }
  return { reactions, activity: [...latest.values()].filter(a => a.state !== 'done') };
}

// What happened to messages, per recipient, as the sender (or the human, who sees the room) may know it.
export function receipts(session: any, actor: { id: string; kind: string }, body: any) {
  const after = body.after ?? 0; const limit = body.limit ?? 200;
  if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) fail(400, 'invalid_cursor', 'after must be a nonnegative integer; limit must be 1–500');
  const fetched = new Map<string, Set<string>>();
  for (const o of session.delivery?.offers ?? []) if (o.confirmedAt) for (const u of o.units) if (u.kind === 'human_message' || u.kind === 'agent_message') {
    const set = fetched.get(u.id) ?? new Set<string>(); set.add(o.participantId); fetched.set(u.id, set); }
  const acked = new Map<string, Set<string>>(session.participants.map((p: any) => [p.id, new Set(p.ack)]));
  const { reactions, activity: now } = current(session);
  const shown = session.messages.filter((m: any) => m.sequence > after && (actor.kind === 'human' || m.sender.id === actor.id || m.recipientIds.includes(actor.id))).slice(0, limit);
  return {
    messages: shown.map((m: any) => ({
      messageId: m.id, sequence: m.sequence,
      // Per-recipient states only for what the actor sent, or for the human; a recipient sees reactions, not others' receipts.
      ...(actor.kind === 'human' || m.sender.id === actor.id ? { recipients: m.recipientIds.map((pid: string) => ({ participantId: pid,
        state: acked.get(pid)?.has(m.id) ? 'acknowledged' : fetched.get(m.id)?.has(pid) ? 'fetched' : 'stored' })) } : {}),
      reactions: [...reactions.keys()].filter(k => k.split(' ')[1] === m.id).map(k => { const [by, , emoji] = k.split(' '); return { by, emoji }; }),
    })),
    activity: now.map(a => ({ participantId: a.by, state: a.state, ...(a.messageId ? { messageId: a.messageId } : {}), ...(a.text ? { text: a.text } : {}), at: a.at })),
    nextCursor: shown.at(-1)?.sequence ?? after,
  };
}

// Diagnostic counters for a wake (Bolter has the same idea): how much agents have said since the human last spoke. They
// decide nothing; budgets and obligations do.
export function conversation(session: any, participantId: string) {
  const lastHuman = [...session.messages].reverse().find((m: any) => m.sender.kind === 'human');
  const since = session.messages.filter((m: any) => !lastHuman || m.sequence > lastHuman.sequence);
  return { agentMessagesSinceHuman: since.filter((m: any) => m.sender.kind === 'agent').length, yoursSinceHuman: since.filter((m: any) => m.sender.id === participantId).length,
    lastHumanAt: lastHuman?.createdAt ?? null };
}

// Store version 6 adds `marks`, passive posts (messageKind 'post', no collab record) and `noReply` on mail.
export function validate(session: any, bad: (where: string) => never) {
  const marks = session.marks; if (!Array.isArray(marks) || marks.length > MARKS_CAP) bad('marks schema');
  const peers = new Set(session.participants.map((p: any) => p.id)); const messages = new Map(session.messages.map((m: any) => [m.id, m]));
  const date = (v: any) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
  for (const [index, mark] of marks.entries()) {
    const keys = mark?.type === 'reaction' ? ['seq', 'type', 'by', 'messageId', 'emoji', 'on', 'at'] : ['seq', 'type', 'by', 'state', 'messageId', 'text', 'at'];
    if (!mark || typeof mark !== 'object' || Object.keys(mark).some(k => !keys.includes(k)) || mark.seq !== index + 1 || !peers.has(mark.by) || !date(mark.at)) bad('mark schema');
    if (mark.type === 'reaction') { if (!messages.has(mark.messageId) || !REACTIONS.includes(mark.emoji) || typeof mark.on !== 'boolean') bad('reaction schema'); }
    else if (mark.type === 'activity') { if (!ACTIVITY.includes(mark.state) || (mark.messageId !== undefined && !messages.has(mark.messageId)) || (mark.text !== undefined && (typeof mark.text !== 'string' || mark.text.length > 200))) bad('activity schema'); }
    else bad('mark type');
  }
}
