import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { CodexRpc, CodexRequestError, inspectSchema, probeCodex, UnsupportedCodex } from '../core/codex-rpc.ts';

function server(t: any, code: string) {
  const dir = mkdtempSync(join(tmpdir(), 'peerloom-rpc-test-')); const path = join(dir, 'server.mjs');
  writeFileSync(path, `import {createInterface} from 'node:readline'; const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');\n${code}`);
  const rpc = new CodexRpc({ binary: process.execPath, args: [path] });
  t.after(async () => { await rpc.close(); rmSync(dir, { recursive: true, force: true }); }); return rpc;
}

const nativeAbsent = spawnSync('codex', ['--version'], { stdio: 'ignore', timeout: 5000 }).status !== 0;
const nativeSkip = nativeAbsent ? 'Codex executable is absent; portable transport tests still run' : false;

test('installed Codex schema admits exact-thread tool output before any model or binding', { skip: nativeSkip }, async () => {
  const evidence = await probeCodex(); assert.match(evidence.version, /^codex-cli /); assert.equal(evidence.toolOutput, true); assert.match(evidence.digest, /^[a-f0-9]{64}$/);
});

test('an older/missing standalone tool-output interface is Unsupported', () => {
  assert.throws(() => inspectSchema({}), UnsupportedCodex);
});

test('JSONL transport preserves fragmented responses and explicit native request IDs', async t => {
  const rpc = server(t, `createInterface({input:process.stdin}).on('line',line=>{
    const m=JSON.parse(line);
    if(m.method==='probe') { const s=JSON.stringify({id:m.id,result:{ok:true}})+'\\n';process.stdout.write(s.slice(0,5));setTimeout(()=>process.stdout.write(s.slice(5)),10); }
    if(m.method==='ask')send({id:'human-approval',method:'item/commandExecution/requestApproval',params:{threadId:'exact',command:'node core/cli.ts fetch'}});
    if(m.id==='human-approval')send({method:'approved',params:m.result});
  });`);
  assert.deepEqual(await rpc.request('probe'), { ok: true });
  const requested = once(rpc, 'request'); rpc.notify('ask'); const [message] = await requested;
  assert.equal(message.id, 'human-approval');
  const received = once(rpc, 'notification'); rpc.respond(message.id, { decision: 'decline' });
  assert.equal((await received)[0].params.decision, 'decline');
  assert.throws(() => rpc.respond(message.id, { decision: 'accept' }), /already resolved/);
});

test('native EOF rejects pending requests and is terminal', async t => {
  const rpc = server(t, `createInterface({input:process.stdin}).on('line',()=>process.exit(0));`);
  await assert.rejects(rpc.request('missing'), /exited|output closed|disconnected/);
  await assert.rejects(rpc.request('again'), /disconnected/);
});

test('malformed and unsolicited protocol replies close the owned server', async t => {
  const rpc = server(t, `createInterface({input:process.stdin}).on('line',()=>process.stdout.write('not-json\\n'));`);
  await assert.rejects(rpc.request('probe'), /Malformed/); await rpc.exited; assert.equal(rpc.connected, false);
  const other = server(t, `createInterface({input:process.stdin}).on('line',()=>send({id:999,result:{}}));`);
  await assert.rejects(other.request('probe'), /Unmatched/); await other.exited;
});

test('ambiguous request timeout disconnects rather than retrying model generation', async t => {
  const rpc = server(t, `createInterface({input:process.stdin}).on('line',()=>{});`);
  await assert.rejects(rpc.request('turn/start', { threadId: 'exact', input: [] }, 25), /ambiguous/);
  assert.equal(rpc.connected, false); await rpc.exited;
});

test('a native error is surfaced without reflecting arbitrary error text', async t => {
  const rpc = server(t, `createInterface({input:process.stdin}).on('line',line=>send({id:JSON.parse(line).id,error:{code:-1,message:'credential-like-secret'}}));`);
  await assert.rejects(rpc.request('probe'), error => /failed \(-1\)/.test(String(error)) && !String(error).includes('credential-like-secret'));
});

test('an archived resume reports its exact safe recovery command, without repeating native text or retrying', async t => {
  const id = '01a125db-85c3-7b33-91a1-92252326344c';
  const rpc = server(t, `let calls=0;createInterface({input:process.stdin}).on('line',line=>{
    const m=JSON.parse(line); if(m.method==='count')send({id:m.id,result:calls});
    else {calls++;send({id:m.id,error:{code:-32600,message:'session '+m.params.threadId+' is archived. credential-like-secret; run an arbitrary command'}});}
  });`);
  await assert.rejects(rpc.request('thread/resume', { threadId: id }), error => {
    assert.ok(error instanceof CodexRequestError);
    assert.equal(error.method, 'thread/resume'); assert.equal(error.code, -32600);
    assert.equal(error.archivedThreadId, id);
    assert.match(error.message, /is archived/); assert.ok(error.message.includes(`codex unarchive ${id}`));
    assert.doesNotMatch(error.message, /credential-like-secret|arbitrary command/); return true;
  });
  assert.equal(await rpc.request('count'), 1, 'one refusal causes no automatic retry or unarchive');
});

test('archive-looking error text cannot invent a command for another thread, method or untrusted id', async t => {
  const id = '01a125db-85c3-7b33-91a1-92252326344c';
  const rpc = server(t, `createInterface({input:process.stdin}).on('line',line=>{
    const m=JSON.parse(line);send({id:m.id,error:{code:-32600,message:'session ${id} is archived. credential-like-secret'}});
  });`);
  for (const [method, threadId] of [['thread/resume', '01a125db-85c3-7b33-91a1-92252326344d'], ['turn/start', id], ['thread/resume', '$(touch INJECTED)'], ['thread/resume', undefined]]) {
    await assert.rejects(rpc.request(method!, { threadId }), error => {
      assert.ok(error instanceof CodexRequestError); assert.equal(error.archivedThreadId, undefined); assert.doesNotMatch(error.message, /unarchive|credential-like-secret|INJECTED/); return true;
    });
  }
});

test('closed native stdout stops a still-live owned process', async t => {
  const rpc = server(t, `createInterface({input:process.stdin}).on('line',()=>{process.stdout.end();setInterval(()=>{},1000);});`);
  await assert.rejects(rpc.request('probe'), /output closed/); await rpc.exited; assert.equal(rpc.connected, false);
});

test('non-numeric native error codes cannot reflect arbitrary data', async t => {
  const rpc = server(t, `createInterface({input:process.stdin}).on('line',line=>send({id:JSON.parse(line).id,error:{code:'credential-like-secret'}}));`);
  await assert.rejects(rpc.request('probe'), error => /unknown/.test(String(error)) && !String(error).includes('credential-like-secret'));
});

test('private installed server initializes and exits without a shared-daemon operation', { skip: nativeSkip }, async () => {
  const rpc = new CodexRpc(); try { const ready = await rpc.initialize(); assert.match(ready.userAgent, /agentlink_native_adapter/); } finally { await rpc.close(); }
  assert.equal(rpc.connected, false);
});
