import { createInterface, emitKeypressEvents } from 'node:readline';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { NativeAdapter, type AdapterDependencies } from './codex-adapter.ts';
import { UnsupportedCodex } from './codex-rpc.ts';

export const usage = 'node core/codex-adapter-cli.ts --client FILE --participant NAME --room NAME [--resume] [--notify] [--wait-seconds 3300] [--codex PATH] [--cwd DIR]';
export function parseOptions(args: string[]) {
  const allowed = new Set(['client', 'participant', 'room', 'cwd', 'codex', 'wait-seconds']);
  const flags: Record<string, string> = {}; let resume = false; let notify = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--resume') { if (resume) throw new Error('Duplicate --resume'); resume = true; continue; }
    if (args[i] === '--notify') { if (notify) throw new Error('Duplicate --notify'); notify = true; continue; }
    const name = args[i].slice(2);
    if (!args[i].startsWith('--') || !allowed.has(name) || flags[name] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unknown, repeated or missing option');
    flags[name] = args[++i];
  }
  for (const name of ['client', 'participant', 'room']) if (!flags[name]) throw new Error(`--${name} is required`);
  return { clientPath: flags.client, participant: flags.participant, room: flags.room, cwd: flags.cwd, codex: flags.codex, resume, notify,
    waitSeconds: flags['wait-seconds'] === undefined ? undefined : Number(flags['wait-seconds']) };
}

type Launch = ReturnType<typeof parseOptions>;
const quote = (text: string) => /^[A-Za-z0-9_\/.:=@%+-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
// The exact command that takes this session up again, so a stop never leaves the human reconstructing it.
export const resumeCommand = (o: Launch) => ['node', 'core/codex-adapter-cli.ts', '--client', o.clientPath, '--participant', o.participant, '--room', o.room,
  ...(o.cwd ? ['--cwd', o.cwd] : []), ...(o.codex ? ['--codex', o.codex] : []), ...(o.waitSeconds !== undefined ? ['--wait-seconds', String(o.waitSeconds)] : []), ...(o.notify ? ['--notify'] : []), '--resume'].map(quote).join(' ');

// A pending native approval stalls delivery until the human answers, so it is announced: always a bell and a line
// on stderr, and with --notify a desktop notification. The notification names no command: that text is the model's.
export function announceApproval(id: string | number, notify: boolean, run: (command: string, args: string[]) => void = (command, args) => { spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); }, platform = process.platform) {
  const shown = String(id).replace(/[^A-Za-z0-9_.:-]/g, '?').slice(0, 64);
  process.stderr.write(`\x07Approval needed: read the native_request event with id ${shown}, then type "accept ${shown}" or "decline ${shown}".\n`);
  if (notify && platform === 'darwin') run('osascript', ['-e', `display notification "Codex is waiting for your approval (request ${shown})." with title "Peerloom"`]);
}

// The adapter changes no Codex setting, but Codex itself may rewrite its configuration while it runs. A private
// copy taken before launch lets a changed hash be diffed afterwards instead of merely noticed. Read-only on Codex.
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
export const codexConfigPath = () => join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
export function snapshotConfig(clientPath: string, source = codexConfigPath()) {
  if (!existsSync(source)) return null;
  const snapshot = `${clientPath}.codex-config.before.toml`; copyFileSync(source, snapshot); chmodSync(snapshot, 0o600);
  return { source, snapshot, sha256: digest(snapshot) };
}
export function compareConfig(taken: NonNullable<ReturnType<typeof snapshotConfig>>) {
  const after = existsSync(taken.source) ? digest(taken.source) : null;
  return { changed: after !== taken.sha256, before: taken.sha256, after, ...(after !== taken.sha256 ? { diff: `diff ${quote(taken.snapshot)} ${quote(taken.source)}` } : {}) };
}

