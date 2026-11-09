// Collaboration domain: items, hub-digested revisions, requests with per-respondent slots,
// responses and requester acceptance. Pure: no file or network access. Everything a reader
// sees is computed from the session's append-only `events`; nothing derived is stored.
import { createHash } from 'node:crypto';

export class DomainError extends Error {
  status: number; code: string; detail?: unknown;
  constructor(status: number, code: string, message: string, detail?: unknown) { super(message); this.status = status; this.code = code; if (detail !== undefined) this.detail = detail; }
}
const fail = (status: number, code: string, message: string, detail?: unknown): never => { throw new DomainError(status, code, message, detail); };

export const OPERATIONS: Record<string, { mutating: boolean }> = {
  suggest: { mutating: true }, adopt_suggestion: { mutating: true },
  item_open: { mutating: true }, item_close: { mutating: true }, publish: { mutating: true }, request: { mutating: true },
  respond: { mutating: true }, withdraw: { mutating: true }, accept: { mutating: true },
  requests: { mutating: false }, items: { mutating: false }, item: { mutating: false }, revision: { mutating: false },
};

type Actor = { id: string; name: string; kind: string; role: string };
type Env = { now(): string; id(prefix: string): string };
type Target = { artifactId: string; revision: number; digest: string };
type Event = { seq: number; type: string; at: string; by: string; [field: string]: any };
type SlotState = 'open' | 'responded' | 'declined' | 'withdrawn';
type Response = { responseId: string; collabRequestId: string; by: string; seq: number; at: string; messageId: string; outcome: 'answered' | 'declined'; verdict?: 'approve' | 'changes_requested'; target?: Target; text: string };
type Request = { collabRequestId: string; itemId: string; by: string; seq: number; at: string; messageId: string; purpose: string; respondentIds: string[]; policy: 'all' | 'any'; target?: Target; text: string; responses: Response[]; withdrawn: Set<string>; accepted?: { responseIds: string[]; at: string } };
type Revision = { revision: number; contentDigest: string; contentSize: number; contentInline: string; at: string };
type Artifact = { artifactId: string; itemId: string; authorId: string; revisions: Revision[] };
type TaskPayload = { outcome: string; scope: string; acceptance: string[] };
type Adoption = { target: Target; taskItemId: string; collabRequestId: string; assigneeId: string; task: TaskPayload; taskDigest: string; by: string; at: string; seq: number };
type Item = { itemId: string; itemType: string; title: string; ownerId: string; externalRefs: { provider: string; ref: string }[]; at: string; adoption?: Adoption; closure?: { state: string; reason: string; agreed?: Target; by: string; at: string } };
type Model = { items: Map<string, Item>; artifacts: Map<string, Artifact>; requests: Map<string, Request>; responses: Map<string, Response> };

// ── Shapes ────────────────────────────────────────────────────────────────────────────────
type Check = (value: any) => boolean;
const text = (max: number): Check => v => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const oneOf = (...values: string[]): Check => v => typeof v === 'string' && values.includes(v);
const ident = (prefix: string): Check => v => typeof v === 'string' && v.length <= 100 && v.startsWith(`${prefix}_`) && v.length > prefix.length + 1;
const positive: Check = v => Number.isInteger(v) && v >= 1;
const list = (entry: Check, min: number, max: number): Check => v => Array.isArray(v) && v.length >= min && v.length <= max && v.every(entry);
const distinct = (inner: Check): Check => v => inner(v) && new Set(v).size === v.length;
// Unlike the scalar checks, a wrong key or member is reported by name rather than as a bare false.
const object = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => v => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  for (const key of Object.keys(v)) if (!Object.hasOwn(required, key) && !Object.hasOwn(optional, key)) fail(400, 'unknown_field', `Unknown field: ${key}`);
  for (const [key, ok] of Object.entries(required)) if (v[key] === undefined || !ok(v[key])) fail(400, 'invalid_field', `${key} is missing or invalid`);
  for (const [key, ok] of Object.entries(optional)) if (v[key] !== undefined && !ok(v[key])) fail(400, 'invalid_field', `${key} is invalid`);
  return true;
};

