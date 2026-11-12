import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { portal } from './Freeze.js';
import { tr } from './i18n';

/** The design system's <pom-icon>. Empty name renders nothing. */
export function Icon({ name, size = 16, style, spin, label }: { name: string; size?: number; style?: CSSProperties; spin?: boolean; label?: string }) {
  return <pom-icon name={name} size={String(size)} style={style} {...(spin ? { spin: '' } : {})} {...(label ? { label } : {})} />;
}

export function Kbd({ children, onGold }: { children: ReactNode; onGold?: boolean }) {
  return <span className={'kbd' + (onGold ? ' on-gold' : '')}>{children}</span>;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} aria-disabled={disabled || undefined} onClick={() => !disabled && onChange(!checked)}>
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel, tall }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; ariaLabel?: string; tall?: boolean }) {
  return (
    <div className={'seg' + (tall ? ' tall' : '')} data-lg="tile" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---- Escape closes only the topmost open thing ------------------------------------------------
// A dropdown, menu or popover that is open takes the Escape press; dialogs and screens behind it never see it.
// Open layers are PortalMenus and any element marked data-popup. The listener is installed when this module loads,
// ahead of every dialog's own Escape handler, so it runs first and stops the rest.
export const POPUP_SELECTOR = '.menu.portal, [data-popup]';
export const ESCAPE_EVENT = 'pom-popup-escape';

/** The open dropdown, menu or popover that is on top, if any. */
export function topPopup(): Element | null {
  const all = document.querySelectorAll(POPUP_SELECTOR);
  const top = all.length ? all[all.length - 1]! : null;
  if (!top) return null;
  // A popup drawn before the topmost dialog sits beneath it (a panel the dialog was opened from): the dialog takes Escape.
  const dialogs = document.querySelectorAll('.dialog');
  const dialog = dialogs.length ? dialogs[dialogs.length - 1]! : null;
  if (dialog && !dialog.contains(top) && dialog.compareDocumentPosition(top) & Node.DOCUMENT_POSITION_PRECEDING) return null;
  return top;
}

if (typeof document !== 'undefined') {
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !topPopup()) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      window.dispatchEvent(new CustomEvent(ESCAPE_EVENT));
    },
    true,
  );
}

/** Closes `el`'s popup when Escape is pressed while it is the topmost one. */
function useEscapeLayer(el: React.RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const on = () => {
      if (el.current && topPopup() === el.current) onClose();
    };
    window.addEventListener(ESCAPE_EVENT, on);
    return () => window.removeEventListener(ESCAPE_EVENT, on);
  }, [el, open, onClose]);
}

/** The latest value, read from listeners that must not re-subscribe when it changes. */
function useLatest<T>(v: T): React.MutableRefObject<T> {
  const r = useRef(v);
  r.current = v;
  return r;
}

/** Calls onClose on a pointer press outside the ref'd element (and outside `part`, a piece of the same layer drawn elsewhere), or on Escape while it is the topmost popup. */
export function useDismiss(ref: React.RefObject<HTMLElement | null>, open: boolean, onClose: () => void, swallowClick = false, part?: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    el.setAttribute('data-popup', '');
    return () => el.removeAttribute('data-popup');
  }, [ref, open]);
  useEscapeLayer(ref, open, onClose);
  const latestClose = useLatest(onClose);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node) || part?.current?.contains(e.target as Node)) return;
      latestClose.current();
      if (!swallowClick) return;
      // The press that closes the layer must not also click what is underneath (or its own trigger, which would reopen it).
      const eat = (c: Event) => { c.stopPropagation(); c.preventDefault(); };
      document.addEventListener('click', eat, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', eat, true), 500);
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [ref, open, swallowClick, latestClose, part]);
}