export async function main(args: string[], dependencies?: AdapterDependencies) {
  const options = parseOptions(args);
  const emit = (event: any) => process.stdout.write(`${JSON.stringify(event)}\n`);
  let config: ReturnType<typeof snapshotConfig> = null;
  const { notify, ...launch } = options;
  const adapter: NativeAdapter = new NativeAdapter({ ...launch, onEvent: event => {
    emit(event);
    if (event.event === 'native_request') announceApproval(event.id, notify);
    if (event.event === 'stopped') {
      if (config) emit({ at: new Date().toISOString(), event: 'codex_config', ...compareConfig(config) });
      // Only a saved registration can be resumed; a refused opening or an unsupported CLI needs a fresh launch.
      if (existsSync(adapter.statePath)) process.stderr.write(`Stopped: ${event.reason}\nAfter inspecting why, resume this same session with:\n  ${resumeCommand(options)}\n`);
      else process.stderr.write(`Stopped: ${event.reason}\nNo registration was saved, so there is nothing to resume.\n`);
    }
  } });
  try { config = snapshotConfig(adapter.clientPath); if (config) emit({ at: new Date().toISOString(), event: 'codex_config_snapshot', sha256: config.sha256, snapshot: config.snapshot }); }
  catch { emit({ at: new Date().toISOString(), event: 'codex_config_snapshot', error: 'the Codex configuration could not be copied; continuing without a snapshot' }); }
  const input = createInterface({ input: process.stdin, output: process.stderr, terminal: !!process.stdin.isTTY });
  let finishing = false;
  const report = () => process.stderr.write('Input refused. Use say TEXT, accept ID, decline ID, cancel ID, stop, or JSON {type:reply,id,result}/{type:draft,present}/{type:input,text}.\n');
  const id = (text: string) => /^\d+$/.test(text) ? Number(text) : text;
  const handle = (line: string) => {
    adapter.setDraft(false);
    try {
      if (line === 'stop') { void adapter.halt('Stopped by human', true); return; }
      if (line.startsWith('say ') && line.length > 4) { void adapter.submit(line.slice(4)).catch(report); return; }
      const approval = /^(accept|decline|cancel) (\S+)$/.exec(line);
      if (approval) { adapter.reply(id(approval[2]), { decision: approval[1] }); return; }
      const message = JSON.parse(line);
      if (message.type === 'draft' && typeof message.present === 'boolean') adapter.setDraft(message.present);
      else if (message.type === 'input' && typeof message.text === 'string') void adapter.submit(message.text).catch(report);
      else if (message.type === 'reply' && ['number', 'string'].includes(typeof message.id)) adapter.reply(message.id, message.result);
      else if (message.type === 'stop') void adapter.halt('Stopped by human', true);
      else report();
    } catch { report(); }
  };
  input.on('line', handle);
  const key = () => { queueMicrotask(() => { if (!finishing) adapter.setDraft(input.line.length > 0); }); };
  if (process.stdin.isTTY) { emitKeypressEvents(process.stdin, input); process.stdin.on('keypress', key); }
  const disconnected = () => { if (!finishing) void adapter.halt('Human input channel closed; no native approval was granted', true); };
  input.on('close', disconnected);
  const interrupted = () => { void adapter.halt('Stopped by human', true); };
  process.on('SIGINT', interrupted); process.on('SIGTERM', interrupted);
  try { await adapter.start(dependencies); const result = await adapter.finished; if (result.reason !== 'Stopped by human') process.exitCode = 1; }
  catch (error) { process.exitCode = error instanceof UnsupportedCodex ? 2 : 1; }
  finally {
    finishing = true; input.off('close', disconnected); input.close(); process.stdin.off('keypress', key);
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  if (process.argv.includes('--help')) console.log(`${usage}\nNative approvals are answered explicitly; the host never approves them automatically.`);
  else await main(process.argv.slice(2)).catch((error: any) => {
    const reason = error instanceof SyntaxError ? 'Invalid credential or options JSON; inspect it locally' : String(error?.message ?? 'Adapter could not start').replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]');
    console.error(`${reason}\n${usage}`); process.exitCode = 1;
  });
}