const ITEM_TYPES = ['question', 'discussion', 'suggestion', 'research', 'task', 'decision'];
const digest: Check = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const target = object({ artifactId: ident('ar'), revision: positive, digest });
const externalRefs = list(object({ provider: text(50), ref: text(500) }), 0, 10);
const key = text(200);
export type ProposalPayload = TaskPayload & { v: 1; kind: 'gap' | 'idea'; gap: string; evidence: string[]; why: string; payoff: string; effort: 'small' | 'medium' | 'large'; impact: 'low' | 'medium' | 'high' };
const taskPayload = object({ outcome: text(2000), scope: text(2000), acceptance: list(text(500), 1, 10) });
const proposalPayload = object({ v: v => v === 1, kind: oneOf('gap', 'idea'), gap: text(2000), outcome: text(2000), evidence: list(text(500), 0, 10), why: text(2000), payoff: text(1000), effort: oneOf('small', 'medium', 'large'), impact: oneOf('low', 'medium', 'high'), scope: text(2000), acceptance: list(text(500), 1, 10) });
export function validateProposal(value: unknown): ProposalPayload {
  if (!proposalPayload(value)) fail(400, 'invalid_field', 'Proposal must be a version 1 payload');
  return value as ProposalPayload;
}
export function parseProposal(value: unknown): { payload: ProposalPayload | null; error: string | null } {
  try {
    if (typeof value !== 'string' || value.length > 32000) throw new Error('Proposal must be JSON text, at most 32000 characters');
    return { payload: validateProposal(JSON.parse(value)), error: null };
  } catch (error: any) { return { payload: null, error: error instanceof DomainError ? error.message : 'Proposal is not valid version 1 JSON' }; }
}
const canonical = (value: any): string => JSON.stringify(value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))])) : Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : value);
const assignmentText = (sourceId: string, target: Target, task: TaskPayload) => `Outcome:\n${task.outcome}\n\nScope:\n${task.scope}\n\nAcceptance criteria:\n${task.acceptance.map((v, i) => `${i + 1}. ${v}`).join('\n')}\n\nAdopted suggestion: ${sourceId}; artifact ${target.artifactId} R${target.revision}; sha256 ${target.digest}. Review positions and objections remain on the source suggestion. Report evidence against these criteria; task creation alone is not completion.`;
const adoptionReceipt = (itemId: string, a: Adoption) => ({ itemId, taskItemId: a.taskItemId, collabRequestId: a.collabRequestId, assigneeId: a.assigneeId, target: a.target, taskDigest: a.taskDigest, seq: a.seq });
const BODIES: Record<string, Check> = {
  suggest: object({ requestId: key, title: text(200), payload: proposalPayload }),
  adopt_suggestion: object({ requestId: key, itemId: ident('it'), target, assignee: text(100), task: taskPayload }),
  item_open: object({ requestId: key, itemType: oneOf(...ITEM_TYPES), title: text(200) }, { externalRefs }),
  item_close: object({ requestId: key, itemId: ident('it'), state: oneOf('resolved', 'dropped'), reason: text(1000) }, { agreed: target }),
  publish: object({ requestId: key, itemId: ident('it'), text: text(32000) }, { artifactId: ident('ar'), baseRevision: positive }),
  request: object({ requestId: key, itemId: ident('it'), purpose: oneOf('review', 'answer', 'decision'), to: list(text(100), 1, 20), text: text(32000) }, { policy: oneOf('all', 'any'), target }),
  respond: object({ requestId: key, collabRequestId: ident('rq'), outcome: oneOf('answered', 'declined'), text: text(32000) }, { verdict: oneOf('approve', 'changes_requested'), target }),
  withdraw: object({ requestId: key, collabRequestId: ident('rq'), reason: text(1000) }, { respondents: list(text(100), 1, 20) }),
  accept: object({ requestId: key, collabRequestId: ident('rq'), responseIds: distinct(list(ident('rs'), 1, 20)) }),
  requests: object({ filter: oneOf('owed_by_me', 'owed_to_me', 'item') }, { itemId: ident('it') }),
  items: object({}),
  item: object({ itemId: ident('it') }),
  revision: object({ artifactId: ident('ar'), revision: positive }),
};
const stamp = { seq: positive, at: text(40), by: ident('p') };
const people = distinct(list(ident('p'), 1, 20));
const EVENTS: Record<string, Check> = {
  suggestion_adopted: object({ ...stamp, type: oneOf('suggestion_adopted'), itemId: ident('it'), target, taskItemId: ident('it'), collabRequestId: ident('rq'), assigneeId: ident('p'), task: taskPayload, taskDigest: digest }),
  item_opened: object({ ...stamp, type: oneOf('item_opened'), itemId: ident('it'), itemType: oneOf(...ITEM_TYPES), title: text(200), externalRefs }),
  item_closed: object({ ...stamp, type: oneOf('item_closed'), itemId: ident('it'), state: oneOf('resolved', 'dropped'), reason: text(1000) }, { agreed: target }),
  revision_published: object({ ...stamp, type: oneOf('revision_published'), itemId: ident('it'), artifactId: ident('ar'), revision: positive, contentDigest: digest, contentSize: positive, contentInline: text(32000) }),
  request_opened: object({ ...stamp, type: oneOf('request_opened'), collabRequestId: ident('rq'), itemId: ident('it'), messageId: ident('m'), purpose: oneOf('review', 'answer', 'decision'), respondentIds: people, policy: oneOf('all', 'any'), text: text(32000) }, { target }),
  response_given: object({ ...stamp, type: oneOf('response_given'), responseId: ident('rs'), collabRequestId: ident('rq'), messageId: ident('m'), outcome: oneOf('answered', 'declined'), text: text(32000) }, { verdict: oneOf('approve', 'changes_requested'), target }),
  slots_withdrawn: object({ ...stamp, type: oneOf('slots_withdrawn'), collabRequestId: ident('rq'), respondentIds: people, reason: text(1000) }),
  request_accepted: object({ ...stamp, type: oneOf('request_accepted'), collabRequestId: ident('rq'), responseIds: distinct(list(ident('rs'), 1, 20)) }),
};

