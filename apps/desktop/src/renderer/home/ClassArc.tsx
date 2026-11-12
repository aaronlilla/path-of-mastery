import { useEffect, useRef, useState } from 'react';
import { CLASS_ARC, classPortrait } from '../art';
import { Icon } from '../ui';
import { tr } from '../i18n';

// Position of each class around the selected one: offset, scale, lift, opacity (from Build List.dc.html).
const X = [0, 154, 292, 414];
const S = [1, 0.886, 0.771, 0.657];
const Y = [40, 32, 18, 0];
const O = [1, 0.82, 0.62, 0.42];
const off = (i: number, sel: number) => ((((i - sel) % 7) + 7 + 3) % 7) - 3;
const mix = (c: string, p: number) => `color-mix(in srgb, ${c} ${p}%, transparent)`;

/** The seven class portraits on an arc, the selected one centred. Clicking the centred one (or Enter) starts a build of it. */
export function ClassArc({ onPick }: { onPick: (className: string) => void }) {
  const [sel, setSel] = useState(3);
  const [fresh, setFresh] = useState<number[]>([]);
  const [pulse, setPulse] = useState(false);
  const [drag, setDrag] = useState(false);
  const dragState = useRef({ down: false, x: 0, dragged: false, wheel: 0 });
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const go = (n: number) => {
    const next = ((n % 7) + 7) % 7;
    if (next === sel) return;
    // A class that jumps across the back of the arc fades in at its new place instead of flying through.
    setFresh(CLASS_ARC.map((_, i) => i).filter((i) => Math.abs(off(i, next) - off(i, sel)) > 3));
    setSel(next);
    timers.current.push(window.setTimeout(() => setFresh([]), 40));
  };
  const start = () => {
    setPulse(true);
    timers.current.push(
      window.setTimeout(() => {
        setPulse(false);
        onPick(CLASS_ARC[sel]!.name);
      }, 220),
    );
  };
  const arcKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(sel - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(sel + 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); start(); }
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(6);
  };
  const cur = CLASS_ARC[sel]!;

  return (
    <div className="arc-wrap">
      <div
        className="arc"
        tabIndex={0}
        role="group"
        aria-label={tr('home_ClassArc.choose_a_class_name_is', { name: cur.name })}
        style={{ cursor: drag ? 'grabbing' : 'grab' }}
        onKeyDown={arcKey}
        onPointerDown={(e) => { if (e.button !== 0) return; dragState.current = { ...dragState.current, down: true, x: e.clientX, dragged: false }; }}
        onPointerMove={(e) => {
          const d = dragState.current;
          if (!d.down) return;
          const dx = e.clientX - d.x;
          if (Math.abs(dx) > 70) {
            if (!d.dragged) {
              d.dragged = true;
              setDrag(true);
              try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
            }
            go(sel + (dx < 0 ? 1 : -1));
            d.x = e.clientX;
          }
        }}
        onPointerUp={() => { dragState.current.down = false; if (drag) setDrag(false); window.setTimeout(() => { dragState.current.dragged = false; }, 0); }}
        onPointerCancel={() => { dragState.current.down = false; setDrag(false); }}
        onWheel={(e) => {
          if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
          const t = Date.now();
          if (t - dragState.current.wheel < 320 || Math.abs(e.deltaX) < 8) return;
          dragState.current.wheel = t;
          go(sel + (e.deltaX > 0 ? 1 : -1));
        }}
      >
        {CLASS_ARC.map((c, i) => {
          const o = off(i, sel);
          const a = Math.abs(o);
          const f = fresh.includes(i);
          const colour = `var(--class-${c.name.toLowerCase()})`;
          const shadow =
            o === 0
              ? `0 0 0 2px ${colour}, 0 0 0 9px rgba(var(--shadow-rgb),calc(.5*var(--shadow-k))), 0 0 48px ${mix(colour, 40)}, 0 24px 48px rgba(var(--shadow-rgb),calc(.6*var(--shadow-k)))`
              : `0 0 0 1.5px ${mix(colour, 53)}, 0 0 0 8px rgba(var(--shadow-rgb),calc(.5*var(--shadow-k))), 0 0 20px ${mix(colour, 19)}, 0 20px 40px rgba(var(--shadow-rgb),calc(.6*var(--shadow-k)))`;
          return (
            <button
              key={c.name}
              type="button"
              className="arc-item"
              title={o === 0 ? tr('home_ClassArc.start_a_name_build', { name: c.name }) : c.name}
              aria-label={o === 0 ? tr('home_ClassArc.start_a_name_build', { name: c.name }) : c.name}
              data-centred={o === 0 || undefined}
              tabIndex={-1}
              onClick={() => { if (dragState.current.dragged) return; if (o === 0) start(); else go(i); }}
              style={{
                transform: `translate(${Math.sign(o) * X[a]!}px, ${-Y[a]!}px) scale(${S[a]})`,
                opacity: f ? 0 : O[a],
                zIndex: 10 - a,
                transition: f ? 'none' : 'transform .6s cubic-bezier(.22,.8,.24,1), opacity .45s',
              }}
            >
              <span className="img" style={{ backgroundImage: `url(${classPortrait(c.name)})`, boxShadow: shadow, transform: o === 0 && pulse ? 'scale(1.08)' : 'scale(1)' }} />
              <span className="nm" style={{ color: colour }}>{c.name}</span>
            </button>
          );
        })}
      </div>
      <div className="arc-nav">
        <button type="button" className="circ" data-lg="control" aria-label={tr('home_ClassArc.previous_class')} onClick={() => go(sel - 1)}>
          <Icon name="chevron-left" size={16} />
        </button>
        <div className="arc-dots">
          {CLASS_ARC.map((c, i) => (
            <button key={c.name} type="button" aria-label={c.name} title={c.name} onClick={() => go(i)} style={{ width: i === sel ? 22 : 6, background: i === sel ? `var(--class-${c.name.toLowerCase()})` : 'rgba(var(--line-rgb),.22)' }} />
          ))}
        </div>
        <button type="button" className="circ" data-lg="control" aria-label={tr('home_ClassArc.next_class')} onClick={() => go(sel + 1)}>
          <Icon name="chevron-right" size={16} />
        </button>
      </div>
      <span className="arc-cap">
        <b>{cur.name}</b> · {cur.attrs} · <span>{tr('home_ClassArc.click_or_press_enter_to')}</span>
      </span>
    </div>
  );
}
