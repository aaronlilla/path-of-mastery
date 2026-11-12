import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { portal } from './Freeze';
import type { CompareLine } from '../shared/statCompare';
import { stripCodes } from '../shared/configLogic';
import { ColorText } from './ColorText';
import { Icon, PortalMenu } from './ui';
import { tr } from './i18n';

// ---- tooltips -------------------------------------------------------------------------------------------------------

/** What a tooltip shows: colour-coded text, then (when `compare` resolves with lines) a "will give you" block. */
export interface TipSpec {
  text?: string;
  header?: string;
  compare?: () => Promise<CompareLine[] | null>;
}

interface TipState {
  x: number;
  y: number;
  spec: TipSpec;
  lines: CompareLine[] | null;
}

type TipSource = TipSpec | null | (() => TipSpec | null);

/**
 * One tooltip for the whole tab (TOOLTIPS.md): 350 ms after the pointer rests (at once while another is showing),
 * below-right of its target, flipped to stay in the window, closed by Esc, leave or blur.
 */
export function useTips(): { host: ReactNode; bind: (src: TipSource) => Pick<HTMLAttributes<HTMLElement>, 'onMouseEnter' | 'onMouseLeave' | 'onFocus' | 'onBlur'> } {
  const [tip, setTip] = useState<TipState | null>(null);
  const timer = useRef<number>(0);
  const shown = useRef(false);
  const seq = useRef(0);
  shown.current = !!tip;
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    seq.current++;
    setTip(null);
  }, []);
  const show = useCallback((el: HTMLElement, src: TipSource) => {
    const spec = typeof src === 'function' ? src() : src;
    if (!spec || (!spec.text && !spec.compare)) return;
    const r = el.getBoundingClientRect();
    const mine = ++seq.current;
    setTip({ x: r.left + 12, y: r.bottom + 8, spec, lines: null });
    if (spec.compare) {
      void spec.compare().then((lines) => {
        if (seq.current === mine && lines) setTip((t) => (t ? { ...t, lines } : t));
      });
    }
  }, []);
  const bind = useCallback(
    (src: TipSource) => {
      const go = (e: { currentTarget: EventTarget }) => {
        const el = e.currentTarget as HTMLElement;
        window.clearTimeout(timer.current);
        if (shown.current) show(el, src);
        else timer.current = window.setTimeout(() => show(el, src), 350);
      };
      return { onMouseEnter: go, onFocus: go, onMouseLeave: hide, onBlur: hide };
    },
    [show, hide],
  );
  // A layout effect: React takes it down while the tab is kept hidden (Freeze), so it only listens for the tab on screen.
  useLayoutEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    document.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', hide, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', hide, true);
      window.clearTimeout(timer.current);
    };
  }, [hide]);
  const host = tip ? <TipView tip={tip} /> : null;
  return useMemo(() => ({ host, bind }), [host, bind]);
}