// ── Derivation ────────────────────────────────────────────────────────────────────────────
const sha256 = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
const latest = (artifact: Artifact) => artifact.revisions.at(-1)!;
const sameTarget = (a?: Target, b?: Target) => a === undefined || b === undefined ? a === b : a.artifactId === b.artifactId && a.revision === b.revision && a.digest === b.digest;
const answered = (request: Request) => request.responses.filter(r => r.outcome === 'answered');

function slot(request: Request, participantId: string): SlotState {
  const own = request.responses.find(r => r.by === participantId);
  if (own) return own.outcome === 'answered' ? 'responded' : 'declined';
  if (request.withdrawn.has(participantId) || request.policy === 'any' && answered(request).length > 0) return 'withdrawn';
  return 'open';
}
function requestState(request: Request) {
  const slots = request.respondentIds.map(p => slot(request, p));
  if (slots.includes('open')) return 'open';
  if (request.accepted) return 'accepted';
  return slots.some(s => s === 'responded' || s === 'declined') ? 'settled' : 'withdrawn';
}
// The designated criterion for this request's own respondents and policy; never room consensus.
function reviewResult(request: Request) {
  if (request.purpose !== 'review' || !request.accepted) return undefined;
  const given = answered(request);
  const passed = request.policy === 'all' ? request.respondentIds.every(p => given.some(r => r.by === p && r.verdict === 'approve')) : given.length === 1 && given[0].verdict === 'approve';
  return passed ? 'passed' : 'not_passed';
}
const supersededTarget = (model: Model, request: Request) => !!request.target && latest(model.artifacts.get(request.target.artifactId)!).revision !== request.target.revision;

function reviewsOf(model: Model, artifactId: string, revision: number) {
  const reviews = [...model.requests.values()].filter(r => r.purpose === 'review' && r.target!.artifactId === artifactId && r.target!.revision === revision);
  const responses = reviews.flatMap(r => answered(r));
  const passedReviews = reviews.filter(r => reviewResult(r) === 'passed').map(r => ({ collabRequestId: r.collabRequestId, policy: r.policy, respondentIds: r.respondentIds, responseIds: r.accepted!.responseIds }));
  const pendingReviews = reviews.filter(r => { const state = requestState(r); return state === 'open' || state === 'settled' && answered(r).length > 0; }).map(r => r.collabRequestId);
  // Only the objector's own later approval of this same revision retires an objection.
  const objections = responses.filter(r => r.verdict === 'changes_requested').map(r => ({ responseId: r.responseId, collabRequestId: r.collabRequestId, respondentId: r.by, at: r.at, standing: responses.some(later => later.by === r.by && later.verdict === 'approve' && later.seq > r.seq) ? 'superseded' : 'current' }));
  const status = objections.some(o => o.standing === 'current') ? 'changes_requested' : pendingReviews.length ? 'in_review' : passedReviews.length ? 'agreed' : 'unreviewed';
  return { passedReviews, pendingReviews, objections, status };
}

function fold(model: Model, e: Event) {
  if (e.type === 'item_opened') model.items.set(e.itemId, { itemId: e.itemId, itemType: e.itemType, title: e.title, ownerId: e.by, externalRefs: e.externalRefs, at: e.at });
  else if (e.type === 'item_closed') model.items.get(e.itemId)!.closure = { state: e.state, reason: e.reason, ...(e.agreed ? { agreed: e.agreed } : {}), by: e.by, at: e.at };
  else if (e.type === 'suggestion_adopted') {
    const item = model.items.get(e.itemId)!;
    item.adoption = { target: e.target, taskItemId: e.taskItemId, collabRequestId: e.collabRequestId, assigneeId: e.assigneeId, task: e.task, taskDigest: e.taskDigest, by: e.by, at: e.at, seq: e.seq };
    item.closure = { state: 'adopted', reason: 'Adopted by the human', by: e.by, at: e.at };
  } else if (e.type === 'revision_published') {
    if (e.revision === 1) model.artifacts.set(e.artifactId, { artifactId: e.artifactId, itemId: e.itemId, authorId: e.by, revisions: [] });
    model.artifacts.get(e.artifactId)!.revisions.push({ revision: e.revision, contentDigest: e.contentDigest, contentSize: e.contentSize, contentInline: e.contentInline, at: e.at });
  } else if (e.type === 'request_opened') model.requests.set(e.collabRequestId, { collabRequestId: e.collabRequestId, itemId: e.itemId, by: e.by, seq: e.seq, at: e.at, messageId: e.messageId, purpose: e.purpose, respondentIds: e.respondentIds, policy: e.policy, ...(e.target ? { target: e.target } : {}), text: e.text, responses: [], withdrawn: new Set() });
  else if (e.type === 'response_given') {
    const response: Response = { responseId: e.responseId, collabRequestId: e.collabRequestId, by: e.by, seq: e.seq, at: e.at, messageId: e.messageId, outcome: e.outcome, ...(e.verdict ? { verdict: e.verdict } : {}), ...(e.target ? { target: e.target } : {}), text: e.text };
    model.requests.get(e.collabRequestId)!.responses.push(response); model.responses.set(e.responseId, response);
  } else if (e.type === 'slots_withdrawn') for (const p of e.respondentIds) model.requests.get(e.collabRequestId)!.withdrawn.add(p);
  else if (e.type === 'request_accepted') model.requests.get(e.collabRequestId)!.accepted = { responseIds: e.responseIds, at: e.at };
}
function build(events: Event[]): Model {
  const model: Model = { items: new Map(), artifacts: new Map(), requests: new Map(), responses: new Map() };
  for (const e of events) fold(model, e);
  return model;
}

