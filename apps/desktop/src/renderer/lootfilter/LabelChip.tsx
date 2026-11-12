import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import type { LabelStyle } from '../../shared/lootfilter/types.js';
import { COLOUR_HEX, ICON_PX, SHAPE_PATH, gameLabelPx, rgba } from '../../shared/lootfilter/styles.js';
import { Icon } from '../ui';
import groundUrl from '../design/assets/ground-desert.webp';
import { tr } from '../i18n';
import { colourName, shapeName, sizeName } from './names';

/**
 * An item label drawn the way the game draws it: Fontin SmallCaps, square box, the filter's colours, with the
 * minimap icon, drop sound and beam beside it. Never themed: it is game art.
 */

export const GROUND_DARK = 'radial-gradient(120% 90% at 50% 40%,#2a2419,#0d0b08)';
export const GROUND_BRIGHT = 'radial-gradient(120% 90% at 50% 40%,#d8d2c4,#a9a292)';
export const GROUND_DESERT = `linear-gradient(rgba(12,10,8,.5),rgba(12,10,8,.6)),url(${groundUrl}) center/cover,#1a1712`;

/** Chips inside one FitGroup (a card) share one fitted text size: the smallest step any of them needed. */
const FitCtx = createContext<{ v: number; up: (n: number) => void; reset: () => void } | null>(null);
export function FitGroup({ children }: { children: ReactNode }) {
  const [v, setV] = useState(0);
  const up = useCallback((n: number) => setV((x) => (n > x ? n : x)), []);
  const reset = useCallback(() => setV(0), []);
  const val = useMemo(() => ({ v, up, reset }), [v, up, reset]);
  return <FitCtx.Provider value={val}>{children}</FitCtx.Provider>;
}

export function groundFor(kind: 'dark' | 'bright' | 'desert'): string {
  return kind === 'bright' ? GROUND_BRIGHT : kind === 'desert' ? GROUND_DESERT : GROUND_DARK;
}

export function Shape({ style, size }: { style: NonNullable<LabelStyle['icon']>; size?: number }) {
  const px = size ?? ICON_PX[style.size];
  return (
    <svg width={px} height={px} viewBox="0 0 10 10" style={{ flex: 'none' }} aria-hidden>
      <path d={SHAPE_PATH[style.shape] ?? SHAPE_PATH.Circle} fill={COLOUR_HEX[style.colour] ?? '#fff'} stroke="rgba(0,0,0,.75)" strokeWidth=".7" />
    </svg>
  );
}

export function Beam({ colour, temp, height = 14 }: { colour: string; temp?: boolean; height?: number }) {
  return <span aria-hidden style={{ flex: 'none', width: 3, height, borderRadius: 2, background: `linear-gradient(0deg,${COLOUR_HEX[colour] ?? '#fff'},transparent)`, opacity: temp ? 0.5 : 1 }} />;
}

export function fxTip(s: LabelStyle): string {
  const parts: string[] = [];
  if (s.sound) parts.push(s.sound.kind === 'builtin' ? tr('lootfilter_LabelChip.sound_id_volume_vol', { id: s.sound.id, vol: s.sound.vol }) : tr('lootfilter_LabelChip.custom_sound_file', { file: s.sound.file }));
  if (s.icon) parts.push(tr('h_lootB_Names.minimap_icon', { size: sizeName(s.icon.size), colour: colourName(s.icon.colour), shape: shapeName(s.icon.shape) }));
  if (s.beam) parts.push(tr(s.beam.temp ? 'h_lootB_Names.beam_colour_temp' : 'h_lootB_Names.beam_colour', { colour: colourName(s.beam.colour) }));
  return parts.join(' · ');
}

export interface LabelChipProps {
  name: string;
  style: LabelStyle;
  /** Font size in CSS pixels. The Overview draws every label at 24; Guided scales the game size. */
  fontPx?: number;
  /** Scale the game font size instead (Guided draws labels at 0.5 of the game size, 10px at least, so four different game sizes draw at four different pixel sizes). */
  scale?: number;
  hidden?: boolean;
  /** How a hidden label is drawn: a dashed box (Guided) or faded (Advanced). */
  hiddenLook?: 'dashed' | 'fade';
  hidTag?: string;
  price?: string;
  locked?: boolean;
  selected?: boolean;
  /** A small gold dot: this label was changed by the player. */
  changed?: boolean;
  bright?: boolean;
  /** Effects (icon, sound, beam) inside the box (Guided) or beside it (Advanced). */
  fxInside?: boolean;
  title?: string;
  onClick?: (e: MouseEvent) => void;
  onDoubleClick?: (e: MouseEvent) => void;
  onMenu?: (e: MouseEvent) => void;
  onContextMenu?: (e: MouseEvent) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  menuLabel?: string;
  menuVisible?: boolean;
  extra?: ReactNode;
  disabled?: boolean;
  style_?: CSSProperties;
  /** Shrink the text a step at a time until the whole name fits the room it has, instead of cutting it with an ellipsis. */
  autoFit?: boolean;
}

