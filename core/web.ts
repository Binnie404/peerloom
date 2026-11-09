import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The console's own web server for the browser page (item 17, brief section 3). The page can approve what an agent
// runs, so this is a boundary: only this exact address, only the page's own requests, only with the token the
// console printed. It holds no hub credential; what it reads and does is whatever the console's host does.
export type WebHost = {
  snapshot(): Promise<Record<string, unknown>>;
  action(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | void>;
  models(kind: string | null): Promise<Record<string, unknown>>;
  // The join route (item 24): what a session holding a join line asks, before it has any credential.
  join?: { help(origin: string, path: string): string; act(op: 'claim' | 'poll', ticket: string, body: Record<string, unknown>): Promise<Record<string, unknown>> };
};
export type WebEvent = { type: string; [field: string]: unknown };

// The page is its three files, the mark (and its light-theme copy, whose white loop is ink) and its four fonts, looked up by exact path, so no request can name anything else on disk.
const FILES: Record<string, [string, string]> = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/mark.svg': ['mark.svg', 'image/svg+xml'], '/mark-light.svg': ['mark-light.svg', 'image/svg+xml'],
  ...Object.fromEntries(['sora-500', 'sora-600', 'plex-mono-400', 'plex-mono-500'].map(font => [`/fonts/${font}.woff2`, [`fonts/${font}.woff2`, 'font/woff2']])) };
const READS = new Set(['state', 'models', 'events']);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const RING = 1000; const KEEPALIVE_MS = 15_000; const BODY_LIMIT = 64 * 1024; const JOIN_BODY_LIMIT = 4 * 1024;
const JOIN = /^\/j\/([^/]{1,200})(?:\/(claim|poll))?$/;

const refuse = (status: number, code: string, message: string): never => { throw Object.assign(new Error(message), { status, code }); };

