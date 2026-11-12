// Renderer side of the human check: one pending check at a time. The Publish dialog (or any port) awaits `run()`; the host
// component shows the dialog, and the answer is true only when the main process holds a server-cleared admission for that request.
type Listener = (open: boolean) => void;
let resolver: ((passed: boolean) => void) | null = null;
let aiCheck = false;
const listeners = new Set<Listener>();
export const humanCheck = {
  /** Opens the check. Resolves true after the server cleared the blocked request, false when the person keeps working locally. */
  run(opts?: { ai?: boolean }): Promise<boolean> {
    resolver?.(false);
    aiCheck = opts?.ai === true;
    return new Promise<boolean>(resolve => { resolver = resolve; for (const l of listeners) l(true); });
  },
  /** True when the main process asked for this check on behalf of a waiting AI request (it continues by itself once the check passes). */
  isAi(): boolean { return aiCheck; },
  finish(passed: boolean): void {
    const r = resolver; resolver = null;
    for (const l of listeners) l(false);
    r?.(passed);
  },
  subscribe(listener: Listener): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
