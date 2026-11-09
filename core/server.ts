import { createServer, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DomainError, OPERATIONS as COLLAB_OPERATIONS, apply as applyCollaboration, read as readCollaboration } from './collab.ts';
import { STATE_VERSION, loadState, retryContext, save, validateState } from './snapshot.ts';
import { activity as quietActivity, react as quietReact, receipts as quietReceipts } from './quiet.ts';
import { splash } from './splash.ts';
import { projectMapView, prepareMapEdit, commitMapEdit, recoverMapEdit } from './map-store.ts';
import { seal, unseal, type Sealed } from './seal.ts';
import { MAIL_RULES } from './protocol.ts';
import { OPERATIONS as DELIVERY_OPERATIONS, initial as initialDelivery, apply as applyDelivery, read as readDelivery,
  checkWait, evaluate as evaluateDelivery, expire as expireDelivery, type Hold } from './delivery.ts';

type Participant = { id: string; name: string; kind: 'human' | 'agent'; role: string; harness: string; tokenHash?: string; status: string; ack: string[] };
type Message = { messageKind?: string; noReply?: true; id: string; sequence: number; sender: { id: string; name: string; kind: string; role: string }; recipientIds: string[]; text: string; createdAt: string; replyTo?: string; threadId: string };
type Invitation = { id: string; participantId: string; tokenHash: string; expiresAt: number; used: boolean; revoked: boolean };
type Session = { id: string; name: string; workspace: string; objective: string; participants: Participant[]; invitations: Invitation[]; messages: Message[]; events?: any[]; delivery?: ReturnType<typeof initialDelivery>; marks?: any[] };
type State = { version: 1 | 2 | 3 | 4 | 5; sessions: Session[]; requests: Record<string, { fingerprint: string; result: any; sealed?: Sealed; unrecoverable?: true }> };
class ProtocolError extends Error { status: number; code: string; constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; } }
const fail = (status: number, code: string, message: string): never => { throw new ProtocolError(status, code, message); };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const textField = (value: any, name: string, max = 4096) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'invalid_field', `${name} must be nonempty text, at most ${max} characters`);
  return value;
};
const canonical = (v: any): string => JSON.stringify(v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, JSON.parse(canonical(v[k]))])) : Array.isArray(v) ? v.map(x => JSON.parse(canonical(x))) : v);
const errorReply = (error: any) => {
  const clientError = error instanceof ProtocolError || error instanceof DomainError;
  return { status: clientError ? error.status : 500, body: { error: { code: clientError ? error.code : 'internal_error', message: clientError ? error.message : 'Internal persistence/server error; check the hub data directory', ...(clientError && error.detail !== undefined ? { detail: error.detail } : {}) } } };
};

// Describes the mailbox dispatch below; collaboration adds its own domain
// registry. Capability discovery therefore follows implemented operations.
const MAILBOX_OPERATIONS: Record<string, { mutating: boolean; fields: string[] }> = {
  create: { mutating: true, fields: ['requestId', 'name', 'workspace', 'objective'] },
  join: { mutating: true, fields: ['requestId', 'token'] },
  room: { mutating: false, fields: [] }, heartbeat: { mutating: false, fields: [] }, leave: { mutating: false, fields: [] },
  invite: { mutating: true, fields: ['requestId', 'name', 'role', 'harness', 'ttlSeconds'] },
  revoke: { mutating: true, fields: ['requestId', 'invitationId'] },
  status: { mutating: true, fields: ['requestId', 'text'] },
  send: { mutating: true, fields: ['requestId', 'text', 'to', 'replyTo', 'seen', 'noReply', 'post'] },
  // Quiet coordination (item 24, slice C, store version 6): none of these is ever a delivery unit.
  react: { mutating: true, fields: ['requestId', 'messageId', 'emoji', 'on'] },
  activity: { mutating: true, fields: ['requestId', 'state', 'messageId', 'text'] },
  receipts: { mutating: false, fields: ['after', 'limit'] },
  inbox: { mutating: false, fields: ['after', 'limit'] }, history: { mutating: false, fields: ['after', 'limit'] },
  ack: { mutating: true, fields: ['requestId', 'messageIds'] },
  map: { mutating: false, fields: [] }, map_edit: { mutating: true, fields: ['requestId', 'base', 'add', 'remove'] },
};

