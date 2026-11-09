// The project map (item 22): a plain-text file in the room's workspace that agents keep current through the hub and the
// human may edit by hand. One entry per line; any line that is not an entry is kept as written and reported, never
// rewritten. Everything here is a pure function of the file's text, so the hub, the console and the tests share it.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

export const MAP_FILE = 'agentlink-map.txt';
export const MAP_KINDS = ['component', 'service', 'data', 'ui', 'process', 'external', 'doc'] as const;
export const MAP_MAX_BYTES = 256 * 1024; export const MAP_MAX_ENTRIES = 2000;
const MAX_PATHS = 10;

export const MAP_TEMPLATE = [
  '# Peerloom project map. Agents keep it current with `peerloom map-edit`; you can edit it by hand too.',
  '# One entry per line:',
  '#   node ID | Label | kind | path, path',
  '#   flow FROM -> TO | label',
  `# kind is one of: ${MAP_KINDS.join(', ')}. Paths are relative to this folder and optional.`,
  '# Examples (remove the leading "# " to use them):',
  '# node web | Browser page | ui | ui/',
  '# node hub | Hub | service | core/server.ts',
  '# flow web -> hub | actions and live updates',
  '',
].join('\n');

export type MapNode = { id: string; label: string; kind: string; paths: string[]; line: number };
export type MapFlow = { id: string; from: string; to: string; label: string; line: number };
export type MapError = { line: number; text: string; reason: string };
export type ParsedMap = { nodes: MapNode[]; flows: MapFlow[]; errors: MapError[] };

