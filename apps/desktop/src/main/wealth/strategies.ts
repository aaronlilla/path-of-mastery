/**
 * Curated farming strategies, re-priced from the price book.
 *
 * A strategy is a recipe: what a map costs (scarabs, device items) and what comes back per map. The per-map yields
 * are the curator's estimates until sessions confirm them (each card says so); every price in them is live from
 * poe.ninja, so net per hour moves with the market. A strategy that cannot be priced says which item is missing.
 */
import type { StrategyDef, StrategyView } from '../../shared/wealth.js';
import type { PriceBook, PriceLine } from './priceBook.js';
import { totals, type Run } from './sessions.js';

const SRC = 'Estimated yields by the app author, re-priced live from poe.ninja. Your own sessions show how close they are.';

export const CURATED: StrategyDef[] = [
  {
    id: 'delirium-wisps',
    name: 'Delirium maps with Wisps',
    tags: ['Mapping', 'Delirium'],
    difficulty: 'Medium',
    map: 'Any Tier 16 map',
    mapNote: 'Alch and go. Quantity does not matter much here; clear speed does.',
    avoid: 'Skip no-regen and reflect. Delirium punishes slow clears.',
    needs: 'about 2M DPS and 5k effective HP',
    note: 'Open every Delirium mirror before the boss. The splinters and cards are most of the money, so sell them in stacks.',
    mapsPerHour: 12,
    scarabs: [{ name: 'Scarab of Wisps', perMap: 1 }, { name: 'Delirium Scarab of Paranoia', perMap: 1 }],
    device: [{ name: "Cartographer's Delirium Orb", perMap: 1 }],
    loot: [
      { name: 'Simulacrum Splinter', perMap: 18 },
      { name: 'Divine Orb', perMap: 0.14 },
      { name: 'Stacked Deck', perMap: 0.7 },
      { name: 'Orb of Annulment', perMap: 0.3 },
      { name: 'Chaos Orb', perMap: 16 },
    ],
    atlas: [{ n: 'Delirium: full wheel', kind: 'notable' }, { n: 'Item Quantity and Rarity', kind: 'node' }],
    atlasPoints: '',
    source: SRC,
  },
  {
    id: 'legion-timeless',
    name: 'Legion maps for Timeless emblems',
    tags: ['Mapping', 'Legion'],
    difficulty: 'Medium',
    map: 'Any Tier 16 map with a Legion encounter',
    mapNote: 'Alch and go. You need to break the whole encounter, so area of effect matters.',
    avoid: 'Skip anything that cuts your area of effect.',
    needs: 'fast clear, 2M+ DPS',
    note: 'Open every general and chest before the timer ends. Sell splinters in stacks of 100: the per-unit price is better.',
    mapsPerHour: 11,
    scarabs: [{ name: 'Legion Scarab of Eternal Conflict', perMap: 1 }],
    device: [],
    loot: [
      { name: 'Timeless Templar Splinter', perMap: 9 },
      { name: 'Timeless Vaal Splinter', perMap: 9 },
      { name: 'Timeless Maraketh Emblem', perMap: 0.12 },
      { name: 'Divine Orb', perMap: 0.1 },
      { name: 'Chaos Orb', perMap: 12 },
    ],
    atlas: [{ n: 'Legion: full wheel', kind: 'notable' }, { n: 'Item Quantity and Rarity', kind: 'node' }],
    atlasPoints: '',
    source: SRC,
  },
  {
    id: 'beasts-duplicating',
    name: 'Bestiary maps, red beasts',
    tags: ['Mapping', 'Bestiary'],
    difficulty: 'Easy',
    map: 'Any Tier 16 map',
    mapNote: 'Alch and go. Use a beast-heavy map layout.',
    avoid: 'Skip maps where beasts cannot be captured: you need room to net them.',
    needs: 'about 1M DPS, a net you can throw quickly',
    note: 'Kill every beast and capture the red ones before the boss. Sell the beasts in bulk, not one by one.',
    mapsPerHour: 10,
    scarabs: [{ name: 'Bestiary Scarab of Duplicating', perMap: 1 }, { name: 'Bestiary Scarab of the Herd', perMap: 1 }],
    device: [],
    loot: [
      { name: 'Wild Brambleback', perMap: 0.3 },
      { name: 'Craicic Croaker', perMap: 0.05 },
      { name: 'Wild Hellion Alpha', perMap: 0.3 },
      { name: 'Divine Orb', perMap: 0.08 },
      { name: 'Chaos Orb', perMap: 14 },
    ],
    atlas: [{ n: 'Bestiary: full wheel', kind: 'notable' }, { n: 'Item Quantity and Rarity', kind: 'node' }],
    atlasPoints: '',
    source: SRC,
  },
  {
    id: 'blight-blooming',
    name: 'Blight with Blooming',
    tags: ['Mapping', 'Blight'],
    difficulty: 'Hard',
    map: 'Any Tier 16 Blighted map',
    mapNote: 'Alch and go. Build towers for the lanes you can cover.',
    avoid: 'Not for slow builds: the late waves need real damage.',
    needs: 'about 3M DPS, tower knowledge',
    note: 'Oils and cards are the steady income; the Divine Orbs are the spike. Keep the lanes clear before the last wave.',
    mapsPerHour: 9,
    scarabs: [{ name: 'Blight Scarab of Blooming', perMap: 1 }],
    device: [],
    loot: [
      { name: 'Divine Orb', perMap: 0.2 },
      { name: 'Stacked Deck', perMap: 1 },
      { name: 'Chaos Orb', perMap: 20 },
      { name: 'Orb of Annulment', perMap: 0.2 },
    ],
    atlas: [{ n: 'Blight: full wheel', kind: 'notable' }, { n: 'Item Quantity and Rarity', kind: 'node' }],
    atlasPoints: '',
    source: SRC,
  },
];