function validateMailboxBody(op: string, body: any) {
  if (op === 'send' && ['sender', 'senderId', 'kind'].some(field => Object.hasOwn(body, field))) {
    fail(400, 'authenticated_sender', 'Sender identity and kind come exclusively from your credential');
  }
  const allowed = MAILBOX_OPERATIONS[op]?.fields;
  if (allowed && Object.keys(body).some(field => !allowed.includes(field))) {
    fail(400, 'unknown_field', 'Request contains an unsupported field; inspect capabilities and the protocol');
  }
}

function lockStore(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const lock = join(dataDir, 'hub.lock');
  if (existsSync(lock)) {
    const pid = Number(readFileSync(join(lock, 'pid'), 'utf8'));
    try { process.kill(pid, 0); fail(409, 'hub_running', `Data directory is already held by process ${pid}`); }
    catch (error: any) { if (error.code !== 'ESRCH') throw error; rmSync(lock, { recursive: true }); }
  }
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600 });
  return () => rmSync(lock, { recursive: true, force: true });
}
function existingAdmin(dataDir: string): string | undefined {
  const path = join(dataDir, 'admin.json');
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, 'utf8'))?.token;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(value)) throw new Error('Unsupported or damaged administrator credential; restore a protected backup.');
  return value;
}
export function inspectHubUpgrade({ dataDir }: { dataDir: string }) {
  dataDir = resolve(dataDir); const statePath = join(dataDir, 'state.json');
  let bytes: Buffer | null = null;
  try { bytes = readFileSync(statePath); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const state = bytes ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : { version: STATE_VERSION, sessions: [], requests: {} };
  validateState(state);
  return { fromVersion: state.version as number, toVersion: STATE_VERSION, needed: state.version < STATE_VERSION, statePath,
    backupPath: state.version < STATE_VERSION ? join(dataDir, `state.v${state.version}.backup.json`) : null,
    rooms: state.sessions.map((s: any) => ({ id: s.id as string, name: s.name as string })), sourceDigest: bytes ? createHash('sha256').update(bytes).digest('hex') : null };
}
// The console must quiesce and close its hub first. The same lock prevents upgrading beneath any live writer.
export function upgradeHubData({ dataDir, adminDir = dataDir, expectedDigest }: { dataDir: string; adminDir?: string; expectedDigest: string | null }) {
  dataDir = resolve(dataDir); adminDir = resolve(adminDir); const release = lockStore(dataDir);
  try {
    const before = inspectHubUpgrade({ dataDir });
    if (expectedDigest !== before.sourceDigest) fail(409, 'upgrade_changed', 'Workspace data changed after the preview; review a new upgrade preview');
    if (adminDir !== dataDir && existsSync(join(dataDir, 'admin.json'))) throw new Error('Move the existing administrator credential to its protected directory before upgrading');
    const admin = existingAdmin(adminDir);
    loadState(before.statePath, true, admin);
    return { ...inspectHubUpgrade({ dataDir }), fromVersion: before.fromVersion, backupPath: before.backupPath };
  } finally { release(); }
}

export async function startHub({ dataDir, adminDir = dataDir, port = 4317, presenceMs = 30_000, upgradeState = false }: { dataDir: string; adminDir?: string; port?: number; presenceMs?: number; upgradeState?: boolean }) {
  dataDir = resolve(dataDir); adminDir = resolve(adminDir); const releaseLock = lockStore(dataDir);
  const statePath = join(dataDir, 'state.json');
  const adminPath = join(adminDir, 'admin.json');
  let state: State;
  let adminToken: string;
  try {
    // Relocation belongs to the console's migration. Never silently mint a new sealing key while the old one
    // remains in the workspace, or leave a second working control credential there after migration.
    if (adminDir !== dataDir && existsSync(join(dataDir, 'admin.json'))) throw new Error('Move the existing administrator credential to its protected directory before starting the hub');
    mkdirSync(adminDir, { recursive: true, mode: 0o700 }); chmodSync(adminDir, 0o700);
    // Only an absent file means "mint one". A file that exists without a well-formed token is damage, and is neither
    // replaced nor allowed to start an upgrade that would then have no key for the create results.
    const savedAdmin = existingAdmin(adminDir);
    adminToken = savedAdmin ?? token();
    state = loadState(statePath, upgradeState, savedAdmin);
    recoverMapEdit(dataDir, state, statePath);
  } catch (error) { releaseLock(); throw error; }
  const presence = new Map<string, number>();
  let storageFailed = false;
  let closing = false;
  let endpoint = '';
  const briefing = MAIL_RULES + ' An inbox acknowledgement means only that this client explicitly acknowledged receipt; it does not prove a model read, executed or completed the work. Workspace paths grant no filesystem permission. Delivery mode: ' + (state.version >= 4
    ? 'Agent-armed cooperative pull. Bind explicitly, wait for pointers, then fetch in the foreground. Confirm establishes client intake, not model action or a response. After wait exit 3 you may wait again against the empty-return allowance. After 4, 5, 6 or 1 stop until a human acts; never automatically retry errors, rebind, restart a run or raise limits.'
    : 'cooperative CLI/API mailbox.');
  const env = { now: () => new Date().toISOString(), id };
  const mapEdits = new Map<string, { by: string; at: string; digest: string }>();
  type Waiter = { sessionId: string; participantId: string; generation: number; attemptId?: string; hold: Hold; response: ServerResponse; timer?: ReturnType<typeof setTimeout>; reply(status: number, body: any): void };
  const waiters = new Map<string, Waiter>();
  function release(waiter: Waiter) {
    if (waiters.get(waiter.participantId) !== waiter) return;
    clearTimeout(waiter.timer);
    waiters.delete(waiter.participantId);
  }
  function finish(waiter: Waiter, status: number, body: any) {
    release(waiter);
    if (!waiter.response.destroyed && !waiter.response.writableEnded) waiter.reply(status, body);
  }
  function failHeld() {
    if (!storageFailed) return;
    for (const waiter of waiters.values()) finish(waiter, 503, { error: { code: 'storage_failed', message: 'Persistence failed; restart the hub after checking the data directory' } });
  }
  // Callbacks store IDs, never session objects: a rejected mutation replaces `state` with its rollback copy.
  // No await occurs between the decision, durable save, registration and recheck.
  function deliveryDecision(sessionId: string, participantId: string, action: (session: Session, actor: Participant) => ReturnType<typeof evaluateDelivery>) {
    const before = structuredClone(state);
    try {
      const session = state.sessions.find(s => s.id === sessionId)!;
      const actor = session.participants.find(p => p.id === participantId)!;
      session.delivery!.changes++;
      const result = action(session, actor);
      if ('reply' in result && result.changed) save(statePath, state);
      else session.delivery!.changes--;
      return result;
    } catch (error) {
      state = before;
      if (!(error instanceof ProtocolError) && !(error instanceof DomainError)) storageFailed = true;
      failHeld();
      throw error;
    }
  }
  function drainWaiters(sessionId: string) {
    for (const waiter of waiters.values()) {
      if (waiter.sessionId !== sessionId) continue;
      try {
        const result = deliveryDecision(sessionId, waiter.participantId,
          (session, actor) => evaluateDelivery(session, actor, waiter.generation, env, true, waiter.attemptId));
        if ('reply' in result) finish(waiter, 200, result.reply);
        else waiter.hold = result.hold;
      } catch (error) { const result = errorReply(error); finish(waiter, result.status, result.body); }
    }
  }
  const roster = (s: Session) => s.participants.map(p => ({ id: p.id, name: p.name, kind: p.kind, role: p.role, harness: p.harness, status: p.status, presence: !p.tokenHash ? 'invited' : (presence.has(p.id) && Date.now() - presence.get(p.id)! < presenceMs ? 'connected' : 'disconnected'), lastSeen: presence.has(p.id) ? new Date(presence.get(p.id)!).toISOString() : null, unread: s.messages.filter(m => m.recipientIds.includes(p.id) && !p.ack.includes(m.id)).length }));
  function authenticate(raw: string) {
    for (const session of state.sessions) {
      const participant = session.participants.find(p => p.tokenHash === hash(raw));
      if (participant) { presence.set(participant.id, Date.now()); return { session, participant }; }
    }
    return fail(401, 'invalid_token', 'Invalid participant credential');
  }
  // `presented` is the bearer token the caller used for an operation that returns a credential. From state version 3
  // the stored result keeps that credential only sealed under it, so reading the store alone recovers nothing.
  function mutation(actor: string, op: string, body: any, action: () => any, presented?: string, commit?: (key: string, fingerprint: string, persist: () => void) => void) {
    const requestId = textField(body.requestId, 'requestId', 200);
    const key = `${actor}:${requestId}`;
    const fingerprint = hash(canonical({ op, body }));
    const prior = state.requests[key];
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail(409, 'request_conflict', 'requestId was already used for different content or operation');
      // A credential-issuing operation whose record has neither a seal nor the marker is damage the loader refuses;
      // this is the same refusal at the point of use, so such a retry can never succeed without its credential.
      if (prior.unrecoverable || (presented !== undefined && state.version >= 3 && !prior.sealed)) fail(409, 'credential_unrecoverable', 'This result was recorded before retry records were sealed, and its credential was removed from the store. Use the credential you saved, or issue a new invitation.');
      const recovered = prior.sealed ? unseal(presented ?? '', prior.sealed, retryContext(key, fingerprint)) ?? fail(409, 'credential_unrecoverable', 'The stored credential cannot be opened with the token presented; it was sealed under a different one.') : undefined;
      return { ...prior.result, ...(recovered === undefined ? {} : { token: recovered }), ...(prior.result.endpoint ? { endpoint } : {}) };
    }
    const before = structuredClone(state);
    try {
      validateMailboxBody(op, body);
      const result = action();
      const changedSession = state.sessions.find(s => actor === 'admin' ? s.id === result.sessionId : s.participants.some(p => p.id === actor) || s.invitations.some(i => i.id === actor));
      if (changedSession?.delivery) changedSession.delivery.changes++;
      if (state.version >= 3 && typeof result?.token === 'string') {
        if (!presented) throw new Error('A credential-issuing operation must supply the presented token');
        const { token: issued, ...rest } = result;
        state.requests[key] = { fingerprint, result: rest, sealed: seal(presented, issued, retryContext(key, fingerprint)) };
      } else state.requests[key] = { fingerprint, result };
      if (commit) commit(key, fingerprint, () => save(statePath, state));
      else save(statePath, state);
      if (changedSession?.delivery) drainWaiters(changedSession.id);
      return result;
    } catch (error) {
      state = before;
      if (!(error instanceof ProtocolError) && !(error instanceof DomainError)) storageFailed = true;
      failHeld();
      throw error;
    }
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const reply = (status: number, body: any) => { res.writeHead(status); res.end(JSON.stringify(body)); };
    try {
      if (storageFailed) fail(503, 'storage_failed', 'Persistence failed; restart the hub after checking the data directory');
      if (closing) fail(503, 'hub_closing', 'The hub is shutting down');
      if (req.headers.origin) fail(403, 'browser_origin', 'Browser-origin requests are not supported by this local API');
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/')) fail(404, 'not_found', 'Use a documented POST /v1 operation');
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') fail(415, 'content_type', 'Content-Type must be application/json');
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 64 * 1024) fail(413, 'too_large', 'Request body exceeds 64 KiB'); chunks.push(chunk); }
      let body: any;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'invalid_json', 'Request body must be JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_json', 'Request must be a JSON object');
      const raw = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const op = req.url.slice(4);
      if (op === 'create') {
        if (hash(raw) !== hash(adminToken)) fail(401, 'invalid_token', 'Administrator credential required to create a session');
        return reply(200, mutation('admin', op, body, () => {
          const name = textField(body.name, 'name', 100);
          const workspace = resolve(textField(body.workspace, 'workspace'));
          if (!existsSync(workspace) || !statSync(workspace).isDirectory()) fail(400, 'workspace_unavailable', 'workspace must be an existing directory on the hub machine');
          const ownerToken = token();
          const owner: Participant = { id: id('p'), name: 'human', kind: 'human', role: 'owner', harness: 'cli', tokenHash: hash(ownerToken), status: '', ack: [] };
          const session: Session = { id: id('s'), name, workspace, objective: body.objective === undefined ? '' : textField(body.objective, 'objective'), participants: [owner], invitations: [], messages: [], ...(state.version >= 2 ? { events: [] } : {}), ...(state.version >= 4 ? { delivery: initialDelivery() } : {}), ...(state.version >= 6 ? { marks: [] } : {}) };
          state.sessions.push(session);
          presence.set(owner.id, Date.now());
          return { endpoint, sessionId: session.id, participantId: owner.id, token: ownerToken, briefing };
        }, raw));
      }
      if (op === 'join') {
        const invitationToken = textField(body.token, 'token', 100);
        const session = state.sessions.find(s => s.invitations.some(i => i.tokenHash === hash(invitationToken)));
        const invitation = session?.invitations.find(i => i.tokenHash === hash(invitationToken));
        if (!session || !invitation) fail(401, 'invalid_invitation', 'Unknown invitation token');
        if (invitation.revoked || invitation.expiresAt < Date.now()) fail(401, 'expired_invitation', 'Invitation expired or revoked');
        const participant = session.participants.find(p => p.id === invitation.participantId)!;
        const result = mutation(invitation.id, op, body, () => {
          if (invitation.used) fail(409, 'invitation_used', 'Invitation is already docked; reconnect using the saved participant credential');
          const participantToken = token(); invitation.used = true; participant.tokenHash = hash(participantToken);
          return { endpoint, sessionId: session.id, participantId: participant.id, token: participantToken, briefing, workspace: session.workspace, objective: session.objective };
        }, invitationToken);
        presence.set(participant.id, Date.now());
        return reply(200, { ...result, roster: roster(session) });
      }
      const { session, participant } = authenticate(raw);
      if (op === 'map') {
        validateMailboxBody(op, body);
        return reply(200, { ...projectMapView(session.workspace), lastEdit: mapEdits.get(session.workspace) ?? null });
      }
      if (op === 'map_edit') {
        let prepared: ReturnType<typeof prepareMapEdit>;
        return reply(200, mutation(participant.id, op, body, () => {
          prepared = prepareMapEdit(session.workspace, body); return prepared.result;
        }, undefined, (key, fingerprint, persist) => {
          commitMapEdit(dataDir, session.workspace, session.id, key, fingerprint, prepared, persist);
          mapEdits.set(session.workspace, { by: participant.name, at: new Date().toISOString(), digest: prepared.result.digest });
        }));
      }
      if (op === 'capabilities') {
        if (Object.keys(body).length) fail(400, 'unknown_field', 'capabilities takes no fields');
        return reply(200, { stateVersion: state.version, collaboration: state.version >= 2, adoption: state.version >= 5, quiet: state.version >= 6, retryCredentials: state.version >= 3 ? 'sealed' : 'plaintext', delivery: state.version >= 4, waitAttempts: state.version >= 4, deliveryMode: state.version >= 4 ? 'agent-armed' : 'cooperative-mailbox',
          operations: [...Object.keys(MAILBOX_OPERATIONS).filter(op => !['react', 'activity', 'receipts'].includes(op) || state.version >= 6), 'capabilities', ...(state.version >= 2 ? Object.keys(COLLAB_OPERATIONS).filter(op => op !== 'adopt_suggestion' || state.version >= 5) : []), ...(state.version >= 4 ? [...Object.keys(DELIVERY_OPERATIONS), 'wait'] : [])].sort() });
      }
      if (op === 'wait' || Object.hasOwn(DELIVERY_OPERATIONS, op)) {
        if (state.version < 4) fail(409, 'upgrade_required', 'Pull delivery requires state version 4; stop the hub and restart once with --upgrade-state.');
        if (op !== 'wait') return reply(200, DELIVERY_OPERATIONS[op].mutating
          ? mutation(participant.id, op, body, () => applyDelivery(session, participant, op, body, env))
          : readDelivery(session, participant, op, body, { waiting: pid => waiters.has(pid) }));
        const { generation, timeoutSeconds, attemptId } = checkWait(body);
        if (participant.kind !== 'agent') fail(403, 'agent_required', 'Only an agent may wait');
        const current = session.delivery!.bindings[participant.id]?.generation;
        if (generation !== current) throw new DomainError(409, 'stale_binding', 'This is not your current binding', { current: current ?? null });
        if (waiters.get(participant.id)?.generation === generation) fail(409, 'already_waiting', 'This binding already has a held wait');
        const result = deliveryDecision(session.id, participant.id, (s, p) => evaluateDelivery(s, p, generation, env, false, attemptId));
        if ('reply' in result) {
          if (result.changed) drainWaiters(session.id);
          return reply(200, result.reply);
        }
        const waiter: Waiter = { sessionId: session.id, participantId: participant.id, generation, ...(attemptId === undefined ? {} : { attemptId }), hold: result.hold, response: res, reply };
        waiters.set(participant.id, waiter);
        res.once('close', () => release(waiter));
        waiter.timer = setTimeout(() => {
          if (waiters.get(participant.id) !== waiter) return;
          try {
            const expired = deliveryDecision(waiter.sessionId, waiter.participantId,
              (s, p) => expireDelivery(s, p, generation, waiter.hold));
            if ('reply' in expired) finish(waiter, 200, expired.reply);
            drainWaiters(waiter.sessionId);
          } catch (error) { const result = errorReply(error); finish(waiter, result.status, result.body); }
        }, timeoutSeconds * 1000);
        drainWaiters(session.id);
        return;
      }
      if (Object.hasOwn(COLLAB_OPERATIONS, op)) {
        if (op === 'adopt_suggestion' && state.version < 5) fail(409, 'upgrade_required', 'Adoption requires state version 5; use Upgrade local workspace data in the console or page');
        if (state.version < 2) fail(409, 'upgrade_required', 'Collaboration requires state version 2 or later; stop the hub, back up its data, then restart with --upgrade-state.');
        return reply(200, COLLAB_OPERATIONS[op].mutating
          ? mutation(participant.id, op, body, () => applyCollaboration(session, participant, op, body, { now: () => new Date().toISOString(), id }))
          : readCollaboration(session, participant, op, body));
      }
      if (MAILBOX_OPERATIONS[op] && !MAILBOX_OPERATIONS[op].mutating) validateMailboxBody(op, body);
      const ownerOnly = () => { if (participant.kind !== 'human') fail(403, 'owner_required', 'Only the human owner may manage invitations'); };
      if (op === 'room' || op === 'heartbeat') return reply(200, { sessionId: session.id, name: session.name, workspace: session.workspace, objective: session.objective, self: participant.id, roster: roster(session), briefing });
      if (op === 'leave') { presence.delete(participant.id); return reply(200, { disconnected: true, participantId: participant.id }); }
      if (op === 'invite') {
        ownerOnly();
        return reply(200, mutation(participant.id, op, body, () => {
          const name = textField(body.name, 'name', 100);
          if (['human', 'all'].includes(name.toLowerCase()) || session.participants.some(p => p.name.toLowerCase() === name.toLowerCase())) fail(409, 'name_taken', 'Choose a unique name other than human or all');
          const ttl = body.ttlSeconds ?? 86400;
          if (!Number.isInteger(ttl) || ttl < 1 || ttl > 604800) fail(400, 'invalid_ttl', 'ttlSeconds must be between 1 and 604800');
          const p: Participant = { id: id('p'), name, kind: 'agent', role: body.role === undefined ? '' : textField(body.role, 'role', 200), harness: body.harness === undefined ? 'cli' : textField(body.harness, 'harness', 100), status: '', ack: [] };
          const inviteToken = token();
          const invitation: Invitation = { id: id('i'), participantId: p.id, tokenHash: hash(inviteToken), expiresAt: Date.now() + ttl * 1000, used: false, revoked: false };
          session.participants.push(p); session.invitations.push(invitation);
          return { endpoint, sessionId: session.id, invitationId: invitation.id, participantId: p.id, name, token: inviteToken, expiresAt: new Date(invitation.expiresAt).toISOString() };
        }, raw));
      }
      if (op === 'revoke') {
        ownerOnly();
        return reply(200, mutation(participant.id, op, body, () => {
          const invitation = session.invitations.find(i => i.id === body.invitationId);
          if (!invitation) fail(404, 'unknown_invitation', 'Unknown invitationId in this session');
          invitation.revoked = true;
          return { revoked: true, invitationId: invitation.id };
        }));
      }
      if (op === 'status') return reply(200, mutation(participant.id, op, body, () => { participant.status = textField(body.text, 'text', 1000); return { participantId: participant.id, status: participant.status }; }));
      if (op === 'send') return reply(200, mutation(participant.id, op, body, () => {
        // Sender fields supplied by callers are rejected rather than trusted.
        if (body.sender !== undefined || body.senderId !== undefined || body.kind !== undefined) fail(400, 'authenticated_sender', 'Sender identity and kind come exclusively from your credential');
        const text = textField(body.text, 'text', 32000);
        let to = body.to;
        if (to === undefined && participant.kind === 'human') to = 'all';
        let recipients: Participant[];
        if (to === 'all') recipients = session.participants.filter(p => p.kind === 'agent' && p.id !== participant.id);
        else {
          const targets = Array.isArray(to) ? to : [to];
          if (!targets.length || targets.some(t => typeof t !== 'string')) fail(400, 'recipient_required', 'Specify all, human, a participant name/ID, or an array of names/IDs');
          recipients = targets.map(t => session.participants.find(p => p.id === t || p.name.toLowerCase() === t.toLowerCase()) ?? fail(404, 'unknown_recipient', `Unknown recipient: ${t}`));
          recipients = [...new Map(recipients.map(p => [p.id, p])).values()];
        }
        recipients = recipients.filter(p => p.id !== participant.id);
        if (!recipients.length) fail(400, 'no_recipients', 'Address at least one other participant');
        const parent = body.replyTo === undefined ? undefined : session.messages.find(m => m.id === body.replyTo);
        if (body.replyTo !== undefined && !parent) fail(404, 'unknown_reply', 'replyTo must identify a message in this session');
        if (body.seen !== undefined) {
          if (!Number.isSafeInteger(body.seen) || body.seen < 0 || body.seen > session.messages.length) fail(400, 'invalid_cursor', 'seen must be an existing nonnegative room sequence');
          if (!parent) fail(400, 'reply_required', 'seen requires replyTo to identify the thread');
          const newer = session.messages.filter(m => m.threadId === parent.threadId && m.sequence > body.seen && m.recipientIds.includes(participant.id));
          if (newer.length) throw new DomainError(409, 'thread_moved', 'Read the newer messages before replying', { messages: newer });
        }
        // A post (item 24, slice C) is room text that wakes nobody; noReply marks mail that needs no answer. Both need store version 6.
        if ((body.noReply !== undefined || body.post !== undefined) && state.version < 6) fail(409, 'upgrade_required', 'Posts and noReply need state version 6; use Upgrade local workspace data in the console or page');
        if (body.noReply !== undefined && body.noReply !== true) fail(400, 'invalid_field', 'noReply is true when given');
        if (body.post !== undefined && body.post !== true) fail(400, 'invalid_field', 'post is true when given');
        if (body.post && body.noReply) fail(400, 'invalid_field', 'A post never asks for a reply; noReply is for mail');
        const messageId = id('m');
        const message: Message = { id: messageId, sequence: session.messages.length + 1, sender: { id: participant.id, name: participant.name, kind: participant.kind, role: participant.role }, recipientIds: recipients.map(p => p.id), text, createdAt: new Date().toISOString(), ...(parent ? { replyTo: parent.id } : {}), threadId: parent?.threadId ?? messageId };
        if (body.post) message.messageKind = 'post'; if (body.noReply) message.noReply = true;
        session.messages.push(message);
        return { message };
      }));
      if (op === 'inbox' || op === 'history') {
        const after = body.after ?? 0; const limit = body.limit ?? 100;
        if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) fail(400, 'invalid_cursor', 'after must be a nonnegative integer; limit must be 1–500');
        const candidates = session.messages.filter(m => m.sequence > after && (op === 'history' || m.recipientIds.includes(participant.id) && !participant.ack.includes(m.id)));
        const messages = candidates.slice(0, limit);
        return reply(200, { messages, nextCursor: messages.at(-1)?.sequence ?? after, hasMore: candidates.length > limit, briefing });
      }
      if (op === 'ack') return reply(200, mutation(participant.id, op, body, () => {
        if (!Array.isArray(body.messageIds) || !body.messageIds.length || body.messageIds.length > 500) fail(400, 'invalid_ack', 'messageIds must contain 1–500 message IDs');
        for (const mid of body.messageIds) if (!session.messages.some(m => m.id === mid && m.recipientIds.includes(participant.id))) fail(403, 'not_your_delivery', `Cannot acknowledge message not addressed to you: ${mid}`);
        participant.ack = [...new Set([...participant.ack, ...body.messageIds])];
        return { acknowledged: body.messageIds, participantId: participant.id };
      }));
      if (op === 'react' || op === 'activity' || op === 'receipts') {
        if (state.version < 6) fail(409, 'upgrade_required', 'Reactions, activity and receipts need state version 6; use Upgrade local workspace data in the console or page');
        if (op === 'receipts') return reply(200, quietReceipts(session, participant, body));
        return reply(200, mutation(participant.id, op, body, () => (op === 'react' ? quietReact : quietActivity)(session, participant, body, new Date().toISOString())));
      }
      fail(404, 'not_found', `Unknown operation ${op}`);
    } catch (error: any) {
      const result = errorReply(error); reply(result.status, result.body);
    }
  });
  server.requestTimeout = 10_000;
  try {
    await new Promise<void>((ok, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); ok(); }); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    endpoint = `http://127.0.0.1:${address.port}`;
    save(adminPath, { endpoint, token: adminToken });
  } catch (error) { server.close(); releaseLock(); throw error; }
  let closed: Promise<void> | undefined;
  return { endpoint, adminPath, stateVersion: state.version, close: () => closed ??= (async () => {
    closing = true;
    // Closing is not an empty wait: it neither spends an allowance nor invites another wait against a dead hub.
    for (const waiter of waiters.values()) finish(waiter, 200, { status: 'closing' });
    await new Promise<void>((ok, reject) => server.close(error => error ? reject(error) : ok()));
    releaseLock();
  })() };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, 'server.ts')) {
  const args = process.argv.slice(2);
  function arg(name: string, fallback: string) { const index = args.indexOf(`--${name}`); return index === -1 ? fallback : args[index + 1]; }
  const port = Number(arg('port', '4317'));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be 0–65535');
  const hub = await startHub({ dataDir: arg('data', '.agentlink'), adminDir: arg('admin-dir', arg('data', '.agentlink')), port, upgradeState: args.includes('--upgrade-state') });
  if (hub.stateVersion < 3) console.error(`Notice: this store is state version ${hub.stateVersion}; its retry records hold credentials in plain text. Stop the hub and restart once with --upgrade-state to seal them.`);
  const mode = hub.stateVersion >= 4 ? 'agent-armed' : 'cooperative-mailbox';
  // For a person at a terminal only, and on stderr: the line below stays the first and only thing on stdout.
  splash(process.stderr, [['Endpoint', hub.endpoint], ['Admin file', hub.adminPath], ['Mode', `${mode} (state version ${hub.stateVersion})`]], 'Ctrl-C stops the hub. Commands: node core/cli.ts help');
  console.log(JSON.stringify({ endpoint: hub.endpoint, adminFile: hub.adminPath, mode }));
  const shutdown = () => { void hub.close().then(() => process.exit(0)).catch(() => process.exit(1)); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
