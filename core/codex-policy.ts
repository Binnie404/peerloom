// What a host that waits on behalf of a Codex session may do next, and nothing about how it does it: no process,
// timer, credential or native protocol is in this file. The runtime reports what it sees and asks; this decides.

export type Registration = { threadId: string; participantId: string; generation: number; run: number; control: number };
export type RunView = {
  number: number; control: number; state: 'idle' | 'running' | 'paused' | 'ended';
  limits: { room: number; agent: number; emptyWaits: number };
  used: { room: number; agents: Record<string, number> };
  bindings: Array<{ participantId: string; generation: number | null; armed: 'waiting' | 'not_armed' | 'disarmed' | 'unknown'; empties: number; held?: 'budget_room' | 'budget_agent' | null; pending?: { wakeId: string; attemptId?: string } | null }>;
};
export type NativeView = { connected: boolean; activeTurnId: string | null; pendingRequestIds: Array<string | number>; draft: boolean };
export type Pointer = { status: 'offer'; wakeId: string };
export type Decision = { kind: 'wait' } | { kind: 'dispatch'; wakeId: string } | { kind: 'defer'; reason: string } | { kind: 'none' } | { kind: 'stop'; reason: string };

// The only thing the host says to the model after the opening. Nothing but a checked wake ID varies.
export const WAKE_ID = /^wk_[A-Za-z0-9_-]{1,97}$/;
export function notice(wakeId: string) {
  if (typeof wakeId !== 'string' || !WAKE_ID.test(wakeId)) throw new Error('Not a wake ID');
  return `AgentLink host: work is offered at wake ID ${wakeId}; fetch it in the foreground.`;
}

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const plain = (value: any) => !!value && typeof value === 'object' && !Array.isArray(value);
// The hub's own ranges (core/delivery.ts). A view outside them did not come from a hub this policy understands.
const RANGES = { room: 500, agent: 200, emptyWaits: 1000 } as const;
const STATES = ['idle', 'running', 'paused', 'ended']; const ARMED = ['waiting', 'not_armed', 'disarmed', 'unknown'];
const readable = (run: any): run is RunView => plain(run) && count(run.number) && count(run.control) && STATES.includes(run.state) &&
  plain(run.limits) && (Object.keys(RANGES) as (keyof typeof RANGES)[]).every(k => count(run.limits[k]) && run.limits[k] >= 1 && run.limits[k] <= RANGES[k]) &&
  plain(run.used) && count(run.used.room) && plain(run.used.agents) && Object.values(run.used.agents).every(count) && Array.isArray(run.bindings) &&
  run.bindings.every((b: any) => plain(b) && typeof b.participantId === 'string' && !!b.participantId && (b.generation === null || count(b.generation) && b.generation >= 1) && ARMED.includes(b.armed) && count(b.empties));
const watched = (native: any): native is NativeView => !!native && typeof native === 'object' && typeof native.connected === 'boolean' &&
  (native.activeTurnId === null || typeof native.activeTurnId === 'string') && Array.isArray(native.pendingRequestIds) && typeof native.draft === 'boolean';

export class DeliveryPolicy {
  private registration: Registration;
  private attempted: string[];
  private held = false;
  private pointer: string | null = null;
  private waking: string | null = null;
  private stopReason: string | null = null;
  // The run as it was when the wait now held, or the one that returned the pending pointer, was allowed.
  private snapshot: { number: number; control: number } | null = null;
  // A wait or dispatch decision permits exactly the next call, and only that one.
  private permit: { kind: 'wait'; number: number; control: number } | { kind: 'dispatch'; wakeId: string } | null = null;
  // Set only by an explicit resume of the same binding. Its first, short wait reconciles a durable offer that
  // may have been prepared before shutdown. Later waits use the ordinary timeout.
  private recovery: boolean;

  constructor(registration: Registration, dispatchedWakeIds: string[] = [], recoveryWait = false) {
    this.registration = { ...registration }; this.attempted = [...dispatchedWakeIds]; this.recovery = recoveryWait === true;
    if (typeof registration.threadId !== 'string' || !registration.threadId || typeof registration.participantId !== 'string' || !registration.participantId || !count(registration.generation) || registration.generation < 1 || !count(registration.run) || registration.run < 1 || !count(registration.control) || !Array.isArray(dispatchedWakeIds) || dispatchedWakeIds.some(id => typeof id !== 'string' || !WAKE_ID.test(id)) || typeof recoveryWait !== 'boolean') this.stopReason = 'the saved registration is unreadable';
  }

  get waiting() { return this.held; }
  get pendingWakeId() { return this.pointer; }
  get stoppedReason() { return this.stopReason; }
  get dispatchedWakeIds() { return [...this.attempted]; }
  // The wake whose turn the host started and has not yet seen end. No wait is held meanwhile: the hub would hand
  // back the same unconfirmed pointer at once.
  get wakingWakeId() { return this.waking; }
  // True from an explicit resume until its first wait begins. The runtime gives that one wait a short timeout: it
  // is a look for an offer already prepared, not a wait for new work.
  get recoveryWaitPending() { return this.recovery && this.stopReason === null; }

  // Sticky, and the first reason is the one kept: what follows a stop is a consequence, not a cause. A pointer held
  // at the time is discarded here; it stays owed in the hub, where a later wait or a human can find it.
  stop(reason: string): void { this.permit = null; this.pointer = null; this.snapshot = null; this.stopReason ??= reason || 'stopped'; }
  private stopped(reason: string): Decision { this.stop(reason); return { kind: 'stop', reason: this.stopReason! }; }

