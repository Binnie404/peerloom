// A private Codex app-server, never the user's shared daemon. JSONL only;
// callers retain request IDs and make every approval decision explicitly.
import { EventEmitter } from 'node:events';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

export class UnsupportedCodex extends Error {}
export type NativeMessage = { id?: string | number; method?: string; params?: any; result?: any; error?: { code?: number; message?: string } };
export type SchemaEvidence = { version: string; digest: string; toolOutput: true };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Native errors may contain plugin output or secrets. Keep arbitrary text private, but recognise the measured
// archived-thread refusal and construct its remedy from our own validated request id, never from server text.
export class CodexRequestError extends Error {
  readonly method: string;
  readonly code: number | null;
  readonly archivedThreadId?: string;
  constructor(method: string, error: NativeMessage['error'], threadId?: string) {
    const safeMethod = /^[A-Za-z][A-Za-z0-9_/]{0,79}$/.test(method) ? method : 'unknown';
    const code = Number.isSafeInteger(error?.code) ? error!.code! : null;
    const archived = safeMethod === 'thread/resume' && code === -32600 && typeof threadId === 'string' && UUID.test(threadId) &&
      typeof error?.message === 'string' && error.message.startsWith(`session ${threadId} is archived.`);
    super(archived
      ? `Codex refused thread/resume (-32600): saved session ${threadId} is archived. Run \`codex unarchive ${threadId}\`, then relaunch this agent; no automatic retry`
      : `Native request failed (${code ?? 'unknown'}) during ${safeMethod}; no automatic retry`);
    this.name = 'CodexRequestError'; this.method = safeMethod; this.code = code;
    if (archived) this.archivedThreadId = threadId;
  }
}
const execute = promisify(execFile);
const requiredMethods = ['initialize', 'thread/start', 'thread/resume', 'thread/read', 'turn/start', 'turn/interrupt'];
const requiredNotifications = ['turn/started', 'turn/completed', 'item/completed', 'serverRequest/resolved'];

// Check the installed binary's interface before creating a thread or binding.
// This is a structural gate, not proof that a model consumes the notice.
export function inspectSchema(files: Record<string, any>): void {
  const methods = (s: any) => new Set((s?.oneOf ?? []).flatMap((v: any) => v.properties?.method?.enum ?? []));
  const client = methods(files['ClientRequest']); const notices = methods(files['ServerNotification']);
  const turn = files['v2/TurnStartParams']; const tool = turn?.definitions?.TurnToolOutput;
  const thread = files['v2/ThreadStartParams'];
  if (requiredMethods.some(m => !client.has(m)) || requiredNotifications.some(m => !notices.has(m)) ||
      !turn?.required?.includes('threadId') || !turn?.required?.includes('input') || turn.properties?.input?.type !== 'array' ||
      !(JSON.stringify(turn.properties?.toolOutput) ?? '').includes('#/definitions/TurnToolOutput') ||
      !tool?.required?.includes('name') || !tool?.required?.includes('output') || tool.properties?.name?.type !== 'string' ||
      !turn.definitions?.FunctionCallOutputBody?.anyOf?.some((v: any) => v.type === 'string') ||
      !thread?.properties?.approvalPolicy || !thread?.properties?.approvalsReviewer || !thread?.properties?.sandbox) {
    throw new UnsupportedCodex('Installed Codex lacks the required exact-thread tool-output, permission or lifecycle interface');
  }
}

