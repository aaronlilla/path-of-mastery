// Main registers the mastery handlers (Atlas, Timelines, Marketplace) only after their stores open; Atlas first validates its
// bundled tree data, 10-20 s on a busy PC. A renderer call made before that used to fail at once with Electron's
// "No handler registered", and the area then showed its empty state ("Download tree data to create this plan.") for the
// rest of the session. Calls now wait for the handler, up to HANDLER_WAIT_MS.
export const HANDLER_WAIT_MS = 60_000;
export const notRegistered = (e: unknown): boolean => /No handler registered/.test(String((e as Error | null)?.message ?? e));

export async function withHandlerWait<T>(call: () => Promise<T>, waitMs = HANDLER_WAIT_MS, sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms)), now = () => Date.now()): Promise<T> {
  const until = now() + waitMs;
  for (let delay = 100; ; delay = Math.min(delay * 2, 1000)) {
    try { return await call(); }
    catch (e) { if (!notRegistered(e) || now() + delay > until) throw e; await sleep(delay); }
  }
}
