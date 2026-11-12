import type { GemTip, ItemInfo, StatDelta, TooltipLine } from '@pom/protocol';
import { portal } from '../Freeze';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { artFor } from '../gameArt';
import { AltHint, useAltHeld } from '../tipFrame';
import { Icon, PortalMenu } from '../ui';
import { colourOf, GemTooltipView, ItemTooltip } from './ItemTooltip';
import { compareLines, type SkillKind } from './statCompare';
import { wikiUrl } from './wiki';
import { tr } from '../i18n';

/** The art for an item: its own for uniques, its base's otherwise. */
export function itemArt(info: Pick<ItemInfo, 'rarity' | 'artName' | 'baseName'> | undefined): string | undefined {
  if (!info) return undefined;
  if (info.rarity === 'UNIQUE' || info.rarity === 'RELIC') return artFor(info.artName, 'uniques') ?? artFor(info.baseName, 'bases');
  return artFor(info.baseName, 'bases');
}

export function rarityColour(info: Pick<ItemInfo, 'headerRarity'> | undefined): string | undefined {
  return colourOf(info?.headerRarity);
}

// ---- hover tooltips -------------------------------------------------------------------------------------------

export interface TipCompare {
  /** The block's heading ("Equipping this item in Ring 1 will give you:"). */
  header: string;
  /** The item the change replaces, shown under the heading. */
  replacing?: { name: string; colour?: string };
  load: () => Promise<StatDelta[]>;
  /** What decides the order of several blocks: empty slots first, then like items (`AddItemStatDifferences`). */
  rank?: { empty: boolean; similar: boolean; label: string };
}

export interface TipSpec {
  /** An item's tooltip. */
  info?: ItemInfo;
  /** Plain lines (a modifier's text) drawn instead of an item. */
  lines?: Array<{ text: string; colour?: string }>;
  /** Stat changes: one block per slot, or one for a flask switched on or off. */
  compares?: TipCompare[];
  /** Said instead of the blocks when there is nothing to show (stat differences are off). */
  note?: string;
  /** "Effective flask stats": the flask's recovery and charge lines with the build's modifiers, from the engine. */
  effective?: { title: string; load: () => Promise<TooltipLine[]> };
  /** The tooltips of the skills the item grants, drawn beside this one while Shift is held. */
  granted?: () => Promise<GemTip[]>;
  /** How many skills the item grants (for the "Hold Shift" tip). */
  grantedCount?: number;
  /** Next-league preview: the note block under a unique the patch notes change. */
  pv?: ReactNode;
}

type Block = { c: TipCompare; lines: ReturnType<typeof compareLines> | null; stats: StatDelta[] | null };

interface TipLoaded {
  blocks: Block[];
  effective: TooltipLine[] | null;
  granted: GemTip[] | null;
}

const EMPTY_LOADED: TipLoaded = { blocks: [], effective: null, granted: null };

/** The order of compare blocks: empty slots first, then like items, then the stronger result (`AddItemStatDifferences`). */
export function orderBlocks(blocks: Block[], stats: Record<string, number | string | boolean | null>): Block[] {
  const after = (b: Block, id: string) => {
    const d = b.stats?.find((x) => x.statId === id);
    const v = d ? d.after : stats[id];
    return typeof v === 'number' ? v : 0;
  };
  return [...blocks].sort((a, b) => {
    const ra = a.c.rank;
    const rb = b.c.rank;
    if (!ra || !rb) return 0;
    if (ra.empty !== rb.empty) return ra.empty ? -1 : 1;
    if (ra.similar !== rb.similar) return ra.similar ? -1 : 1;
    for (const id of ['FullDPS', 'CombinedDPS', 'TotalEHP']) {
      const x = after(a, id);
      const y = after(b, id);
      if (x !== y) return y > x ? 1 : -1;
    }
    return ra.label.localeCompare(rb.label);
  });
}

