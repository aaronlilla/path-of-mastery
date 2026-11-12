import type { CatalogItem, Catalog, TierInfo } from '../../../../shared/lootfilter/catalog.js';
import type { PriceTable } from '../../../../shared/lootfilter/ipcTypes.js';
import { tierNames } from '../../../../shared/lootfilter/tierNames.js';

/**
 * Price-aware retier. For every NeverSink item type with at least two priced tiers:
 *  1. each tier's price is the median of the poe.ninja prices of its current members;
 *  2. the band between two neighbouring tiers is the geometric midpoint of their medians;
 *  3. an item whose price is at least 20% past the edge of its own tier's band belongs in the tier whose band holds it.
 * Nothing here is a guess about the future: it only compares today's prices with where NeverSink put each item.
 */

export const OUTSIDE_FACTOR = 1.2;

/** NeverSink's section titles run long ("Currency - Regular Currency Tiering"). The part before the dash is the name people use. */
export const shortType = (label: string): string => label.split(/\s+-\s+|:\s/)[0]!.trim() || label;

export interface TierBand {
  tier: TierInfo;
  /** Short name, S to E. */
  name: string;
  median: number;
  /** Lowest price in the band, 0 for the cheapest tier. */
  low: number;
  /** Highest price in the band, Infinity for the dearest tier. */
  high: number;
  members: number;
}

export interface RetierRow {
  item: CatalogItem;
  type: string;
  typeLabel: string;
  from: TierInfo;
  to: TierInfo;
  fromName: string;
  toName: string;
  price: number;
  fromMedian: number;
  toMedian: number;
  /** Price against the median of the tier it sits in now. */
  pct: number;
  /** A price rule already moves this item. */
  done: boolean;
}

export interface RetierType {
  type: string;
  label: string;
  bands: TierBand[];
  rows: RetierRow[];
}

export interface RetierResult {
  ready: boolean;
  types: RetierType[];
  /** Every row of every type, the furthest from its band first. */
  rows: RetierRow[];
  /** The type with the most rows: its tier lines are the ones shown. */
  lead: RetierType | undefined;
  total: number;
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function computeRetier(cat: Catalog | null | undefined, prices: PriceTable | null | undefined, rules: ReadonlyArray<{ source?: string; enabled: boolean; targets: Array<{ conditions?: Array<{ key: string; values: string[] }> }> }>): RetierResult {
  if (!cat || !prices) return { ready: false, types: [], rows: [], lead: undefined, total: 0 };
  const moved = new Set<string>();
  for (const r of rules) {
    if (r.source !== 'price' || !r.enabled) continue;
    for (const t of r.targets) for (const c of t.conditions ?? []) if (c.key === 'BaseType') c.values.forEach((v) => moved.add(v));
  }
  const out: RetierType[] = [];
  let total = 0;
  for (const ty of cat.types) {
    if (ty.type.startsWith('uniques')) continue;
    const usable = ty.tiers.filter((t) => t.kind !== 'Hide' && !t.conditional);
    const bands: TierBand[] = [];
    for (const t of usable) {
      const ps: number[] = [];
      for (const n of t.items) {
        const it = cat.byName.get(n);
        const p = prices.byName[n]?.chaos;
        if (it && it.type === t.type && it.tier === t.tier && p !== undefined && p > 0) ps.push(p);
      }
      if (ps.length) bands.push({ tier: t, name: '', median: median(ps), low: 0, high: Infinity, members: ps.length });
    }
    if (bands.length < 2) continue;
    const names = tierNames(ty.tiers);
    for (const b of bands) b.name = names.get(b.tier.key) ?? b.tier.tier;
    bands.sort((a, b) => b.median - a.median);
    for (let i = 0; i < bands.length; i++) {
      if (i > 0) bands[i]!.high = Math.sqrt(bands[i - 1]!.median * bands[i]!.median);
      if (i < bands.length - 1) bands[i]!.low = Math.sqrt(bands[i]!.median * bands[i + 1]!.median);
    }
    const rows: RetierRow[] = [];
    for (const b of bands) {
      for (const n of b.tier.items) {
        const it = cat.byName.get(n);
        const p = prices.byName[n]?.chaos;
        if (!it || it.type !== b.tier.type || it.tier !== b.tier.tier || p === undefined || p <= 0) continue;
        if (p >= b.low / OUTSIDE_FACTOR && p <= b.high * OUTSIDE_FACTOR) continue;
        const target = bands.find((x) => p >= x.low);
        if (!target || target === b) continue;
        rows.push({ item: it, type: ty.type, typeLabel: shortType(ty.label), from: b.tier, to: target.tier, fromName: b.name, toName: target.name, price: p, fromMedian: b.median, toMedian: target.median, pct: Math.round((p / b.median - 1) * 100), done: moved.has(n) });
      }
    }
    if (!rows.length) continue;
    rows.sort((a, b) => Math.abs(Math.log(b.price / b.fromMedian)) - Math.abs(Math.log(a.price / a.fromMedian)));
    total += rows.filter((r) => !r.done).length;
    out.push({ type: ty.type, label: shortType(ty.label), bands, rows });
  }
  out.sort((a, b) => b.rows.length - a.rows.length);
  const rows = out.flatMap((t) => t.rows).sort((a, b) => Math.abs(Math.log(b.price / b.fromMedian)) - Math.abs(Math.log(a.price / a.fromMedian)));
  return { ready: true, types: out, rows, lead: out[0], total };
}