function TipView({ tip }: { tip: TipState }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: tip.x, top: tip.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(tip.x, window.innerWidth - w - 8));
    const top = tip.y + h > window.innerHeight - 8 ? Math.max(8, tip.y - 16 - h - 24) : tip.y;
    setPos({ left, top });
  }, [tip.x, tip.y, tip.lines, tip.spec]);
  const { spec, lines } = tip;
  return portal(
    <div ref={ref} className="cfg-tip" role="tooltip" data-lg="pop" data-solid="" style={{ left: pos.left, top: pos.top }}>
      {spec.text && (
        <div className="body">
          <ColorText text={spec.text} />
        </div>
      )}
      {lines && (lines.length > 0 || spec.compare) && ( // the header shows even when toggling changes no stat
        <div className="cmp">
          <div className="hd">{spec.header ?? tr('ConfigParts.this_will_give_you')}</div>
          {lines.map((l, i) => (
            <div key={i} className={l.positive ? 'pos' : 'neg'}>
              {l.value} {l.label}
              {l.percent ?? ''}
            </div>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

// ---- dropdown -------------------------------------------------------------------------------------------------------

export interface DdItem {
  val: string | number;
  label: string;
  /** Extra words the search also matches. */
  search?: string;
  tip?: TipSpec;
}

/** The design's dropdown: value trigger with a turning chevron, glass menu, search above 10 entries, arrows/Enter/Esc/type-ahead. */
export function CfgDropdown({
  value,
  items,
  width,
  ariaLabel,
  defaultVal,
  onPick,
  bind,
  triggerTip,
}: {
  value: string | number | undefined;
  items: DdItem[];
  width: number;
  ariaLabel: string;
  defaultVal?: string | number;
  onPick: (v: string | number) => void;
  bind: (src: TipSource) => Pick<HTMLAttributes<HTMLElement>, 'onMouseEnter' | 'onMouseLeave' | 'onFocus' | 'onBlur'>;
  triggerTip?: TipSource;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  /** Set by a mouse hover: the row under the pointer is already visible, and scrolling a half-clipped one into view moved the list under it. */
  const hovered = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const searchable = items.length > 10;
  const cur = items.find((i) => i.val === value || String(i.val) === String(value));
  const shownItems = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return items;
    const words = t.split(/\s+/);
    return items.filter((i) => {
      const hay = (stripCodes(i.label) + ' ' + (i.search ?? '')).toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [items, q]);
  const close = useCallback(() => {
    setOpen(false);
    setQ('');
  }, []);
  const openMenu = () => {
    hovered.current = false;
    const idx = Math.max(0, items.findIndex((i) => i.val === value));
    setActive(idx);
    setQ('');
    setOpen(true);
  };
  useEffect(() => {
    if (open && !hovered.current) list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);
  const pick = (i: DdItem | undefined) => {
    if (!i) return;
    onPick(i.val);
    close();
    trigger.current?.focus();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    const n = shownItems.length;
    hovered.current = false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (n ? (a + 1) % n : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (n ? (a - 1 + n) % n : 0));
    } else if (e.key === 'Home' && !searchable) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End' && !searchable) {
      e.preventDefault();
      setActive(n - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(shownItems[active]);
    } else if (!searchable && e.key.length === 1 && /\S/.test(e.key)) {
      const k = e.key.toLowerCase();
      const from = (active + 1) % Math.max(1, n);
      const order = [...shownItems.slice(from), ...shownItems.slice(0, from)];
      const hit = order.find((i) => stripCodes(i.label).toLowerCase().startsWith(k));
      if (hit) setActive(shownItems.indexOf(hit));
    }
  };
  return (
    <div className="cfg-dd" style={{ width }}>
      <button
        ref={trigger}
        type="button"
        className="cfg-select"
        data-mt="dd"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKey}
        {...(triggerTip && !open ? bind(triggerTip) : {})}
      >
        <span className="v">{cur ? <ColorText text={cur.label} /> : value === undefined ? '' : String(value)}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      <PortalMenu anchor={trigger} open={open} onClose={close} role="listbox" label={ariaLabel} minWidth={Math.max(width, 190)}>
        {searchable && (
          <div className="cfg-dd-search">
            <Icon name="search" size={14} />
            <input
              autoFocus
              value={q}
              placeholder={tr('ConfigParts.search')}
              aria-label={tr('ConfigParts.search_options')}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKey}
            />
            <span className="n">{shownItems.length}</span>
          </div>
        )}
        <div ref={list} className="cfg-dd-list" onKeyDown={onKey} tabIndex={-1}>
          {shownItems.map((i, idx) => (
            <button
              key={String(i.val)}
              type="button"
              role="option"
              aria-selected={i.val === value}
              data-active={idx === active}
              className="menu-item cfg-opt"
              onMouseEnter={() => {
                hovered.current = true;
                setActive(idx);
              }}
              onClick={() => pick(i)}
              {...(i.tip ? bind(i.tip) : {})}
            >
              <span className="grow">
                <ColorText text={i.label} />
              </span>
              {defaultVal !== undefined && i.val === defaultVal && i.val !== value && <span className="meta">{tr('ConfigParts.default')}</span>}
              {i.val === value && <Icon name="check" size={13} style={{ color: 'var(--gold-400)' }} />}
            </button>
          ))}
          {shownItems.length === 0 && (
            <div className="cfg-dd-none">
              {tr('ConfigParts.no_matches')}
              <button type="button" onClick={() => setQ('')}>
                {tr('ConfigParts.clear_search')}
              </button>
            </div>
          )}
        </div>
        {searchable && <div className="cfg-dd-foot">{tr('ConfigParts.to_move_enter_to_pick')}</div>}
      </PortalMenu>
    </div>
  );
}

// ---- number box -----------------------------------------------------------------------------------------------------

/** A right-aligned number box that commits on blur and Enter, steps with the arrow keys, and shows the placeholder greyed. */
export function NumBox({
  value,
  placeholder,
  ariaLabel,
  sanitize,
  parse,
  onCommit,
  min,
}: {
  value: number | undefined;
  placeholder: string;
  ariaLabel: string;
  sanitize: (t: string) => string;
  parse: (t: string) => number | null | undefined;
  onCommit: (v: number | null) => void;
  min?: number;
}) {
  // An input equal to the option's default is not reported back as set, so a typed 0 on a default-0 option would read as empty: remember it.
  const [zero, setZero] = useState(false);
  const shown = value === undefined ? (zero ? '0' : '') : String(value);
  const [text, setText] = useState(shown);
  const focused = useRef(false);
  const escaped = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(shown);
  }, [shown]);
  useEffect(() => {
    if (value !== undefined && value !== 0) setZero(false);
  }, [value]);
  const commit = (t: string) => {
    const n = parse(t);
    if (n === undefined) {
      setText(shown);
      return;
    }
    const cur = value ?? (zero ? 0 : undefined); // a stored 0 that equals the default is not reported back as set
    setZero(n === 0);
    if ((n === null && cur === undefined) || n === cur) return;
    onCommit(n);
  };
  return (
    <div className="cfg-num">
      <input
        type="text"
        inputMode="numeric"
        value={text}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onFocus={() => {
          focused.current = true;
          escaped.current = false;
        }}
        onChange={(e) => setText(sanitize(e.target.value))}
        onBlur={(e) => {
          focused.current = false;
          if (escaped.current) {
            // Escape gives the typed text up: the old value stays, nothing is committed.
            escaped.current = false;
            setText(shown);
            return;
          }
          commit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          else if (e.key === 'Escape') {
            escaped.current = true;
            setText(shown);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const base = Number(text === '' ? placeholder : text) || 0;
            const next = Math.max(min ?? -1e9, base + (e.key === 'ArrowUp' ? 1 : -1));
            setZero(next === 0);
            setText(String(next));
            onCommit(next);
          }
        }}
      />
    </div>
  );
}