export function useHoverTip(kind: SkillKind, stats: Record<string, number | string | boolean | null> = {}) {
  const [tip, setTip] = useState<{ spec: TipSpec; rect: DOMRect } | null>(null);
  const [loaded, setLoaded] = useState<TipLoaded>(EMPTY_LOADED);
  const [shift, setShift] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const live = useRef(0);
  const anchorEl = useRef<Element | null>(null);
  const statsRef = useRef(stats);
  statsRef.current = stats;
  const kindRef = useRef(kind);
  kindRef.current = kind;

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    live.current += 1;
    setTip(null);
    setLoaded(EMPTY_LOADED);
  }, []);

  const show = useCallback((el: Element, spec: TipSpec) => {
    window.clearTimeout(timer.current);
    const mine = ++live.current;
    anchorEl.current = el;
    const rect = el.getBoundingClientRect();
    timer.current = window.setTimeout(() => {
      if (mine !== live.current) return;
      setTip({ spec, rect });
      const compares = spec.compares ?? [];
      setLoaded({ blocks: compares.map((c) => ({ c, lines: null, stats: null })), effective: null, granted: null });
      void (async () => {
        const done: Block[] = compares.map((c) => ({ c, lines: null, stats: null }));
        for (let i = 0; i < compares.length; i++) {
          const c = compares[i]!;
          let changed: StatDelta[] = [];
          try {
            changed = await c.load();
          } catch {
            changed = [];
          }
          if (mine !== live.current) return;
          done[i] = { c, lines: compareLines(changed, kindRef.current), stats: changed };
          setLoaded((l) => ({ ...l, blocks: [...done] }));
        }
      })();
      if (spec.effective) {
        spec.effective
          .load()
          .then((e) => mine === live.current && setLoaded((l) => ({ ...l, effective: e })))
          .catch(() => mine === live.current && setLoaded((l) => ({ ...l, effective: [] })));
      }
    }, 120);
  }, []);

  // Holding Shift shows the tooltips of the skills an item grants.
  // A layout effect: React takes it down while the tab is kept hidden (Freeze), so these keys only act on the tab on screen.
  useLayoutEffect(() => {
    if (!tip?.spec.granted) return;
    const down = (e: KeyboardEvent) => e.key === 'Shift' && setShift(true);
    const up = (e: KeyboardEvent) => e.key === 'Shift' && setShift(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      setShift(false);
    };
  }, [tip]);
  useEffect(() => {
    if (!shift || !tip?.spec.granted || loaded.granted) return;
    const mine = live.current;
    tip.spec
      .granted()
      .then((g) => mine === live.current && setLoaded((l) => ({ ...l, granted: g })))
      .catch(() => mine === live.current && setLoaded((l) => ({ ...l, granted: [] })));
  }, [shift, tip, loaded.granted]);

  // F1 over an item opens its page on the wiki (`itemLib.wiki`).
  // A layout effect: React takes it down while the tab is kept hidden (Freeze), so these keys only act on the tab on screen.
  useLayoutEffect(() => {
    const info = tip?.spec.info;
    if (!info) return;
    const up = (e: KeyboardEvent) => {
      if (e.key !== 'F1') return;
      e.preventDefault();
      void window.pom.app.openExternal(wikiUrl(info));
    };
    window.addEventListener('keyup', up);
    return () => window.removeEventListener('keyup', up);
  }, [tip]);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  // A tooltip never outlives its pointer: a row that is re-drawn or removed under the pointer, or a pointer that
  // leaves the window quickly, can miss `mouseleave`, so the pointer is checked against the anchor as it moves.
  // A layout effect: React takes it down while the tab is kept hidden (Freeze), so it only listens for the tab on screen.
  useLayoutEffect(() => {
    if (!tip) return;
    const move = (e: MouseEvent) => {
      const el = anchorEl.current;
      if (!el || !el.isConnected) return hide();
      const r = el.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) hide();
    };
    const out = (e: MouseEvent) => {
      if (!e.relatedTarget) hide();
    };
    document.addEventListener('mousemove', move, true);
    document.documentElement.addEventListener('mouseleave', hide);
    document.addEventListener('mouseout', out, true);
    return () => {
      document.removeEventListener('mousemove', move, true);
      document.documentElement.removeEventListener('mouseleave', hide);
      document.removeEventListener('mouseout', out, true);
    };
  }, [tip, hide]);
  // A layout effect: React takes it down while the tab is kept hidden (Freeze), so it only listens for the tab on screen.
  useLayoutEffect(() => {
    const k = () => hide();
    window.addEventListener('blur', k);
    document.addEventListener('scroll', k, true);
    return () => {
      window.removeEventListener('blur', k);
      document.removeEventListener('scroll', k, true);
    };
  }, [hide]);

  const node = tip ? <TipPortal spec={tip.spec} rect={tip.rect} loaded={loaded} shift={shift} stats={statsRef.current} /> : null;
  return { show, hide, node };
}

