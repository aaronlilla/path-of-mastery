import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import './adv-s.css';
import type { LabelStyle } from '../../../../shared/lootfilter/types.js';
import { Icon } from '../../../ui';
import { groundFor } from '../../LabelChip';
import { useLf } from '../../lfStore';
import { tr } from '../../../i18n';

/** Small pieces shared by the Strictness, Themes, Advanced, Retier, Adapt, Update and Components screens. */

/** `fill` makes the last panel take the rest of the height instead of growing the page. */
export function Page({ children, fill }: { children: ReactNode; fill?: boolean }) {
  return <div className={'adv-s-page' + (fill ? ' fill' : '')}>{children}</div>;
}

export function Head({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="adv-s-head">
      <div className="adv-s-headtxt">
        <span className="adv-s-title">{title}</span>
        {sub ? <span className="adv-s-sub">{sub}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function Panel({ children, className = '', style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`lf-card adv-s-panel ${className}`} {...(style ? { style } : {})}>
      {children}
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="lf-eyebrow">{children}</span>;
}

export function Btn({ kind, icon, onClick, disabled, title, children, small }: { kind?: 'gold' | 'ghost' | 'text' | 'danger'; icon?: string; onClick?: () => void; disabled?: boolean; title?: string; children?: ReactNode; small?: boolean }) {
  return (
    <button type="button" className={`adv-s-btn${kind ? ' ' + kind : ''}${small ? ' sm' : ''}`} onClick={onClick} disabled={disabled} {...(title ? { title } : {})}>
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </button>
  );
}

/** The design's small segmented control. */
export function Seg<T extends string>({ value, options, onChange, label, wrap }: { wrap?: boolean; value: T; options: { value: T; label: string; icon?: string; disabled?: boolean }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="adv-s-seg" role="group" aria-label={label} style={wrap ? { flexWrap: "wrap" } : undefined}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} disabled={o.disabled} onClick={() => onChange(o.value)}>
          {o.icon ? <Icon name={o.icon} size={14} style={{ opacity: 0.85 }} /> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A look without its map icon, sound and beam: the design draws plain boxes in lists and comparisons. */
export function plain(s: LabelStyle): LabelStyle {
  const { icon: _i, sound: _s, beam: _b, ...rest } = s;
  void _i;
  void _s;
  void _b;
  return rest;
}

export type GroundKind = 'dark' | 'bright';

/** The ground behind labels, remembered with the filter state. */
export function useGround(): [GroundKind, (g: GroundKind) => void] {
  const lf = useLf();
  const v = lf.ui.advGround === 'bright' ? 'bright' : 'dark';
  return [v, (g) => lf.setUi('advGround', g)];
}

export function GroundBox({ kind, children, style, className = 'adv-s-ground' }: { kind: GroundKind; children: ReactNode; style?: CSSProperties; className?: string }) {
  return (
    <span className={className} style={{ background: groundFor(kind), ...(style ?? {}) }}>
      {children}
    </span>
  );
}

export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return tr('lootfilter_advanced_strictness_kit_2.just_now');
  const m = Math.round(s / 60);
  if (m < 60) return tr('lootfilter_advanced_strictness_kit.m_min', { value: m });
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return tr('lootfilter_advanced_strictness_kit.v1_days', { value: Math.round(h / 24) });
}

/** Rows of fixed height inside a scroll container: only the visible ones are mounted. */
export function useWindow(count: number, rowH: number, overscan = 12): { ref: React.RefObject<HTMLDivElement>; from: number; to: number; total: number; scrollTo(row: number, align?: 'start' | 'center'): void } {
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ top: 0, h: 600 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const upd = (): void => setRange({ top: el.scrollTop, h: el.clientHeight });
    upd();
    el.addEventListener('scroll', upd, { passive: true });
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', upd);
      ro.disconnect();
    };
  }, []);
  const from = Math.max(0, Math.floor(range.top / rowH) - overscan);
  const to = Math.min(count, Math.ceil((range.top + range.h) / rowH) + overscan);
  const scrollTo = (row: number, align: 'start' | 'center' = 'center'): void => {
    const el = ref.current;
    if (!el) return;
    const y = row * rowH;
    el.scrollTop = align === 'center' ? Math.max(0, y - el.clientHeight / 2 + rowH) : y;
  };
  return { ref, from, to, total: count * rowH, scrollTo };
}

export function Spinner() {
  return <span className="lf-spinner" aria-label={tr('lootfilter_advanced_strictness_kit.working')} />;
}
