// The project file and a keyed hub receipt cannot share a filesystem rename. Keep one durable intent while
// committing them: restart records a completed rename, or drops an intent whose rename never happened. A
// conflicting hand edit is preserved and reported for recovery, never overwritten to finish an old request.
import { constants, openSync, closeSync, fstatSync, fchmodSync, readSync, writeFileSync, fsyncSync, renameSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError } from './collab.ts';
import { MAP_FILE, MAP_MAX_BYTES, MAP_MAX_ENTRIES, MapEditError, parseMap, editMap, mapDigest } from './map.ts';
import { save } from './snapshot.ts';

const refuse = (code: string, message: string, detail?: unknown): never => { throw new DomainError(code === 'map_unsafe' ? 400 : 409, code, message, detail); };
const JOURNAL = 'map-edit.pending.json';
const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

export function readProjectMap(workspace: string) {
  let fd: number | undefined;
  try {
    if (!lstatSync(workspace).isDirectory()) refuse('map_unsafe', 'The workspace must be a real directory, not a symbolic link');
    const root = realpathSync(workspace); const path = join(root, MAP_FILE);
    let info;
    try { info = lstatSync(path); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    if (!info) return { path, root, exists: false, text: '', digest: mapDigest(''), size: 0, modifiedAt: null, mtimeMs: null, mode: 0o644, nodes: [], flows: [], errors: [] };
    if (!info.isFile()) refuse('map_unsafe', 'The project map must be a regular file, not a symbolic link or special file');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    info = fstatSync(fd);
    if (!info.isFile()) refuse('map_unsafe', 'The project map must be a regular file');
    if (info.size > MAP_MAX_BYTES) refuse('map_too_large', `The project map exceeds ${MAP_MAX_BYTES / 1024} KiB`);
    const bytes = Buffer.alloc(MAP_MAX_BYTES + 1); let size = 0; let count;
    while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null))) size += count;
    if (size > MAP_MAX_BYTES) refuse('map_too_large', `The project map exceeds ${MAP_MAX_BYTES / 1024} KiB`);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)); const parsed = parseMap(text);
    if (parsed.nodes.length + parsed.flows.length > MAP_MAX_ENTRIES) refuse('map_too_large', `The project map exceeds ${MAP_MAX_ENTRIES} entries`);
    return { path, root, exists: true, text, digest: mapDigest(text), size, modifiedAt: info.mtime.toISOString(), mtimeMs: info.mtimeMs, mode: info.mode & 0o777, ...parsed };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    refuse('map_unsafe', 'The project map or its workspace cannot be safely read');
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function projectMapView(workspace: string) {
  const { text, root, mode, ...view } = readProjectMap(workspace)!; return view;
}

export function prepareMapEdit(workspace: string, body: any) {
  if (Object.keys(body).some(k => !['requestId', 'base', 'add', 'remove'].includes(k))) throw new DomainError(400, 'unknown_field', 'Unsupported map edit field');
  if ((body.base !== undefined && !digest(body.base)) || ['add', 'remove'].some(k => body[k] !== undefined && (!Array.isArray(body[k]) || body[k].length > MAP_MAX_ENTRIES || body[k].some((v: any) => typeof v !== 'string' || v.length > 4096)))) throw new DomainError(400, 'invalid_field', 'base must be a SHA-256 digest; add and remove must be bounded arrays of text');
  const before = readProjectMap(workspace)!;
  if (body.base !== undefined && before.digest !== body.base) refuse('map_changed', 'The map changed; read it again before editing', { digest: before.digest });
  try { const edited = editMap(before.text, body); return { before, text: edited.text, result: { digest: mapDigest(edited.text), added: edited.added, removed: edited.removed } }; }
  catch (error) {
    if (error instanceof MapEditError) throw new DomainError(['invalid_line', 'empty_edit', 'map_too_large'].includes(error.code) ? 400 : 409, error.code, error.message, error.detail);
    throw error;
  }
}

function syncDirectory(path: string) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function clearJournal(dataDir: string) { unlinkSync(join(dataDir, JOURNAL)); syncDirectory(dataDir); }

