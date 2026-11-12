import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export interface WindowRange {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
}

/** The rows of a long list that are on screen (plus a few either side) and the space the rest takes up. */
export function windowRange(count: number, pitch: number, top: number, height: number, overscan = 10): WindowRange {
  if (count <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const first = Math.max(0, Math.floor(top / pitch) - overscan);
  const last = Math.min(count, Math.ceil((top + Math.max(height, pitch)) / pitch) + overscan);
  const start = Math.min(first, Math.max(0, count - 1));
  const end = Math.max(start, last);
  return { start, end, padTop: start * pitch, padBottom: (count - end) * pitch };
}

/**
 * Draws only the rows that are visible in a scrolling box, so a list of thousands (the 1137 uniques) is all reachable
 * without drawing it all at once. Attach `ref` and `onScroll` to the scrolling element.
 */
export function useWindowedRows(count: number, pitch: number, resetKey: string | number = 0) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const read = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
  }, []);
  useLayoutEffect(() => {
    read();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [read, count, resetKey]);
  return { ref, onScroll: read, range: windowRange(count, pitch, view.top, view.height) };
}
