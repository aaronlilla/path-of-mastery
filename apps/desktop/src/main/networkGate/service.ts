import { pendingIntentSchema, networkClearanceSchema, type PendingIntent, type NetworkClearance, type ValidationLimits } from '@pom/mastery-contracts';
import type { SignalSummary } from './signals.js';
import { signalState } from './signals.js';

export type LocalOperation = 'run' | 'log' | 'edit' | 'save_local' | 'import_file' | 'optimizer' | 'cache';
export type ResumeResult = 'resumed' | 'review' | 'stale' | 'unavailable';
export type GateContext = { accountBinding: string; target: PendingIntent['target']; requestHash: PendingIntent['requestHash'] };
export class NetworkGate {
  private pending = new Map<string, PendingIntent>();
  private completed = new Set<string>();
  private resuming = new Set<string>();
  constructor(private limits: ValidationLimits,
    private admit?: (intent: PendingIntent,clearance: NetworkClearance) => Promise<NetworkClearance>) {}

  allowsLocal(_operation: LocalOperation): true { return true; }
  needsCheck(summary: SignalSummary, now = Date.now()): boolean { return signalState(summary, now) === 'uncertain'; }
  pause(value: unknown): void {
    const parsed = pendingIntentSchema.parse(value, this.limits);
    if (!parsed.ok) throw new Error('VALIDATION_FAILED');
    const intent = parsed.value;
    const old = this.pending.get(intent.requestId);
    if (old && JSON.stringify(old) !== JSON.stringify(intent)) throw new Error('REVISION_CONFLICT');
    if (!this.completed.has(intent.requestId)) this.pending.set(intent.requestId, structuredClone(intent));
  }
  cancelAccount(): void { this.pending.clear(); }
  async resume(requestId: string, clearance: NetworkClearance, context: GateContext | (() => GateContext),
    execute: (intent: PendingIntent) => Promise<void>, review: (intent: PendingIntent) => void, now = Date.now()): Promise<ResumeResult> {
    const intent = this.pending.get(requestId);
    if (!intent || this.completed.has(requestId) || this.resuming.has(requestId)) return 'stale';
    const current = typeof context === 'function' ? context() : context;
    const parsed = networkClearanceSchema.parse(clearance, this.limits);
    if (!parsed.ok || parsed.value.status !== 'clear' || Date.parse(parsed.value.expiresAt) <= now) return 'unavailable';
    if (intent.accountBinding !== current.accountBinding || intent.requestHash !== current.requestHash
      || parsed.value.requestHash !== intent.requestHash || JSON.stringify(intent.target) !== JSON.stringify(current.target)) {
      this.pending.delete(requestId); return 'stale';
    }
    if (!this.admit) return 'unavailable';
    this.resuming.add(requestId);
    let authorized: NetworkClearance;
    try { authorized = await this.admit(structuredClone(intent),parsed.value); }
    catch { return 'unavailable'; }
    finally { this.resuming.delete(requestId); }
    const accepted = networkClearanceSchema.parse(authorized,this.limits);
    if (!accepted.ok || accepted.value.status !== 'clear' || accepted.value.clearanceId !== parsed.value.clearanceId
      || accepted.value.requestHash !== intent.requestHash || Date.parse(accepted.value.expiresAt) <= Date.now()) return 'unavailable';
    const latest = typeof context === 'function' ? context() : context;
    if (this.pending.get(requestId) !== intent || latest.accountBinding !== intent.accountBinding
      || latest.requestHash !== intent.requestHash || JSON.stringify(latest.target) !== JSON.stringify(intent.target)) return 'stale';
    // Server admission is one-use. Unknown execution outcomes are reconciled by idempotency, never auto-replayed.
    this.completed.add(requestId); this.pending.delete(requestId);
    if (intent.resumePolicy === 'return_to_review') { review(structuredClone(intent)); return 'review'; }
    await execute(structuredClone(intent)); return 'resumed';
  }
}
