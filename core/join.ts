import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { saveCredential } from './client.ts';

// One-paste join (item 24). The console issues a ticket; a session that has it makes one claim and is shown a pairing
// code; the human compares the code and approves on the page; approval runs the hub's invite and join and writes the
// agent's profile. Three secrets, three jobs:
//   - the ticket (in the paste line) allows one claim and nothing else. Only its hash is kept.
//   - the claim secret (in the claimant's profile directory) proves a rerun is the same claimant. Only its hash is kept.
//   - the pairing code is for the human's eyes: it is never a credential and never enough to ask about a claim.
// Approval is journalled. Each step has a deterministic hub key per ticket, so a second click, or a console that stops
// after any step, ends in the same identity. The invite is made with a lifetime longer than the recovery window, so a
// keyed retry inside the window always finds it valid; outside it the ticket waits for the human to reconcile rather
// than recover past a revocation or make a second participant.
export const TICKET_MS = 30 * 60_000;
export const RECOVERY_MS = 60 * 60_000;
export const INVITE_TTL_SECONDS = 2 * 60 * 60;
export const OPEN_TICKETS = 20;
const PAIRING = 'BCDFGHJKLMNPQRSTVWXZ23456789';
const TICKET = /^alj_[A-Za-z0-9_-]{32}$/;
const SECRET = /^[A-Za-z0-9_-]{32,128}$/;

