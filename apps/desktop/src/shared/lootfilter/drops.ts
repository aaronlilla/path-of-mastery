/**
 * Drops, as far as they can honestly be known. The game's Client.txt has no item lines, so the source is the loot the
 * Wealth sessions recorded: what arrived in the counted tabs and the character between two stash reads. Items that
 * came in as one side of a trade are left out.
 */

export interface DropSession {
  start: number;
  gained: { name: string; qty: number; transfer?: boolean }[];
}

export interface Drop {
  name: string;
  qty: number;
  /** Start of the session that recorded it. */
  at: number;
}

export const LAST_DROPS = 50;

/** The newest `n` loot stacks, newest session first, trades left out. */
export function recentDrops(sessions: DropSession[], n = LAST_DROPS): Drop[] {
  const out: Drop[] = [];
  for (const s of [...sessions].sort((a, b) => b.start - a.start)) {
    for (const g of s.gained) {
      if (out.length >= n) return out;
      if (g.transfer) continue;
      out.push({ name: g.name, qty: g.qty, at: s.start });
    }
  }
  return out;
}

export interface DropProbe {
  /** Whether the filter shows this item now. */
  visible: boolean;
  /** Chaos price, null when unpriced. */
  price: number | null;
}

export interface DropSuggestion {
  id: string;
  /** Hidden items worth keeping, dearest first. */
  names: string[];
  line: string;
  question: string;
  done: string;
}

/** A drop the filter hides is worth showing from this price (chaos). */
export const SHOW_FROM = 2;
const MAX_NAMES = 10;

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Items from the last drops that the filter hides although they are worth at least `min` chaos. */
export function hiddenValuableDrops(drops: Drop[], probe: (name: string) => DropProbe | null, min = SHOW_FROM): DropSuggestion | null {
  const seen = new Map<string, number>();
  for (const d of drops) {
    const p = probe(d.name);
    if (p && !p.visible && p.price !== null && p.price >= min) seen.set(d.name, p.price);
  }
  const names = [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n).slice(0, MAX_NAMES);
  if (!names.length) return null;
  const list = names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  return {
    id: `drops:show:${[...names].sort().join(',')}`,
    names,
    line: `${list} dropped in your last ${plural(drops.length, 'loot stack')}, and the filter hides ${names.length === 1 ? 'it' : 'them'}, though ${names.length === 1 ? 'it is' : 'they are'} worth ${min} chaos or more each.`,
    question: `Show ${names.length === 1 ? 'this item' : plural(names.length, 'item')}?`,
    done: `Showed ${plural(names.length, 'item')} that dropped but were hidden`,
  };
}

/** The tier whose median price is closest (on a log scale) to `price`: the look a newly shown item should take. */
export function nearestTier<T>(tiers: { tier: T; median: number }[], price: number): T | null {
  let best: T | null = null;
  let d = Infinity;
  for (const t of tiers) {
    if (t.median <= 0 || price <= 0) continue;
    const x = Math.abs(Math.log(price / t.median));
    if (x < d) {
      d = x;
      best = t.tier;
    }
  }
  return best;
}
