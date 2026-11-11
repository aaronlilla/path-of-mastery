import { useEffect, useRef, type RefObject } from 'react';

/** Ctrl+F is an area shortcut. While the Timelines area is the visible one, Ctrl+F pressed with focus
 *  outside the section (the top-bar Timelines button just clicked, a heading, empty space) runs `onFind`. Inside the section its own
 *  onKeyDown handles the key; dialogs and text fields keep their own Ctrl+F. Same rule as the Atlas area. */
export function useAreaFind(section: RefObject<HTMLElement | null>, onFind: () => void) {
  const find = useRef(onFind);
  find.current = onFind;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const area = section.current, target = event.target as HTMLElement | null;
      if (!area || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'f') return;
      if (!area.getClientRects().length || area.contains(target) || document.querySelector('[role="dialog"]')) return;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable) return;
      event.preventDefault();
      find.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [section]);
}
