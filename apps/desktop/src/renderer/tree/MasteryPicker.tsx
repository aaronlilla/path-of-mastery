// The mastery picker (design route 22): the tree dims, the mastery shows as a big ring where it sits on the tree, and its
// effects fan out beside it as cards on an arc. A card says what the effect changes in the calculation (the engine's number),
// an effect another copy of this mastery already took is locked with the side it sits on, and Remove un-allocates the node.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../ui';
import { nodeIcon } from './NodeTooltip';
import type { PassiveTree } from './PassiveTree';
import { reducedMotion, springEase } from './treeFx';
import { tr } from '../i18n';

type Detail = ReturnType<PassiveTree['masteryDetail']>;

const CARD_W = 364;
const CARD_GAP = 12;
const CARD_H = 74;

/** "north", "south-east"... of a point seen from another (screen y grows downward). */
export function compass(dx: number, dy: number): string {
  const a = (Math.atan2(-dy, dx) * 180) / Math.PI;
  const names = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
  return names[Math.round(((a + 360) % 360) / 45) % 8]!;
}

export function MasteryPicker({ detail: d, host, tree, calc, onChoose, onRemove, onClose }: { detail: Detail; host: HTMLElement | undefined; tree: PassiveTree | null; calc: (effectId: number) => Promise<string | null>; onChoose: (e: number) => void; onRemove: () => void; onClose: () => void }) {
  const taken = useMemo(() => new Map(d.sisters.filter((s) => s.eff !== undefined).map((s) => [s.eff!, s])), [d]);
  const [change, setChange] = useState<Record<number, string | null | undefined>>({});
  const [hover, setHover] = useState<number>(d.eff !== undefined ? d.effects.findIndex((e) => e.e === d.eff) : -1);
  useEffect(() => {
    let live = true;
    for (const e of d.effects) {
      if (d.eff === e.e || (taken.has(e.e) && d.eff !== e.e)) continue;
      void calc(e.e).then((t) => live && setChange((c) => ({ ...c, [e.e]: t })), () => live && setChange((c) => ({ ...c, [e.e]: null })));
    }
    return () => {
      live = false;
    };
  }, [d, taken]); // eslint-disable-line react-hooks/exhaustive-deps
  // Cards grow with their text; measure them so they stack with a gap and never overlap.
  const cardEls = useRef<Array<HTMLDivElement | null>>([]);
  const [heights, setHeights] = useState<number[]>([]);
  useLayoutEffect(() => {
    const h = d.effects.map((_, i) => cardEls.current[i]?.offsetHeight ?? CARD_H);
    setHeights((o) => (o.length === h.length && o.every((v, i) => v === h[i]) ? o : h));
  });
  // Motion (design: mpIntro, mpPick, mpCloseAnim). Every piece is WAAPI on transform and opacity; input is never blocked.
  const root = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const red = reducedMotion();
    if (red) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'ease', fill: 'backwards' });
      return;
    }
    const heavy = springEase('heavy');
    const glass = springEase('glass');
    const ease = 'cubic-bezier(.2,0,0,1)';
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out', fill: 'backwards' });
    const ring = el.querySelector('.tt-mp-ring svg') as SVGElement | null;
    if (ring) {
      const intro = ring.animate([{ transform: 'scale(.7) rotate(-40deg)', opacity: 0 }, { transform: 'scale(1) rotate(0deg)', opacity: 1 }], { duration: 520, easing: heavy, fill: 'backwards' });
      // The one ambient motion kept: the tick ring turns once per 90 s, only while the picker is open.
      intro.onfinish = () => {
        ring.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 90000, iterations: Infinity, easing: 'linear' });
      };
    }
    el.querySelector('.tt-mp-node')?.animate([{ transform: 'scale(.55)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 420, easing: heavy, fill: 'backwards' });
    const ringEl = el.querySelector('.tt-mp-ring') as HTMLElement | null;
    const ox = parseFloat(ringEl?.style.left ?? '0');
    const oy = parseFloat(ringEl?.style.top ?? '0');
    el.querySelectorAll<HTMLElement>('.tt-mp-card').forEach((c, i) => {
      const rot = c.style.transform || 'rotate(0deg)';
      const dx = (ox - (c.offsetLeft + c.offsetWidth / 2)) * 0.6;
      const dy = (oy - (c.offsetTop + c.offsetHeight / 2)) * 0.6;
      c.animate([{ transform: `translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px) scale(.6) ${rot}`, opacity: 0 }, { transform: rot, opacity: 1 }], { duration: 440, delay: 90 + 34 * i, easing: glass, fill: 'backwards' });
    });
    el.querySelector('.tt-mp-lines')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 160, easing: ease, fill: 'backwards' });
    el.querySelectorAll('.tt-mp-sis').forEach((c, i) => c.animate([{ opacity: 0, transform: 'translate(-50%,-50%) scale(.6)' }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1)' }], { duration: 300, delay: 260 + 40 * i, easing: glass, fill: 'backwards' }));
    el.querySelector('.tt-mp-keys')?.animate([{ opacity: 0, transform: 'translateX(-50%) translateY(6px)' }, { opacity: 1, transform: 'translateX(-50%) translateY(0)' }], { duration: 260, delay: 260, easing: ease, fill: 'backwards' });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** The picker leaves as a copy (the real one unmounts at once, so the engine edit and the tree never wait): the chosen card flies into the node, the rest fade. */
  const leave = (chosen?: number) => {
    const el = root.current;
    if (!el || !document.body.contains(el)) return;
    const copy = el.cloneNode(true) as HTMLElement;
    copy.style.pointerEvents = 'none';
    copy.querySelectorAll<HTMLElement>('*').forEach((n) => (n.style.pointerEvents = 'none'));
    document.body.appendChild(copy);
    const red = reducedMotion();
    const ringEl = copy.querySelector('.tt-mp-ring') as HTMLElement | null;
    const ox = parseFloat(ringEl?.style.left ?? '0');
    const oy = parseFloat(ringEl?.style.top ?? '0');
    const dur = red ? 120 : chosen === undefined ? 160 : 380;
    copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur, easing: red ? 'ease' : 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
    if (!red && chosen !== undefined) {
      copy.querySelectorAll<HTMLElement>('.tt-mp-card').forEach((c, i) => {
        if (i !== chosen) {
          c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' });
          return;
        }
        const rot = c.style.transform || 'rotate(0deg)';
        const dx = ox - (c.offsetLeft + c.offsetWidth / 2);
        const dy = oy - (c.offsetTop + c.offsetHeight / 2);
        c.animate([{ transform: rot, opacity: 1 }, { transform: `translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px) scale(.25) ${rot}`, opacity: 0.2 }], { duration: 380, easing: springEase('heavy'), fill: 'forwards' });
      });
    }
    window.setTimeout(() => copy.remove(), dur + 80);
  };
  const choose = (i: number) => {
    leave(i);
    onChoose(d.effects[i]!.e);
  };
  const shake = (c: HTMLElement) => {
    if (reducedMotion()) return;
    const rot = c.style.transform || 'rotate(0deg)';
    c.animate([{ transform: rot }, { transform: `${rot} translateX(-7px)` }, { transform: `${rot} translateX(6px)` }, { transform: `${rot} translateX(-4px)` }, { transform: `${rot} translateX(2px)` }, { transform: rot }], { duration: 320, easing: 'ease-out' });
  };
  const pickable = (i: number) => {
    const eff = d.effects[i];
    return !!eff && !(taken.has(eff.e) && d.eff !== eff.e) && (d.can || d.alloc);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const n = d.effects.length;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (/^[1-9]$/.test(e.key)) {
        if (pickable(Number(e.key) - 1)) choose(Number(e.key) - 1);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setHover((h) => ((h < 0 ? (step > 0 ? -1 : n) : h) + step + n) % n);
      } else if (e.key === 'Enter' && hover >= 0) {
        if (pickable(hover)) onChoose(d.effects[hover]!.e);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && d.alloc) onRemove();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  // Geometry follows the prototype: the ring sits over the node, the cards fan out on the side with room along an arc
  // (radius 320, 86 px apart, each tipped a little), and a curve joins every card to the ring.
  const r = host?.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const L = d.effects.length;
  const left = r?.left ?? 0;
  const top = r?.top ?? 0;
  const right = r?.right ?? vw;
  const bottom = r?.bottom ?? vh;
  const hs = d.effects.map((_, i) => heights[i] ?? CARD_H);
  const total = hs.reduce((a, b) => a + b, 0) + (L - 1) * CARD_GAP;
  const span = total / 2;
  let cx = left + d.sx;
  let cy = top + d.sy;
  const fitR = cx + 350 + CARD_W < right - 16;
  const fitL = cx - 350 - CARD_W > left + 24;
  if (!fitR && !fitL) cx = Math.max(left + 164, Math.min(right - 350 - CARD_W - 16, cx));
  cy = Math.max(top + span + 70, Math.min(bottom - span - 70, cy));
  const side = cx + 350 + CARD_W < right - 16 ? 1 : -1;
  const locked = !d.can && !d.alloc;
  let run = -total / 2;
  const cards = d.effects.map((e, i) => {
    const dy = run + hs[i]! / 2;
    run += hs[i]! + CARD_GAP;
    const ax = cx + side * (40 + Math.sqrt(Math.max(0, 320 * 320 - dy * dy)));
    const ay = cy + dy;
    return { e, i, ax, ay, x: Math.round(side > 0 ? ax : ax - CARD_W), y: Math.round(ay - hs[i]! / 2), rot: ((side * dy) / 205) * 1.1 };
  });
  const sisters = d.sisters
    .map((s) => {
      const sx = left + s.sx;
      const sy = top + s.sy;
      const x = Math.max(24, Math.min(vw - 24, sx));
      const y = Math.max(24, Math.min(vh - 24, sy));
      return { s, on: s.alloc && s.eff !== undefined, x, y, off: x !== sx || y !== sy };
    })
    .filter((t) => t.on)
    .slice(0, 8);
  const icon = tree ? nodeIcon(tree, d.id, 76) : undefined;
  const sub = locked ? tr('tree_MasteryPicker.allocate_a_passive_in_this') : d.alloc ? tr('tree_MasteryPicker.allocated_pick_another_to_swap') : tr('tree_MasteryPicker.choose_one_effect');
  const tone = (t: string) => (t.startsWith('-') ? 'var(--negative-text)' : 'var(--positive-text)');

  return createPortal(
    <div ref={root} className="tt-mp" role="dialog" aria-label={tr('tree_MasteryPicker.choose_a_mastery_effect')} onClick={() => { leave(); onClose(); }} style={{ background: `radial-gradient(circle at ${cx}px ${cy}px, rgba(var(--void-rgb), .18) 0, rgba(var(--void-rgb), .3) 150px, rgba(var(--void-rgb), .76) 480px)` }}>
      <svg className="tt-mp-lines" width={vw} height={vh} aria-hidden="true">
        {sisters.map(({ s, on, x, y }) => (
          <line key={s.id} x1={cx} y1={cy} x2={x} y2={y} stroke={on ? 'rgba(var(--mastery-rgb), .7)' : 'rgba(var(--line-rgb), .25)'} strokeWidth={1.2} strokeDasharray="2 6" strokeLinecap="round" />
        ))}
        {cards.map(({ e, ax, ay, i }) => {
          const a = Math.atan2(ay - cy, ax - cx);
          const x0 = cx + Math.cos(a) * 112;
          const y0 = cy + Math.sin(a) * 112;
          const mx = (x0 + ax) / 2;
          const sis = taken.get(e.e);
          const lock = !!sis && d.eff !== e.e;
          const on = (hover === i && !lock) || d.eff === e.e;
          return <path key={i} d={`M${x0.toFixed(1)} ${y0.toFixed(1)} C${mx.toFixed(1)} ${y0.toFixed(1)} ${mx.toFixed(1)} ${ay.toFixed(1)} ${ax.toFixed(1)} ${ay.toFixed(1)}`} fill="none" strokeLinecap="round" stroke={on ? 'rgba(var(--mastery-rgb), .8)' : lock ? 'rgba(var(--line-rgb), .12)' : 'rgba(var(--mastery-rgb), .28)'} strokeWidth={on ? 1.6 : 1} />;
        })}
      </svg>
      {sisters.map(({ s, on, x, y, off }) => {
        const lines = d.effects.find((e) => e.e === s.eff)?.s.join(' ') ?? '';
        const label = (off ? '↗ ' : '') + (lines.length > 58 ? lines.slice(0, 58).trim() + '…' : lines);
        return (
          <div key={s.id} className="tt-mp-sis" style={{ left: x, top: y }}>
            <span className="dot" style={{ width: off ? 10 : 30, height: off ? 10 : 30, borderColor: on ? 'rgba(var(--mastery-rgb), .7)' : 'rgba(var(--line-rgb), .25)', boxShadow: `0 0 14px ${on ? 'rgba(var(--mastery-rgb), .45)' : 'transparent'}` }} />
            {on && <span className="lab" style={{ transform: `translateX(${Math.max(110, Math.min(vw - 110, x)) - x}px)` }}>{label}</span>}
          </div>
        );
      })}
      <div className="tt-mp-ring" style={{ left: cx, top: cy }} onClick={(e) => e.stopPropagation()}>
        <svg width="260" height="260" viewBox="0 0 260 260" style={{ position: 'absolute', left: -130, top: -130, overflow: 'visible' }} aria-hidden="true">
          <circle cx="130" cy="130" r="124" stroke="rgba(var(--mastery-rgb), .28)" strokeWidth="1" fill="none" />
          <circle cx="130" cy="130" r="118" stroke="rgba(var(--mastery-rgb), .55)" strokeWidth="1.5" fill="none" strokeDasharray="1.5 7.9" />
          <path d="M130 2v10M130 248v10M2 130h10M248 130h10" stroke="var(--mastery-name)" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="130" cy="6" r="3" fill="var(--mastery-name)" />
        </svg>
        <div className="tt-mp-node">
          <span className="ico" style={icon} />
          <span className="nm">{d.node.n}</span>
          <span className="st" style={{ color: locked ? 'var(--mastery-name)' : 'var(--mastery-cap)' }}>{sub}</span>
        </div>
      </div>
      {cards.map(({ e, x, y, rot, i }) => {
        const sis = taken.get(e.e);
        const lock = !!sis && d.eff !== e.e;
        const mine = d.eff === e.e;
        const can = d.can || d.alloc;
        const on = hover === i && !lock;
        const c = change[e.e];
        const chip = lock ? tr('tree_MasteryPicker.taken_sy', { sy: compass(sis!.sx - d.sx, sis!.sy - d.sy) }) : mine ? tr('tree_MasteryPicker_2.allocated') : c === undefined ? tr('tree_MasteryPicker_2.calculating') : c ?? tr('tree_MasteryPicker.no_calc_change');
        const calc = !lock && !mine && typeof c === 'string';
        const chipColor = lock ? 'var(--mastery-cap)' : mine ? 'var(--mastery-name)' : calc ? tone(c!) : 'var(--mastery-cap)';
        const chipBg = lock ? 'rgba(var(--line-rgb), .06)' : mine ? 'rgba(var(--mastery-rgb), .14)' : calc ? 'rgba(79, 220, 124, .1)' : 'rgba(var(--line-rgb), .05)';
        return (
          <div
            key={e.e}
            ref={(el) => { cardEls.current[i] = el; }}
            role="button"
            tabIndex={-1}
            aria-disabled={lock || !can}
            aria-pressed={mine}
            className={'tt-mp-card' + (mine ? ' mine' : '') + (on ? ' on' : '')}
            style={{ left: x, top: y, width: CARD_W, transform: `rotate(${rot.toFixed(2)}deg)`, transformOrigin: side > 0 ? '0 50%' : '100% 50%', opacity: lock ? 0.72 : can ? 1 : 0.8, cursor: lock || !can ? 'not-allowed' : 'pointer', color: lock ? 'var(--mastery-cap)' : 'var(--mod-mastery)' }}
            onMouseEnter={() => setHover(i)}
            onClick={(ev) => {
              ev.stopPropagation();
              if (!lock && can) choose(i);
              else if (lock) shake(ev.currentTarget);
            }}
          >
            <span className="k" style={{ color: on || mine ? 'var(--mastery-name)' : 'var(--mastery-cap)' }}>{i + 1}</span>
            <span className="s">
              <span className="l">{e.s.map((l, j) => <span key={j}>{l}</span>)}</span>
              <span className="chip" style={{ color: chipColor, background: chipBg }}>{chip}</span>
            </span>
            {(lock || mine) && <span className="mark" style={{ color: lock ? 'var(--mastery-cap)' : 'var(--mastery-name)' }}><Icon name={lock ? 'lock' : 'check'} size={14} /></span>}
          </div>
        );
      })}
      <div className="tt-mp-keys" style={{ left: cx, top: cy + total / 2 + 28 }} onClick={(e) => e.stopPropagation()}>
        <span><span className="mono">1{'–'}{L}</span> {tr('tree_MasteryPicker.choose')}</span>
        <span><span className="mono">{tr('tree_MasteryPicker.esc')}</span> {tr('tree_MasteryPicker.close')}</span>
        {d.alloc && <button type="button" className="rm" onClick={onRemove}>{tr('tree_MasteryPicker.remove_mastery')} <span className="mono">{tr('tree_MasteryPicker.del')}</span></button>}
      </div>
    </div>,
    document.body,
  );
}