/** A glass menu drawn at the page level, so no scrolling or clipping parent can cut it off. It flips above its anchor near the bottom edge. */
export function PortalMenu({ anchor, open, onClose, align = 'left', children, label, role = 'menu', minWidth, className }: { anchor: React.RefObject<HTMLElement | null>; open: boolean; onClose: () => void; align?: 'left' | 'right'; children: ReactNode; label?: string; role?: string; minWidth?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; minW: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const a = anchor.current;
    const m = ref.current;
    if (!a || !m) return;
    const r = a.getBoundingClientRect();
    // Whole pixels, so the first measure (before the min-width is applied) and every re-measure agree and the menu never drifts a fraction.
    // Measure at the final cap, not the CSS 320px one, so the flip and the footer limit below use the height the menu really gets.
    m.style.maxHeight = Math.min(420, window.innerHeight - 16) + 'px';
    const w = Math.max(m.offsetWidth, Math.ceil(r.width), minWidth ?? 0);
    const h = m.offsetHeight;
    let left = align === 'right' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    // Inside a dialog the list stays above the dialog's own footer (its Save and Cancel row and the note) instead of covering it.
    const foot = a.closest('.settings')?.querySelector('.foot') ?? a.closest('.dialog')?.querySelector('.dialog-foot');
    const limit = Math.min(window.innerHeight - 8, foot ? foot.getBoundingClientRect().top - 6 : Infinity);
    const below = r.bottom + 6;
    const roomAbove = r.top - 6 - 8;
    const flip = below + h > limit && roomAbove >= h;
    const top = flip ? Math.max(8, r.top - 6 - h) : Math.min(below, Math.max(8, limit - h));
    // Cap after placement to the room it was placed in (above its anchor when flipped, down to the footer or viewport bottom otherwise); only its own list scrolls.
    m.style.maxHeight = Math.max(120, (flip ? r.top - 6 : limit) - top) + 'px';
    // Snapped to device pixels: a fractional origin lets the text re-rasterise a pixel over when the open animation ends or a re-render lands.
    const dpr = window.devicePixelRatio || 1;
    const snap = (v: number) => Math.round(v * dpr) / dpr;
    const next = { left: snap(left), top: snap(top), minW: Math.ceil(r.width) };
    setPos((p) => (p && p.left === next.left && p.top === next.top && p.minW === next.minW ? p : next));
  }, [open, anchor, align, minWidth, children]);
  // The listeners read the latest onClose through a ref, so a re-render never re-subscribes them. A re-subscribe during a
  // press (an inner list closing on the same press re-renders this menu) would drop the menu's own listener for that press.
  const latestClose = useLatest(onClose);
  useEffect(() => {
    if (!open) return;
    const onClose = () => latestClose.current();
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      // A press inside a portal menu opened after this one (its nested list) is not outside; a press inside an earlier
      // one (the menu this list hangs off) is, and closes only this top layer; the press itself still reaches the field it landed on.
      const other = (t as Element).closest?.('.menu.portal');
      if (other && ref.current && (ref.current.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
      onClose();
    };
    const openedAt = performance.now();
    const scroll = (e: Event) => {
      // A text box scrolling its own text (after a re-render) is not the page moving out from under the menu, and the
      // page settling as the menu opens (focus moving to the button that opened it) does not close it either.
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (performance.now() - openedAt < 250) return;
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('resize', onClose);
    document.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('resize', onClose);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [open, anchor, latestClose]);
  useEscapeLayer(ref, open, onClose);
  if (!open) return null;
  return portal(
    <div ref={ref} className={'menu portal' + (className ? ' ' + className : '')} data-lg="pop" data-solid="" role={role} aria-label={label} style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, minWidth: Math.max(pos?.minW ?? 0, minWidth ?? 0), visibility: pos ? 'visible' : 'hidden' }}>
      {children}
    </div>,
    document.body,
  );
}

export interface Option<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** A dropdown that follows DROPDOWNS.md: chevron turns when open, menu is a glass pop, arrows/Enter/Esc work. */
export function Select<T extends string>({ value, options, onChange, width = 190, ariaLabel, up }: { value: T; options: Option<T>[]; onChange: (v: T) => void; width?: number | string; ariaLabel: string; up?: boolean }) {
  void up;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const hovered = useRef(false);
  const cur = options.find((o) => o.value === value);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const close = useCallback(() => setOpen(false), []);
  const openMenu = () => {
    hovered.current = false;
    setActive(idx);
    setOpen(true);
  };
  const onKey = (e: React.KeyboardEvent) => {
    hovered.current = false;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + options.length) % options.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const o = options[active];
      if (o) onChange(o.value);
      setOpen(false);
    }
  };
  return (
    <div style={{ position: 'relative', flex: 'none', width }}>
      <button ref={trigger} type="button" className="select" style={{ width: '100%' }} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} onClick={() => (open ? setOpen(false) : openMenu())} onKeyDown={onKey}>
        <span className="label">{cur?.label ?? ''}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      <PortalMenu anchor={trigger} open={open} onClose={close} role="listbox" label={ariaLabel}>
        {options.map((o, i) => (
          <button
            key={o.value}
            type="button"
            role="option"
            aria-selected={o.value === value}
            data-active={i === active}
            ref={i === active ? (el) => { if (el && !hovered.current) el.scrollIntoView({ block: 'nearest' }); } : undefined}
            className="menu-item"
            onMouseEnter={() => { hovered.current = true; setActive(i); }}
            onClick={() => {
              onChange(o.value);
              setOpen(false);
            }}
          >
            <span className="grow">{o.label}</span>
            {o.hint && <span className="meta">{o.hint}</span>}
            {o.value === value && <Icon name="check" size={14} style={{ color: 'var(--gold-text)' }} />}
          </button>
        ))}
      </PortalMenu>
    </div>
  );
}