// The one place a rule is stated. `apply` asks it about a new event; `validate` replays it over stored ones.
function admit(model: Model, e: Event, session: any) {
  const actor = session.participants.find((p: any) => p.id === e.by) ?? fail(403, 'unknown_participant', 'Actor is not a participant in this session');
  const human = actor.kind === 'human';
  const item = (itemId: string): Item => model.items.get(itemId) ?? fail(404, 'unknown_item', 'Unknown itemId in this session');
  const open = (itemId: string) => { const found = item(itemId); if (found.closure) fail(409, 'item_closed', `Item is ${found.closure.state}; open a new item instead`); return found; };
  const artifactIn = (itemId: string, artifactId: string): Artifact => { const found = model.artifacts.get(artifactId); return found && found.itemId === itemId ? found : fail(404, 'unknown_artifact', 'Unknown artifactId in this item'); };
  const request = (collabRequestId: string): Request => model.requests.get(collabRequestId) ?? fail(404, 'unknown_request', 'Unknown collabRequestId in this session');

  if (e.type === 'item_opened') { if (model.items.has(e.itemId)) fail(409, 'duplicate_id', 'itemId already exists'); return; }
  if (e.type === 'suggestion_adopted') {
    if (!human) fail(403, 'human_required', 'Only the human may adopt a suggestion');
    const source = open(e.itemId);
    if (source.itemType !== 'suggestion') fail(400, 'invalid_item', 'Only a suggestion may be adopted');
    const artifact = artifactIn(e.itemId, e.target.artifactId); const head = latest(artifact);
    if (head.revision !== e.target.revision || head.contentDigest !== e.target.digest) fail(409, 'stale_revision', 'Adoption must name the latest exact revision');
    const parsed = parseProposal(head.contentInline);
    if (!parsed.payload) fail(400, 'invalid_proposal', parsed.error!);
    const task = item(e.taskItemId); const assigned = request(e.collabRequestId);
    if (session.participants.find((p: any) => p.id === e.assigneeId)?.kind !== 'agent') fail(400, 'agent_required', 'Assignee must be an agent participant');
    if (e.taskDigest !== sha256(canonical(e.task)) || task.itemType !== 'task' || task.ownerId !== e.by || task.title !== source.title ||
        assigned.itemId !== task.itemId || assigned.by !== e.by || assigned.purpose !== 'answer' || assigned.respondentIds.length !== 1 || assigned.respondentIds[0] !== e.assigneeId ||
        assigned.text !== assignmentText(source.itemId, e.target, e.task)) fail(400, 'invalid_adoption', 'Adoption must identify the exact human-created task and assignment');
    if ([...model.requests.values()].some(r => r.itemId === source.itemId && requestState(r) === 'open')) fail(409, 'open_requests', 'Settle or withdraw outstanding source requests before adoption');
    return;
  }
  if (e.type === 'item_closed') {
    const found = open(e.itemId);
    if (found.ownerId !== e.by && !human) fail(403, 'not_owner', 'Only the item owner or the human owner may close this item');
    if (e.state === 'dropped') { if (e.agreed) fail(400, 'agreed_forbidden', 'A dropped item records no agreed revision'); return; }
    if ([...model.requests.values()].some(r => r.itemId === e.itemId && requestState(r) === 'open')) fail(409, 'open_requests', 'Requests in this item still have open slots; answer or withdraw them, or drop the item');
    const artifacts = [...model.artifacts.values()].filter(a => a.itemId === e.itemId);
    if (!e.agreed) { if (artifacts.length) fail(400, 'agreed_required', 'Name the agreed revision when resolving an item that has artifacts'); return; }
    const artifact = artifactIn(e.itemId, e.agreed.artifactId); const head = latest(artifact);
    if (head.revision !== e.agreed.revision || head.contentDigest !== e.agreed.digest || reviewsOf(model, artifact.artifactId, head.revision).status !== 'agreed') fail(409, 'not_agreed', 'agreed must be the latest revision of this item\'s artifact, with status agreed', { latest: head.revision, status: reviewsOf(model, artifact.artifactId, head.revision).status });
    // Naming one agreed artifact must not bury dissent or an unfinished review on another. Unreviewed ones do not block.
    const unsettled = artifacts.map(a => ({ artifactId: a.artifactId, revision: latest(a).revision, status: reviewsOf(model, a.artifactId, latest(a).revision).status })).filter(a => a.status === 'changes_requested' || a.status === 'in_review');
    if (unsettled.length) fail(409, 'not_agreed', 'Another artifact in this item has a current objection or a pending review', { unsettled });
    return;
  }
  if (e.type === 'revision_published') {
    open(e.itemId);
    if (e.contentDigest !== sha256(e.contentInline) || e.contentSize !== Buffer.byteLength(e.contentInline, 'utf8')) fail(400, 'digest_mismatch', 'contentDigest and contentSize must describe contentInline');
    if (e.revision === 1) { if (model.artifacts.has(e.artifactId)) fail(409, 'duplicate_id', 'artifactId already exists'); return; }
    const artifact = artifactIn(e.itemId, e.artifactId);
    if (artifact.authorId !== e.by) fail(403, 'not_author', 'Only the artifact author may publish its next revision');
    if (latest(artifact).revision !== e.revision - 1) fail(409, 'stale_revision', `baseRevision must be the latest revision (${latest(artifact).revision})`, { latest: latest(artifact).revision });
    return;
  }
  if (e.type === 'request_opened') {
    open(e.itemId);
    if (model.requests.has(e.collabRequestId)) fail(409, 'duplicate_id', 'collabRequestId already exists');
    for (const p of e.respondentIds) if (!session.participants.some((x: any) => x.id === p)) fail(404, 'unknown_recipient', `Unknown recipient: ${p}`);
    if (e.respondentIds.includes(e.by)) fail(400, 'self_request', 'A request cannot name its own requester as a respondent');
    if (e.purpose !== 'review') { if (e.target) fail(400, 'target_forbidden', 'Only a review request names a target revision'); return; }
    if (!e.target) fail(400, 'target_required', 'A review request must name the exact revision under review');
    const head = latest(artifactIn(e.itemId, e.target.artifactId));
    if (head.revision !== e.target.revision || head.contentDigest !== e.target.digest) fail(409, 'stale_revision', `target must be the latest revision (${head.revision}) with its digest`, { latest: head.revision, digest: head.contentDigest });
    return;
  }
  if (e.type === 'response_given') {
    const found = request(e.collabRequestId);
    if (model.responses.has(e.responseId)) fail(409, 'duplicate_id', 'responseId already exists');
    if (!found.respondentIds.includes(e.by)) fail(403, 'not_respondent', 'Only a designated respondent may respond to this request');
    const state = slot(found, e.by);
    if (state !== 'open') fail(409, 'slot_closed', `Your response slot is already ${state}`, { slot: state });
    const review = found.purpose === 'review';
    if (review && !e.target) fail(400, 'target_required', 'Echo the request\'s target revision and digest');
    if (!review && e.target) fail(400, 'target_forbidden', 'This request has no target revision');
    if (!sameTarget(e.target, found.target)) fail(409, 'target_mismatch', 'target must equal the request\'s target exactly', { target: found.target });
    if (review && e.outcome === 'answered' && !e.verdict) fail(400, 'verdict_required', 'An answered review needs verdict approve or changes_requested');
    if (e.verdict && !(review && e.outcome === 'answered')) fail(400, 'verdict_forbidden', 'Only an answered review carries a verdict');
    return;
  }
  if (e.type === 'slots_withdrawn') {
    const found = request(e.collabRequestId);
    if (found.by !== e.by && !human) fail(403, 'not_requester', 'Only the requester or the human owner may withdraw');
    if (found.accepted) fail(409, 'request_accepted', 'An accepted request cannot be withdrawn');
    for (const p of e.respondentIds) if (!found.respondentIds.includes(p) || slot(found, p) !== 'open') fail(409, 'slot_closed', 'Only open slots can be withdrawn', { respondentId: p, slot: found.respondentIds.includes(p) ? slot(found, p) : 'none' });
    return;
  }
  if (e.type === 'request_accepted') {
    const found = request(e.collabRequestId);
    if (found.by !== e.by) fail(403, 'not_requester', 'Only the requester may accept responses to this request');
    if (found.accepted) fail(409, 'already_accepted', 'This request was already accepted');
    if (requestState(found) === 'open') fail(409, 'slots_open', 'Some respondents still owe a response; wait or withdraw their slots', { open: found.respondentIds.filter(p => slot(found, p) === 'open') });
    const given = answered(found).map(r => r.responseId);
    if (!given.length) fail(409, 'no_result', 'No respondent answered, so there is nothing to accept');
    if (supersededTarget(model, found)) fail(409, 'target_superseded', 'The reviewed revision is no longer the latest; request a review of the new revision');
    if (given.length !== e.responseIds.length || given.some(id => !e.responseIds.includes(id))) fail(409, 'response_set', 'responseIds must be exactly the answered responses', { answered: given });
    return;
  }
  fail(400, 'unknown_event', `Unknown event type ${e.type}`);
}

