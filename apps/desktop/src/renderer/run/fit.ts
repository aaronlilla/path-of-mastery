/** Run window height sizing (long text is never cut, the window grows to fit and goes back when the text is short again).
 *  Pure logic, no DOM and no timers of its own: RunApp measures the content and asks this which height to request from the main
 *  process. Decisions use the height the main process CONFIRMED (its last reply or push), never an optimistic local guess, so a
 *  request that is lost or refused is asked again (with backoff, never given up) instead of being remembered as done. */
export type FitInput = {
  /** Height the content needs right now (px). */
  needed: number;
  /** Window height the main process last confirmed (px). */
  current: number;
  /** False until the real window settings arrive: placeholder settings must never be sent back (main rejects them). */
  ready: boolean;
};

export const RETRY_FIRST_MS = 50;
export const RETRY_MAX_MS = 5000;
/** Wait before retry number `failures` (1-based): 50 ms doubling to 5 s, and 5 s from then on. */
export const retryDelay = (failures: number): number => Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.max(0, Math.min(failures - 1, 20)));

export class WindowFit {
  private base: number | null = null;        // reference height before the first grow, to go back to
  private inflight: number | null = null;    // height currently being requested, awaiting the reply
  private unreachable: number | null = null; // main answered with another height for this one (screen clamp): not asked again until the content changes
  private failures = 0;

  /** The height to request now, or null when nothing needs sending. Call after every measurement. */
  plan({ needed, current, ready }: FitInput): number | null {
    if (!ready || this.inflight !== null) return null;
    let target: number | null = null;
    if (needed > current + 1) { target = needed; if (this.base === null) this.base = current; }
    else if (this.base !== null && needed <= this.base) target = this.base;
    if (target === null) return null;
    if (target === current) { if (this.base === current) this.base = null; return null; }
    if (target === this.unreachable) return null;
    this.inflight = target;
    return target;
  }
  /** Main acknowledged with the settings it now holds (height `applied`). */
  acked(applied: number): void {
    const asked = this.inflight; this.inflight = null; this.failures = 0;
    this.unreachable = asked !== null && applied !== asked ? asked : null;
    if (this.base !== null && applied === this.base) this.base = null;
  }
  /** The request was lost or refused. Returns how long to wait before measuring again; it keeps retrying until acknowledged. */
  failed(): number { this.inflight = null; this.failures++; return retryDelay(this.failures); }
  /** The content changed size or the window was focused: ask again right away, and restart the backoff. */
  contentChanged(): void { this.unreachable = null; this.failures = 0; }
}
