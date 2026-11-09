import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { validateEndpoint, type Credential } from './client.ts';

// Agent profiles are project-local. This is a cooperative local boundary, not isolation from another same-user
// process. No resolver scans for credentials or falls back to the owner's credential or another room's index.
export const PROFILE_ID = /^[a-z]{2,6}-[a-z0-9]{4}$/;
// The short identity selects an agent credential only. Membership, interactive console and run controls are never
// forwarded by the agent-facing entry point. The old explicit --client CLI retains its compatibility surface.
export const PROFILE_COMMANDS = new Set(['bind', 'wait', 'fetch', 'reply', 'send', 'ack', 'status', 'room', 'inbox', 'history', 'heartbeat', 'leave', 'run',
  'board', 'item-open', 'item-close', 'publish', 'request', 'respond', 'accept', 'withdraw', 'owed', 'awaiting', 'items', 'item', 'requests', 'revision', 'capabilities', 'suggest', 'map', 'map-edit',
  'react', 'working', 'blocked', 'done', 'post', 'receipts']);
type Metadata = { name: string; roomId: string; harness: string };
type Index = Record<string, Metadata>;
export type Profile = { id: string; name: string; harness: string; credentialPath: string; stateDir: string };
export type ProfileInput = { id: string; name: string; harness: string; credential: Credential };
export class ProfileError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = 'ProfileError'; this.code = code; }
}
const fail = (code: string, message: string): never => { throw new ProfileError(code, message); };
const idOf = (id: string) => PROFILE_ID.test(id) ? id : fail('profile_id', 'An agent id is 2–6 lower-case letters, a hyphen, and 4 lower-case letters or digits');
const nameOK = (name: unknown): name is string => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(name) && !['human', 'owner', 'all'].includes(name.toLowerCase());
const harnessOK = (harness: unknown): harness is string => typeof harness === 'string' && /^[a-z][a-z0-9-]{1,31}$/.test(harness);
const roomOK = (room: unknown): room is string => typeof room === 'string' && /^s_[A-Za-z0-9_-]{1,96}$/.test(room);

function stat(path: string) {
  try { return lstatSync(path); } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}