// ── Views ─────────────────────────────────────────────────────────────────────────────────
function requestView(model: Model, r: Request) {
  const result = reviewResult(r); const closure = model.items.get(r.itemId)!.closure;
  return {
    collabRequestId: r.collabRequestId, itemId: r.itemId, requesterId: r.by, purpose: r.purpose, policy: r.policy, respondentIds: r.respondentIds, ...(r.target ? { target: r.target } : {}), text: r.text, messageId: r.messageId, at: r.at,
    state: requestState(r), ...(result ? { result } : {}), targetSuperseded: supersededTarget(model, r), ...(closure ? { itemClosed: closure.state } : {}),
    slots: r.respondentIds.map(p => ({ respondentId: p, state: slot(r, p) })),
    responses: r.responses.map(x => ({ responseId: x.responseId, respondentId: x.by, outcome: x.outcome, ...(x.verdict ? { verdict: x.verdict } : {}), text: x.text, messageId: x.messageId, at: x.at })),
    ...(r.accepted ? { accepted: r.accepted } : {}),
  };
}
function artifactView(model: Model, a: Artifact) {
  const head = latest(a).revision;
  return { artifactId: a.artifactId, itemId: a.itemId, authorId: a.authorId, latestRevision: head, revisions: a.revisions.map(v => {
    const { status, ...evidence } = reviewsOf(model, a.artifactId, v.revision);
    return { revision: v.revision, contentDigest: v.contentDigest, contentSize: v.contentSize, at: v.at, ...evidence, ...(v.revision === head ? { status } : { superseded: true }) };
  }) };
}
function itemView(model: Model, i: Item) {
  return { itemId: i.itemId, itemType: i.itemType, title: i.title, ownerId: i.ownerId, externalRefs: i.externalRefs, at: i.at, state: i.closure?.state ?? 'open', ...(i.closure ? { closure: i.closure } : {}),
    ...(i.adoption ? { adoption: i.adoption } : {}),
    artifacts: [...model.artifacts.values()].filter(a => a.itemId === i.itemId).map(a => artifactView(model, a)),
    requests: [...model.requests.values()].filter(r => r.itemId === i.itemId).map(r => requestView(model, r)) };
}
export function project(session: any) {
  const model = build(session.events ?? []);
  return { items: [...model.items.values()].map(i => itemView(model, i)) };
}

