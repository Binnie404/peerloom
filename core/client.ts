import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';

export type Credential = { endpoint: string; token: string; sessionId?: string; participantId?: string };
export function credential(path: string): Credential {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  validateEndpoint(value.endpoint);
  if (typeof value.token !== 'string' || !value.token) throw new Error('Credential file has no token');
  return value;
}
export function validateEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Only an http://127.0.0.1:PORT endpoint is supported');
}
export function saveCredential(path: string, value: any) {
  path = resolve(path);
  const temporary = `${path}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}
// A call that got no answer from the hub: nothing listening, a connection that ended, a deadline, or a reply that was
// not the hub's. It is a different thing from a refusal, which carries the hub's own code and an HTTP status, and a
// caller must not have to tell them apart by reading a message.
export type Transport = 'refused' | 'reset' | 'timeout' | 'invalid_response' | 'failed';
export class TransportError extends Error {
  code = 'hub_unreachable' as const; transport: Transport;
  constructor(cause: any) {
    const system = cause?.code ?? cause?.cause?.code;
    const transport: Transport = cause instanceof SyntaxError ? 'invalid_response' : cause?.name === 'TimeoutError' || cause?.name === 'AbortError' ? 'timeout' : system === 'ECONNREFUSED' ? 'refused' : system === 'ECONNRESET' || system === 'EPIPE' || system === 'UND_ERR_SOCKET' ? 'reset' : 'failed';
    super(`The hub did not answer (${transport}${system ? `, ${system}` : ''}): ${cause?.message ?? cause}`, { cause }); this.name = 'TransportError'; this.transport = transport;
  }
}
// Every ordinary call is abandoned after 10 seconds. A caller that names its own deadline gets the transport that can honour it.
export async function request(auth: Credential, op: string, body: any = {}, timeoutMs?: number) {
  if (timeoutMs !== undefined) return requestHeld(auth, op, body, timeoutMs);
  validateEndpoint(auth.endpoint);
  let response: Response; let result: any;
  try {
    response = await fetch(`${auth.endpoint}/v1/${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    result = await response.json();
  } catch (error) { throw new TransportError(error); }
  if (!response.ok) {
    const error = new Error(`${result.error?.code ?? response.status}: ${result.error?.message ?? 'Request failed'}`) as Error & { code: string; status: number; detail?: unknown };
    error.code = result.error?.code; error.status = response.status; error.detail = result.error?.detail; throw error;
  }
  return result;
}

// A call the hub may legitimately leave unanswered for a long time, such as a held `wait`. Node's built-in fetch gives
// up on any request whose response has not begun within 300 seconds, whatever deadline the caller sets, so this one
// is made with node:http, where the only deadline is the one given here. Errors have the same shape as `request`.
export async function requestHeld(auth: Credential, op: string, body: any, timeoutMs: number) {
  validateEndpoint(auth.endpoint);
  const payload = JSON.stringify(body);
  const { status, text } = await new Promise<{ status: number; text: string }>((ok, reject) => {
    const call = httpRequest(`${auth.endpoint}/v1/${op}`, { method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${auth.token}` } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { clearTimeout(timer); ok({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }); });
      response.on('error', error => { clearTimeout(timer); reject(error); });
    });
    const timer = setTimeout(() => { const error = new Error('The operation was aborted due to timeout'); error.name = 'TimeoutError'; call.destroy(error); }, timeoutMs);
    call.on('error', error => { clearTimeout(timer); reject(error); });
    call.end(payload);
  }).catch(error => { throw new TransportError(error); });
  let result: any;
  try { result = JSON.parse(text); } catch (error) { if (status >= 200 && status <= 299) throw new TransportError(error); result = {}; }
  if (status < 200 || status > 299) {
    const error = new Error(`${result.error?.code ?? status}: ${result.error?.message ?? 'Request failed'}`) as Error & { code: string; status: number; detail?: unknown };
    error.code = result.error?.code; error.status = status; error.detail = result.error?.detail; throw error;
  }
  return result;
}
