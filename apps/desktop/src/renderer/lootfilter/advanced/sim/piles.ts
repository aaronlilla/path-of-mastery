import type { DropSession } from '../../../../shared/lootfilter/drops.js';
import type { Catalog, CatalogItem } from '../../../../shared/lootfilter/catalog.js';
import type { ItemProps } from '../../../../shared/lootfilter/evaluate.js';
import type { SimItem } from './parseItem';
import { tr } from '../../../i18n';

/** The three piles the design offers, built from real data: NeverSink's items, the game's base table, poe.ninja prices and the player's own sessions. */

export const T16_LEVEL = 83;
/** Act 3 monsters sit around level 30. An approximation: the game data here has no zone table. */
export const ACT3_LEVEL = 30;

export interface BaseRow {
  name: string;
  class: string;
  level: number;
}

export function rng(seed: number): () => number {
  let s = Math.max(1, Math.floor(seed)) % 2147483647;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const isGear = (c: string): boolean => !/Flask|Jewel|Quiver|Fishing|Tincture/i.test(c);

/** Picks `n` distinct entries; cheaper or commoner ones come up more often. */
function pickWeighted<T>(list: T[], n: number, weight: (x: T) => number, r: () => number): T[] {
  const pool = list.map((x) => ({ x, w: Math.max(0.0001, weight(x)) }));
  const out: T[] = [];
  while (out.length < n && pool.length) {
    const total = pool.reduce((s, e) => s + e.w, 0);
    let t = r() * total;
    let i = 0;
    for (; i < pool.length - 1; i++) {
      t -= pool[i]!.w;
      if (t <= 0) break;
    }
    out.push(pool[i]!.x);
    pool.splice(i, 1);
  }
  return out;
}

function gearItems(bases: BaseRow[], lo: number, hi: number, n: number, seed: number, rarities: [string, number][], keyPrefix: string): SimItem[] {
  const pool = bases.filter((b) => b.level >= lo && b.level <= hi && isGear(b.class));
  if (!pool.length) return [];
  const r = rng(seed);
  const used = new Set<string>();
  const out: SimItem[] = [];
  const total = rarities.reduce((s, e) => s + e[1], 0);
  for (let i = 0; i < n * 4 && out.length < n; i++) {
    const b = pool[Math.floor(r() * pool.length)]!;
    if (used.has(b.name)) continue;
    used.add(b.name);
    let x = r() * total;
    let rarity = rarities[0]![0];
    for (const [name, w] of rarities) {
      x -= w;
      if (x <= 0) {
        rarity = name;
        break;
      }
    }
    const il = Math.min(hi + 4, Math.max(1, b.level + Math.floor(r() * 6)));
    const body = /Body|Two Hand|Bows|Staves|Warstaves/.test(b.class);
    const l = body && r() < 0.2 ? 4 : 0;
    const props = { name: b.name, class: b.class, rarity, itemLevel: il, dropLevel: b.level, identified: true, corrupted: false, mirrored: false, quality: 0, linkedSockets: l, stackSize: 1, ...(l === 0 ? { sockets: '' } : {}) } as ItemProps;
    out.push({ key: `${keyPrefix}:${b.name}`, display: b.name, props });
  }
  return out;
}

const goldItem = (n: number): SimItem => ({ key: `gold:${n}`, display: tr('lootfilter_advanced_sim_piles.tolocalestring_gold', { value: n.toLocaleString('en-US') }), props: { name: 'Gold', class: 'Stackable Currency', rarity: 'Normal', stackSize: n, identified: true, corrupted: false, mirrored: false, quality: 0, linkedSockets: 0 } as unknown as ItemProps });
const mapItem = (tier: number): SimItem => ({ key: `map:${tier}`, display: tr('lootfilter_advanced_sim_piles.map_tier_tier', { tier }), props: { name: `Tier ${tier} Map`, class: 'Maps', rarity: 'Normal', mapTier: tier, itemLevel: 68 + tier, identified: true, corrupted: false, mirrored: false, quality: 0, linkedSockets: 0, stackSize: 1 } as unknown as ItemProps });

interface Ctx {
  catalog: Catalog;
  bases: BaseRow[] | undefined;
  price(name: string): number | undefined;
  propsOf(it: CatalogItem): ItemProps;
}

const named = (c: Ctx, it: CatalogItem): SimItem => ({ key: 'c:' + it.name, display: it.name, props: c.propsOf(it) });
/** Commoner means cheaper: weight falls with the poe.ninja price, and an unpriced item counts as cheap. */
const cheapFirst = (c: Ctx) => (it: CatalogItem): number => 1 / Math.pow(1 + (c.price(it.name) ?? 0), 0.7);

/** What a T16 map drops: currency, cards, a few fragments and scarabs, maps, gold, and gear at the top item levels. */
export function t16Pile(c: Ctx): SimItem[] {
  const r = rng(7);
  const of = (re: RegExp) => c.catalog.items.filter((it) => re.test(it.type) && !it.hidden);
  const out: SimItem[] = [];
  out.push(...pickWeighted(of(/^currency$/), 10, cheapFirst(c), r).map((it) => named(c, it)));
  out.push(...[16, 15, 14].map(mapItem));
  out.push(...pickWeighted(of(/^divination/), 4, cheapFirst(c), r).map((it) => named(c, it)));
  out.push(...pickWeighted(of(/^uniques$/), 3, cheapFirst(c), r).map((it) => named(c, it)));
  out.push(...pickWeighted(of(/^fragments/), 3, cheapFirst(c), r).map((it) => named(c, it)));
  out.push(goldItem(850));
  if (c.bases) out.push(...gearItems(c.bases, 60, 84, 10, 11, [['Normal', 3], ['Magic', 4], ['Rare', 3]], 't16'));
  return out;
}

/** An Act 3 pile: white and blue gear from the level-appropriate bases, with the leveling currency that drops beside it. */
export function act3Pile(c: Ctx): SimItem[] {
  const r = rng(31);
  const out: SimItem[] = [];
  if (c.bases) out.push(...gearItems(c.bases, 1, 34, 24, 29, [['Normal', 1], ['Magic', 1]], 'a3'));
  const cur = c.catalog.items.filter((it) => it.type === 'currency' && /Wisdom|Portal|Transmutation|Augmentation|Alteration|Chromatic|Blessed|Alchemy|Jeweller/.test(it.name));
  out.push(...pickWeighted(cur, 6, () => 1, r).map((it) => named(c, it)));
  out.push(goldItem(120));
  return out;
}

/** The player's recent drops, from the loot their Wealth sessions recorded: newest first, each stack expanded up to 3 labels. */
export function lastDrops(sessions: DropSession[], c: Ctx, n = 50): { items: SimItem[]; unplaced: number } {
  const bases = new Map((c.bases ?? []).map((b) => [b.name, b]));
  const items: SimItem[] = [];
  let unplaced = 0;
  for (const s of [...sessions].sort((a, b) => b.start - a.start)) {
    for (const g of s.gained) {
      if (items.length >= n) break;
      if (g.transfer) continue;
      const it = c.catalog.byName.get(g.name);
      const base = bases.get(g.name);
      const reps = Math.min(3, Math.max(1, Math.round(g.qty)));
      for (let i = 0; i < reps && items.length < n; i++) {
        if (it) items.push({ ...named(c, it), key: `d:${items.length}:${it.name}` });
        else if (base) items.push({ key: `d:${items.length}:${base.name}`, display: base.name, props: { name: base.name, class: base.class, rarity: 'Rare', itemLevel: Math.min(86, base.level + 6), dropLevel: base.level, identified: true, corrupted: false, mirrored: false, quality: 0, linkedSockets: 0, stackSize: 1, sockets: '' } as ItemProps });
        else {
          unplaced++;
          break;
        }
      }
    }
  }
  return { items, unplaced };
}