const unit = (book: PriceBook, name: string): { line: PriceLine | null; chaos: number | null } => {
  const l = book.lines(name).sort((a, b) => a.chaos - b.chaos)[0] ?? null;
  return { line: l, chaos: l ? l.chaos : null };
};

/** A line's 7 prices, or its current price repeated when it has no history. */
function series(l: PriceLine | null): number[] {
  if (!l) return [];
  return l.spark.length >= 7 ? l.spark.slice(-7) : Array(7).fill(l.chaos);
}

export interface StrategyContext {
  book: PriceBook;
  /** What the player holds, by item name. */
  have: (name: string) => number;
  /** Sessions tagged with a strategy id. */
  runs: Run[];
}

export function priceStrategy(def: StrategyDef, ctx: StrategyContext): StrategyView {
  const unpriced: string[] = [];
  const row = (name: string, perMap: number) => {
    const u = unit(ctx.book, name);
    if (u.chaos === null) unpriced.push(name);
    const art = u.line?.art ?? name;
    return { name, perMap, unit: u.chaos, have: ctx.have(name), art, ...(u.line?.artCat ? { artCat: u.line.artCat } : {}) };
  };
  const scarabRows = def.scarabs.map((s) => row(s.name, s.perMap));
  const deviceRows = def.device.map((s) => row(s.name, s.perMap));
  const lootRaw = def.loot.map((s) => ({ ...row(s.name, s.perMap), line: unit(ctx.book, s.name).line }));
  const costPerMap = [...scarabRows, ...deviceRows].reduce((s, r) => s + (r.unit ?? 0) * r.perMap, 0);
  const revenuePerMap = lootRaw.reduce((s, r) => s + (r.unit ?? 0) * r.perMap, 0);
  const lootRows = lootRaw.map((r) => ({ name: r.name, perMap: r.perMap, perHour: (r.unit ?? 0) * r.perMap * def.mapsPerHour, art: r.art, ...(r.artCat ? { artCat: r.artCat } : {}) }));

  // 7-day history of net per map, point by point.
  const costLines = [...def.scarabs, ...def.device].map((s) => ({ q: s.perMap, s: series(unit(ctx.book, s.name).line) }));
  const lootLines = def.loot.map((s) => ({ q: s.perMap, s: series(unit(ctx.book, s.name).line) }));
  const spark: number[] = [];
  for (let i = 0; i < 7; i++) {
    const rev = lootLines.reduce((a, l) => a + (l.s[i] ?? 0) * l.q, 0);
    const cost = costLines.reduce((a, l) => a + (l.s[i] ?? 0) * l.q, 0);
    spark.push((rev - cost) * def.mapsPerHour);
  }

  // What you would have to buy for 10 maps.
  let missing = 0;
  for (const r of [...scarabRows, ...deviceRows]) {
    const need = r.perMap * 10;
    if (r.have < need) missing += (need - r.have) * (r.unit ?? 0);
  }

  const mine = ctx.runs.filter((r) => r.end !== null && r.strategyId === def.id);
  let yours: StrategyView['yours'] = null;
  if (mine.length) {
    const hours = mine.reduce((a, r) => a + Math.max(1, ((r.end ?? r.start) - r.start) / 60000) / 60, 0);
    const net = mine.reduce((a, r) => a + totals(r).net, 0);
    yours = { perHour: net / hours, sessions: mine.length };
  }

  // With enough of the player's own sessions behind it (5 maps or more), the yield comes from them, not from the estimate.
  const mapsRun = mine.reduce((a, r) => a + r.maps, 0);
  const hoursRun = mine.reduce((a, r) => a + Math.max(1, ((r.end ?? r.start) - r.start) / 60000) / 60, 0);
  const measuredOn = mapsRun >= 5 && hoursRun > 0;
  let measuredLoot: StrategyView['lootRows'] | null = null;
  let mRevenue = 0;
  let mCost = 0;
  if (measuredOn) {
    const agg = new Map<string, { qty: number; value: number; art: string; artCat?: string }>();
    for (const r of mine) {
      for (const i of Object.values(r.gained)) {
        if (i.transfer) continue;
        const a = agg.get(i.name) ?? { qty: 0, value: 0, art: i.art, ...(i.artCat ? { artCat: i.artCat } : {}) };
        a.qty += i.qty;
        a.value += i.value;
        agg.set(i.name, a);
      }
      for (const i of Object.values(r.spent)) if (!i.transfer) mCost += i.value;
      for (const i of Object.values(r.gained)) if (!i.transfer) mRevenue += i.value;
    }
    measuredLoot = [...agg.entries()].sort((a, b) => b[1].value - a[1].value).slice(0, 6).map(([name, a]) => ({ name, perMap: a.qty / mapsRun, perHour: a.value / hoursRun, art: a.art, ...(a.artCat ? { artCat: a.artCat } : {}) }));
  }

  return {
    ...def,
    basis: measuredOn ? ('measured' as const) : ('estimate' as const),
    sessionsUsed: mine.length,
    mapsPerHour: measuredOn ? mapsRun / hoursRun : def.mapsPerHour,
    revenue: measuredOn ? mRevenue / hoursRun : revenuePerMap * def.mapsPerHour,
    cost: measuredOn ? mCost / hoursRun : costPerMap * def.mapsPerHour,
    net: measuredOn ? (mRevenue - mCost) / hoursRun : (revenuePerMap - costPerMap) * def.mapsPerHour,
    costPerMap: measuredOn ? mCost / mapsRun : costPerMap,
    spark,
    scarabRows,
    deviceRows,
    lootRows: measuredLoot ?? lootRows,
    missing,
    yours,
    unpriced,
  };
}