// ── Operations ────────────────────────────────────────────────────────────────────────────
function prepare(session: any, op: string, body: any, mutating: boolean) {
  const known = OPERATIONS[op];
  if (!known || known.mutating !== mutating) fail(404, 'not_found', `Unknown operation ${op}`);
  if (!Array.isArray(session.events)) fail(409, 'upgrade_required', 'This store predates collaboration records; upgrade it explicitly first');
  if (!BODIES[op](body)) fail(400, 'invalid_field', 'Request must be a JSON object');
  return build(session.events);
}
const known = (model: Model, collabRequestId: string): Request => model.requests.get(collabRequestId) ?? fail(404, 'unknown_request', 'Unknown collabRequestId in this session');
function resolve(session: any, names: string[], code: string) {
  const found = names.map(n => session.participants.find((p: any) => p.id === n || p.name.toLowerCase() === n.toLowerCase()) ?? fail(404, 'unknown_recipient', `Unknown recipient: ${n}`));
  if (new Set(found.map((p: any) => p.id)).size !== found.length) fail(400, code, 'A participant is named more than once');
  return found.map((p: any) => p.id as string);
}

export function apply(session: any, actor: Actor, op: string, body: any, env: Env): unknown {
  const model = prepare(session, op, body, true);
  if (op === 'suggest' || op === 'adopt_suggestion') {
    // Stage the whole compound operation, even for direct callers without the hub's rollback boundary.
    const staged = { ...session, events: [...session.events], messages: [...session.messages] };
    const act = (operation: string, value: any): any => apply(staged, actor, operation, { requestId: body.requestId, ...value }, env);
    if (op === 'suggest') {
      const opened = act('item_open', { itemType: 'suggestion', title: body.title });
      const published = act('publish', { itemId: opened.itemId, text: JSON.stringify(validateProposal(body.payload)) });
      session.events = staged.events; session.messages = staged.messages;
      return published;
    }
    if (actor.kind !== 'human') fail(403, 'human_required', 'Only the human may adopt a suggestion');
    const source = model.items.get(body.itemId) ?? fail(404, 'unknown_item', 'Unknown itemId in this session');
    if (source.itemType !== 'suggestion') fail(400, 'invalid_item', 'Only a suggestion may be adopted');
    const artifact = model.artifacts.get(body.target.artifactId);
    if (!artifact || artifact.itemId !== source.itemId) fail(404, 'unknown_artifact', 'Unknown artifact in this suggestion');
    const head = latest(artifact);
    if (head.revision !== body.target.revision || head.contentDigest !== body.target.digest) fail(409, 'stale_revision', 'The proposal changed; review its latest revision', { latest: head.revision, digest: head.contentDigest });
    const parsed = parseProposal(head.contentInline);
    if (!parsed.payload) fail(400, 'invalid_proposal', parsed.error!);
    const [assigneeId] = resolve(session, [body.assignee], 'invalid_field');
    if (session.participants.find((p: any) => p.id === assigneeId)?.kind !== 'agent') fail(400, 'agent_required', 'Assignee must be an agent participant');
    const taskDigest = sha256(canonical(body.task));
    if (source.adoption) {
      if (!sameTarget(source.adoption.target, body.target) || source.adoption.assigneeId !== assigneeId || source.adoption.taskDigest !== taskDigest) fail(409, 'adoption_conflict', 'This proposal was already adopted with a different target, assignee or confirmed task');
      return adoptionReceipt(source.itemId, source.adoption);
    }
    if (source.closure) fail(409, 'item_closed', `Suggestion is ${source.closure.state}`);
    const pending = [...model.requests.values()].filter(r => r.itemId === source.itemId && requestState(r) === 'open');
    if (pending.some(r => r.purpose !== 'review')) fail(409, 'open_requests', 'Settle or withdraw outstanding non-review requests before adopting');
    const opened = act('item_open', { itemType: 'task', title: source.title, externalRefs: [{ provider: 'agentlink-suggestion', ref: JSON.stringify({ itemId: source.itemId, ...body.target }) }] });
    const assigned = act('request', { itemId: opened.itemId, purpose: 'answer', to: [assigneeId], text: assignmentText(source.itemId, body.target, body.task) });
    for (const request of pending) act('withdraw', { collabRequestId: request.collabRequestId, reason: 'adopted by the human' });
    const event: Event = { seq: staged.events.length + 1, type: 'suggestion_adopted', at: env.now(), by: actor.id, itemId: source.itemId, target: body.target, taskItemId: opened.itemId, collabRequestId: assigned.collabRequestId, assigneeId, task: body.task, taskDigest };
    admit(build(staged.events), event, staged); staged.events.push(event);
    session.events = staged.events; session.messages = staged.messages;
    const adopted = build(session.events).items.get(source.itemId)!.adoption!;
    return adoptionReceipt(source.itemId, adopted);
  }
  const event: Event = { seq: session.events.length + 1, type: '', at: env.now(), by: actor.id };
  const message = (recipientIds: string[], content: string, messageKind: string, collab: any, parent?: any) => {
    const messageId = env.id('m');
    return { id: messageId, sequence: session.messages.length + 1, sender: { id: actor.id, name: actor.name, kind: actor.kind, role: actor.role }, recipientIds, text: content, createdAt: event.at, ...(parent ? { replyTo: parent.id } : {}), threadId: parent?.threadId ?? messageId, messageKind, collab };
  };
  let mail: any; let receipt: any;
  if (op === 'item_open') {
    Object.assign(event, { type: 'item_opened', itemId: env.id('it'), itemType: body.itemType, title: body.title, externalRefs: body.externalRefs ?? [] });
    receipt = { itemId: event.itemId };
  } else if (op === 'item_close') {
    Object.assign(event, { type: 'item_closed', itemId: body.itemId, state: body.state, reason: body.reason, ...(body.agreed ? { agreed: body.agreed } : {}) });
    receipt = { itemId: body.itemId, state: body.state };
  } else if (op === 'publish') {
    if ((body.artifactId === undefined) !== (body.baseRevision === undefined)) fail(400, 'invalid_field', 'Give artifactId and baseRevision together for a new revision, or neither for a new artifact');
    Object.assign(event, { type: 'revision_published', itemId: body.itemId, artifactId: body.artifactId ?? env.id('ar'), revision: (body.baseRevision ?? 0) + 1, contentDigest: sha256(body.text), contentSize: Buffer.byteLength(body.text, 'utf8'), contentInline: body.text });
    receipt = { itemId: event.itemId, artifactId: event.artifactId, revision: event.revision, digest: event.contentDigest, contentSize: event.contentSize };
  } else if (op === 'request') {
    const collabRequestId = env.id('rq'); const respondentIds = resolve(session, body.to, 'duplicate_recipient');
    mail = message(respondentIds, body.text, 'request', { collabRequestId });
    Object.assign(event, { type: 'request_opened', collabRequestId, itemId: body.itemId, messageId: mail.id, purpose: body.purpose, respondentIds, policy: body.policy ?? 'all', ...(body.target ? { target: body.target } : {}), text: body.text });
    receipt = { collabRequestId, messageId: mail.id };
  } else if (op === 'respond') {
    const responseId = env.id('rs'); const found = known(model, body.collabRequestId);
    mail = message([found.by], body.text, 'response', { collabRequestId: found.collabRequestId, responseId }, session.messages.find((m: any) => m.id === found.messageId));
    Object.assign(event, { type: 'response_given', responseId, collabRequestId: body.collabRequestId, messageId: mail.id, outcome: body.outcome, ...(body.verdict ? { verdict: body.verdict } : {}), ...(body.target ? { target: body.target } : {}), text: body.text });
    receipt = { collabRequestId: body.collabRequestId, responseId, messageId: event.messageId };
  } else if (op === 'withdraw') {
    const found = known(model, body.collabRequestId);
    // An explicit list is all-or-nothing (admit refuses any slot that is not open); no list means every open slot.
    const respondentIds = body.respondents ? resolve(session, body.respondents, 'invalid_field') : found.respondentIds.filter(p => slot(found, p) === 'open');
    if (respondentIds.some(p => !found.respondentIds.includes(p))) fail(400, 'invalid_field', 'respondents must be respondents of this request');
    if (found.by !== actor.id && actor.kind !== 'human') fail(403, 'not_requester', 'Only the requester or the human owner may withdraw');
    if (!respondentIds.length) fail(409, found.accepted ? 'request_accepted' : 'slot_closed', 'This request has no open slot to withdraw');
    Object.assign(event, { type: 'slots_withdrawn', collabRequestId: body.collabRequestId, respondentIds, reason: body.reason });
    receipt = { collabRequestId: body.collabRequestId, respondentIds: event.respondentIds };
  } else {
    Object.assign(event, { type: 'request_accepted', collabRequestId: body.collabRequestId, responseIds: body.responseIds });
    receipt = { collabRequestId: body.collabRequestId, responseIds: body.responseIds };
  }
  admit(model, event, session);
  if (mail) session.messages.push(mail);
  session.events.push(event);
  return { ...receipt, seq: event.seq };
}