// ---- Dialog ----------------------------------------------------------------------------------

const BADGE: Record<string, [string, string, string]> = {
  info: ['info', 'rgba(var(--line-rgb),.08)', 'var(--text-2)'],
  warning: ['warning', 'rgba(255,153,34,.12)', 'var(--warning-text)'],
  danger: ['trash', 'rgba(239,70,86,.12)', 'var(--negative-text)'],
  success: ['check', 'rgba(79,220,124,.12)', 'var(--positive-text)'],
  error: ['error', 'rgba(239,70,86,.12)', 'var(--negative-text)'],
  folder: ['folder-open', 'rgba(var(--line-rgb),.08)', 'var(--text-2)'],
  import: ['import', 'rgba(var(--accent-rgb),.12)', 'var(--gold-text)'],
  share: ['share', 'rgba(var(--accent-rgb),.12)', 'var(--gold-text)'],
  history: ['history', 'rgba(var(--line-rgb),.08)', 'var(--text-2)'],
  save: ['save', 'rgba(var(--accent-rgb),.12)', 'var(--gold-text)'],
  plus: ['plus', 'rgba(var(--accent-rgb),.12)', 'var(--gold-text)'],
  keyboard: ['keyboard', 'rgba(var(--line-rgb),.08)', 'var(--text-2)'],
  user: ['user', 'rgba(var(--accent-rgb),.12)', 'var(--gold-text)'],
  compare: ['compare', 'rgba(var(--accent-rgb),.12)', 'var(--gold-text)'],
  sync: ['sync', 'rgba(var(--accent-rgb),.12)', 'var(--gold-text)'],
};

export interface DialogProps {
  size?: 'small' | 'medium' | 'large';
  /** Overrides the size's width, in px. */
  width?: number;
  icon?: keyof typeof BADGE;
  tone?: 'primary' | 'danger';
  title: string;
  subtitle?: string;
  cancelLabel?: string | null;
  confirmLabel?: string | null;
  confirmIcon?: string;
  confirmDisabled?: boolean;
  confirmBusy?: boolean;
  /** Tooltip on the confirm button. */
  confirmTitle?: string;
  altLabel?: string;
  altIcon?: string;
  altDisabled?: boolean;
  note?: ReactNode;
  /** Hides the X: for a dialog that must be answered. */
  hideClose?: boolean;
  /** Puts the keyboard focus on the confirm button when the dialog opens (the primary action). */
  focusConfirm?: boolean;
  onCancel: () => void;
  onConfirm?: () => void;
  onAlt?: () => void;
  children?: ReactNode;
}

