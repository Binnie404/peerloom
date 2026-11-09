import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// A stand-in for `claude -p` in stream-JSON mode, for the owned Claude host's tests. It speaks the protocol measured
// in item 17's probes P1 and P3 and does what a model would: says Ready to the opening, and for a wake runs the
// Peerloom fetch and reply it was told about. Like the real CLI, it runs a shell command it judges harmless without
// asking anyone, unless a host-registered PreToolUse hook answers "ask"; an edit it always asks about. Everything it
// is sent is logged.
const args = process.argv.slice(2); const flag = (name: string) => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; };
const sessionId = flag('--session-id') ?? flag('--resume') ?? randomUUID(); const log = process.env.CLAUDE_FIXTURE_LOG;
const record = (value: unknown) => { if (log) appendFileSync(log, `${JSON.stringify({ pid: process.pid, ...value as object })}\n`); };
const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
record({ args });

const permissions = new Map<string, (answer: any) => void>(); let hookIds: string[] = []; let running: ChildProcess | undefined; let interrupted = false;
const queue: string[] = []; let busy = false;
const ask = (request: any) => new Promise<any>(ok => { const requestId = randomUUID(); permissions.set(requestId, ok); out({ type: 'control_request', request_id: requestId, request }); });
// The host's hook decides first when one is registered: allow, deny, ask, or no decision (the CLI's own rule then).
async function hook(tool: string, input: any, toolId: string) {
  if (!hookIds.length) return undefined;
  const answer = await ask({ subtype: 'hook_callback', callback_id: hookIds[0], input: { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input }, tool_use_id: toolId });
  const decision = answer?.hookSpecificOutput?.permissionDecision; record({ hook: tool, decision: decision ?? null }); return decision;
}
async function bash(command: string) {
  const toolId = `toolu_${randomUUID()}`; const input = { command, description: 'Peerloom command' };
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Bash', input }] }, session_id: sessionId });
  const decision = await hook('Bash', input, toolId);
  const answer = decision === 'ask' ? await ask({ subtype: 'can_use_tool', tool_name: 'Bash', input, description: 'Peerloom command', tool_use_id: toolId })
    : decision === 'deny' ? { behavior: 'deny', message: 'denied by hook' } : { behavior: 'allow', updatedInput: input, unasked: true };
  record({ permission: command, behavior: answer.behavior, ...(answer.unasked ? { unasked: true } : {}) });
  if (answer.behavior !== 'allow') { out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: answer.message, is_error: true }] }, session_id: sessionId }); return false; }
  const result = await new Promise<{ code: number | null; text: string }>(ok => { running = spawn('/bin/sh', ['-c', answer.updatedInput.command], { stdio: ['ignore', 'pipe', 'pipe'] }); let text = '';
    running.stdout!.on('data', c => { text += c; }); running.once('close', code => { running = undefined; ok({ code, text }); }); });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: result.text, is_error: result.code !== 0 }] }, session_id: sessionId });
  return result.code === 0;
}
// A tool that is not a shell command: Claude asks for it the same way, by name and input.
async function edit(path: string) {
  const toolId = `toolu_${randomUUID()}`; const input = { file_path: path, old_string: 'a', new_string: 'b' };
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Edit', input }] }, session_id: sessionId });
  const decision = await hook('Edit', input, toolId);
  const answer = decision === 'allow' ? { behavior: 'allow', updatedInput: input } : await ask({ subtype: 'can_use_tool', tool_name: 'Edit', input, description: `Edit ${path}`, tool_use_id: toolId });
  record({ permission: `Edit ${path}`, behavior: answer.behavior, updatedInput: answer.updatedInput });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: answer.behavior === 'allow' ? 'edited' : answer.message, is_error: answer.behavior !== 'allow' }] }, session_id: sessionId });
  return answer.behavior === 'allow';
}
const say = (text: string) => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, session_id: sessionId });
async function turn(text: string) {
  record({ turn: text }); interrupted = false; out({ type: 'system', subtype: 'init', session_id: sessionId });
  let final = '';
  if (text.startsWith('You are participant')) { final = process.env.CLAUDE_FIXTURE_OPENING ?? 'Ready'; say(final); }
  else if (/^AgentLink wake /.test(text)) {
    const fetch = /(node \S+ fetch --client \S+ --wake \S+)/.exec(text)![1];
    if (await bash(fetch) && !interrupted) { const reply = fetch.replace(' fetch ', ' reply ') + ` --text 'Fixture answer: it'\\''s done'`; await bash(reply); }
    final = 'Answered';
  } else if (/^EDIT \S+$/.test(text)) { const path = text.slice(5); final = await edit(path) ? `Edited ${path}` : `Not edited ${path}`; say(final); }
  else { final = `Heard: ${text}`; say(final); }
  out(interrupted ? { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId } : { type: 'result', subtype: 'success', is_error: false, result: final, session_id: sessionId, total_cost_usd: 0.001 });
}
async function next() { if (busy) return; busy = true; while (queue.length) await turn(queue.shift()!); busy = false; }

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buffer += chunk; let at: number;
  while ((at = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (!line.trim()) continue; const value = JSON.parse(line);
    if (value.type === 'control_request' && value.request?.subtype === 'initialize') { hookIds = (value.request.hooks?.PreToolUse ?? []).flatMap((m: any) => m.hookCallbackIds ?? []); record({ hooks: value.request.hooks ?? null }); }
    if (value.type === 'control_request' && value.request?.subtype === 'initialize') setTimeout(() => out({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: { commands: [], models: [
      { value: 'default', displayName: 'Default (recommended)', supportedEffortLevels: ['low', 'high'] }, { value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: ['low', 'medium', 'high'] }] } } }), Number(process.env.CLAUDE_FIXTURE_INIT_DELAY_MS ?? 0));
    else if (value.type === 'control_request' && value.request?.subtype === 'interrupt') { interrupted = true; running?.kill('SIGTERM'); for (const [id, ok] of permissions) { permissions.delete(id); ok({ behavior: 'deny', message: 'interrupted' }); } out({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: { still_queued: [] } } }); }
    else if (value.type === 'control_response') { const ok = permissions.get(value.response.request_id); permissions.delete(value.response.request_id); ok?.(value.response.response); }
    else if (value.type === 'user') { queue.push(String(value.message.content)); void next(); }
  } });
// A real CLI takes a moment to wind down; a delay here makes that window wide enough to test.
process.stdin.on('end', () => { record({ stdinEnded: true }); setTimeout(() => process.exit(0), Number(process.env.CLAUDE_FIXTURE_EXIT_DELAY_MS ?? 0)); });