export function read(session: any, actor: Actor, op: string, body: any): unknown {
  const model = prepare(session, op, body, false);
  const item = (itemId: string) => model.items.get(itemId) ?? fail(404, 'unknown_item', 'Unknown itemId in this session');
  if (op === 'items') return { items: [...model.items.values()].map(i => { const view = itemView(model, i); return { itemId: view.itemId, itemType: view.itemType, title: view.title, ownerId: view.ownerId, state: view.state, artifacts: view.artifacts.map(a => ({ artifactId: a.artifactId, latestRevision: a.latestRevision, status: a.revisions.at(-1)!.status })), openSlots: view.requests.flatMap(r => r.slots).filter(s => s.state === 'open').length }; }) };
  if (op === 'item') return { item: itemView(model, item(body.itemId)) };
  if (op === 'revision') {
    const artifact = model.artifacts.get(body.artifactId); const found = artifact?.revisions.find(v => v.revision === body.revision);
    if (!artifact || !found) return fail(404, 'unknown_revision', 'Unknown artifact revision in this session');
    return { revision: { artifactId: artifact.artifactId, itemId: artifact.itemId, authorId: artifact.authorId, ...found, superseded: latest(artifact).revision !== found.revision } };
  }
  if ((body.filter === 'item') !== (body.itemId !== undefined)) fail(400, 'invalid_field', 'itemId is required with filter item and not accepted otherwise');
  if (body.filter === 'item') item(body.itemId);
  const all = [...model.requests.values()];
  const chosen = body.filter === 'item' ? all.filter(r => r.itemId === body.itemId)
    : body.filter === 'owed_by_me' ? all.filter(r => r.respondentIds.includes(actor.id) && slot(r, actor.id) === 'open')
    // A settled review of a superseded revision can be neither accepted nor withdrawn: it is history, not something owed.
    : all.filter(r => r.by === actor.id && (requestState(r) === 'open' || requestState(r) === 'settled' && !supersededTarget(model, r)));
  return { filter: body.filter, requests: chosen.map(r => requestView(model, r)) };
}

