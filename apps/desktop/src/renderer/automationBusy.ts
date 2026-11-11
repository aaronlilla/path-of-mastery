/** Engine work in flight (edits and the refresh after each), for scripted drivers that wait for the page to settle.
 *  Lives on globalThis so a driver can read window.__pomBusy; nothing in the UI reads it. */
const g = globalThis as { __pomBusy?: number };
export function busyCount(): number { return g.__pomBusy ?? 0; }
export function begin(): void { g.__pomBusy = busyCount() + 1; }
export function end(): void { g.__pomBusy = Math.max(0, busyCount() - 1); }
export async function track<T>(p: Promise<T>): Promise<T> {
  begin();
  try { return await p; } finally { end(); }
}