/** A strategy published from the player's own session: measured, not estimated. */
export function strategyFromRun(run: Run, divine: number): StrategyView {
  const t = totals(run);
  const hours = Math.max(1, ((run.end ?? run.start) - run.start) / 60000) / 60;
  const gained = Object.values(run.gained).filter((i) => !i.transfer).sort((a, b) => b.value - a.value);
  const spentItems = Object.values(run.spent).filter((i) => !i.transfer).sort((a, b) => b.value - a.value);
  const maps = Math.max(run.maps, 0);
  const perMapCost = maps ? t.cost / maps : 0;
  void divine;
  return {
    id: `m${run.id}`,
    name: run.name,
    tags: ['Mine'],
    difficulty: 'Medium',
    map: maps ? `${maps} maps in the session` : 'Not a mapping session',
    mapNote: 'Measured from your own stash snapshots.',
    avoid: '',
    needs: '',
    note: `Averaged over ${Math.round(hours * 60)} minutes of play.`,
    mapsPerHour: maps / hours,
    scarabs: [],
    device: [],
    loot: [],
    atlas: [],
    atlasPoints: '',
    source: 'Measured from your own stash snapshots.',
    mine: true,
    basis: 'measured' as const,
    sessionsUsed: 1,
    revenue: t.revenue / hours,
    cost: t.cost / hours,
    net: t.net / hours,
    costPerMap: perMapCost,
    spark: Array(7).fill(t.net / hours),
    scarabRows: spentItems.slice(0, 6).map((i) => ({ name: i.name, perMap: maps ? i.qty / maps : i.qty, unit: i.qty ? i.value / i.qty : null, have: 0, art: i.art, ...(i.artCat ? { artCat: i.artCat } : {}) })),
    deviceRows: [],
    lootRows: gained.slice(0, 6).map((i) => ({ name: i.name, perMap: maps ? i.qty / maps : i.qty, perHour: i.value / hours, art: i.art, ...(i.artCat ? { artCat: i.artCat } : {}) })),
    missing: 0,
    yours: { perHour: t.net / hours, sessions: 1 },
    unpriced: [],
  };
}

