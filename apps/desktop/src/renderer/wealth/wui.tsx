import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { fmtPct, type Cat } from '../../shared/wealth.js';
import { fmtAgo, never } from './mainText';
import { artFor } from '../gameArt.js';
import { Icon } from '../ui.js';
import { tr } from '../i18n';

/** CAT_NAMES (shared, English) in the current language. */
export const catName = (c: Cat): string => ({ cur: tr('wealth_Market_2.currency'), frag: tr('wealth_Market_2.fragments'), scar: tr('wealth_Market_2.scarabs'), map: tr('h_c_Wl.maps'), rare: tr('h_c_Wl.rares'), uniq: tr('wealth_Market_2.uniques'), card: tr('wealth_Market_2.divination'), ess: tr('wealth_Market_2.essences'), gem: tr('wealth_Market_2.gems'), other: tr('wealth_Overview.everything_else') } as Record<Cat, string>)[c];

export const CAT_COLOUR: Record<Cat, string> = {
  cur: 'var(--gold-400)',
  frag: 'var(--dmg-cold)',
  scar: 'var(--stat-evasion)',
  map: 'var(--pool-life)',
  rare: 'var(--rarity-rare)',
  uniq: 'var(--rarity-unique)',
  card: 'var(--cat-card)',
  ess: 'var(--cat-essence)',
  gem: 'var(--rarity-gem-text)',
  other: 'var(--text-muted)',
};

/** A card has no picture of its own in the game data, only an empty frame that reads as a blank tile at this size. */
const CARD_FRAME = 'ui/divination-card.png';

/**
 * Pictures for things the game data has none for: one well-known item of the same class, so a tile is never letters.
 * By poe.ninja type first (the item class), then by category.
 */
const GENERIC_BY_KIND: Record<string, [string, string?]> = {
  UniqueWeapon: ['Starforge', 'uniques'],
  UniqueArmour: ["Kaom's Heart", 'uniques'],
  UniqueAccessory: ['Mageblood', 'uniques'],
  UniqueFlask: ['Bottled Faith', 'uniques'],
  UniqueJewel: ["Watcher's Eye", 'uniques'],
  ForbiddenJewel: ["Watcher's Eye", 'uniques'],
  UniqueRelic: ["Watcher's Eye", 'uniques'],
  UniqueTincture: ['Mageblood', 'uniques'],
  Beast: ['Bestiary Scarab'],
  Corpse: ['Bestiary Scarab'],
};
const GENERIC_BY_CAT: Record<Cat, [string, string?]> = {
  cur: ['Chaos Orb'],
  frag: ['Simulacrum Splinter'],
  scar: ['Scarab of Wisps'],
  map: ['Map (Tier 16)', 'maps'],
  rare: ['Vermillion Ring', 'bases'],
  uniq: ["Kaom's Heart", 'uniques'],
  card: ['Stacked Deck'],
  ess: ['Deafening Essence of Scorn'],
  gem: ['Cyclone', 'gems'],
  other: ['Stacked Deck'],
};

function wealthArt(name: string, artCat: string | undefined, cat: Cat, base: string | undefined, kind: string | undefined): string | undefined {
  const own = (n: string, c?: string) => {
    const a = artFor(n, c);
    return a?.endsWith(CARD_FRAME) ? artFor('Stacked Deck') : a;
  };
  // "Foulborn X" is a variant of the unique X and shares its picture.
  const byName = own(name, artCat === 'beasts' ? undefined : artCat) ?? (name.startsWith('Foulborn ') ? own(name.slice('Foulborn '.length), artCat) : undefined);
  if (byName) return byName;
  // A unique the art index does not know still shows its base item.
  if (base) {
    const b = artFor(base, 'bases') ?? artFor(base);
    if (b) return b;
  }
  // A map the game has no art for by name still shows a map, as the design does.
  const g = (kind && GENERIC_BY_KIND[kind]) || (artCat === 'beasts' ? GENERIC_BY_KIND.Beast : undefined) || GENERIC_BY_CAT[cat];
  return own(g[0], g[1]) ?? own(g[0]);
}

/** Item art from the game data; a stand-in picture of the same kind when there is none. Never letters. */
export function ItemIcon({ name, cat, artCat, base, kind, size = 24, bare }: { name: string; cat: Cat; artCat?: string; /** Base item, used when the item itself has no art. */ base?: string; /** poe.ninja type (the item class), picks the stand-in picture. */ kind?: string; size?: number; /** Show nothing when the game has no art for it, instead of a stand-in. */ bare?: boolean }) {
  const src = wealthArt(name, artCat, cat, base, kind);
  if (!src && bare) return <span className="w-ic bare" style={{ width: size, height: size }} aria-hidden="true" />;
  return (
    <span className="w-ic" style={{ width: size, height: size, ['--ic' as string]: CAT_COLOUR[cat] } as CSSProperties}>
      {src ? <img src={src} alt="" draggable={false} /> : <i className="w-ic-gem" aria-hidden="true" />}
    </span>
  );
}