export function Dialog(p: DialogProps) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(p.onCancel);
  cancelRef.current = p.onCancel;
  const b = p.icon ? BADGE[p.icon] : undefined;
  const danger = p.tone === 'danger';
  const confirm = p.confirmLabel === null ? undefined : p.confirmLabel ?? (danger ? tr('ui_2.delete') : tr('h_rb_Ui.ok'));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    const first = el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>('input:not([disabled]), textarea');
    (first ?? el).focus();
    first instanceof HTMLInputElement && first.select();
    // Escape closes the dialog wherever the focus is, including on the page behind it.
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !topPopup()) {
        e.stopPropagation();
        cancelRef.current();
      }
    };
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('keydown', esc, true);
      prev?.focus?.();
    };
  }, []);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      p.onCancel();
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement) && p.onConfirm && !p.confirmDisabled) {
      e.preventDefault();
      p.onConfirm();
    } else if (e.key === 'Tab' && ref.current) {
      const f = [...ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  // Drawn at the window level: a dialog opened from inside the header or a panel must not be clipped to it.
  return portal(
    <>
      <div className="scrim" onClick={p.onCancel} />
      <div className="dialog-wrap" onKeyDown={onKey}>
        <div ref={ref} className={'dialog ' + (p.size ?? 'small')} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} style={{ outline: 'none', ...(p.width ? { width: p.width } : {}) }} data-lg="pop" data-solid="">
          <div className="dialog-head">
            {b && (
              <span className="dialog-badge" style={{ background: b[1], color: b[2] }}>
                <Icon name={b[0]} size={18} />
              </span>
            )}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span id={id} className="dialog-title">{p.title}</span>
              {p.subtitle && <span className="dialog-sub">{p.subtitle}</span>}
            </div>
            {!p.hideClose && (
              <button type="button" className="icon-btn" aria-label={tr('ui.close')} onClick={p.onCancel}>
                <Icon name="x" size={16} />
              </button>
            )}
          </div>
          <div className="dialog-body">{p.children}</div>
          {(confirm !== undefined || p.cancelLabel !== null) && (
            <div className="dialog-foot">
              {p.note && <span className="note">{p.note}</span>}
              {p.cancelLabel !== null && (
                <button type="button" className="btn ghost" onClick={p.onCancel}>
                  {p.cancelLabel ?? tr('ui.cancel')}
                </button>
              )}
              {p.altLabel && (
                <button type="button" className="btn" data-lg="control" disabled={p.altDisabled} onClick={p.onAlt}>
                  {p.altIcon && <Icon name={p.altIcon} size={16} />}
                  {p.altLabel}
                </button>
              )}
              {confirm !== undefined && (
                <button type="button" className={'btn ' + (danger ? 'danger' : 'gold')} style={{ minWidth: 96 }} title={p.confirmTitle} aria-disabled={p.confirmDisabled || undefined} {...(p.focusConfirm ? { 'data-autofocus': '' } : {})} onClick={() => !p.confirmDisabled && p.onConfirm?.()}>
                  {p.confirmBusy ? <span className="spinner" /> : p.confirmIcon || danger ? <Icon name={p.confirmIcon ?? 'trash'} size={16} /> : null}
                  {confirm}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </>,
    document.getElementById('root') ?? document.body,
  );
}

// ---- Toasts ----------------------------------------------------------------------------------

export interface ToastSpec {
  text: string;
  kind?: 'ok' | 'error' | 'info' | 'warn';
  action?: { label: string; run: () => void };
  /** A second button, shown before `action` and without the undo icon. */
  action2?: { label: string; run: () => void };
  ttl?: number;
  /** Stays until dismissed. */
  sticky?: boolean;
  /** A new toast with the same key replaces the old one instead of stacking under it. */
  key?: string;
}
interface ToastItem extends ToastSpec {
  id: number;
}

const ToastCtx = createContext<(t: ToastSpec) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const push = useCallback((t: ToastSpec) => {
    // An empty text with a key only takes that toast away.
    if (!t.text && t.key) {
      setItems((s) => s.filter((x) => x.key !== t.key));
      return;
    }
    const id = next.current++;
    setItems((s) => [...s.filter((x) => !t.key || x.key !== t.key).slice(-3), { ...t, id }]);
    if (!t.sticky) window.setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), t.ttl ?? (t.action ? 9000 : t.kind === 'error' ? 7000 : 4000));
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={'toast ' + (t.kind ?? 'info')} data-lg="pop" data-solid="">
            {t.kind === 'error' && <Icon name="error" size={16} />}
            {t.kind === 'warn' && <Icon name="warning" size={16} />}
            {t.kind === 'ok' && <Icon name="check-circle" size={16} />}
            <span className="txt">{t.text}</span>
            {t.action2 && (
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  t.action2?.run();
                  setItems((s) => s.filter((x) => x.id !== t.id));
                }}
              >
                {t.action2.label}
              </button>
            )}
            {t.action && (
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  t.action?.run();
                  setItems((s) => s.filter((x) => x.id !== t.id));
                }}
              >
                {!t.action2 && <Icon name="undo" size={14} />}
                {t.action.label}
              </button>
            )}
            <button type="button" className="icon-btn" aria-label={tr('ui.dismiss')} onClick={() => setItems((s) => s.filter((x) => x.id !== t.id))}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
