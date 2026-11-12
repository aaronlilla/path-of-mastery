/** The one-line reason a write failed, as the Simple screens show it. A missing folder reads short; the full path stays in the tooltip. */
export function writeErrorText(o: { code: string; message: string }): string {
  return o.code === 'folder-missing' ? "Couldn't write: game folder not found." : `Couldn't write: ${o.message}`;
}

/**
 * How the Guided "Write to game" button looks. `busy` is the delayed writing flag (on only once a write
 * has run 200 ms), so a quick write leaves icon, label and key hint exactly as they were: nothing blinks.
 */
export function guidedWriteButton(s: { busy: boolean; firstWrite: boolean; pending: number }): { icon: 'spinner' | 'gamepad' | 'check'; label: string; kbd: boolean; quiet: boolean } {
  if (s.busy) return { icon: 'spinner', label: 'Writing…', kbd: false, quiet: true };
  const can = s.firstWrite || s.pending > 0;
  const label = s.firstWrite ? 'Write to game' : s.pending ? `Write ${s.pending} change${s.pending === 1 ? '' : 's'}` : 'Written';
  return { icon: can ? 'gamepad' : 'check', label, kbd: can, quiet: !can };
}
