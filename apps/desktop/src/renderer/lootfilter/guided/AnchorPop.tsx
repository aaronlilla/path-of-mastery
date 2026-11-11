import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A popover that hangs under whatever element holds it, drawn on the document body so no parent
 * (the 32 px title bar, a scroller, an overflow-hidden panel) can clip it. It follows its anchor on
 * resize and scroll, flips above the anchor when there is no room below, and never leaves the window.
 * Its container carries data-lf-pop so click-outside handlers can tell a click inside it.
 */
export function AnchorPop({ align = 'left', width, className = 'gd-pop', children, ...rest }: { align?: 'left' | 'right'; width?: number; className?: string; children: ReactNode } & Record<string, unknown>) {
  const marker = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    const place = (): void => {
      const a = marker.current?.parentElement;
      const b = box.current;
      if (!a || !b) return;
      const r = a.getBoundingClientRect();
      const w = width ?? b.offsetWidth;
      const h = b.scrollHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const left = Math.max(8, Math.min(align === 'right' ? r.right - w : r.left, vw - w - 8));
      const below = vh - (r.bottom + 8) - 8;
      const above = r.top - 8 - 8;
      const up = h > below && above > below;
      const room = Math.max(120, up ? above : below);
      const used = Math.min(h, room);
      const top = up ? r.top - 8 - used : r.bottom + 8;
      setPos((p) => (p && p.left === left && p.top === top && p.maxHeight === room ? p : { left, top, maxHeight: room }));
    };
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    const ro = new ResizeObserver(place);
    if (box.current) ro.observe(box.current);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
      ro.disconnect();
    };
  }, [align, width]);
  const style: CSSProperties = {
    position: 'fixed',
    right: 'auto',
    left: pos?.left ?? 0,
    top: pos?.top ?? 0,
    zIndex: 400,
    maxHeight: pos?.maxHeight,
    overflowY: 'auto',
    visibility: pos ? 'visible' : 'hidden',
    ...(width ? { width } : null),
    // The placement above uses `width` as the whole box; padding inside it must not push the box past the window edge.
    boxSizing: 'border-box',
    maxWidth: 'calc(100vw - 16px)',
  };
  return (
    <>
      <span ref={marker} style={{ display: 'none' }} />
      {createPortal(
        <div ref={box} className={`lf-portal text-aa ${className}`} data-lf-pop="" style={style} {...rest}>
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}
