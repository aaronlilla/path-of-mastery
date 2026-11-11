import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDismiss } from '../../../ui';

/** A glass menu at viewport coordinates (a right-click, or under a button). Closes on outside press, Escape, scroll and resize. */
export function FloatMenu({ at, onClose, width = 240, label, children, onKey }: { at: { x: number; y: number }; onClose: () => void; width?: number; label?: string; children: ReactNode; onKey?: (e: KeyboardEvent) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const h = m.offsetHeight;
    const left = Math.max(8, Math.min(at.x, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(at.y, window.innerHeight - h - 8));
    setPos({ left, top });
  }, [at.x, at.y, width, children]);
  // Registers the menu as a popup layer: Escape and an outside press close it through the app's shared mechanism.
  useDismiss(ref, true, onClose, true);
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') onKey?.(e);
    };
    const scroll = (e: Event): void => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', onClose);
    document.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', onClose);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [onClose, onKey]);
  return createPortal(
    <div ref={ref} className="menu portal adv-sh-float" data-lg="pop" data-solid="" role="menu" aria-label={label} style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, width, minWidth: 0, visibility: pos ? 'visible' : 'hidden', maxHeight: 'calc(100vh - 16px)' }}>
      {children}
    </div>,
    document.body,
  );
}