function directory(path: string, create = false) {
  let found = stat(path);
  if (!found && create) {
    try { mkdirSync(path, { mode: 0o700 }); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    found = stat(path);
  }
  if (!found) fail('profile_unknown', 'The agent profile directory does not exist');
  if (found!.isSymbolicLink() || !found!.isDirectory()) fail('profile_unsafe', 'Agent profile paths must be real directories, never symlinks');
  if (found!.mode & 0o077) fail('profile_unsafe', 'Agent profile directories must be private (mode 0700)');
}
function agentsDir(dataDir: string, create = false) {
  const data = resolve(dataDir);
  directory(data, create);
  const agents = join(data, 'agents'); directory(agents, create);
  return agents;
}
export function profileDir(dataDir: string, id: string): string { return join(resolve(dataDir), 'agents', idOf(id)); }

// Open without following a final symlink; parse errors never include the file's contents in an error message.
function json(path: string, optional = false): any {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error: any) {
    if (error.code === 'ENOENT') { if (optional) return undefined; fail('profile_corrupt', 'An agent profile file is missing'); }
    if (error.code === 'ELOOP') fail('profile_unsafe', 'Agent profile files must not be symlinks');
    throw error;
  }
  try {
    if (!fstatSync(fd!).isFile()) fail('profile_unsafe', 'Agent profile files must be regular files');
    try { return JSON.parse(readFileSync(fd!, 'utf8')); }
    catch { return fail('profile_corrupt', 'An agent profile file is not valid JSON'); }
  }
  finally { closeSync(fd!); }
}
function readIndex(agents: string, optional = false): Index {
  const index = json(join(agents, 'index.json'), optional);
  if (index === undefined) return Object.create(null);
  if (!index || typeof index !== 'object' || Array.isArray(index)) fail('profile_corrupt', 'The agent profile index is invalid');
  for (const [id, raw] of Object.entries(index)) {
    const value = raw as any;
    if (!PROFILE_ID.test(id) || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['name', 'roomId', 'harness'].includes(key))
      || !nameOK(value.name) || !roomOK(value.roomId) || !harnessOK(value.harness)) fail('profile_corrupt', 'The agent profile index has an invalid entry');
  }
  return index;
}
function auth(value: any): Credential & { sessionId: string; participantId: string } {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.endpoint !== 'string' || typeof value.token !== 'string'
      || !value.token || value.token.length > 4096 || /[\u0000-\u001f\u007f]/.test(value.token) || !roomOK(value.sessionId)
      || typeof value.participantId !== 'string' || !/^p_[A-Za-z0-9_-]{1,96}$/.test(value.participantId)) throw new Error();
    validateEndpoint(value.endpoint);
  } catch { return fail('profile_credential', 'An agent profile needs a valid local participant credential'); }
  return { endpoint: value.endpoint, token: value.token, sessionId: value.sessionId, participantId: value.participantId };
}
function sameAuth(left: any, right: Credential): boolean {
  const saved = auth(left);
  return saved.endpoint === right.endpoint && saved.sessionId === right.sessionId && saved.participantId === right.participantId && saved.token === right.token;
}
function regular(path: string) {
  const found = stat(path);
  if (found && (found.isSymbolicLink() || !found.isFile())) fail('profile_unsafe', 'Agent profile files must be regular files, never symlinks');
  return found;
}
function privateFile(path: string, value: unknown, replace = false) {
  regular(path);
  const temp = join(dirname(path), `.profile-${randomUUID()}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    if (replace) renameSync(temp, path);
    else { try { linkSync(temp, path); } catch (error: any) { if (error.code === 'EEXIST') fail('profile_collision', 'That agent profile already has a credential'); throw error; } }
    const dir = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { rmSync(temp, { force: true }); }
}

// Publish a whole PID+nonce lock by hard link. A dead owner can be reclaimed only under a separate guard and after
// checking it again. A live PID, reused PID or malformed record is never guessed dead. This mirrors wait locking.
function indexLock(agents: string): () => void {
  const lock = join(agents, '.write.lock'); const guard = join(agents, '.write.reclaim');
  const own = `${process.pid}:${randomUUID()}`; const temp = join(agents, `.write-${randomUUID()}.tmp`);
  const read = (path: string) => {
    const found = regular(path); if (!found) return undefined;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { if (!fstatSync(fd).isFile()) fail('profile_unsafe', 'A profile lock must be a regular file'); return readFileSync(fd, 'utf8'); }
    finally { closeSync(fd); }
  };
  const drop = (path: string) => { if (read(path) === own) rmSync(path); };
  const take = (path: string) => { regular(path); try { linkSync(temp, path); return true; } catch (error: any) { if (error.code === 'EEXIST') return false; throw error; } };
  const owner = () => {
    const value = read(lock); if (value === undefined) return 'absent';
    const match = /^([1-9]\d*):[a-z0-9-]+$/.exec(value);
    if (!match || Number(match[1]) < 2 || !Number.isSafeInteger(Number(match[1]))) fail('profile_busy', 'A profile lock is malformed; human recovery is required');
    try { process.kill(Number(match![1]), 0); return 'live'; } catch (error: any) { return error.code === 'ESRCH' ? 'dead' : 'live'; }
  };
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, own); } finally { closeSync(fd); }
  try {
    if (take(lock)) return () => drop(lock);
    if (owner() === 'live') fail('profile_busy', 'Another profile write is pending');
    if (!take(guard)) fail('profile_busy', 'A profile lock recovery is pending; an abandoned guard needs human recovery');
    try {
      const state = owner();
      if (state === 'live') fail('profile_busy', 'Another profile write took the lock');
      // An absent lock may have just been acquired by another writer; never unlink it in that case.
      if (state === 'dead') rmSync(lock);
      if (!take(lock)) fail('profile_busy', 'Another profile write took the lock');
      return () => drop(lock);
    } finally { drop(guard); }
  } finally { rmSync(temp, { force: true }); }
}

export function readProfile(dataDir: string, id: string): Profile {
  idOf(id);
  const agents = agentsDir(dataDir); const index = readIndex(agents);
  const metadata = index[id];
  if (!metadata) fail('profile_unknown', 'No agent with that id is in this room; choose an explicit id from its index');
  const dir = profileDir(dataDir, id); directory(dir);
  const credentialPath = join(dir, 'credential.json'); const credentialStat = regular(credentialPath);
  if (credentialStat && credentialStat.mode & 0o077) fail('profile_unsafe', 'An agent credential must be private (mode 0600)');
  const saved = auth(json(credentialPath));
  if (saved.sessionId !== metadata.roomId) fail('profile_corrupt', 'The profile credential does not belong to the indexed room');
  const canonical = realpathSync(dir);
  return { id, name: metadata.name, harness: metadata.harness, credentialPath: join(canonical, 'credential.json'), stateDir: canonical };
}

// Credential first, index second. An interrupted write leaves a recoverable profile, never an index naming a
// credential that has not been written. The caller's approval journal owns recovery across the hub operations.
export function writeProfile(dataDir: string, input: ProfileInput): Profile {
  const id = idOf(input.id);
  if (!nameOK(input.name) || !harnessOK(input.harness)) fail('profile_metadata', 'An agent profile needs a valid agent name and harness id');
  const value = auth(input.credential);
  const agents = agentsDir(dataDir, true); const release = indexLock(agents);
  try {
    const index = readIndex(agents, true); const prior = index[id];
    if (prior && (prior.name !== input.name || prior.harness !== input.harness || prior.roomId !== value.sessionId)) fail('profile_collision', 'That agent id belongs to a different profile');
    for (const [other, metadata] of Object.entries(index)) {
      if (other !== id && metadata.roomId === value.sessionId && metadata.name.toLowerCase() === input.name.toLowerCase()) fail('profile_collision', 'That name already belongs to another profile in this room');
      if (other !== id && metadata.roomId === value.sessionId) {
        const otherProfile = readProfile(dataDir, other); const otherCredential = auth(json(otherProfile.credentialPath));
        if (otherCredential.participantId === value.participantId || otherCredential.token === value.token) fail('profile_collision', 'That participant already has a canonical profile and runtime directory');
      }
    }
    const dir = profileDir(dataDir, id); directory(dir, true);
    const target = join(dir, 'credential.json'); const existing = regular(target);
    if (existing) {
      if (existing.mode & 0o077) fail('profile_unsafe', 'An agent credential must be private (mode 0600)');
      if (!sameAuth(json(target), value)) fail('profile_collision', 'That agent id already holds a different credential');
    } else {
      if (prior) fail('profile_corrupt', 'The indexed agent credential is missing; human recovery is required');
      privateFile(target, value);
    }
    if (!prior) {
      index[id] = { name: input.name, roomId: value.sessionId, harness: input.harness };
      privateFile(join(agents, 'index.json'), index, true);
    }
    return readProfile(dataDir, id);
  } finally { release(); }
}

export function resolveAs(id: string): Profile {
  idOf(id);
  let cwd = realpathSync(process.cwd());
  for (;;) {
    const data = join(cwd, '.agentlink'); const agents = join(data, 'agents');
    // Checking directories before the index keeps a nested symlink from redirecting a room lookup.
    const dataStat = stat(data);
    if (dataStat) {
      directory(data);
      if (stat(agents)) {
        directory(agents);
        if (stat(join(agents, 'index.json'))) return readProfile(data, id);
      }
    }
    const parent = dirname(cwd);
    if (parent === cwd) fail('profile_unknown', 'No Peerloom profile index is above this directory; run in the intended room workspace');
    cwd = parent;
  }
}

// --client and --as must share a wait lock when they name the same managed credential. Ordinary legacy files keep
// their original sibling files. The index, not the filename alone, establishes that a credential is managed.
export function profileForCredential(path: string): Profile | undefined {
  const at = (absolute: string) => {
    const dir = dirname(absolute); const id = basename(dir);
    if (basename(absolute) !== 'credential.json' || basename(dirname(dir)) !== 'agents' || !PROFILE_ID.test(id)) return undefined;
    const data = dirname(dirname(dir));
    if (!stat(join(data, 'agents/index.json'))) return undefined;
    return readProfile(data, id);
  };
  // Validate a managed path before resolving aliases. Otherwise a symlink inside a profile could resolve outside
  // the index and accidentally fall back to the legacy state/lock layout.
  const supplied = resolve(path); const direct = at(supplied); if (direct) return direct;
  const canonical = realpathSync(path);
  return canonical === supplied ? undefined : at(canonical);
}

export function joinClaim(dataDir: string, ticket: string, harness: string, label: string): { secret: string; path: string } {
  if (!/^alj_[A-Za-z0-9_-]{32}$/.test(ticket) || !harnessOK(harness) || !label.trim() || label.length > 60 || /[\u0000-\u001f\u007f]/.test(label)) fail('join_claim', 'The join ticket, harness or label is invalid');
  const agents = agentsDir(dataDir, true); const claims = join(agents, 'claims'); directory(claims, true);
  const hash = createHash('sha256').update(ticket).digest('hex'); const path = join(claims, `${hash}.json`);
  const read = () => {
    const found = regular(path); if (!found) return undefined;
    if (found.mode & 0o077) fail('profile_unsafe', 'A join claim must be private (mode 0600)');
    const value = json(path);
    if (!value || value.v !== 1 || value.ticketHash !== hash || value.harness !== harness || value.label !== label || typeof value.secret !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(value.secret)) fail('join_claim', 'The saved claim is damaged or belongs to a different harness or label; do not overwrite it');
    return { secret: value.secret as string, path };
  };
  const prior = read(); if (prior) return prior;
  try { privateFile(path, { v: 1, ticketHash: hash, harness, label, secret: randomBytes(32).toString('base64url') }); }
  catch (error) { if (!(error instanceof ProfileError) || error.code !== 'profile_collision') throw error; }
  return read() ?? fail('join_claim', 'The claim could not be saved; no join request was sent');
}
