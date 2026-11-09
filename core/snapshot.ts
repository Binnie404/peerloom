import { readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { validate as validateCollaboration } from './collab.ts';
import { isSealed, seal } from './seal.ts';
import { upgrade as upgradeDelivery, validate as validateDelivery } from './delivery.ts';
import { validate as validateQuiet } from './quiet.ts';

// The current store version. 6 (item 24, slice C) adds marks (reactions and activity), passive posts and noReply.
export const STATE_VERSION = 6;

function object(v: any): boolean { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// Validate before a snapshot can establish identity or authorize a mutation.
// Malformed data is never repaired, defaulted or silently reset.
export function validateState(value: any): void {
  const bad = (where: string): never => { throw new Error(`Unsupported or damaged state file (${where}); restore a protected backup.`); };
  const text = (v: any, max: number, empty = false) => typeof v === 'string' && v.length <= max && (empty || v.trim().length > 0);
  const id = (v: any, prefix: string) => text(v, 100) && v.startsWith(`${prefix}_`);
  const digest = (v: any) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const date = (v: any) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
  const keys = (v: any, allowed: string[]) => object(v) && Object.keys(v).every(k => allowed.includes(k));
  if (!keys(value, ['version', 'sessions', 'requests']) || ![1, 2, 3, 4, 5, 6].includes(value.version) || !Array.isArray(value.sessions) || !object(value.requests)) bad('root schema/version');
  const sessionIds = new Set<string>(); const participantIds = new Set<string>(); const credentials = new Set<string>(); const invitationIds = new Set<string>();
  for (const s of value.sessions) {
    if (!keys(s, ['id', 'name', 'workspace', 'objective', 'participants', 'invitations', 'messages', ...(value.version >= 2 ? ['events'] : []), ...(value.version >= 4 ? ['delivery'] : []), ...(value.version >= 6 ? ['marks'] : [])]) ||
        !id(s.id, 's') || sessionIds.has(s.id) || !text(s.name, 100) || !text(s.workspace, 4096) || !text(s.objective, 4096, true) ||
        !Array.isArray(s.participants) || !Array.isArray(s.invitations) || !Array.isArray(s.messages) ||
        (value.version >= 2 && !Array.isArray(s.events)) || (value.version >= 6 && !Array.isArray(s.marks))) bad('session schema');
    sessionIds.add(s.id);
    const names = new Set<string>(); const peers = new Map<string, any>();
    for (const p of s.participants) {
      if (!keys(p, ['id', 'name', 'kind', 'role', 'harness', 'tokenHash', 'status', 'ack']) || !id(p.id, 'p') || participantIds.has(p.id) ||
          !text(p.name, 100) || names.has(p.name.toLowerCase()) || !['human', 'agent'].includes(p.kind) ||
          !text(p.role, 200, true) || !text(p.harness, 100) || !text(p.status, 1000, true) || !Array.isArray(p.ack) ||
          p.ack.some((mid: any) => !id(mid, 'm')) || new Set(p.ack).size !== p.ack.length ||
          (p.tokenHash !== undefined && (!digest(p.tokenHash) || credentials.has(p.tokenHash)))) bad('participant schema/identity');
      names.add(p.name.toLowerCase()); participantIds.add(p.id); peers.set(p.id, p);
      if (p.tokenHash !== undefined) credentials.add(p.tokenHash);
    }
    const humans = s.participants.filter((p: any) => p.kind === 'human');
    if (humans.length !== 1 || humans[0].name !== 'human' || humans[0].role !== 'owner' || !humans[0].tokenHash) bad('human owner');
    const invitations = new Set<string>();
    for (const i of s.invitations) {
      if (!keys(i, ['id', 'participantId', 'tokenHash', 'expiresAt', 'used', 'revoked']) || !id(i.id, 'i') || invitations.has(i.id) ||
          peers.get(i.participantId)?.kind !== 'agent' || !digest(i.tokenHash) || !Number.isSafeInteger(i.expiresAt) || i.expiresAt <= 0 ||
          typeof i.used !== 'boolean' || typeof i.revoked !== 'boolean' || (i.used && !peers.get(i.participantId)?.tokenHash)) bad('invitation schema');
      invitations.add(i.id); invitationIds.add(i.id);
    }
    const messages = new Map<string, any>();
    for (const [index, m] of s.messages.entries()) {
      const author = peers.get(m?.sender?.id);
      if (!keys(m, ['id', 'sequence', 'sender', 'recipientIds', 'text', 'createdAt', 'replyTo', 'threadId', ...(value.version >= 2 ? ['messageKind', 'collab'] : []), ...(value.version >= 6 ? ['noReply'] : [])]) ||
          !id(m.id, 'm') || messages.has(m.id) || m.sequence !== index + 1 || !keys(m.sender, ['id', 'name', 'kind', 'role']) ||
          !author || ['id', 'name', 'kind', 'role'].some(key => m.sender[key] !== author[key]) ||
          !Array.isArray(m.recipientIds) || !m.recipientIds.length || m.recipientIds.some((pid: any) => !peers.has(pid)) ||
          new Set(m.recipientIds).size !== m.recipientIds.length || !text(m.text, 32000) || !date(m.createdAt) ||
          (m.replyTo === undefined ? m.threadId !== m.id : !messages.has(m.replyTo) || m.threadId !== messages.get(m.replyTo).threadId)) bad('message schema/relationship');
      if (m.noReply !== undefined && (m.noReply !== true || m.messageKind !== undefined)) bad('noReply schema');
      if (m.messageKind === 'post' && value.version >= 6) { if (m.collab !== undefined) bad('post schema'); }
      else if (m.messageKind !== undefined || m.collab !== undefined) {
        if (!['request', 'response'].includes(m.messageKind) || !keys(m.collab, ['collabRequestId', 'responseId']) ||
            !id(m.collab.collabRequestId, 'rq') || (m.messageKind === 'response' ? !id(m.collab.responseId, 'rs') : m.collab.responseId !== undefined)) bad('collaboration message schema');
      }
      messages.set(m.id, m);
    }
    for (const p of s.participants) if (p.ack.some((mid: string) => !messages.get(mid)?.recipientIds.includes(p.id))) bad('receipt relationship');
    if (value.version < 5 && s.events?.some((e: any) => e.type === 'suggestion_adopted')) bad('adoption requires state version 5');
    if (value.version >= 2) validateCollaboration(s);
    if (value.version >= 4) validateDelivery(s);
    if (value.version >= 6) validateQuiet(s, bad);
  }
  for (const [key, r] of Object.entries(value.requests) as [string, any][]) {
    if (!text(key, 400) || !keys(r, ['fingerprint', 'result', ...(value.version >= 3 ? ['sealed', 'unrecoverable'] : [])]) || !digest(r.fingerprint) || !object(r.result)) bad('retry record');
    // From version 3 a retry record never holds a usable credential. A result that issued one (create, invite, join)
    // carries exactly one of a valid seal or the removal marker, so a retry can never succeed without its credential;
    // any other result carries neither.
    if (value.version >= 3) {
      const actor = key.slice(0, key.indexOf(':'));
      const issued = actor === 'admin' || invitationIds.has(actor) || (participantIds.has(actor) && r.result.invitationId !== undefined && r.result.expiresAt !== undefined);
      const marks = (r.sealed !== undefined ? 1 : 0) + (r.unrecoverable !== undefined ? 1 : 0);
      if (r.result.token !== undefined || (r.sealed !== undefined && !isSealed(r.sealed)) || (r.unrecoverable !== undefined && r.unrecoverable !== true) ||
          marks !== (issued ? 1 : 0)) bad('retry record credential');
    }
  }
}

// Successful mutation replies follow file fsync, atomic rename and directory fsync.
export function save(path: string, value: any) {
  const temporary = `${path}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const dir = openSync(resolve(path, '..'), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export const retryContext = (key: string, fingerprint: string) => `${key}:${fingerprint}`;

// Version 3 keeps no plaintext credential in retry records. Each legacy result is sealed again under the token its
// caller presented. The hub stores those only as hashes, but a complete legacy store still holds them in the clear in
// sibling results: the owner token an invite was made with is the token a create returned, and the invitation token a
// join presented is the token an invite returned. Every plaintext token is indexed by hash before any is removed, and
// one is used only when it matches the hash the hub authenticates that actor by. A credential is marked removed only
// when the token that would seal it is truly absent.
function sealRetryRecords(state: any, adminToken?: string) {
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  const byHash = new Map<string, string>();
  for (const r of Object.values(state.requests) as any[]) if (typeof r.result.token === 'string') byHash.set(sha(r.result.token), r.result.token);
  const expected = new Map<string, string>();
  for (const s of state.sessions) {
    for (const p of s.participants) if (p.tokenHash) expected.set(p.id, p.tokenHash);
    for (const i of s.invitations) expected.set(i.id, i.tokenHash);
  }
  for (const [key, r] of Object.entries(state.requests) as [string, any][]) {
    if (typeof r.result.token !== 'string') continue;
    const actor = key.slice(0, key.indexOf(':'));
    const presented = actor === 'admin' ? adminToken : byHash.get(expected.get(actor) ?? '');
    const { token, ...rest } = r.result; r.result = rest;
    if (presented) r.sealed = seal(presented, token, retryContext(key, r.fingerprint));
    else r.unrecoverable = true;
  }
}

export function loadState(path: string, upgrade: boolean, adminToken?: string): any {
  let original: Buffer;
  try { original = readFileSync(path); }
  catch (error: any) {
    if (error.code === 'ENOENT') return { version: STATE_VERSION, sessions: [], requests: {} };
    throw error;
  }
  // Never normalize invalid UTF-8 into replacement characters during upgrade.
  // The backup below receives the original bytes, not a re-encoded string.
  const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(original));
  validateState(state);
  if (state.version === STATE_VERSION || !upgrade) return state;
  const upgraded = structuredClone(state); upgraded.version = STATE_VERSION;
  if (state.version === 1) for (const s of upgraded.sessions) s.events = [];
  if (state.version < 3) sealRetryRecords(upgraded, adminToken);
  if (state.version < 4) for (const s of upgraded.sessions) upgradeDelivery(s);
  if (state.version < 6) for (const s of upgraded.sessions) s.marks = [];
  validateState(upgraded);
  const backupName = `state.v${state.version}.backup.json`;
  const backup = join(resolve(path, '..'), backupName);
  let fd: number;
  try { fd = openSync(backup, 'wx', 0o600); }
  catch (error: any) {
    if (error.code === 'EEXIST') throw new Error(`State upgrade refused: ${backupName} already exists; preserve it and reconcile before retrying.`);
    throw error;
  }
  try { writeFileSync(fd, original); fsyncSync(fd); } finally { closeSync(fd); }
  const dir = openSync(resolve(path, '..'), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
  // After a rename, a directory fsync failure leaves durability uncertain.
  // The original backup is already durable: preserve it and fail startup.
  try { save(path, upgraded); }
  catch { throw new Error(`State upgrade persistence failed; startup stopped. Original state is preserved in ${backupName}; inspect state.json before recovery.`); }
  return upgraded;
}
