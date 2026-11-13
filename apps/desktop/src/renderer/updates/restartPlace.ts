// Restart now reopens the build the player was on. The page stashes its place just before main restarts the app and
// takes it back at the next start (the same state an interface swap hands over; see App.tsx __pomRestoreState).
const KEY = 'pom-reopen-after-restart';

export function stashPlace(state: unknown, store: Pick<Storage, 'setItem'> = localStorage): void {
  try { store.setItem(KEY, JSON.stringify(state)); } catch { /* per-viewer convenience only */ }
}

export function dropPlace(store: Pick<Storage, 'removeItem'> = localStorage): void {
  try { store.removeItem(KEY); } catch { /* nothing stashed */ }
}

/** The stashed place, once: it is removed as it is read, so a normal start never reopens an old one. */
export function takePlace(store: Pick<Storage, 'getItem' | 'removeItem'> = localStorage): unknown {
  try {
    const raw = store.getItem(KEY);
    store.removeItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