// Replays every stored event through the rules that would have admitted it. Throws a plain Error
// naming the first offending seq; the caller must stop without rewriting the file.
export function validate(session: any): void {
  if (!Array.isArray(session.events)) throw new Error('Session has no events array');
  const model = build([]); const claimed = new Set<string>();
  session.events.forEach((e: any, index: number) => {
    try {
      if (!e || typeof e.type !== 'string' || !Object.hasOwn(EVENTS, e.type) || !EVENTS[e.type](e)) fail(400, 'invalid_event', 'Event is not a known, well-formed record');
      if (e.seq !== index + 1) fail(400, 'seq_gap', `Expected seq ${index + 1}`);
      admit(model, e, session);
      fold(model, e);
      if (e.messageId) {
        // The event and its Message were committed together, so one without the other is damage.
        const mail = session.messages.find((m: any) => m.id === e.messageId); const opened = model.requests.get(e.collabRequestId)!;
        const response = e.type === 'response_given';
        const to = response ? [opened.by] : e.respondentIds;
        const parent = response ? session.messages.find((m: any) => m.id === opened.messageId) : undefined;
        if (!mail || claimed.has(mail.id) || mail.messageKind !== (response ? 'response' : 'request') || mail.sender?.id !== e.by || mail.text !== e.text || mail.createdAt !== e.at
          || mail.collab?.collabRequestId !== e.collabRequestId || mail.collab?.responseId !== e.responseId || mail.replyTo !== parent?.id || mail.threadId !== (parent?.threadId ?? mail.id)
          || !Array.isArray(mail.recipientIds) || mail.recipientIds.length !== to.length || to.some((p: string) => !mail.recipientIds.includes(p))) fail(400, 'message_mismatch', 'The Message recorded for this event is absent or does not match it');
        claimed.add(mail.id);
      }
    } catch (error: any) { throw new Error(`Collaboration event ${index + 1} (seq ${e?.seq}, ${e?.type}) is invalid: ${error.code ?? 'error'}: ${error.message}`); }
  });
  // A passive post (item 24, slice C) is ordinary room text that wakes nobody; it carries no collaboration record.
  const orphan = session.messages.find((m: any) => ((m.messageKind !== undefined && m.messageKind !== 'post') || m.collab !== undefined) && !claimed.has(m.id));
  if (orphan) throw new Error(`Message ${orphan.id} claims a collaboration record that no event accounts for`);
}
