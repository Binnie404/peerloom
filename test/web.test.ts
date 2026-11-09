import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWeb, type WebHost } from '../core/web.ts';

// The page can approve commands, so the console's web server is a security boundary: only a page it served, on its
// own address, with the token it printed, may read the room or act on it. Item 17, brief section 3.
type Reply = { status: number; headers: IncomingMessage['headers']; text: string; json: any };
function call(port: number, method: string, path: string, options: { headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((ok, reject) => {
    const length = options.body === undefined ? {} : { 'content-length': String(Buffer.byteLength(options.body)) };
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...length, ...options.headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; });
      res.on('end', () => { let json: any; try { json = JSON.parse(text); } catch { /* not JSON */ } ok({ status: res.statusCode!, headers: res.headers, text, json }); });
    });
    req.on('error', reject); req.end(options.body);
  });
}
// An event stream, read as the page reads it: fetch-style, with the token and an optional Last-Event-ID.
function events(port: number, token: string, last?: number) {
  const seen: any[] = []; let res: IncomingMessage | undefined; let buffer = ''; const waits: (() => void)[] = [];
  const req = httpRequest({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, ...(last === undefined ? {} : { 'last-event-id': String(last) }) } }, r => {
    res = r; r.setEncoding('utf8');
    r.on('data', chunk => { buffer += chunk; let at: number;
      while ((at = buffer.indexOf('\n\n')) !== -1) { const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
        const id = block.match(/^id: (\d+)$/m); const data = block.match(/^data: (.*)$/m); if (data) seen.push({ id: id ? Number(id[1]) : undefined, ...JSON.parse(data[1]) }); }
      for (const wake of waits.splice(0)) wake(); });
    r.on('end', () => { for (const wake of waits.splice(0)) wake(); });
  });
  req.on('error', () => { /* ended by the test */ }); req.end();
  const until = async (count: number) => { const end = Date.now() + 3000; while (seen.length < count && Date.now() < end) await new Promise<void>(ok => { waits.push(ok); setTimeout(ok, 50); }); return seen; };
  return { seen, until, get response() { return res; }, close: () => req.destroy() };
}

function fixture(t: any, host: Partial<WebHost> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agentlink-web-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ui = join(dir, 'ui'); mkdirSync(ui);
  writeFileSync(join(ui, 'index.html'), '<!doctype html><title>room</title>'); writeFileSync(join(ui, 'app.js'), 'void 0;'); writeFileSync(join(ui, 'styles.css'), 'body{}');
  writeFileSync(join(dir, 'secret.json'), '{"token":"x"}');
  const calls: [string, any][] = [];
  const full: WebHost = { snapshot: async () => ({ defaults: { workspace: dir }, room: null }), action: async (path, body) => { calls.push([path, body]); return { done: path }; }, models: async kind => ({ models: kind === 'codex' ? [{ model: 'm1' }] : [] }), ...host };
  return { ui, calls, start: async () => { const web = await startWeb({ host: full, uiDir: ui }); t.after(() => web.close()); return { web, port: Number(new URL(web.origin).port) }; } };
}
const auth = (token: string, more: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...more });
const json = (token: string) => auth(token, { 'content-type': 'application/json' });

