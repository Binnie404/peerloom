// The harnesses Peerloom can put in a room (item 23). One descriptor per coding agent; the console reads the
// descriptor instead of branching on a hardcoded kind. The hub never learns any of this: a harness's `hubName` is what
// the participant's free-text `harness` field receives, and identity remains the participant name.
//
// Two rules matter more than the rest:
//   - `probe` records what was actually observed on a real machine, with the version and the date. `enabled` is exactly
//     `probe.ok`; a harness without a passing probe stays disabled and is refused rather than guessed at.
//   - `wake` is per route, because the route is the difference that matters: `hosted` (the console owns bind/wait and
//     gives the model a turn), `self-arming` (the agent owns bind/wait and its harness re-invokes it when the background
//     command ends), `in-turn` (the agent holds a wait and polls it inside one turn).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Route = 'owned' | 'terminal' | 'app' | 'external';
export type Wake = 'hosted' | 'self-arming' | 'in-turn';
export type Probe = { date: string; version: string; ok: boolean; evidence: string[]; missing?: string };
export type Harness = {
  id: string;                        // the stored `kind` value in shell.json
  label: string;                     // what the human sees
  hubName: string;                   // the participant's harness field at the hub (free text)
  routes: Route[];                   // where it can run, in the invite form's order
  wake: Partial<Record<Route, Wake>>; // how a turn starts on each route
  host?: 'claude' | 'codex';         // the owned route only: which existing host class runs it
  approvals: 'relay' | 'native' | 'none'; // relay: the console answers; native: the harness's own prompts; none: neither
  detect: { bin: string; version: string[] };
  probe: Probe;
  source?: 'built-in' | 'user'; // user: from the user-level registry file (see loadUserHarnesses)
};

const AT = '2026-10-26T13:20:00.000Z';

// The registry. Order is the order the invitation form offers them. The ids are the values already stored in
// shell.json (`claude`, `codex`), so no store or config rewrite is needed for the two that exist.
const REGISTRY: Harness[] = [
  {
    id: 'claude', label: 'Claude Code', hubName: 'claude-code',
    routes: ['owned', 'terminal', 'app'], wake: { owned: 'hosted', terminal: 'self-arming', app: 'self-arming' },
    host: 'claude', approvals: 'relay', detect: { bin: 'claude', version: ['--version'] },
    probe: {
      date: AT, version: '2.1.295', ok: true,
      evidence: [
        'the console launches /opt/homebrew/bin/claude 2.1.295 in the real runs of items 17, 21 and 22',
        '~/.local/bin/claude 2.1.294 is what an interactive PATH finds first; its --version exits 0 with stdin closed',
        'terminal and app routes run for real in items 15 and 16; the owned host in item 17',
      ],
    },
  },
  {
    id: 'codex', label: 'Codex', hubName: 'codex',
    routes: ['owned', 'app'], wake: { owned: 'hosted', app: 'in-turn' },
    host: 'codex', approvals: 'native', detect: { bin: 'codex', version: ['--version'] },
    probe: {
      date: AT, version: '0.160.0', ok: true,
      evidence: [
        'adapter and app routes run for real in items 16 to 18',
        '--version exits 0 with stdin closed on 26 October 2026',
      ],
    },
  },
  {
    id: 'dsh', label: 'DeepSeek Harness', hubName: 'dsh',
    routes: ['external'], wake: { external: 'self-arming' },
    approvals: 'none', detect: { bin: '', version: [] },
    // Filled by the idle-wake probe (log/005-opus.md, step 1). Until it passes, DSH is disabled: the route is written
    // but not observed.
    probe: {
      date: '2026-10-26T13:24:34.475Z', version: 'DSH chat (this session)', ok: true,
      evidence: [
        'an idle session was woken by a background job that printed after 12 s and exited 0, with no human message (13:24:34Z)',
        'the wake arrives as an in-session completion message; the job output is read with the job tool',
        'a self-arming wait uses the same path: the job is the wait, and its exit 0 prints the wake ID',
        'live room "Item 23 real run" on 26 October 2026: an external session answered a human broadcast, a human direct message and a Codex peer message as three separate wakes, then acknowledged a Codex summary without replying',
        'the same console showed it as "dsh · its own harness · its own session · armed" and refused /kill; 3 peer offers were used',
      ],
    },
  },
  {
    // The Cursor app's agent (item 25), whatever model it runs. It has no CLI of ours to probe; its route, wake and
    // approvals are observed by hand in a real Cursor session. Disabled until that probe passes.
    id: 'cursor', label: 'Cursor', hubName: 'cursor',
    routes: ['external'], wake: { external: 'self-arming' },
    approvals: 'native', detect: { bin: '', version: [] },
    probe: { date: '2026-10-31T14:31:53.867Z', version: 'Cursor app (version not recorded), agent model Grok 4.7', ok: true, evidence: [
      'a Cursor agent session started `sleep 25; echo CURSOR-WAKE-DONE` with its terminal tool in the background and ended its turn',
      'with no human message, Cursor gave the agent a new turn when the command ended (exit 0 at 14:31:53.867Z); it answered WOKE-BY-ITSELF at 14:32 UTC',
      'not yet observed: peerloom on the agent PATH, writes under the workspace .agentlink, and Cursor approval prompts; the first live join is that check',
    ] },
  },
  {
    id: 'gemini', label: 'Gemini CLI', hubName: 'gemini',
    routes: ['external'], wake: { external: 'self-arming' },
    approvals: 'none', detect: { bin: 'gemini', version: ['--version'] },
    probe: {
      date: AT, version: 'unknown', ok: false,
      evidence: ['installed on 26 October 2026; --version exits 0 with no output when stdin is closed, so it is not a usable version probe'],
      missing: 'route unprobed: run the checklist in docs/HARNESSES.md before enabling',
    },
  },
  {
    id: 'kimi', label: 'Kimi CLI', hubName: 'kimi',
    routes: ['external'], wake: { external: 'self-arming' },
    approvals: 'none', detect: { bin: 'kimi', version: ['--version'] },
    probe: { date: AT, version: '', ok: false, evidence: ['not installed: no kimi on PATH on 26 October 2026'], missing: 'not installed' },
  },
  {
    id: 'glm', label: 'GLM CLI', hubName: 'glm',
    routes: ['external'], wake: { external: 'self-arming' },
    approvals: 'none', detect: { bin: 'glm', version: ['--version'] },
    probe: { date: AT, version: '', ok: false, evidence: ['not installed: no glm on PATH on 26 October 2026'], missing: 'not installed' },
  },
];