export type JoinState = 'open' | 'claimed' | 'approving' | 'approved' | 'refused' | 'expired' | 'revoked' | 'reconcile';
type Entry = {
  id: string; hash: string; name?: string; harness?: string; issuedAt: number; expiresAt: number; state: JoinState;
  claim?: { claimId: string; secretHash: string; pairingCode: string; harness: string; label: string; at: number };
  approval?: { startedAt: number; name: string; agentId: string; invited?: true; participantId?: string; profile?: true; recorded?: true; at?: number; stuck?: 'window' | 'participant' };
};
type Journal = { version: 1; entries: Record<string, Entry> };
export type Effects = {
  // What name the agent gets, chosen once at the first approval and kept in the journal.
  chooseName: (wanted: { name?: string; harness: string; label: string }) => string;
  agentId: (harness: string, seed: string) => string;
  invite: (o: { key: string; name: string; harness: string; ttlSeconds: number }) => Promise<any>;
  join: (o: { key: string; invited: any }) => Promise<any>;
  writeProfile: (o: { id: string; name: string; harness: string; credential: any }) => void | Promise<void>;
  record: (o: { name: string; harness: string; participantId: string; agentId: string }) => void;
};
export class JoinError extends Error {
  code: 'invalid' | 'claimed' | 'harness' | 'secret' | 'full' | 'state' | 'reconcile'; status: number;
  constructor(code: JoinError['code'], message: string, status = 400) { super(message); this.code = code; this.status = status; }
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const code = () => { const bytes = randomBytes(8); const c = [...bytes].map(b => PAIRING[b % PAIRING.length]).join(''); return `${c.slice(0, 4)}-${c.slice(4)}`; };
// The answer every unknown, mistyped, used or expired ticket gets, so the route says nothing about which it was.
const invalid = () => new JoinError('invalid', 'This join line is not valid any more. Ask the human for a new one.', 404);
// What the human is told about an approval that cannot finish by itself, and what each action keeps (Codex, seq 55).
const NOTES = {
  window: 'This approval stopped longer ago than it may finish by itself. Retry carries on with the same identity, or refuses if the hub no longer allows it; Refuse ends it and keeps the record of what was done.',
  participant: 'On recovery the hub returned a different participant than this approval recorded, so nothing more was done. Refuse ends it and keeps the record; send a new join line if the agent still needs to join.',
};

export function joinService(path: string, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  let journal: Journal = { version: 1, entries: {} };
  if (existsSync(path)) { const read = JSON.parse(readFileSync(path, 'utf8')); if (read?.version !== 1 || typeof read.entries !== 'object') throw new Error(`${path} is not a join journal`); journal = read; }
  const save = () => saveCredential(path, journal);
  const running = new Map<string, Promise<any>>();
  // A ticket or a claim past its time becomes expired the first time anything looks at it.
  const age = (e: Entry) => { if ((e.state === 'open' || e.state === 'claimed') && now() >= e.expiresAt) { e.state = 'expired'; save(); } return e; };
  const byTicket = (ticket: unknown) => { if (typeof ticket !== 'string' || !TICKET.test(ticket)) throw invalid(); const e = journal.entries[sha(ticket)]; if (!e) throw invalid(); return age(e); };
  const byClaim = (claimId: string) => { const e = Object.values(journal.entries).find(x => x.claim?.claimId === claimId); if (!e) throw new JoinError('state', 'There is no such join request.', 404); return age(e); };
  const partial = (e: Entry) => e.approval ? { kept: { name: e.approval.name, agentId: e.approval.agentId, participantId: e.approval.participantId ?? null } } : {};
  const status = (e: Entry) => ({ state: e.state === 'claimed' ? 'awaiting_approval' : e.state, pairingCode: e.claim!.pairingCode, expiresAt: new Date(e.expiresAt).toISOString(),
    ...(e.state === 'approved' ? { agentId: e.approval!.agentId, name: e.approval!.name } : {}) });

  return {
    issue(o: { name?: string; harness?: string } = {}) {
      const open = Object.values(journal.entries).map(age).filter(e => e.state === 'open' || e.state === 'claimed').length;
      if (open >= OPEN_TICKETS) throw new JoinError('full', `There are already ${OPEN_TICKETS} join lines waiting; refuse or let some expire first.`, 429);
      const ticket = `alj_${randomBytes(24).toString('base64url')}`; const hash = sha(ticket);
      journal.entries[hash] = { id: hash.slice(0, 16), hash, ...(o.name ? { name: o.name } : {}), ...(o.harness ? { harness: o.harness } : {}), issuedAt: now(), expiresAt: now() + TICKET_MS, state: 'open' };
      save(); return { ticket, ticketId: hash.slice(0, 16), expiresAt: new Date(now() + TICKET_MS).toISOString() };
    },
    // The one claim a ticket allows, or the same claim again when the secret matches.
    claim(ticket: unknown, o: { secret: unknown; harness: unknown; label: unknown }, harnessOk: (id: string) => string | null) {
      const e = byTicket(ticket);
      if (typeof o.secret !== 'string' || !SECRET.test(o.secret)) throw new JoinError('secret', 'The claim secret is missing or malformed.');
      if (e.claim) { if (!same(e.claim.secretHash, sha(o.secret))) throw new JoinError('claimed', 'Another session has already used this join line.', 409); return { claimId: e.claim.claimId, ...status(e) }; }
      if (e.state !== 'open') throw invalid();
      const harness = typeof o.harness === 'string' ? o.harness : ''; if (e.harness && harness !== e.harness) throw new JoinError('harness', `This line is for ${e.harness}.`);
      const refused = harnessOk(harness); if (refused) throw new JoinError('harness', refused);
      const label = typeof o.label === 'string' && o.label.trim() && !/[\u0000-\u001f\u007f]/.test(o.label) ? o.label.trim().slice(0, 60) : harness;
      e.claim = { claimId: `jc_${randomBytes(9).toString('base64url')}`, secretHash: sha(o.secret), pairingCode: code(), harness, label, at: now() }; e.state = 'claimed';
      save(); return { claimId: e.claim.claimId, ...status(e) };
    },
    poll(ticket: unknown, secret: unknown) {
      const e = byTicket(ticket); if (!e.claim || typeof secret !== 'string' || !same(e.claim.secretHash, sha(secret))) throw invalid();
      return { claimId: e.claim.claimId, ...status(e) };
    },
    pending() {
      return Object.values(journal.entries).map(age).filter(e => e.state === 'claimed' || e.state === 'approving' || e.state === 'reconcile')
        .map(e => ({ claimId: e.claim!.claimId, label: e.claim!.label, harness: e.claim!.harness, pairingCode: e.claim!.pairingCode, state: e.state, expiresAt: new Date(e.expiresAt).toISOString(),
          ...(e.state === 'reconcile' ? { note: NOTES[e.approval?.stuck ?? 'window'], retry: e.approval?.stuck !== 'participant' } : {}) }));
    },
    // Refusing a claim makes nobody. Refusing a stuck approval ends it but keeps what it did in the journal: the name, the
    // agent id and any participant the hub made, which the answer names so the human can see it in the roster.
    refuse(claimId: string) {
      const e = byClaim(claimId); if (e.state === 'refused') return { ...status(e), ...partial(e) };
      if (e.state !== 'claimed' && e.state !== 'reconcile') throw new JoinError('state', e.state === 'expired' ? 'That join request has expired.' : 'That join request is no longer waiting.', 409);
      e.state = 'refused'; save(); return { ...status(e), ...partial(e) };
    },
    revoke(ticketId: string) {
      const e = Object.values(journal.entries).find(x => x.id === ticketId); if (!e) throw new JoinError('state', 'There is no such join line.', 404);
      if (e.state === 'open' || e.state === 'claimed') { e.state = 'revoked'; save(); } return { state: e.state };
    },
    // Approve, or carry on an approval that stopped. Two presses at once share one run.
    // `retry` is the human's explicit choice for an approval stuck past its window: the same keys, a fresh window, never a
    // new identity. One the hub answered with a different participant cannot be retried.
    approve(claimId: string, effects: Effects, o: { retry?: boolean } = {}): Promise<ReturnType<typeof status>> {
      const e = byClaim(claimId);
      if (e.state === 'approved') return Promise.resolve(status(e));
      if (e.state === 'reconcile' && o.retry && e.approval?.stuck !== 'participant' && !running.has(claimId)) { e.approval!.startedAt = now(); delete e.approval!.stuck; e.state = 'approving'; save(); }
      if (e.state !== 'claimed' && e.state !== 'approving') throw new JoinError(e.state === 'reconcile' ? 'reconcile' : 'state', e.state === 'expired' ? 'That join request has expired.' : e.state === 'reconcile' ? NOTES[e.approval?.stuck ?? 'window'] : 'That join request is no longer waiting.', 409);
      const inFlight = running.get(claimId); if (inFlight) return inFlight;
      const run = (async () => {
        if (e.state === 'claimed') {
          const name = effects.chooseName({ name: e.name, harness: e.claim!.harness, label: e.claim!.label });
          e.approval = { startedAt: now(), name, agentId: effects.agentId(e.claim!.harness, e.hash) }; e.state = 'approving'; save();
        }
        const a = e.approval!;
        if (now() - a.startedAt > RECOVERY_MS) { e.state = 'reconcile'; a.stuck = 'window'; save(); throw new JoinError('reconcile', NOTES.window, 409); }
        const invited = await effects.invite({ key: `join-${e.id}-invite`, name: a.name, harness: e.claim!.harness, ttlSeconds: INVITE_TTL_SECONDS });
        if (!a.invited) { a.invited = true; save(); }
        const joined = await effects.join({ key: `join-${e.id}-join`, invited });
        if (a.participantId && a.participantId !== joined.participantId) { e.state = 'reconcile'; a.stuck = 'participant'; save(); throw new JoinError('reconcile', NOTES.participant, 409); }
        if (!a.participantId) { a.participantId = joined.participantId; save(); }
        await effects.writeProfile({ id: a.agentId, name: a.name, harness: e.claim!.harness, credential: joined }); if (!a.profile) { a.profile = true; save(); }
        effects.record({ name: a.name, harness: e.claim!.harness, participantId: joined.participantId, agentId: a.agentId });
        a.recorded = true; a.at = now(); e.state = 'approved'; save(); return status(e);
      })();
      running.set(claimId, run); const clear = () => { running.delete(claimId); }; run.then(clear, clear); return run;
    },
    // Approvals a stopped console left part done, to carry on once it is back.
    unfinished() { return Object.values(journal.entries).filter(e => e.state === 'approving').map(e => e.claim!.claimId); },
    entries: () => journal.entries,
  };
}
export type JoinService = ReturnType<typeof joinService>;
