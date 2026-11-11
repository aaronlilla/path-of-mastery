import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { setHighlight, useHighlight } from './bus';
import { tr } from '../i18n';

/** The element a tab marked for the current highlight, if it is on screen. */
function marked(): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('[data-assistant-highlight]')) if (el.getClientRects().length) return el;
  return null;
}

/** Where the chip sits when the panel's thread is not on screen (panel closed, or the Connector or Solve view): a corner of the window. */
function floatHost(): HTMLElement {
  let el = document.getElementById('asst-chip-float');
  if (!el) {
    el = document.createElement('div');
    el.id = 'asst-chip-float';
    document.body.appendChild(el);
  }
  return el;
}
const hostNow = () => document.getElementById('asst-chip-slot') ?? floatHost();

/**
 * The caption chip for what the assistant changed or pointed at ("Added by assistant: ..." with Undo). The tab draws
 * the glow ring on the element (data-assistant-highlight); this scrolls it into view once. The chip itself sits in the
 * assistant panel between the answer and the question box, so it never covers a tab's content or the answer.
 * With the thread hidden it moves to a corner of the window (asst-chip-float) so the change and its Undo stay visible.
 * It stays until the player clicks anywhere else.
 */
export function HighlightChip() {
  const h = useHighlight();
  const box = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!h) return;
    setSlot(hostNow());
    // the panel can open, close or switch view while the chip is up: follow the slot
    // a light poll, not a MutationObserver on the whole document (that would run on every DOM change while the chip is up)
    const follow = window.setInterval(() => setSlot(hostNow()), 300);
    let raf = 0;
    const t0 = performance.now();
    // The tab may still be loading the change: look for the marked element for a while, then scroll to it once.
    const find = () => {
      const el = marked();
      if (!el && performance.now() - t0 < 2500) { raf = requestAnimationFrame(find); return; }
      // Tree rings sit on a canvas the tree tab already framed; scrolling would move the canvas.
      if (el && !el.hasAttribute('data-asst-ring')) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    raf = requestAnimationFrame(find);
    // Any click outside the chip puts the highlight away.
    const away = (e: PointerEvent) => {
      if (box.current && e.target instanceof Node && box.current.contains(e.target)) return;
      // the panel's header (Collapse, Solve, provider) only moves the thread out of sight: the chip has to survive that click, its host follows
      if (e.target instanceof Element && e.target.closest('.ap .hd')) return;
      setHighlight(null);
    };
    window.addEventListener('pointerdown', away, true);
    return () => {
      window.clearInterval(follow);
      cancelAnimationFrame(raf);
      window.removeEventListener('pointerdown', away, true);
    };
  }, [h]);

  if (!h || !slot) return null;
  return createPortal(
    <div ref={box} className="asst-chip" role="status" data-lg="pop">
      <span className="spark" aria-hidden>✦</span>
      <span className="txt">
        <b>{h.head}</b>
        <span>{h.text}</span>
      </span>
      {h.undo && (
        <button type="button" className="btn ghost sm" onClick={() => { h.undo!(); setHighlight(null); }}>
          
          {tr('assistant_HighlightChip.undo')}
        </button>
      )}
    </div>,
    slot,
  );
}