export async function startWeb({ host, uiDir, port = 0 }: { host: WebHost; uiDir: string; port?: number }) {
  const token = randomBytes(32).toString('base64url'); const expected = Buffer.from(`Bearer ${token}`);
  let origin = ''; let lastId = 0; const ring: { id: number; data: string }[] = []; const streams = new Set<ServerResponse>();
  const write = (res: ServerResponse, entry: { id: number; data: string }) => res.write(`id: ${entry.id}\ndata: ${entry.data}\n\n`);
  function emit(event: WebEvent) {
    const entry = { id: ++lastId, data: JSON.stringify(event) }; ring.push(entry); if (ring.length > RING) ring.shift();
    for (const res of streams) write(res, entry); return entry.id;
  }
  const authorised = (req: IncomingMessage) => { const given = Buffer.from(req.headers.authorization ?? ''); return given.length === expected.length && timingSafeEqual(given, expected); };
  async function body(req: IncomingMessage, limit = BODY_LIMIT) {
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') refuse(415, 'content_type', 'Content-Type must be application/json');
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) refuse(413, 'too_large', `The request is larger than ${limit / 1024} KiB`); chunks.push(chunk); }
    let value: any; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { refuse(400, 'invalid_json', 'The request must be JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(400, 'invalid_json', 'The request must be a JSON object');
    return value as Record<string, unknown>;
  }
  // A reconnect names the last event it saw. One the ring no longer holds, or one from an earlier console, gets a reset.
  function subscribe(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' }); res.write(': open\n\n');
    const header = req.headers['last-event-id'];
    if (header !== undefined) { const last = Number(header); const oldest = ring.length ? ring[0].id : lastId + 1;
      if (!Number.isInteger(last) || last > lastId || last < oldest - 1) res.write('data: {"type":"reset"}\n\n'); else for (const entry of ring) if (entry.id > last) write(res, entry); }
    streams.add(res); const timer = setInterval(() => res.write(': keep-alive\n\n'), KEEPALIVE_MS);
    req.on('close', () => { clearInterval(timer); streams.delete(res); });
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    const reply = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      // Another host name is DNS rebinding or a mistake; either way not this page.
      if (req.headers.host !== new URL(origin).host) refuse(403, 'wrong_host', 'Open the address the console printed');
      const url = new URL(req.url ?? '/', origin);
      // The join route has its own boundary, because the page token does not apply to it. The ticket is the only thing it
      // accepts; a change is only JSON posted from no web page (any Origin, or a cross-site fetch, is refused); a GET is
      // the same text for every ticket, valid or not, so the route never says which tickets exist.
      const joining = JOIN.exec(url.pathname);
      if (joining || url.pathname === '/j') {
        if (!host.join || !joining) refuse(404, 'not_found', 'Not found');
        const [, ticket, op] = joining!;
        if (!op) { if (req.method !== 'GET') refuse(405, 'method', 'Only GET'); res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Frame-Options': 'DENY' }); res.end(host.join!.help(origin, url.pathname)); return; }
        if (req.method !== 'POST') refuse(405, 'method', 'Only POST');
        if (req.headers.origin !== undefined) refuse(403, 'cross_origin', 'A join request comes from the peerloom command, not a web page');
        const site = req.headers['sec-fetch-site']; if (site !== undefined && site !== 'none') refuse(403, 'cross_site', 'A join request comes from the peerloom command, not a web page');
        reply(200, { ok: true, ...await host.join!.act(op as 'claim' | 'poll', ticket, await body(req, JOIN_BODY_LIMIT)) }); return;
      }
      if (!url.pathname.startsWith('/api/')) {
        const file = FILES[url.pathname]; if (!file) refuse(404, 'not_found', 'Not found'); if (req.method !== 'GET') refuse(405, 'method', 'Only GET');
        let content: Buffer; try { content = readFileSync(join(uiDir, file[0])); } catch { refuse(404, 'not_found', 'The page is not there'); }
        res.writeHead(200, { 'Content-Type': file[1], 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY' }); res.end(content!); return;
      }
      // The API answers only the page's own requests: no other origin, no cross-site fetch, and never CORS.
      if (req.headers.origin !== undefined && req.headers.origin !== origin) refuse(403, 'cross_origin', 'Requests from other pages are refused');
      const site = req.headers['sec-fetch-site']; if (site !== undefined && site !== 'same-origin' && site !== 'none') refuse(403, 'cross_site', 'Requests from other sites are refused');
      if (!authorised(req)) refuse(401, 'unauthorized', 'Open the address the console printed; it carries the key');
      const path = url.pathname.slice('/api/'.length);
      if (req.method !== (READS.has(path) ? 'GET' : 'POST')) refuse(405, 'method', READS.has(path) ? 'Only GET' : 'Only POST');
      if (path === 'events') { subscribe(req, res); return; }
      if (path === 'state') { const eventId = lastId; reply(200, { ...await host.snapshot(), eventId }); return; }
      if (path === 'models') { reply(200, await host.models(url.searchParams.get('kind'))); return; }
      reply(200, { ok: true, ...await host.action(path, await body(req)) });
    } catch (error: any) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : error?.code === 'hub_unreachable' ? 502 : 500;
      const code = typeof error?.code === 'string' && status !== 500 ? error.code : 'internal';
      if (!res.headersSent) reply(status, { ok: false, error: { code, message: String(error?.message ?? 'That did not work').replace(/^[a-z_0-9]+: /, ''), ...(error?.detail !== undefined && status !== 500 ? { detail: error.detail } : {}) } }); else res.end();
    }
  });
  server.requestTimeout = 10_000;
  await new Promise<void>((ok, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); ok(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('The web server has no address');
  origin = `http://127.0.0.1:${address.port}`;
  let closed: Promise<void> | undefined;
  // Open event streams would hold close() for ever; they are ended first, then any idle kept-alive connection.
  const close = () => closed ??= new Promise<void>(ok => { for (const res of streams) res.end(); streams.clear(); server.close(() => ok()); server.closeAllConnections(); });
  return { url: `${origin}/#k=${token}`, origin, token, emit, close };
}
