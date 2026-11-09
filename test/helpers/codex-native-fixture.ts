import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

// A native-peer fixture, not a host implementation. Both JSONL orderings
// are deliberately separated by ticks, unlike the original reference stub.
export class NativeFixture extends EventEmitter {
  connected = true;
  calls: Array<{ method: string; params: any }> = [];
  replies: any[] = [];
  active: { id: string; params: any; purpose: string; announced: boolean } | null = null;
  serial = 0;
  eventFirst = false;
  openingReply = 'Ready';
  holdHuman = false;
  holdWake = false;
  askApproval = false;
  secretFile?: string;
  mismatchedResponse = false;
  onWake?: (params: any) => Promise<void>;
  private question: string | number | null = null;

  async initialize() { return { userAgent: 'test-native-peer' }; }
  async request(method: string, params: any = {}) {
    this.calls.push({ method, params });
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId ?? 'native-exact', status: { type: 'idle' } }, cwd: params.cwd, model: 'fixture', approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer, sandbox: { type: 'workspaceWrite' } };
    if (method === 'turn/interrupt') { this.complete('interrupted'); return {}; }
    if (method !== 'turn/start') throw new Error('Unexpected fixture request');
    if (this.active) throw new Error('Fixture is busy');
    const id = `turn-${++this.serial}`; const purpose = params.toolOutput ? 'wake' : params.input?.[0]?.text?.startsWith('Peerloom host setup') ? 'opening' : 'human';
    this.active = { id, params, purpose, announced: false };
    const started = () => {
      if (!this.connected || !this.active) return;
      this.active.announced = true;
      this.emit('notification', { method: 'turn/started', params: { threadId: params.threadId, turn: { id, status: 'inProgress' } } });
      if (purpose === 'opening') setTimeout(() => this.complete('completed', this.openingReply), 2);
      else if (purpose === 'human') { if (!this.holdHuman) setTimeout(() => this.complete('completed', 'Human task done'), 2); }
      else if (this.askApproval) {
        this.question = 0; this.emit('request', { id: 0, method: 'item/commandExecution/requestApproval', params: { threadId: params.threadId, turnId: id, command: 'node core/cli.ts fetch --client protected.json', reason: 'localhost permission', availableDecisions: ['accept', 'decline', 'cancel'] } });
      } else if (!this.holdWake) void this.finishWake();
    };
    if (this.eventFirst) started(); else setTimeout(started, 3);
    return { turn: { id: this.mismatchedResponse ? `${id}-wrong` : id, status: 'inProgress', items: [] } };
  }
  async finishWake() {
    const current = this.active;
    if (!current) return;
    try { await this.onWake?.(current.params); this.complete('completed', 'Answered'); }
    catch { this.complete('failed', 'Native foreground failed'); }
  }
  complete(status = 'completed', text = 'Done') {
    const current = this.active; if (!current || !this.connected) return; this.active = null;
    if (this.secretFile) text = `Native output ${readFileSync(this.secretFile, 'utf8')}`;
    this.emit('notification', { method: 'item/completed', params: { threadId: current.params.threadId, turnId: current.id, item: { type: 'agentMessage', phase: 'final_answer', id: 'message', text } } });
    this.emit('notification', { method: 'turn/completed', params: { threadId: current.params.threadId, turn: { id: current.id, status, items: [] } } });
  }
  respond(id: string | number, result: any) {
    if (id !== this.question) throw new Error('Wrong fixture approval ID');
    this.question = null; this.replies.push({ id, result });
    if (result.decision === 'accept') void this.finishWake();
  }
  forgetRequest(_id: string | number) {}
  async close() { if (this.connected) { this.connected = false; this.active = null; this.emit('disconnected', 'Fixture exited'); } }
}