export async function probeCodex(binary = 'codex'): Promise<SchemaEvidence> {
  const directory = await mkdtemp(join(tmpdir(), 'peerloom-native-schema-'));
  try {
    const version = (await execute(binary, ['--version'], { timeout: 15_000, maxBuffer: 32_768 })).stdout.trim();
    await execute(binary, ['app-server', 'generate-json-schema', '--out', directory], { timeout: 30_000, maxBuffer: 1_048_576 });
    const files: Record<string, any> = {}; const digest = createHash('sha256');
    for (const name of ['ClientRequest', 'ServerNotification', 'v2/TurnStartParams', 'v2/ThreadStartParams']) {
      const bytes = await readFile(join(directory, `${name}.json`)); digest.update(name).update(bytes); files[name] = JSON.parse(bytes.toString());
    }
    inspectSchema(files);
    return { version, digest: digest.digest('hex'), toolOutput: true };
  } catch (error) {
    if (error instanceof UnsupportedCodex) throw error;
    throw new UnsupportedCodex('Could not validate the installed Codex protocol; no thread or binding was created');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export class CodexRpc extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  connected = true;
  private serial = 0;
  private buffer = '';
  private pending = new Map<number, { method: string; threadId?: string; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private requests = new Map<string | number, NativeMessage>();
  private finishExit!: () => void;
  private closing?: Promise<void>;

  constructor(options: { binary?: string; cwd?: string; args?: string[]; env?: NodeJS.ProcessEnv } = {}) {
    super();
    this.exited = new Promise(resolve => { this.finishExit = resolve; });
    this.child = spawn(options.binary ?? 'codex', options.args ?? ['app-server', '--listen', 'stdio://'], {
      cwd: options.cwd, env: options.env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.receive(chunk));
    this.child.stdout.on('end', () => { this.disconnect('Native output closed'); void this.close(); });
    this.child.stdout.on('error', () => { this.disconnect('Native output failed'); void this.close(); });
    // Stderr can contain arbitrary native/plugin data. Drain without publishing it.
    this.child.stderr.resume();
    this.child.on('error', () => this.disconnect('Native app-server could not start'));
    this.child.on('exit', () => { this.disconnect('Native app-server exited'); void this.close(); });
    this.child.on('close', () => { this.disconnect('Native app-server disconnected'); this.finishExit(); });
    this.child.stdin.on('error', () => this.disconnect('Native app-server input closed'));
  }

  private disconnect(reason: string) {
    if (!this.connected) return;
    this.connected = false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear(); this.requests.clear();
    this.emit('disconnected', reason);
  }

  private receive(chunk: string) {
    if (!this.connected) return;
    this.buffer += chunk;
    if (this.buffer.length > 16_777_216) { this.disconnect('Native protocol line exceeded its size limit'); void this.close(); return; }
    let at: number;
    while ((at = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1);
      if (!line.trim()) continue;
      let message: NativeMessage;
      try { message = JSON.parse(line); } catch { this.disconnect('Malformed native JSONL'); void this.close(); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { this.disconnect('Malformed native message'); void this.close(); return; }
      if (typeof message.method === 'string') {
        if (message.id !== undefined) {
          if (!['string', 'number'].includes(typeof message.id) || this.requests.has(message.id)) {
            this.disconnect('Duplicate or invalid native request ID'); void this.close(); return;
          }
          this.requests.set(message.id, message); this.emit('request', message);
        } else this.emit('notification', message);
      } else {
        const p = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
        if (!p) { this.disconnect('Unmatched native response'); void this.close(); return; }
        this.pending.delete(message.id as number); clearTimeout(p.timer);
        if (message.error) p.reject(new CodexRequestError(p.method, message.error, p.threadId));
        else if (Object.hasOwn(message, 'result')) p.resolve(message.result);
        else { p.reject(new Error('Malformed native response')); this.disconnect('Malformed native response'); void this.close(); return; }
      }
    }
  }

  private write(message: NativeMessage) {
    if (!this.connected) throw new Error('Native app-server is disconnected');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: any = {}, timeoutMs = 30_000): Promise<any> {
    if (!this.connected) return Promise.reject(new Error('Native app-server is disconnected'));
    if (this.pending.size >= 100) return Promise.reject(new Error('Too many pending native requests'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A late turn/start could already have caused inference. Never retry it.
        this.pending.delete(id); reject(new Error(`Native ${method} timed out; outcome may be ambiguous`));
        this.disconnect('Native request timed out'); void this.close();
      }, timeoutMs);
      this.pending.set(id, { method, ...(typeof params?.threadId === 'string' && UUID.test(params.threadId) ? { threadId: params.threadId } : {}), resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method: string, params?: any) { this.write({ method, ...(params === undefined ? {} : { params }) }); }
  respond(id: string | number, result: any) {
    if (!this.requests.has(id)) throw new Error('Unknown or already resolved native request');
    this.write({ id, result }); this.requests.delete(id);
  }
  forgetRequest(id: string | number) { this.requests.delete(id); }

  async initialize() {
    const initialized = await this.request('initialize', {
      clientInfo: { name: 'agentlink_native_adapter', title: 'Peerloom', version: '0.1.0' },
    });
    this.notify('initialized'); return initialized;
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.child.stdin.end();
      const signal = (kind: NodeJS.Signals) => {
        if (!this.child.pid) return;
        try { process.kill(process.platform === 'win32' ? this.child.pid : -this.child.pid, kind); } catch (e: any) { if (e.code !== 'ESRCH') throw e; }
      };
      const gentle = setTimeout(() => signal('SIGTERM'), 500);
      const force = setTimeout(() => signal('SIGKILL'), 2500);
      try { await this.exited; } finally { clearTimeout(gentle); clearTimeout(force); }
    })();
  }
}