export const HARNESSES: readonly Harness[] = REGISTRY;

export function harnessOf(id: string | null | undefined): Harness | undefined {
  return id ? REGISTRY.find(h => h.id === id) : undefined;
}

// What the page may render: no functions, no host paths, no credentials.
export function harnessList() {
  return REGISTRY.map(h => ({ id: h.id, label: h.label, routes: [...h.routes], enabled: h.probe.ok, reason: h.probe.ok ? null : (h.probe.missing ?? 'unprobed'), source: h.source ?? 'built-in' }));
}

// Tests add a fake harness here, so a descriptor that exists only in a test runs through the real console unchanged.
// Registering an id twice is a mistake, not a replacement.
export function registerHarness(h: Harness): Harness {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(h.id)) throw new Error('A harness id is lower-case letters, digits and -, at most 32');
  if (!h.label.trim() || !h.hubName.trim()) throw new Error('A harness needs a label and a hub name');
  if (!h.routes.length || h.routes.some(route => !['owned', 'terminal', 'app', 'external'].includes(route))) throw new Error('A harness names at least one known route');
  for (const route of h.routes) if (!h.wake[route]) throw new Error(`The ${route} route needs a wake mode`);
  if (h.routes.includes('owned') && !h.host) throw new Error('An owned route needs a host class');
  if (REGISTRY.some(existing => existing.id === h.id)) throw new Error(`${h.id} is already registered`);
  REGISTRY.push({ ...h, routes: [...h.routes], wake: { ...h.wake }, probe: { ...h.probe, evidence: [...h.probe.evidence] } });
  return h;
}

// ── The user-level registry ──
// A harness that is not in this file can still be added without editing it: a JSON file of external harnesses, read
// once when this module loads. Only the external route is data (a hosted harness needs a host class), so every entry
// is external, with its own wake and probe. A built-in id always wins; a bad entry is skipped and said, never guessed
// at; a bad file adds nothing. The file is the user's own, so this is configuration, not a trust boundary.
//
//   { "version": 1, "harnesses": [ { "id": "mycli", "label": "My CLI", "wake": "self-arming", "approvals": "none",
//       "detect": { "bin": "mycli", "version": ["--version"] },
//       "probe": { "date": "2026-11-06", "version": "mycli 1.2.3", "ok": true, "evidence": ["what you saw"] } } ] }
//
// Where: PEERLOOM_HARNESSES names the file (set it empty to read none); otherwise $AGENTLINK_HOME/harnesses.json, or
// ~/.agentlink/harnesses.json.
export function userRegistryPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.PEERLOOM_HARNESSES !== undefined) return env.PEERLOOM_HARNESSES === '' ? null : env.PEERLOOM_HARNESSES;
  return join(env.AGENTLINK_HOME || join(homedir(), '.agentlink'), 'harnesses.json');
}

export type UserRegistry = { path: string | null; loaded: string[]; errors: string[] };
let userRegistry: UserRegistry = { path: null, loaded: [], errors: [] };
// What the last load found: the file, the ids it added, and one line per problem (shown by the console and the CLI).
export const userHarnesses = (): UserRegistry => ({ path: userRegistry.path, loaded: [...userRegistry.loaded], errors: [...userRegistry.errors] });

const ENTRY_KEYS = ['id', 'label', 'hubName', 'wake', 'approvals', 'detect', 'probe'];
const PROBE_KEYS = ['date', 'version', 'ok', 'evidence', 'missing'];
const line = (value: unknown, most: number) => typeof value === 'string' && value.trim() !== '' && value.length <= most && !/[\u0000-\u001f\u007f]/.test(value);

