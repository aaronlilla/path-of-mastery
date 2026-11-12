export const AI_MIN_INTERVAL_MS = 10_000;
export const AI_DEBOUNCE_MS = 1_000;
export type Timers = { now(): number; set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
export const realTimers: Timers = { now: () => Date.now(), set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h as ReturnType<typeof setTimeout>) };

/**
 * Paces AI suggestion requests. Off until the player opts in; nothing is sent while off.
 * After opting in: changes are debounced, at most one request starts per 10 s, and none starts during a drag.
 * Only the latest summary is sent; earlier ones are dropped, never queued.
 */
export class AiScheduler<S> {
  private enabled = false;
  private dragging = false;
  private latest: S | undefined;
  private lastAt: number | null = null;
  private timer: unknown = null;
  private inFlight: AbortController | null = null;
  sent = 0;
  constructor(private readonly send: (summary: S, signal: AbortSignal) => Promise<void>, private readonly timers: Timers = realTimers,
    private readonly minIntervalMs = AI_MIN_INTERVAL_MS, private readonly debounceMs = AI_DEBOUNCE_MS) {}
  get on(): boolean { return this.enabled; }
  get pending(): boolean { return this.timer !== null; }
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) { this.cancel(); this.latest = undefined; return; }
    if (this.latest !== undefined) this.arm(0);
  }
  setDragging(on: boolean): void {
    this.dragging = on;
    if (!on && this.enabled && this.latest !== undefined) this.arm(this.debounceMs);
  }
  /** Report the current plan summary. Cheap to call on every change. */
  notify(summary: S, immediate = false): void {
    if (!this.enabled) return;
    this.latest = summary;
    this.arm(immediate ? 0 : this.debounceMs);
  }
  cancel(): void { if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; } this.inFlight?.abort(); this.inFlight = null; }
  private arm(delay: number): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    const wait = this.lastAt === null ? delay : Math.max(delay, this.lastAt + this.minIntervalMs - this.timers.now());
    this.timer = this.timers.set(() => { this.timer = null; void this.fire(); }, wait);
  }
  private async fire(): Promise<void> {
    if (!this.enabled || this.latest === undefined) return;
    if (this.dragging) return; // setDragging(false) re-arms
    const wait = this.lastAt === null ? 0 : this.lastAt + this.minIntervalMs - this.timers.now();
    if (wait > 0) { this.arm(wait); return; }
    const summary = this.latest; this.latest = undefined; this.lastAt = this.timers.now(); this.sent++;
    const controller = new AbortController(); this.inFlight = controller;
    try { await this.send(summary, controller.signal); } catch { /* the caller shows its own status */ }
    finally { if (this.inFlight === controller) this.inFlight = null; }
    if (this.latest !== undefined && this.enabled) this.arm(this.debounceMs);
  }
}