  // Validates the run, the binding and the native session before allowing any effect. May stop for good.
  decide(run: RunView, native: NativeView): Decision {
    this.permit = null;
    if (this.stopReason !== null) return { kind: 'stop', reason: this.stopReason };
    if (!watched(native)) return this.stopped('the native session state is unreadable');
    if (!native.connected) return this.stopped('the native app-server is disconnected');
    if (!readable(run)) return this.stopped('the run could not be read');
    if (run.state !== 'running') return this.stopped(`the run is ${run.state}`);
    if (run.number !== this.registration.run) return this.stopped(`run ${this.registration.run} was replaced by run ${run.number}`);
    const mine = run.bindings.filter(b => b?.participantId === this.registration.participantId);
    if (mine.length !== 1 || mine[0].generation !== this.registration.generation) return this.stopped('the hub no longer holds this binding');
    const busy = native.activeTurnId !== null ? 'a native turn is active' : native.pendingRequestIds.length ? 'a native approval or question is pending' : native.draft ? 'the human has a draft' : null;

    // A wait or pointer belongs to the controls it was allowed under. Pause then Resume between two looks leaves the
    // run running at a later control: that is still a Pause, and the host stops as soon as it sees the number move.
    // Only a host holding nothing takes up new controls, with its next wait.
    if (this.held && (!this.snapshot || run.control !== this.snapshot.control)) return this.stopped('the run controls changed while a wait was held; resume explicitly');
    if (this.pointer !== null) {
      if (!this.snapshot || run.number !== this.snapshot.number || run.control !== this.snapshot.control) return this.stopped('the run controls changed while a pointer was held; it stays owed in the hub');
      if (busy) return { kind: 'defer', reason: busy };
      this.permit = { kind: 'dispatch', wakeId: this.pointer };
      return { kind: 'dispatch', wakeId: this.pointer };
    }
    if (this.held || this.waking !== null) return { kind: 'none' };
    // Genuine idle disarming still stops the host. Budgets are the hub's decision: keep holding a wait so that
    // free human work can reach a session at its cap, and peer work can wait for the human to extend the limits.
    if (mine[0].armed === 'disarmed' || mine[0].empties >= run.limits.emptyWaits) return this.stopped('disarmed: the empty-return allowance is used up');
    this.permit = { kind: 'wait', number: run.number, control: run.control };
    return { kind: 'wait' };
  }

  // Called immediately before the runtime starts the one wait. Throws, and stops, unless the last decision was `wait`:
  // the runtime must not start a wait this refuses.
  beginWait(): void {
    const permit = this.permit; this.permit = null;
    if (this.stopReason !== null) throw new Error(`Stopped: ${this.stopReason}`);
    if (permit?.kind !== 'wait' || this.held) { this.stop('a wait was started without a wait decision'); throw new Error(this.stopReason!); }
    this.held = true; this.recovery = false; this.snapshot = { number: permit.number, control: permit.control };
  }

  // The held wait ended. Exit 0 must carry a pointer and nothing else usable is taken from it; 3 with a timeout may
  // re-arm; everything else stops. Never throws: a late result after a stop is dropped.
  finishWait(exitCode: number | null, output: unknown): void {
    this.permit = null;
    if (this.stopReason !== null) { this.held = false; return; }
    if (!this.held) { this.stop('a wait result arrived with no wait held'); return; }
    this.held = false;
    const out = output as any; const shaped = plain(out);
    if (exitCode === 0) {
      if (!shaped || out.status !== 'offer' || typeof out.wakeId !== 'string' || !WAKE_ID.test(out.wakeId)) { this.stop('the wait returned no usable pointer'); return; }
      if (this.attempted.includes(out.wakeId)) { this.stop(`${out.wakeId} was already dispatched once and is still unconfirmed; inspect the session, then run-reoffer`); return; }
      this.pointer = out.wakeId; return;
    }
    if (exitCode === 3) { if (!shaped || out.status !== 'timeout') this.stop('the wait timed out without saying so'); return; }
    this.stop(exitCode === 4 ? 'superseded: another session bound this identity' : exitCode === 5 ? 'disarmed: the empty-return allowance is used up' : exitCode === 6 ? 'the wait call failed' : `the wait exited ${exitCode}`);
  }

  // Reserves the single dispatch of a wake. The runtime persists `dispatchedWakeIds` after this and before it sends
  // anything. Throws, and stops, unless the last decision was to dispatch exactly this wake.
  reserveDispatch(wakeId: string): void {
    const permit = this.permit; this.permit = null;
    if (this.stopReason !== null) throw new Error(`Stopped: ${this.stopReason}`);
    if (permit?.kind !== 'dispatch' || permit.wakeId !== wakeId || this.pointer !== wakeId || this.attempted.includes(wakeId)) { this.stop('a dispatch was attempted without a dispatch decision'); throw new Error(this.stopReason!); }
    this.attempted.push(wakeId); this.pointer = null; this.snapshot = null; this.waking = wakeId;
  }

  // The turn started for a wake has ended, or could not be started. Anything but a completed turn stops: an
  // ambiguous start may already have caused inference and is never tried again.
  finishDispatch(outcome: 'completed' | 'failed' | 'interrupted' | 'not_started' | string): void {
    this.permit = null;
    if (this.stopReason !== null) { this.waking = null; return; }
    if (this.waking === null) { this.stop('a wake turn ended that was never started'); return; }
    const wakeId = this.waking; this.waking = null;
    if (outcome !== 'completed') this.stop(`the turn for ${wakeId} ended ${outcome}; it is not retried`);
  }
}