/**
 * A dialog over Wealth. The page under it is dimmed and blurred from the bottom of the title bar down (the title bar
 * stays sharp), the card is centred in what is left, and it closes with Escape, a click outside it, or its own Close button.
 */
export function Modal({ label, onClose, className = '', children }: { label: string; onClose: () => void; className?: string; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="w-scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`w-dialog ${className}`} data-lg="pop" data-solid="" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

export function Cb({ on, label, onClick, disabled }: { on: boolean; label: string; onClick: (e: React.MouseEvent) => void; disabled?: boolean }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} aria-label={label} disabled={disabled} className="w-cb" data-on={on} onClick={onClick}>
      {on && <Icon name="check" size={11} style={{ strokeWidth: 3 }} />}
    </button>
  );
}

export function Chip({ tone = 'neutral', children, title }: { tone?: 'positive' | 'negative' | 'gold' | 'warning' | 'neutral'; children: ReactNode; title?: string }) {
  return (
    <span className={`w-chip ${tone}`} title={title}>
      {children}
    </span>
  );
}

/** Green when the price rose over the week, red when it fell, faint when flat (within half a percent). */
export function Spark({ data, w = 64, h = 20, title }: { data: number[]; w?: number; h?: number; /** What the line says in words, shown on hover. */ title?: string }) {
  if (data.length < 2) return <span className="w-spark-none" style={{ width: w }} title={tr('wealth_wui.no_price_history')}>—</span>;
  const mn = Math.min(...data);
  const mx = Math.max(...data);
  const r = mx - mn || 1;
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - mn) / r) * (h - 4)).toFixed(1)}`).join(' ');
  const c = change(data);
  const stroke = c > 0.005 ? 'var(--positive)' : c < -0.005 ? 'var(--negative)' : 'var(--text-faint)';
  return (
    <span title={title} style={{ display: 'inline-flex' }}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
        <polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/** The sparkline in words: the price a week ago and now, and the change between them. */
export const sparkTitle = (d: number[], fmt: (c: number) => string): string | undefined =>
  d.length > 1 ? tr('wealth_wui.price_over_7_days_v1', { value: fmt(d[0]!), value2: fmt(d[d.length - 1]!), value3: fmtPct(change(d)) }) : undefined;

export const change = (d: number[]): number => (d.length > 1 && d[0]! > 0 ? d[d.length - 1]! / d[0]! - 1 : 0);

export function Panel({ children, className = '', style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`w-panel ${className}`} data-lg="panel" style={style}>
      {children}
    </div>
  );
}

export function Eyebrow({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="w-eyebrow">
      <span>{children}</span>
      {right}
    </div>
  );
}

export function Seg({ labels, active, onPick, label }: { labels: string[]; active: number; onPick: (i: number) => void; label: string }) {
  return (
    <div className="w-seg" role="group" aria-label={label}>
      {labels.map((l, i) => (
        <button key={l} type="button" aria-pressed={i === active} onClick={() => onPick(i)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="w-empty">
      <b>{title}</b>
      {body && <span>{body}</span>}
      {action}
    </div>
  );
}

/** A price line chart over equally spaced points. */
export function LineChart({ data, height = 80, area = false }: { data: number[]; height?: number; area?: boolean }) {
  if (data.length < 2) return <div className="w-chart-none" style={{ height }}>{tr('wealth_wui.history_starts_now')}</div>;
  const w = 300;
  const mn = Math.min(...data);
  const mx = Math.max(...data);
  const r = mx - mn || 1;
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(height - 4 - ((v - mn) / r) * (height - 8)).toFixed(1)}`);
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" width="100%" height={height} aria-hidden="true">
      {area && <polygon points={`0,${height} ${pts.join(' ')} ${w},${height}`} fill="rgba(var(--accent-rgb),.12)" />}
      <polyline points={pts.join(' ')} fill="none" stroke="var(--gold-400)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export const ago = (t: number | null | undefined, now: number): string => (t ? fmtAgo(Math.max(0, now - t)) : never());

export const clock = (t: number): string => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

export const dayLabel = (t: number, now: number): string => {
  const d = new Date(t);
  const n = new Date(now);
  const same = d.toDateString() === n.toDateString();
  const y = new Date(now - 86400000).toDateString() === d.toDateString();
  return `${same ? tr('wealth_wui_2.today') : y ? tr('wealth_wui_2.yesterday') : d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(t)}`;
};