export function commitMapEdit(dataDir: string, workspace: string, sessionId: string, key: string, fingerprint: string, prepared: ReturnType<typeof prepareMapEdit>, saveReceipt: () => void) {
  const temporary = join(prepared.before.root, `${MAP_FILE}.tmp-${randomUUID()}`); let journalled = false;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { writeFileSync(fd, prepared.text, 'utf8'); if (prepared.before.exists) fchmodSync(fd, prepared.before.mode); fsyncSync(fd); } finally { closeSync(fd); }
    const current = readProjectMap(workspace)!;
    if (current.root !== prepared.before.root || current.exists !== prepared.before.exists || current.digest !== prepared.before.digest) refuse('map_changed', 'The map changed while preparing the edit; read it again', { digest: current.digest });
    save(join(dataDir, JOURNAL), { sessionId, key, fingerprint, temporary: basename(temporary), before: { exists: current.exists, digest: current.digest }, text: prepared.text, result: prepared.result });
    journalled = true;
    renameSync(temporary, current.path); syncDirectory(current.root);
    saveReceipt(); clearJournal(dataDir);
    return prepared.result;
  } finally {
    // After an intent is durable, failures leave it for startup recovery. Never pretend a failed snapshot save
    // rolled back a project-file rename. The server stops writing until that recovery has happened.
    try { unlinkSync(temporary); } catch (error: any) { if (error.code !== 'ENOENT' && !journalled) throw error; }
  }
}

export function recoverMapEdit(dataDir: string, state: any, statePath: string) {
  const path = join(dataDir, JOURNAL); let fd: number | undefined;
  try {
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
    const info = fstatSync(fd); if (!info.isFile() || info.size > MAP_MAX_BYTES * 6 + 32_768) throw new Error('invalid pending map edit');
    const bytes = Buffer.alloc(info.size); let offset = 0; let count;
    while (offset < bytes.length && (count = readSync(fd, bytes, offset, bytes.length - offset, null))) offset += count;
    const pending = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)));
    const session = state.sessions.find((s: any) => s.id === pending.sessionId);
    const actor = typeof pending.key === 'string' ? pending.key.slice(0, pending.key.indexOf(':')) : null;
    if (!session || !session.participants.some((p: any) => p.id === actor) || !digest(pending.fingerprint) || !digest(pending.before?.digest) || typeof pending.before?.exists !== 'boolean' || typeof pending.text !== 'string' || Buffer.byteLength(pending.text) > MAP_MAX_BYTES || !digest(pending.result?.digest) || mapDigest(pending.text) !== pending.result.digest || !['added', 'removed'].every(k => Array.isArray(pending.result[k]) && pending.result[k].every((v: any) => typeof v === 'string'))) throw new Error('invalid pending map edit');
    if (pending.temporary !== undefined && (typeof pending.temporary !== 'string' || !/^agentlink-map\.txt\.tmp-[a-f0-9-]{36}$/.test(pending.temporary))) throw new Error('invalid pending map temporary file');
    const prior = state.requests[pending.key];
    if (prior) {
      if (prior.fingerprint !== pending.fingerprint || JSON.stringify(prior.result) !== JSON.stringify(pending.result)) throw new Error('conflicting map receipt');
      // The receipt proves this commit completed; a subsequent human edit must stay untouched.
    } else {
      const current = readProjectMap(session.workspace)!;
      if (current.exists && current.digest === pending.result.digest) {
        state.requests[pending.key] = { fingerprint: pending.fingerprint, result: pending.result }; save(statePath, state);
      } else if (current.exists !== pending.before.exists || current.digest !== pending.before.digest) throw new Error('project file changed during interrupted map edit');
      // Still at the old baseline: no rename occurred and no receipt is recorded. A retry can apply the edit.
    }
    if (pending.temporary !== undefined) {
      if (!lstatSync(session.workspace).isDirectory()) throw new Error('map workspace is not a real directory');
      const root = realpathSync(session.workspace);
      try { unlinkSync(join(root, pending.temporary)); syncDirectory(root); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    clearJournal(dataDir);
  } catch (error: any) {
    throw new Error(`Pending map edit needs recovery (${error.message}). Preserve ${path} and the project map; reconcile them before restarting.`);
  } finally { if (fd !== undefined) closeSync(fd); }
}