function TipPortal({ spec, rect, loaded, shift, stats }: { spec: TipSpec; rect: DOMRect; loaded: TipLoaded; shift: boolean; stats: Record<string, number | string | boolean | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const showGranted = shift && Boolean(spec.granted);
  // Hold Alt for the full details; without it the item card and the stat changes.
  const alt = useAltHeld();
  const grantRef = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState(false);
  // The skill tooltips sit beside the item's; with no room on the right they go to its left.
  useLayoutEffect(() => {
    const g = grantRef.current;
    if (!showGranted || !g || !ref.current) return;
    const main = ref.current.getBoundingClientRect();
    setFlip(main.right + 8 + g.offsetWidth > window.innerWidth - 8 && main.left - 8 - g.offsetWidth >= 8);
  }, [showGranted, loaded.granted, pos]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 10;
    let left = rect.right + gap;
    if (left + w > window.innerWidth - 8) left = Math.max(8, rect.left - gap - w);
    let top = rect.top;
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - h);
    setPos({ left, top });
  }, [rect, spec, loaded, showGranted, alt]);
  const blocks = orderBlocks(loaded.blocks, stats);
  const pending = blocks.some((b) => b.lines === null);
  const withLines = blocks.filter((b) => b.lines && b.lines.length > 0);
  const totalLines = withLines.reduce((n, b) => n + (b.lines?.length ?? 0), 0);
  const compareNode = spec.compares ? (
    <div className="it-tt-cmp">
      {pending && withLines.length === 0 ? (
        <div className="c" style={{ color: 'var(--text-faint)' }}>{tr('items_parts.calculating')}</div>
      ) : withLines.length === 0 ? (
        <>
          <div className="h">{spec.compares[0]?.header}</div>
          <div className="c" style={{ color: 'var(--text-faint)' }}>{tr('items_parts.no_changes_to_the_build')}</div>
        </>
      ) : (
        withLines.map((b, i) => (
          <div key={i} style={i ? { marginTop: 6 } : undefined}>
            <div className="h">{b.c.header}</div>
            {b.c.replacing && <div className="h" style={{ color: b.c.replacing.colour }}>{tr('items_parts.replacing_name', { name: b.c.replacing.name })}</div>}
            <div className={totalLines > 14 ? 'cols' : undefined}>
              {b.lines!.map((l) => (
                <div key={l.stat} className={'c ' + (l.good ? 'good' : 'bad')}>
                  {l.text}
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  ) : spec.note && alt ? (
    <div className="it-tt-cmp">
      <div className="c" style={{ color: 'var(--text-faint)', fontSize: 12.5 }}>{spec.note}</div>
    </div>
  ) : null;
  const effective =
    spec.effective && loaded.effective && loaded.effective.length > 0 ? (
      <div className="it-tt-cmp">
        <div className="h">{spec.effective.title}</div>
        {loaded.effective.map((l, i) => (
          <div key={i} className="c eff">
            {l.segs.map((sg, j) => (
              <span key={j} style={{ color: colourOf(sg.c) }}>{sg.t}</span>
            ))}
          </div>
        ))}
      </div>
    ) : null;
  const grantedTip = spec.granted ? (
    <div className="it-tt-hint">{tr('items_parts.tip_hold_shift_to_display')}{(spec.grantedCount ?? 1) > 1 ? 's' : ''}.</div>
  ) : null;
  const extra = (
    <>
      {alt && spec.pv}
      {alt && grantedTip}
      {effective}
      {compareNode}
      {!alt && <AltHint />}
    </>
  );
  return portal(
    <div ref={ref} className="it-tt-pop" style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
      {spec.info ? (
        <ItemTooltip info={spec.info} extra={extra} detail={alt} />
      ) : (
        <div className="it-tt" data-lg="pop" data-solid="">
          {(spec.lines ?? []).map((l, i) => (
            <div key={i} className="it-tt-line" style={{ color: l.colour }}>{l.text}</div>
          ))}
          {extra}
        </div>
      )}
      {showGranted && (
        <div className={'it-tt-granted' + (flip ? ' flip' : '')} ref={grantRef}>
          {loaded.granted === null ? (
            <div className="it-tt gem" data-lg="pop" data-solid="">
              <div className="it-tt-line" style={{ color: 'var(--text-faint)' }}>{tr('items_parts.reading_the_skill')}</div>
            </div>
          ) : (
            loaded.granted.map((g, i) => <GemTooltipView key={i} tip={g} detail={alt} />)
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}

// ---- menus ---------------------------------------------------------------------------------------------------

export interface MenuEntry {
  key: string;
  label?: string;
  sub?: string;
  img?: string;
  colour?: string;
  right?: string;
  rightColour?: string;
  on?: boolean;
  disabled?: boolean;
  head?: boolean;
  sep?: boolean;
  tip?: TipSpec;
  /** A tooltip that has to be read from the engine first. */
  tipLoad?: () => Promise<ItemInfo>;
  run?: () => void;
}

export interface MenuState {
  anchor: HTMLElement;
  entries: MenuEntry[];
  width?: number;
}

/** One dropdown at a time; every trigger opens it with its own entries. */
export function useMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const open = useCallback((anchor: HTMLElement, entries: MenuEntry[], width?: number) => setMenu((m) => (m && m.anchor === anchor ? null : { anchor, entries, width })), []);
  const close = useCallback(() => setMenu(null), []);
  return { menu, open, close };
}

export function MenuHost({ menu, close, onTip, offTip }: { menu: MenuState | null; close: () => void; onTip: (el: Element, t: TipSpec) => void; offTip: () => void }) {
  const anchor = useRef<HTMLElement | null>(null);
  anchor.current = menu?.anchor ?? null;
  const [q, setQ] = useState('');
  useEffect(() => setQ(''), [menu]);
  const entries = menu?.entries ?? [];
  const searchable = entries.filter((e) => !e.head && !e.sep).length > 10;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = searchable && words.length ? entries.filter((e) => e.head || e.sep || words.every((w) => `${e.label ?? ''} ${e.sub ?? ''}`.toLowerCase().includes(w))) : entries;
  return (
    <PortalMenu anchor={anchor} open={Boolean(menu)} onClose={() => { offTip(); close(); }} role="listbox" minWidth={menu?.width}>
      {searchable && (
        <div className="it-search" style={{ margin: '2px 2px 6px', height: 30 }}>
          <Icon name="search" size={14} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('items_parts.search')} aria-label={tr('items_parts.search_the_list')} />
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 'min(60vh, 420px)', overflowY: 'auto', scrollbarWidth: 'thin' }}>
        {shown.map((e) => {
          if (e.sep) return <div key={e.key} className="menu-sep" />;
          if (e.head) return <div key={e.key} className="menu-head">{e.label}</div>;
          return (
            <button
              key={e.key}
              type="button"
              role="option"
              aria-selected={e.on}
              className={'menu-item it-menu-item' + (e.disabled ? ' off' : '')}
              disabled={e.disabled}
              onMouseEnter={(ev) => {
                const el = ev.currentTarget;
                if (e.tip) onTip(el, e.tip);
                else if (e.tipLoad) {
                  offTip();
                  void e.tipLoad().then((info) => el.matches(':hover') && onTip(el, { info })).catch(() => undefined);
                } else offTip();
              }}
              onMouseLeave={offTip}
              onClick={() => {
                offTip();
                close();
                e.run?.();
              }}
            >
              {e.img && <img src={e.img} alt="" />}
              <span className="col">
                <span style={{ color: e.colour }}>{e.label}</span>
                {e.sub && <span className="sub">{e.sub}</span>}
              </span>
              {e.right && <span className="meta" style={{ color: e.rightColour }}>{e.right}</span>}
              {e.on && <Icon name="check" size={14} style={{ color: 'var(--gold-400)' }} />}
            </button>
          );
        })}
        {shown.length === 0 && <div style={{ padding: '10px 12px', color: 'var(--text-muted)' }}>{tr('items_parts.no_matches')}</div>}
      </div>
    </PortalMenu>
  );
}

/** A trigger that looks like the design's dropdown: value in its colour, a chevron. */
export function PickButton({ value, colour, onOpen, disabled, title, small, children, dataKey }: { value?: ReactNode; colour?: string; onOpen: (el: HTMLButtonElement) => void; disabled?: boolean; title?: string; small?: boolean; children?: ReactNode; dataKey?: string }) {
  return (
    <button type="button" className={'it-pick' + (small ? ' sm' : '')} disabled={disabled} title={title} data-pick={dataKey} onClick={(e) => onOpen(e.currentTarget)} aria-haspopup="listbox">
      {children}
      <span className="v" style={{ color: colour }}>{value}</span>
      <Icon name="chevron-down" size={12} />
    </button>
  );
}

export function SegControl<T extends string>({ value, options, onChange, label, tall }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string; tall?: boolean }) {
  return (
    <div className={'it-seg' + (tall ? ' tall' : '')} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A roll slider: drag along the track, commit on release. */
export function RollSlider({ value, onChange, onCommit, title }: { value: number; onChange: (v: number) => void; onCommit: (v: number) => void; title?: string }) {
  const track = useRef<HTMLSpanElement>(null);
  const last = useRef(value);
  const at = (e: { clientX: number }) => {
    const r = track.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <span
      className="it-roll"
      title={title}
      role="slider"
      aria-label={tr('items_parts.roll')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      tabIndex={0}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        last.current = at(e);
        onChange(last.current);
      }}
      onPointerMove={(e) => {
        if (e.buttons !== 1) return;
        last.current = at(e);
        onChange(last.current);
      }}
      onPointerUp={() => onCommit(last.current)}
      onKeyDown={(e) => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 0.05 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -0.05 : 0;
        if (!d) return;
        e.preventDefault();
        const v = Math.max(0, Math.min(1, value + d));
        onChange(v);
        onCommit(v);
      }}
    >
      <span className="l">{tr('items_parts.roll')}</span>
      <span className="track" ref={track}>
        <span className="fill" style={{ width: `${pct}%` }} />
        <span className="knob" style={{ left: `${pct}%` }} />
      </span>
    </span>
  );
}