test('the page is served, and only its three files, with headers that keep it out of frames and caches', async t => {
  const { start } = fixture(t); const { web, port } = await start();
  assert.match(web.url, /^http:\/\/127\.0\.0\.1:\d+\/#k=[A-Za-z0-9_-]{43}$/);
  const page = await call(port, 'GET', '/');
  assert.equal(page.status, 200); assert.match(String(page.headers['content-type']), /^text\/html/); assert.equal(page.text, '<!doctype html><title>room</title>');
  assert.equal(page.headers['cache-control'], 'no-store'); assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/); assert.match(String(page.headers['content-security-policy']), /default-src 'none'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.match(String((await call(port, 'GET', '/app.js')).headers['content-type']), /^text\/javascript/);
  assert.match(String((await call(port, 'GET', '/styles.css')).headers['content-type']), /^text\/css/);
  for (const path of ['/index.html', '/../secret.json', '/%2e%2e/secret.json', '/secret.json', '/ui/app.js', '/app.js/']) assert.equal((await call(port, 'GET', path)).status, 404, path);
});

test('the page\'s two marks (dark and light) and its four self-hosted fonts are served at exact paths, and no other file under them', async t => {
  const { ui, start } = fixture(t); mkdirSync(join(ui, 'fonts'));
  writeFileSync(join(ui, 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>'); writeFileSync(join(ui, 'mark-light.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  for (const font of ['sora-500', 'sora-600', 'plex-mono-400', 'plex-mono-500']) writeFileSync(join(ui, 'fonts', `${font}.woff2`), 'wOF2');
  writeFileSync(join(ui, 'fonts', 'other.woff2'), 'wOF2');
  const { port } = await start();
  for (const path of ['/mark.svg', '/mark-light.svg']) { const mark = await call(port, 'GET', path); assert.equal(mark.status, 200, path); assert.equal(mark.headers['content-type'], 'image/svg+xml'); }
  for (const font of ['sora-500', 'sora-600', 'plex-mono-400', 'plex-mono-500']) { const got = await call(port, 'GET', `/fonts/${font}.woff2`); assert.equal(got.status, 200, font); assert.equal(got.headers['content-type'], 'font/woff2'); }
  assert.match(String((await call(port, 'GET', '/')).headers['content-security-policy']), /font-src 'self'/);
  for (const path of ['/fonts/other.woff2', '/fonts/', '/fonts/sora-500.woff', '/ui/mark.svg']) assert.equal((await call(port, 'GET', path)).status, 404, path);
});

test('the room is read only with the token the console printed', async t => {
  const { start } = fixture(t); const { web, port } = await start();
  assert.equal((await call(port, 'GET', '/api/state')).status, 401);
  assert.equal((await call(port, 'GET', '/api/state', { headers: auth('x'.repeat(43)) })).status, 401);
  const state = await call(port, 'GET', '/api/state', { headers: auth(web.token) });
  assert.equal(state.status, 200); assert.equal(state.headers['cache-control'], 'no-store'); assert.equal(state.json.room, null); assert.equal(state.json.eventId, 0); assert.ok(state.json.defaults.workspace);
  assert.deepEqual((await call(port, 'GET', '/api/models?kind=codex', { headers: auth(web.token) })).json, { models: [{ model: 'm1' }] });
  assert.deepEqual((await call(port, 'GET', '/api/models?kind=claude', { headers: auth(web.token) })).json, { models: [] });
});

test('another site, another host name or a cross-site fetch is refused even with the token', async t => {
  const { start, calls } = fixture(t); const { web, port } = await start();
  const refused = [
    { host: `localhost:${port}` }, { host: `evil.example:${port}` }, { host: '127.0.0.1' },
    { origin: 'http://evil.example' }, { origin: `http://localhost:${port}` }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
  ];
  for (const headers of refused) {
    assert.equal((await call(port, 'GET', '/api/state', { headers: auth(web.token, headers) })).status, 403, JSON.stringify(headers));
    assert.equal((await call(port, 'POST', '/api/send', { headers: { ...json(web.token), ...headers }, body: '{"text":"hi"}' })).status, 403, JSON.stringify(headers));
  }
  assert.equal((await call(port, 'GET', '/', { headers: { host: `evil.example:${port}` } })).status, 403);
  // The page's own requests carry its origin and same-origin; those pass.
  assert.equal((await call(port, 'POST', '/api/send', { headers: { ...json(web.token), origin: web.origin, 'sec-fetch-site': 'same-origin' }, body: '{"text":"hi"}' })).status, 200);
  assert.deepEqual(calls, [['send', { text: 'hi' }]]);
  assert.equal((await call(port, 'GET', '/api/state', { headers: { ...auth(web.token), 'access-control-request-method': 'POST' } })).headers['access-control-allow-origin'], undefined);
});

test('an action is passed to the console by name, and its refusal comes back with its own status and code', async t => {
  const reached: string[] = [];
  const { start } = fixture(t, { action: async (path, body) => { reached.push(path); if (path === 'run') { throw Object.assign(new Error('no_room: There is no room yet'), { status: 409, code: 'no_room' }); } if (path === 'boom') throw new Error('broken'); if (path === 'stale') throw Object.assign(new Error('stale_revision: The proposal changed'), { status: 409, code: 'stale_revision', detail: { latest: 2 } }); return { echoed: body }; } });
  const { web, port } = await start();
  const sent = await call(port, 'POST', '/api/agents/Codex/stop', { headers: json(web.token), body: '{}' });
  assert.equal(sent.status, 200); assert.deepEqual(sent.json, { ok: true, echoed: {} });
  const refused = await call(port, 'POST', '/api/run', { headers: json(web.token), body: '{"op":"start"}' });
  assert.equal(refused.status, 409); assert.deepEqual(refused.json, { ok: false, error: { code: 'no_room', message: 'There is no room yet' } });
  // A refusal's detail (the latest revision of a changed proposal) reaches the page with it.
  assert.deepEqual((await call(port, 'POST', '/api/stale', { headers: json(web.token), body: '{}' })).json, { ok: false, error: { code: 'stale_revision', message: 'The proposal changed', detail: { latest: 2 } } });
  const broken = await call(port, 'POST', '/api/boom', { headers: json(web.token), body: '{}' });
  assert.equal(broken.status, 500); assert.equal(broken.json.error.code, 'internal');
  assert.equal((await call(port, 'POST', '/api/send', { headers: auth(web.token, { 'content-type': 'text/plain' }), body: '{"text":"hi"}' })).status, 415);
  assert.equal((await call(port, 'POST', '/api/send', { headers: json(web.token), body: 'not json' })).status, 400);
  assert.equal((await call(port, 'POST', '/api/send', { headers: json(web.token), body: '[1]' })).status, 400);
  assert.equal((await call(port, 'POST', '/api/send', { headers: json(web.token), body: JSON.stringify({ text: 'x'.repeat(70 * 1024) }) })).status, 413);
  assert.equal((await call(port, 'GET', '/api/send', { headers: auth(web.token) })).status, 405);
  // Reads are GET and actions are POST, nothing else (GPT, 009-gpt): another method never reaches the console.
  for (const method of ['PUT', 'DELETE', 'PATCH']) { assert.equal((await call(port, method, '/api/send', { headers: json(web.token), body: '{"text":"hi"}' })).status, 405, method); assert.equal((await call(port, method, '/api/state', { headers: auth(web.token) })).status, 405, method); }
  assert.equal((await call(port, 'POST', '/api/state', { headers: json(web.token), body: '{}' })).status, 405);
  assert.equal((await call(port, 'POST', '/api/send', { headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  // Only the three well-formed calls reached the console; the hub's "code: " prefix is not shown to the human.
  assert.deepEqual(reached, ['agents/Codex/stop', 'run', 'stale', 'boom']);
});

test('events arrive in order with ids; a reconnect gets what it missed, and one from too long ago is told to reset', async t => {
  const { start } = fixture(t); const { web, port } = await start();
  web.emit({ type: 'notice', level: 'info', text: 'before anyone listened' });
  const first = events(port, web.token); t.after(first.close);
  await new Promise(ok => setTimeout(ok, 100));
  web.emit({ type: 'message', sequence: 1, text: 'one' }); web.emit({ type: 'message', sequence: 2, text: 'two' });
  assert.equal(first.response?.headers['content-type'], 'text/event-stream'); assert.equal(first.response?.headers['cache-control'], 'no-store');
  assert.deepEqual((await first.until(2)).map(e => [e.id, e.type, e.text]), [[2, 'message', 'one'], [3, 'message', 'two']]);
  first.close();
  web.emit({ type: 'message', sequence: 3, text: 'three' });
  const again = events(port, web.token, 3); t.after(again.close);
  assert.deepEqual((await again.until(1)).map(e => [e.id, e.text]), [[4, 'three']]);
  // The snapshot says which event it already includes, so the page reconnects from there.
  assert.equal((await call(port, 'GET', '/api/state', { headers: auth(web.token) })).json.eventId, 4);
  for (let n = 0; n < 1001; n += 1) web.emit({ type: 'notice', level: 'info', text: `n${n}` });
  const late = events(port, web.token, 3); t.after(late.close);
  assert.equal((await late.until(1))[0].type, 'reset');
  const ahead = events(port, web.token, 99_999); t.after(ahead.close);
  assert.equal((await ahead.until(1))[0].type, 'reset');
  assert.equal((await new Promise<Reply>(ok => { const req = httpRequest({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `127.0.0.1:${port}` } }, res => { res.resume(); ok({ status: res.statusCode!, headers: res.headers, text: '', json: null }); }); req.end(); })).status, 401);
});

test('closing the server ends open event streams instead of waiting for them', async t => {
  const { start } = fixture(t); const { web, port } = await start();
  const open = events(port, web.token); t.after(open.close);
  await new Promise(ok => setTimeout(ok, 100));
  const began = Date.now(); await web.close(); assert.ok(Date.now() - began < 1000, 'close returned promptly');
  await assert.rejects(call(port, 'GET', '/'));
});

test('the header shows the light mark in light mode at the dark mark\'s size, with no tile behind it', () => {
  const page = (file: string) => readFileSync(join(import.meta.dirname, '..', 'ui', file), 'utf8');
  const html = page('index.html'); const css = page('styles.css');
  assert.match(html, /<a class="brand"[^>]*><img class="mark-dark" src="\/mark\.svg" alt=""><img class="mark-light" src="\/mark-light\.svg" alt="">/);
  assert.match(css, /\.brand \.mark-light\{display:none\}/); assert.match(css, /:root\[data-theme=light\] \.brand \.mark-dark\{display:none\}/); assert.match(css, /:root\[data-theme=light\] \.brand \.mark-light\{display:block\}/);
  assert.doesNotMatch(css, /\.brand img\{[^}]*(background|padding)/); assert.doesNotMatch(css, /data-theme=light\] \.brand img\{/, 'no tile, no padding in light mode');
  const light = page('mark-light.svg'); assert.doesNotMatch(light, /<metadata>/, 'the changed copy does not carry the original\'s provenance manifest');
  assert.doesNotMatch(light, /stop-color="rgb\(9[5-9]\.\d+%, 9[5-9]\.\d+%, 100%\)"/, 'the white loop is ink, not white');
});
