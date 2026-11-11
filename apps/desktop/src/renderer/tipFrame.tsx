// What every hover tooltip shares: the Alt state (hold Alt for the full details) and the hint line. The frame, header
// band and dividers are the `tt-*` rules in tipFrame.css.
import { useEffect, useSyncExternalStore } from 'react';
import './tipFrame.css';
import { tr } from './i18n';

let altDown = false;
let open = 0;
const subs = new Set<() => void>();
function set(v: boolean) {
  if (v === altDown) return;
  altDown = v;
  subs.forEach((f) => f());
}
if (typeof window !== 'undefined') {
  // Always listening: Alt may already be held when a tooltip opens. Alt alone must not focus Electron's menu bar,
  // so its keydown and keyup are cancelled, but only while a tooltip is open.
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'Alt') return;
    if (open > 0) e.preventDefault();
    set(e.type === 'keydown');
  };
  window.addEventListener('keydown', key, true);
  window.addEventListener('keyup', key, true);
  window.addEventListener('blur', () => set(false));
  // A key press the page missed (Alt released over another window) is corrected by the next pointer move.
  window.addEventListener('pointermove', (e) => set(e.altKey), true);
}
const sub = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};

/** True while Alt is held. Call it inside a tooltip (or with `active` true while one shows): it also keeps Alt from reaching the menu bar. */
export function useAltHeld(active = true): boolean {
  useEffect(() => {
    if (!active) return;
    open += 1;
    return () => void (open -= 1);
  }, [active]);
  return useSyncExternalStore(sub, () => altDown) && active;
}

/** The one muted line at the bottom of a default tooltip. */
export function AltHint() {
  return <div className="tt-alt">{tr('tipFrame.hold_alt_for_details')}</div>;
}
