import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Shared scaffolding for the item 24 join tests (slice B): the real console, its page, the agent's /j side and a real
// CLI credential. A join must never need a model, so nothing here opens a Claude or Codex turn.
export const repoRoot = resolve(import.meta.dirname, '..', '..');
export const cliPath = join(repoRoot, 'core/cli.ts');
export const shell: any = await import('../../core/shell.ts').then(module => module, () => null);
export const joinBackend: any = await import('../../core/join.ts').then(module => module, () => null);
// The one message every join test group skips with until the backend is on the branch that runs it.
export const joinSkip: false | string = shell?.ownerStore && joinBackend?.joinService ? false : 'the item 24 join backend is not on this branch yet';

process.env.AGENTLINK_HOME = realpathSync(mkdtempSync(join(tmpdir(), 'peerloom-join-home-')));

export const until = async <T>(found: () => T | Promise<T>, what: string, ms = 15_000): Promise<NonNullable<T>> => {
  for (let waited = 0; waited < ms; waited += 25) { const value = await found(); if (value) return value as NonNullable<T>; await new Promise(ok => setTimeout(ok, 25)); }
  throw new Error(`Timed out waiting for ${what}`);
};

const harnesses: any = await import('../../core/harnesses.ts');
if (!harnesses.harnessOf('fakeext')) harnesses.registerHarness({ id: 'fakeext', label: 'Fake External', hubName: 'fake-ext', routes: ['external'], wake: { external: 'self-arming' }, approvals: 'none', detect: { bin: '', version: [] }, probe: { date: '2026-10-26T00:00:00.000Z', version: 'test', ok: true, evidence: ['a test descriptor'] } });

export function console_(t: { after(fn: () => unknown): void }, options: { now?: () => number; dir?: string } = {}) {
  const dir = options.dir ?? realpathSync(mkdtempSync(join(tmpdir(), 'peerloom-join-e2e-'))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ui = join(dir, 'ui-assets'); mkdirSync(ui, { recursive: true });
  writeFileSync(join(ui, 'index.html'), '<!doctype html><title>room</title>'); writeFileSync(join(ui, 'app.js'), ''); writeFileSync(join(ui, 'styles.css'), '');
  const input = new PassThrough(); let text = '';
  const output = Object.assign(new PassThrough(), { isTTY: false, columns: 100 }); output.on('data', chunk => { text += String(chunk); });
  const done = shell.runShell({ cwd: dir, input, output, uiDir: ui, pollMs: 60, waitSeconds: 30, controlIntervalMs: 100, ...(options.now ? { now: options.now } : {}) });
  t.after(async () => { input.end(); await Promise.race([done.catch(() => {}), new Promise(ok => setTimeout(ok, 5000))]); });
  return { dir, input, done, get text() { return text; } };
}

export async function page(c: ReturnType<typeof console_>) {
  const url = new URL((await until(() => /Page: (http:\/\/127\.0\.0\.1:\d+\/#k=\S+)/.exec(c.text), 'the page address'))[1]);
  const token = url.hash.slice('#k='.length); const port = Number(url.port); const host = `127.0.0.1:${port}`;
  const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; json: any }>((ok, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { host, authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }, res => {
      let reply = ''; res.setEncoding('utf8'); res.on('data', d => { reply += d; }); res.on('end', () => { let json: any; try { json = JSON.parse(reply); } catch { json = undefined; } ok({ status: res.statusCode!, json }); }); });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body)); });
  const events: any[] = [];
  const stream = httpRequest({ host: '127.0.0.1', port, path: '/api/events', headers: { host, authorization: `Bearer ${token}` } }, res => {
    let buffer = ''; res.setEncoding('utf8'); res.on('data', chunk => { buffer += chunk; let at; while ((at = buffer.indexOf('\n\n')) !== -1) { const data = /^data: (.*)$/m.exec(buffer.slice(0, at)); buffer = buffer.slice(at + 2); if (data) events.push(JSON.parse(data[1])); } }); });
  stream.on('error', () => {}); stream.end();
  return { call, events, state: async () => (await call('GET', '/api/state')).json, port, host, token, close: () => stream.destroy() };
}

// The agent's side of /j: raw HTTP, no page token and none of the page's headers.
export function raw(port: number, host: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; json: any; text: string; headers: any }>((ok, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { host, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', d => { text += d; }); res.on('end', () => { let json: any; try { json = JSON.parse(text); } catch { json = undefined; } ok({ status: res.statusCode!, json, text, headers: res.headers }); }); });
    req.on('error', reject); req.end(payload);
  });
}

// A console command as an agent runs it, from the room folder so any profile the console writes is found.
export function runCli(args: string[], options: { cwd?: string; timeoutMs?: number } = {}) {
  return new Promise<{ code: number | null; text: string; child: ReturnType<typeof spawn> }>(ok => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: options.cwd ?? repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; child.stdout.on('data', d => { text += d; }); child.stderr.on('data', d => { text += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 20_000);
    child.once('exit', code => { clearTimeout(timer); ok({ code, text, child }); });
  });
}