function userEntry(raw: any, at: number): Harness {
  const where = `entry ${at + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where} is not an object`);
  const extra = Object.keys(raw).filter(key => !ENTRY_KEYS.includes(key)); if (extra.length) throw new Error(`${where} has unknown keys: ${extra.join(', ')}`);
  if (typeof raw.id !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(raw.id)) throw new Error(`${where}: id is 2–32 lower-case letters, digits and -, starting with a letter`);
  const name = `${where} (${raw.id})`;
  if (!line(raw.label, 60)) throw new Error(`${name}: label is one line of at most 60 characters`);
  const hubName = raw.hubName ?? raw.id; if (typeof hubName !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(hubName)) throw new Error(`${name}: hubName is like an id`);
  if (raw.wake !== 'self-arming' && raw.wake !== 'in-turn') throw new Error(`${name}: wake is "self-arming" or "in-turn"`);
  const approvals = raw.approvals ?? 'none'; if (approvals !== 'none' && approvals !== 'native') throw new Error(`${name}: approvals is "none" or "native"`);
  const detect = raw.detect ?? { bin: '', version: [] };
  if (!detect || typeof detect !== 'object' || typeof detect.bin !== 'string' || !/^[A-Za-z0-9._-]{0,64}$/.test(detect.bin) || !Array.isArray(detect.version) || detect.version.length > 4 || !detect.version.every((arg: unknown) => line(arg, 40)) || Object.keys(detect).some(key => key !== 'bin' && key !== 'version'))
    throw new Error(`${name}: detect is { "bin": a command name, "version": up to four arguments }`);
  const probe = raw.probe;
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) throw new Error(`${name}: probe is required: what you saw it do, with a date and a version`);
  const stray = Object.keys(probe).filter(key => !PROBE_KEYS.includes(key)); if (stray.length) throw new Error(`${name}: probe has unknown keys: ${stray.join(', ')}`);
  if (typeof probe.ok !== 'boolean') throw new Error(`${name}: probe.ok is true or false`);
  if (!line(probe.date, 40) || Number.isNaN(Date.parse(probe.date))) throw new Error(`${name}: probe.date is a date, such as 2026-11-06`);
  if (typeof probe.version !== 'string' || probe.version.length > 120 || /[\u0000-\u001f\u007f]/.test(probe.version)) throw new Error(`${name}: probe.version is one line`);
  if (!Array.isArray(probe.evidence) || probe.evidence.length > 20 || !probe.evidence.every((item: unknown) => line(item, 500))) throw new Error(`${name}: probe.evidence is a list of up to 20 lines`);
  if (probe.ok && !probe.evidence.length) throw new Error(`${name}: an enabled harness (probe.ok true) needs at least one line of evidence`);
  if (!probe.ok && !line(probe.missing, 200)) throw new Error(`${name}: a disabled harness (probe.ok false) says why in probe.missing`);
  return { id: raw.id, label: raw.label, hubName, routes: ['external'], wake: { external: raw.wake }, approvals, detect: { bin: detect.bin, version: [...detect.version] },
    probe: { date: new Date(probe.date).toISOString(), version: probe.version, ok: probe.ok, evidence: [...probe.evidence], ...(probe.ok ? {} : { missing: probe.missing }) }, source: 'user' };
}

// Reads one registry file and adds its valid entries. A missing file is not an error. Returns what it did.
export function loadUserHarnesses(path: string | null = userRegistryPath()): UserRegistry {
  const found: UserRegistry = { path, loaded: [], errors: [] };
  if (!path) return (userRegistry = found);
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') found.errors.push(`${path} could not be read: ${error.code ?? error.message}`); return (userRegistry = found); }
  let file: any; try { file = JSON.parse(text); } catch (error: any) { found.errors.push(`${path} is not valid JSON: ${error.message}`); return (userRegistry = found); }
  if (!file || typeof file !== 'object' || file.version !== 1 || !Array.isArray(file.harnesses) || Object.keys(file).some(key => key !== 'version' && key !== 'harnesses')) {
    found.errors.push(`${path} must be { "version": 1, "harnesses": [ … ] }`); return (userRegistry = found);
  }
  if (file.harnesses.length > 50) { found.errors.push(`${path} lists more than 50 harnesses`); return (userRegistry = found); }
  file.harnesses.forEach((raw: unknown, at: number) => {
    try {
      const entry = userEntry(raw, at);
      const taken = REGISTRY.find(existing => existing.id === entry.id);
      if (taken) throw new Error(`${entry.id} is already ${taken.source === 'user' ? 'listed earlier in this file' : 'a built-in harness'}; it was skipped`);
      REGISTRY.push(entry); found.loaded.push(entry.id);
    } catch (error: any) { found.errors.push(`${path}: ${error.message}`); }
  });
  return (userRegistry = found);
}
loadUserHarnesses();