export class MapEditError extends Error { code: string; detail?: unknown; constructor(code: string, message: string, detail?: unknown) { super(message); this.code = code; this.detail = detail; } }
const refuse = (code: string, message: string, detail?: unknown): never => { throw new MapEditError(code, message, detail); };

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHAPE = '"node ID | Label | kind | paths" or "flow FROM -> TO | label"';
const LABEL_RULE = 'a label is 1 to 120 characters, with no "|" and no control characters';
const label = (text: string) => text.length >= 1 && text.length <= 120 && !/[|\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/.test(text);
const flowKey = (from: string, to: string) => `${from}->${to}`;

type Entry = { node: Omit<MapNode, 'line'> } | { flow: Omit<MapFlow, 'line'> } | { error: string } | { blank: true };
// One line, on its own: its shape and fields. Whether a flow's nodes exist is a property of the whole file.
function entry(raw: string): Entry {
  const text = raw.trim();
  if (!text || text.startsWith('#')) return { blank: true };
  const node = /^node\s+(.*)$/.exec(text); const flow = /^flow\s+(.*)$/.exec(text);
  if (node) {
    const fields = node[1].split('|').map(f => f.trim()); if (fields.length < 3 || fields.length > 4) return { error: `a line is ${SHAPE}` };
    const [id, name, kind, cited = ''] = fields;
    if (!ID.test(id)) return { error: 'a node ID is lower-case letters, digits, ".", "_" or "-", starting with a letter or digit, at most 64' };
    if (!label(name)) return { error: LABEL_RULE };
    if (!(MAP_KINDS as readonly string[]).includes(kind)) return { error: `kind is one of ${MAP_KINDS.join(', ')}` };
    const paths = cited ? cited.split(',').map(p => p.trim()) : [];
    if (paths.length > MAX_PATHS) return { error: `a node cites at most ${MAX_PATHS} paths` };
    for (const path of paths) { const why = badPath(path); if (why) return { error: why }; }
    return { node: { id, label: name, kind, paths } };
  }
  if (flow) {
    const match = /^([^\s|]+)\s*->\s*([^\s|]+)\s*\|(.*)$/.exec(flow[1]); if (!match) return { error: `a line is ${SHAPE}` };
    const [, from, to, rest] = match; const name = rest.trim();
    if (!ID.test(from) || !ID.test(to)) return { error: 'a flow joins two node IDs' };
    if (!label(name)) return { error: LABEL_RULE };
    return { flow: { id: flowKey(from, to), from, to, label: name } };
  }
  return { error: `a line is ${SHAPE}` };
}
// A cited path names something in the workspace and nothing private; whether it exists is the freshness check's job.
function badPath(path: string) {
  if (!path || path.length > 300 || /[\u0000-\u001f\u007f]/.test(path)) return `a path is 1 to 300 characters with no control characters: ${path}`;
  const normal = posix.normalize(path);
  if (posix.isAbsolute(path) || normal === '..' || normal.startsWith('../') || path.split('/').includes('..')) return `a path is relative to the workspace and stays inside it: ${path}`;
  const top = normal.split('/')[0];
  if (top === '.agentlink' || top === '.git') return `a path may not point into .agentlink or .git: ${path}`;
  return null;
}

type Line = { raw: string; entry: Entry };
function lines(text: string) { return text.split(/\r?\n/).map(raw => ({ raw, entry: entry(raw) })); }
function classify(all: Line[]): ParsedMap {
  const nodes: MapNode[] = []; const flows: MapFlow[] = []; const errors: MapError[] = []; const first = new Map<string, number>();
  all.forEach(({ raw, entry: e }, index) => {
    const line = index + 1;
    if ('error' in e) errors.push({ line, text: raw, reason: e.error });
    else if ('node' in e) { const seen = first.get(e.node.id); if (seen) errors.push({ line, text: raw, reason: `node ID ${e.node.id} is already used on line ${seen}` }); else { first.set(e.node.id, line); nodes.push({ ...e.node, line }); } }
  });
  all.forEach(({ raw, entry: e }, index) => {
    if (!('flow' in e)) return; const line = index + 1; const missing = [e.flow.from, e.flow.to].filter(id => !first.has(id));
    if (missing.length) errors.push({ line, text: raw, reason: `flow to a node that is not in the map: ${missing.join(', ')}` });
    else if (flows.some(f => f.from === e.flow.from && f.to === e.flow.to && f.label === e.flow.label)) errors.push({ line, text: raw, reason: 'the same flow is already in the map' });
    else flows.push({ ...e.flow, line });
  });
  errors.sort((a, b) => a.line - b.line);
  return { nodes, flows, errors };
}
export function parseMap(text: string): ParsedMap { return classify(lines(text)); }
export const mapDigest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const format = (e: Entry) => 'node' in e ? `node ${e.node.id} | ${e.node.label} | ${e.node.kind}${e.node.paths.length ? ` | ${e.node.paths.join(', ')}` : ''}`
  : 'flow' in e ? `flow ${e.flow.from} -> ${e.flow.to} | ${e.flow.label}` : '';

// An edit is all or nothing: removals first (a node by its ID; a flow by FROM->TO, or FROM->TO|label where a pair has
// more than one), then additions, each a single entry line written in one form. Lines the edit does not name, error
// lines included, stay exactly as they were.
export function editMap(text: string, edit: { add?: string[]; remove?: string[] }): { text: string; added: string[]; removed: string[] } {
  const add = edit.add ?? []; const remove = edit.remove ?? [];
  if (!add.length && !remove.length) refuse('empty_edit', 'Name at least one entry to add or remove');
  const base = text === '' ? MAP_TEMPLATE : text;
  const eol = /\r\n/.test(base) ? '\r\n' : '\n';
  let all = lines(base); const ending = all.length > 1 && all[all.length - 1].raw === '' ? all.pop() : undefined;
  const parsed = classify(all); const valid = new Set([...parsed.nodes.map(n => n.line), ...parsed.flows.map(f => f.line)]);
  const gone = new Set<number>();
  for (const id of remove) {
    const node = parsed.nodes.find(n => n.id === id);
    const [pair, named] = id.includes('|') ? [id.slice(0, id.indexOf('|')), id.slice(id.indexOf('|') + 1)] : [id, undefined];
    const flows = parsed.flows.filter(f => f.id === pair && (named === undefined || f.label === named));
    if (node) gone.add(node.line);
    else if (flows.length > 1) refuse('ambiguous_id', `${id} names ${flows.length} flows; add the label: ${flows.map(f => `${f.id}|${f.label}`).join(', ')}`, { flows: flows.map(f => `${f.id}|${f.label}`) });
    else if (flows.length === 1) gone.add(flows[0].line);
    else refuse('unknown_id', `${id} is not in the map`);
  }
  const kept = all.filter((_, index) => !gone.has(index + 1));
  const added: string[] = []; const fresh: Line[] = [];
  for (const raw of add) {
    if (/[\r\n]/.test(raw)) refuse('invalid_line', 'Each entry to add is one line');
    const e = entry(raw);
    if ('error' in e) refuse('invalid_line', `${raw.trim()}: ${e.error}`);
    if ('blank' in e) refuse('invalid_line', 'Only node and flow entries can be added');
    fresh.push({ raw: format(e), entry: e }); added.push('node' in e ? e.node.id : (e as any).flow.id);
  }
  // Nodes first, so a flow added in the same edit can name them.
  fresh.sort((a, b) => Number('flow' in a.entry) - Number('flow' in b.entry));
  const result = [...kept, ...fresh]; const after = classify(result);
  const live = (index: number, l: Line) => valid.has(all.indexOf(l) + 1) || fresh.includes(l);
  for (const [index, l] of result.entries()) {
    const problem = after.errors.find(e => e.line === index + 1); if (!problem || !live(index, l)) continue;
    if ('node' in l.entry) refuse('duplicate_id', `node ID ${l.entry.node.id} is already in the map`);
    if ('flow' in l.entry) refuse(/already/.test(problem.reason) ? 'duplicate_id' : 'dangling_flow', `${format(l.entry)}: ${problem.reason}`, { line: l.raw });
  }
  const out = result.map(l => l.raw).join(eol) + (ending ? eol : fresh.length && !text.endsWith('\n') ? eol : '');
  if (Buffer.byteLength(out, 'utf8') > MAP_MAX_BYTES || after.nodes.length + after.flows.length > MAP_MAX_ENTRIES) refuse('map_too_large', `A map holds at most ${MAP_MAX_ENTRIES} entries and ${MAP_MAX_BYTES / 1024} KiB; split detail into fewer, larger parts`);
  return { text: out, added, removed: [...remove] };
}

// ── Freshness (R3 section 7, for a file): what a check of the workspace can say, and no more ──
// Cited sources: each path a node cites is present, missing (absent, or resolving outside the workspace), changed
// (a file written after the map file was last written) or unchecked (past the bound). A directory is only present or
// missing: its contents are not compared. Coverage: how many workspace files no node cites, by top-level area, from a
// bounded inventory that never enters private or generated folders. Neither says the map is right.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.agentlink', '.worktrees', 'dist', 'build', 'coverage']);
// Private or generated, by name: checked on a path as written and again on the path a link leads to (GPT, 005-gpt).
const excluded = (path: string) => path.split('/').some(part => SKIP_DIRS.has(part) || part.startsWith('.env') || /\.(pem|key)$/.test(part));
const normal = (path: string) => posix.normalize(path).replace(/\/+$/, '') || '.';
export type PathState = 'present' | 'missing' | 'changed' | 'unchecked';
export type MapCheck = {
  checkedAt: string; state: 'complete' | 'incomplete'; reason?: string;
  sources: Record<string, { state: PathState | 'none'; paths: { path: string; state: PathState }[] }>;
  coverage: { state: 'complete' | 'incomplete'; reason?: string; files: number; uncited: number; byArea: { area: string; files: number; uncited: number }[] };
};
export async function checkMap(workspace: string, map: ParsedMap, since: number, options: { signal?: AbortSignal; maxInventory?: number; maxCited?: number; budgetMs?: number } = {}): Promise<MapCheck> {
  const { opendir, realpath, stat } = await import('node:fs/promises'); const { join, relative, sep } = await import('node:path');
  const maxInventory = options.maxInventory ?? 20_000; const maxCited = options.maxCited ?? 400; const deadline = Date.now() + (options.budgetMs ?? 2000);
  const root = await realpath(workspace);
  // The workspace-relative form of a resolved path, or null when it lies outside the workspace.
  const within = (real: string) => real === root ? '.' : real.startsWith(root + sep) ? relative(root, real).split(sep).join('/') : null;
  const stopped = () => options.signal?.aborted ? 'cancelled' : Date.now() > deadline ? `the check took longer than ${(options.budgetMs ?? 2000) / 1000} s` : null;
  let checked = 0; let sourcesReason: string | undefined;
  const cited = async (path: string): Promise<PathState> => {
    const why = checked >= maxCited ? `only the first ${maxCited} cited paths were checked` : stopped();
    if (why) { sourcesReason ??= why; return 'unchecked'; } checked += 1;
    const asWritten = normal(path); if (asWritten !== '.' && excluded(asWritten)) return 'missing';
    try { const real = await realpath(join(root, asWritten)); const at = within(real); if (at === null || (at !== '.' && excluded(at))) return 'missing';
      const found = await stat(real); return found.isFile() && found.mtimeMs > since ? 'changed' : found.isFile() || found.isDirectory() ? 'present' : 'missing'; }
    // Not there is missing; anything else (a permission, a read error) is not known, so the check is incomplete (GPT, 009-gpt).
    catch (error: any) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'missing'; sourcesReason ??= `${path} could not be read (${error?.code ?? 'error'})`; return 'unchecked'; }
  };
  const sources: MapCheck['sources'] = {};
  for (const node of map.nodes) {
    const paths = []; for (const path of node.paths) paths.push({ path, state: await cited(path) });
    const has = (s: PathState) => paths.some(p => p.state === s);
    sources[node.id] = { state: !paths.length ? 'none' : has('missing') ? 'missing' : has('changed') ? 'changed' : has('unchecked') ? 'unchecked' : 'present', paths };
  }
  // A file counts as cited when a node names it or a folder holding it ("." names them all).
  const prefixes = map.nodes.flatMap(n => n.paths).map(normal);
  const isCited = (path: string) => prefixes.some(p => p === '.' || path === p || path.startsWith(`${p}/`));
  const areas = new Map<string, { files: number; uncited: number }>(); let files = 0; let reason: string | undefined;
  // Directories are read an entry at a time, so a huge one is cut off by the bounds rather than read whole first.
  const queue = ['']; walk: while (queue.length) {
    const dir = queue.shift()!; let handle;
    try { handle = await opendir(join(root, dir)); } catch { reason = `${dir || '.'} could not be read`; break; }
    for await (const entry of handle) {
      if ((reason = stopped() ?? undefined)) break walk;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!excluded(path)) queue.push(path); continue; }
      if (entry.name === MAP_FILE || entry.name.startsWith(`${MAP_FILE}.tmp-`) || excluded(path)) continue;
      // A link counts only when it leads to a file inside the workspace that is not itself private; folders behind links are not entered.
      if (entry.isSymbolicLink()) { try { const real = await realpath(join(root, path)); const at = within(real); if (at === null || excluded(at) || !(await stat(real)).isFile()) continue; } catch { continue; } }
      else if (!entry.isFile()) continue;
      if (files >= maxInventory) { reason = `the inventory stopped at ${maxInventory} files`; break walk; }
      files += 1; const area = path.includes('/') ? path.slice(0, path.indexOf('/')) : '.';
      const counts = areas.get(area) ?? { files: 0, uncited: 0 }; counts.files += 1; if (!isCited(path)) counts.uncited += 1; areas.set(area, counts);
    }
  }
  const byArea = [...areas].map(([area, c]) => ({ area, ...c })).sort((a, b) => a.area < b.area ? -1 : 1);
  const overall = sourcesReason ?? reason;
  return { checkedAt: new Date().toISOString(), state: overall ? 'incomplete' : 'complete', ...(overall ? { reason: overall } : {}), sources,
    coverage: { state: reason ? 'incomplete' : 'complete', ...(reason ? { reason } : {}), files, uncited: byArea.reduce((n, a) => n + a.uncited, 0), byArea } };
}