const FONT = "'Fontin SmallCaps','Cormorant SC',Georgia,serif";
/** Fontin SmallCaps has no glyphs for the ffi, ffl and fi ligatures, so "Efficacy" drew with holes. Must come after the font shorthand, which resets it. */
const NO_LIGATURES = { fontVariantLigatures: 'none', fontFeatureSettings: '"liga" 0, "clig" 0' } as const;

export function LabelChip(p: LabelChipProps) {
  const s = p.style;
  const [shrink, setShrink] = useState(0);
  const [, bump] = useState(0);
  const grp = useContext(FitCtx);
  const nameRef = useRef<HTMLSpanElement>(null);
  const fs0 = p.fontPx ?? (p.scale ? Math.max(10, Math.round(Math.max(18, Math.min(45, s.fs ?? 32)) * p.scale)) : gameLabelPx(s.fs));
  const search = useRef<{ lo: number; hi: number } | null>(null);
  // While its own search runs a chip measures at its own step; the group's shared step applies only once it is done.
  const eff = search.current ? shrink : Math.max(shrink, grp?.v ?? 0);
  const fs = eff ? Math.max(14, fs0 - eff) : fs0;
  // The text shrinks 2px at a time until the name fits or reaches 14px; the answer is the smallest such step. Stepping one
  // render at a time took up to 15 renders and page layouts per chip (the Loot Filter's Full view spent 130 ms on it), so
  // the step is found by halving the range instead: the same answer, since a smaller font never fits worse.
  useLayoutEffect(() => {
    if (!p.autoFit) return;
    const el = nameRef.current;
    if (!el) return;
    // A group reset by another chip learns this chip's step again.
    if (!search.current && grp && shrink > grp.v) grp.up(shrink);
    const done = !(el.scrollWidth > el.clientWidth + 1) || fs <= 14;
    if (!search.current) {
      if (done) return;
      // lo: a step known not to fit; hi: a step known to stop (the first one that reaches 14px).
      search.current = { lo: shrink, hi: Math.max(shrink + 2, Math.ceil((fs0 - 14) / 2) * 2) };
    } else if (done) search.current.hi = shrink;
    else search.current.lo = shrink;
    const { lo, hi } = search.current;
    if (hi - lo <= 2) {
      search.current = null;
      if (shrink !== hi) setShrink(hi);
      else if (grp && grp.v > hi) bump((x) => x + 1); // render once more at the group's larger step
      grp?.up(hi);
      return;
    }
    setShrink(lo + Math.max(2, Math.floor((hi - lo) / 4) * 2));
  });
  useLayoutEffect(() => {
    search.current = null;
    setShrink(0);
    grp?.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.name, fs0, p.style.fs]);
  // The room a chip has changes with the window, the inspector and the section; measure again whenever its container's width changes.
  useLayoutEffect(() => {
    if (!p.autoFit) return;
    const box = nameRef.current?.closest('.lf-chip')?.parentElement;
    if (!box || typeof ResizeObserver === 'undefined') return;
    let w = box.clientWidth;
    const ro = new ResizeObserver(() => {
      if (Math.abs(box.clientWidth - w) < 2) return;
      w = box.clientWidth;
      search.current = null;
      setShrink(0);
      grp?.reset();
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, [p.autoFit]);
  const h = Math.round(fs * 1.36);
  const padX = Math.max(3, Math.round(fs * 0.2));
  const hid = !!p.hidden;
  const dashed = hid && (p.hiddenLook ?? 'fade') === 'dashed';
  const gl = p.bright ? 'rgba(24,20,14,.8)' : 'rgba(255,240,215,.85)';
  const gt = p.bright ? 'rgba(24,20,14,.72)' : 'rgba(255,240,215,.62)';
  const showFx = !hid || p.hiddenLook === 'fade';
  const inside = !!p.fxInside && !hid;
  const body: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: inside ? 4 : 0,
    height: h,
    padding: `0 ${padX}px`,
    boxSizing: 'border-box',
    border: `1px ${dashed ? 'dashed' : 'solid'} ${dashed ? 'rgba(255,255,255,.35)' : rgba(s.bd ?? [0, 0, 0, 0])}`,
    borderRadius: 0,
    background: dashed ? 'rgba(0,0,0,.35)' : rgba(s.bg ?? [0, 0, 0, 150]),
    color: dashed ? 'rgba(255,255,255,.62)' : rgba(s.fg ?? [200, 200, 200]),
    font: `400 ${fs}px/1 ${FONT}`,
    ...NO_LIGATURES,
    whiteSpace: 'nowrap',
    maxWidth: '100%',
    minWidth: 0,
    cursor: p.onClick ? 'pointer' : 'default',
    outline: p.selected ? '2px solid var(--gold-400)' : 'none',
    outlineOffset: 2,
    textDecoration: hid ? 'line-through' : 'none',
    opacity: hid && !dashed ? 0.45 : 1,
    ...(p.style_ ?? {}),
  };
  const Tag = p.onClick || p.onDoubleClick ? 'button' : 'span';
  const fx = showFx && (s.icon || s.sound || s.beam);
  return (
    <span
      className="lf-chip"
      draggable={p.draggable || undefined}
      onDragStart={p.onDragStart}
      onDragEnd={p.onDragEnd}
      onMouseEnter={p.onMouseEnter}
      onMouseLeave={p.onMouseLeave}
      onContextMenu={p.onContextMenu}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%', minWidth: 0 }}
    >
      {Tag === 'button' ? (
        <button type="button" onClick={p.onClick} onDoubleClick={p.onDoubleClick} title={p.title} style={body} disabled={p.disabled}>
          {inside && s.icon && <Shape style={s.icon} />}
          <span ref={nameRef} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
          {inside && s.sound && <Icon name="volume-low" size={Math.round(fs * 0.5)} style={{ flex: 'none', opacity: 0.85 }} />}
          {inside && s.beam && <Beam colour={s.beam.colour} temp={s.beam.temp} height={Math.round(fs * 0.7)} />}
        </button>
      ) : (
        <span title={p.title} style={body}>
          {inside && s.icon && <Shape style={s.icon} />}
          <span ref={nameRef} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
          {inside && s.sound && <Icon name="volume-low" size={Math.round(fs * 0.5)} style={{ flex: 'none', opacity: 0.85 }} />}
          {inside && s.beam && <Beam colour={s.beam.colour} temp={s.beam.temp} height={Math.round(fs * 0.7)} />}
        </span>
      )}
      {!inside && fx && (
        <span title={fxTip(s)} style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 1px' }}>
          {s.icon && <Shape style={s.icon} />}
          {s.sound && <Icon name="volume-low" size={13} style={{ flex: 'none', color: gl }} />}
          {s.beam && <Beam colour={s.beam.colour} temp={s.beam.temp} />}
        </span>
      )}
      {p.locked && <Icon name="lock" size={12} style={{ flex: 'none', color: gl }} />}
      {p.price && <span style={{ flex: 'none', font: '500 11px Geist', color: gt, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{p.price}</span>}
      {p.hidTag && hid && <span style={{ flex: 'none', font: '500 10.5px Geist', padding: '1px 5px', borderRadius: 4, border: `1px dashed ${gt}`, color: gt, whiteSpace: 'nowrap' }}>{p.hidTag}</span>}
      {p.changed && <span aria-label={tr('lootfilter_LabelChip.changed_by_you')} title={tr('lootfilter_LabelChip.changed_by_you')} style={{ position: 'absolute', right: -3, top: -3, width: 7, height: 7, borderRadius: '50%', background: 'var(--gold-400)', boxShadow: '0 0 0 1.5px rgba(0,0,0,.7)' }} />}
      {p.onMenu && (
        <button
          type="button"
          className="lf-chip-menu"
          title={p.menuLabel ?? tr('lootfilter_LabelChip.actions')}
          aria-label={p.menuLabel ?? tr('lootfilter_LabelChip.actions')}
          onClick={p.onMenu}
          style={{ flex: 'none', width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, borderRadius: 6, background: 'rgba(255,255,255,.1)', color: gl, cursor: 'pointer', opacity: p.menuVisible ? 1 : 0 }}
        >
          <Icon name="more" size={12} />
        </button>
      )}
      {p.extra}
    </span>
  );
}
