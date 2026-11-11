import { tr } from '../../i18n';
/**
 * The Trader's logic, ported from upstream's `TradeQuery.lua` and `TradeQueryGenerator.lua`: stat weights, the weighted
 * search query, sorting fetched results and the total price. Pure functions; the engine and the network sit outside.
 */

export interface StatWeight {
  stat: string;
  label: string;
  weightMult: number;
  /** "Taken damage" stats: lower is better, so the ratio is negated. */
  negate: boolean;
}

export const DEFAULT_WEIGHTS: StatWeight[] = [
  { stat: 'FullDPS', label: 'Full DPS', weightMult: 1, negate: false },
  { stat: 'TotalEHP', label: 'Effective Hit Pool', weightMult: 0.5, negate: false },
];

export const SORT_MODES = ['(Highest) Stat Value', 'Stat Value / Price', '(Lowest) Price', '(Highest) Weighted Sum'] as const;
export type SortMode = (typeof SORT_MODES)[number];
/** The sort mode's name in the current language (the English value is what is stored and compared). */
export const sortWord = (m: string): string => ({ '(Highest) Stat Value': tr('h_c_It.sm_highest_stat'), 'Stat Value / Price': tr('h_c_It.sm_value_price'), '(Lowest) Price': tr('h_c_It.sm_lowest_price'), '(Highest) Weighted Sum': tr('h_c_It.sm_weighted') } as Record<string, string>)[m] ?? m;

export const TRADE_TYPES: Array<{ label: string; status: string }> = [
  { label: tr('items_trader_model.instant_buyout'), status: 'securable' },
  { label: tr('h_c_It.tt_instant_inperson'), status: 'available' },
  { label: tr('h_c_It.tt_inperson_league'), status: 'onlineleague' },
  { label: tr('h_c_It.tt_inperson_online'), status: 'online' },
  { label: tr('h_c_It.tt_any'), status: 'any' },
];

export const REALMS = [
  { label: 'PC', id: 'pc' },
  { label: 'Xbox', id: 'xbox' },
  { label: 'Sony', id: 'sony' },
];

/** `data.misc.maxStatIncrease`: a result counts for at most double the stat. */
export const MAX_STAT_INCREASE = 2;

/** The stats of the open build with and without a candidate: stat id -> value (null when it could not be calculated). */
export type StatValues = Record<string, number | null | undefined>;

/**
 * `WeightedRatioOutputs`: how much better a candidate is than the build as it stands, the stats' ratios added up with
 * their multipliers. A stat the build has none of counts its ratio from 1.
 */
export function weightedRatio(base: StatValues, next: StatValues, weights: StatWeight[]): number {
  let sum = 0;
  for (const w of weights) {
    const b = base[w.stat];
    const n = next[w.stat];
    if (b === undefined || b === null || n === undefined || n === null) continue;
    let ratio: number;
    if (b === Infinity) ratio = 0;
    else if (n === Infinity) ratio = MAX_STAT_INCREASE;
    else ratio = Math.min(n / (b !== 0 ? b : 1), MAX_STAT_INCREASE);
    if (w.negate) ratio = -ratio;
    sum += ratio * w.weightMult;
  }
  return sum;
}

// ---- trade URLs ------------------------------------------------------------------------------------------------------

export interface TradeUrl {
  realm: string | null;
  league: string;
  id: string;
}

/** `.../trade/search/[realm/]league/id`; null for anything else (upstream needs 2 or 3 path parts). */
export function parseTradeUrl(url: string): TradeUrl | null {
  const m = /^(?:https?:\/\/)?(?:www\.)?pathofexile\.com\/trade\/search\/([^?#]+)/i.exec(url.trim());
  if (!m) return null;
  const parts = m[1]!.split('/').filter(Boolean).map((p) => decodeURIComponent(p.replace(/\+/g, ' ')));
  if (parts.length < 2 || parts.length > 3) return null;
  return { realm: parts.length === 3 ? parts[0]! : null, league: parts[parts.length - 2]!, id: parts[parts.length - 1]! };
}

export function buildSearchUrl(realm: string, league: string, query: unknown, queryId?: string): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  let url = 'https://www.pathofexile.com/trade/search';
  if (realm && realm !== 'pc') url += '/' + realm;
  url += '/' + enc(league || 'Standard').replace(/%20/g, '+');
  return queryId ? `${url}/${queryId}` : `${url}?q=${enc(JSON.stringify(query))}`;
}

// ---- query mods ------------------------------------------------------------------------------------------------------

/** One entry of upstream's QueryMods data. */
export interface QMod {
  k: string;
  /** The trade site's stat id ("explicit.stat_123"). */
  id: string;
  /** The stat's text with # for the value. */
  t: string;
  /** Per item category the lowest and highest roll. */
  c: Record<string, [number, number]>;
  s?: string;
  i?: string;
  x?: { overrideModLine?: string; overrideModLineSingular?: string };
  y?: string;
}
export type QueryMods = Record<string, QMod[]>;

export interface QueryOptions {
  includeCorrupted: boolean;
  includeScourge: boolean;
  includeTalisman: boolean;
  /** "Copy Current" | "Keep regular" | "Keep regular+presence" | "Remove" */
  eldritch?: string;
}

/** The mod lists the weight pass tests for an item category, in upstream's order (`ExecuteQuery`). */
export function modGroups(o: QueryOptions, special?: 'watchersEye' | 'pearl' | 'megalomaniac'): string[] {
  if (special === 'watchersEye') return o.includeCorrupted ? ['WatchersEye', 'Corrupted'] : ['WatchersEye'];
  const out = ['Explicit', 'Implicit'];
  if (o.includeCorrupted) out.push('Corrupted');
  if (o.includeTalisman) out.push('Enchant');
  if (o.includeScourge) out.push('Scourge');
  if (o.eldritch && o.eldritch.startsWith('Keep')) out.push('Eater', 'Exarch');
  return out;
}

export interface Candidate {
  tradeId: string;
  /** The test line the engine calculates: the mod's text with a value halfway through its range. */
  line: string;
  value: number;
  invert: boolean;
}

/** `GenerateModWeights`: the mods to test for a category, one per trade stat, each at the middle of its range. */
export function modCandidates(data: QueryMods, groups: string[], category: string, o: QueryOptions, quality = 0.5): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const g of groups) {
    for (const m of data[g] ?? []) {
      const range = m.c[category];
      if (!range || seen.has(m.id)) continue;
      if (g === 'Eater' || g === 'Exarch') {
        // "Keep regular" leaves out the conditional presence mods (upstream matches the mod key's ending).
        if (o.eldritch === 'Keep regular' && /(PinnaclePresence|UniquePresence)$/.test(m.k)) continue;
      }
      const value = Math.ceil((range[1] - range[0]) * quality + range[0]);
      if (!value) continue;
      const shown = (m.s ?? '') + String(value);
      const template = value === 1 && m.x?.overrideModLineSingular ? m.x.overrideModLineSingular : m.x?.overrideModLine ?? m.t;
      out.push({ tradeId: m.id, line: template.replace(/#/g, shown), value, invert: m.s === '-' });
      seen.add(m.id);
    }
  }
  return out;
}

export interface Weighted {
  tradeModId: string;
  weight: number;
  meanStatDiff: number;
  invert: boolean;
}

/** The sort upstream gives the tested mods: the biggest stat difference first. */
export function sortWeights(list: Weighted[]): Weighted[] {
  return [...list].sort((a, b) => (a.meanStatDiff === b.meanStatDiff ? Math.abs(b.weight) - Math.abs(a.weight) : b.meanStatDiff - a.meanStatDiff));
}

// ---- the weighted search query ---------------------------------------------------------------------------------------

export interface MaxPrice {
  amount: number;
  /** The trade site's currency option ("chaos_divine"...). */
  type: string;
}

export interface BuildQueryInput {
  weights: Weighted[];
  minWeight: number;
  /** 'securable' | 'available' | 'onlineleague' | 'online' | 'any' */
  status: string;
  category: string;
  /** Query filters that replace the category/rarity filter (the unique rows). */
  filters?: Record<string, unknown>;
  /** Extra top-level query fields (a unique's name and type). */
  extra?: Record<string, unknown>;
  required: Array<{ tradeId: string; value?: number }>;
  blocked: Array<{ tradeId: string; value?: number }>;
  includeMirrored: boolean;
  maxPrice?: MaxPrice;
  maxLevel?: number;
  sockets?: number;
  links?: number;
}

const PSEUDO: Record<string, string> = {
  '3372524247': 'pseudo.pseudo_total_fire_resistance',
  '4220027924': 'pseudo.pseudo_total_cold_resistance',
  '1671376347': 'pseudo.pseudo_total_lightning_resistance',
  '2923486259': 'pseudo.pseudo_total_chaos_resistance',
  '4080418644': 'pseudo.pseudo_total_strength',
  '3261801346': 'pseudo.pseudo_total_dexterity',
  '328541901': 'pseudo.pseudo_total_intelligence',
};

/** Hybrid stats (their value comes from the single stats) and "all attributes" carry no weight of their own. */
export const IGNORED_TEXTS = [
  '+#% to all Elemental Resistances',
  '+# to all Attributes',
  '+#% to Fire and Cold Resistances',
  '+#% to Fire and Lightning Resistances',
  '+#% to Cold and Lightning Resistances',
  '+#% to Fire and Chaos Resistances',
  '+#% to Cold and Chaos Resistances',
  '+#% to Lightning and Chaos Resistances',
  '+# to Strength and Dexterity',
  '+# to Strength and Intelligence',
  '+# to Dexterity and Intelligence',
];

const hashOf = (id: string): string => /stat_(\d+)/.exec(id)?.[1] ?? '';

export function ignoredHashes(data: QueryMods): Set<string> {
  const texts = new Set(IGNORED_TEXTS);
  const out = new Set<string>();
  for (const list of Object.values(data)) for (const m of list) if (texts.has(m.t)) out.add(hashOf(m.id));
  // The all-resistances and all-attributes stats upstream names by hash.
  for (const h of ['2901986750', '1379411836', '2897413282']) out.add(h);
  return out;
}

export interface BuiltQuery {
  query: Record<string, unknown>;
  filters: number;
  error?: string;
}

/** `FinishQuery`: the trade search that sorts by the weighted sum, within the site's complexity limit of 200. */
export function buildWeightedQuery(input: BuildQueryInput, ignored: Set<string>): BuiltQuery {
  const weightGroup: { type: 'weight'; value: { min: number }; filters: unknown[] } = { type: 'weight', value: { min: input.minWeight }, filters: [] };
  const andGroup: { type: 'and'; filters: unknown[] } = { type: 'and', filters: [] };
  const notGroup: { type: 'not'; filters: unknown[] } = { type: 'not', filters: [] };
  const filters: Record<string, unknown> = input.filters ?? { type_filters: { filters: { category: { option: input.category }, rarity: { option: 'nonunique' } } } };
  const q: Record<string, unknown> = { filters, status: { option: input.status }, stats: [weightGroup, andGroup, notGroup] };
  // The site allows a complexity of 200 per query; the weighted group costs 54 to start, the rarity filter and category 4, the and group 4.
  let budget = 200 - 54 - 4 - 4;
  const statFilters: Array<{ id: string; value: { weight: number } }> = [];
  const pseudo = new Map<string, { id: string; value: { weight: number } }>();
  for (const e of input.weights) {
    const hash = hashOf(e.tradeModId);
    const entry = { id: e.tradeModId, value: { weight: e.invert ? e.weight * -1 : e.weight } };
    if (ignored.has(hash)) continue;
    const ps = PSEUDO[hash];
    if (ps) {
      entry.id = ps;
      const have = pseudo.get(ps);
      if (have) have.value.weight = Math.max(entry.value.weight, have.value.weight);
      else {
        pseudo.set(ps, entry);
        statFilters.push(entry);
      }
    } else statFilters.push(entry);
  }
  for (const [k, v] of Object.entries(input.extra ?? {})) {
    budget -= 2;
    q[k] = v;
  }
  for (const r of input.required) {
    budget -= 4;
    andGroup.filters.push({ id: r.tradeId, value: { min: r.value } });
  }
  for (const r of input.blocked) {
    budget -= 4;
    notGroup.filters.push({ id: r.tradeId, value: { min: r.value } });
  }
  if (!input.includeMirrored) {
    budget -= 3;
    filters.misc_filters = { disabled: false, filters: { mirrored: false } };
  }
  if (input.maxPrice && input.maxPrice.amount > 0) {
    budget -= 3;
    filters.trade_filters = { filters: { price: { option: input.maxPrice.type, max: input.maxPrice.amount } } };
  }
  if (input.maxLevel && input.maxLevel > 0) {
    budget -= 3;
    filters.req_filters = { disabled: false, filters: { lvl: { max: input.maxLevel } } };
  }
  if (input.sockets && input.sockets > 0) {
    budget -= 3;
    filters.socket_filters = { disabled: false, filters: { sockets: { min: input.sockets, max: input.sockets } } };
  }
  if (input.links && input.links > 0) {
    budget -= 3;
    const sf = (filters.socket_filters ??= { disabled: false, filters: {} }) as { filters: Record<string, unknown> };
    sf.filters.links = { min: input.links, max: input.links };
  }
  for (const e of statFilters) {
    // Leave room for the exact search's account name and price.
    if (budget < 8) break;
    budget -= 4;
    weightGroup.filters.push(e);
  }
  return {
    query: { query: q, sort: { 'statgroup.0': 'desc' }, engine: 'new' },
    filters: weightGroup.filters.length,
    ...(weightGroup.filters.length === 0 ? { error: tr('items_trader_model.could_not_generate_search_found_no') } : {}),
  };
}

/** Sorting a pasted URL's search: weighted queries sort by their weight, others by price (`SearchWithURL`). */
export function sortForQuery(query: { query?: { stats?: Array<{ type?: string }> } }): Record<string, string> {
  return query.query?.stats?.[0]?.type === 'weight' ? { 'statgroup.0': 'desc' } : { price: 'asc' };
}

// ---- results ---------------------------------------------------------------------------------------------------------

export interface Priced {
  amount: number | null;
  currency: string | null;
}

/** Evaluated results keep the order the trade site gave, or are sorted by stat value or price (`SortFetchResults`). */
export function sortResults<T extends Priced & { weight: number }>(rows: T[], mode: SortMode, divOf: (currency: string, amount: number) => number | null): { order: number[]; fellBack: boolean } {
  const idx = rows.map((_, i) => i);
  if (mode === '(Highest) Weighted Sum') return { order: idx, fellBack: false };
  const byValue = () => idx.sort((a, b) => rows[b]!.weight - rows[a]!.weight);
  if (mode === '(Highest) Stat Value') return { order: byValue(), fellBack: false };
  const prices = rows.map((r) => (r.currency && r.amount !== null ? divOf(r.currency, r.amount) : null));
  if (prices.some((p) => p === null)) return { order: byValue(), fellBack: true };
  if (mode === '(Lowest) Price') return { order: idx.sort((a, b) => prices[a]! - prices[b]!), fellBack: false };
  // Stat Value / Price: the weight less 0.1 times the log of the price in divines, so a cheap good item beats a perfect one costing far more.
  const score = (i: number) => rows[i]!.weight - 0.1 * Math.log10(prices[i]!);
  return { order: idx.sort((a, b) => score(b) - score(a)), fellBack: false };
}

/** "Total Price: 3 chaos, 1 divine": the chosen results' prices added per currency, the most valuable currency first. */
export function totalPriceText(prices: Array<{ currency: string; amount: number }>, divOf: (currency: string) => number | undefined): string {
  const sums = new Map<string, number>();
  for (const p of prices) sums.set(p.currency, (sums.get(p.currency) ?? 0) + p.amount);
  const order = [...sums.keys()].sort((a, b) => {
    const x = divOf(a);
    const y = divOf(b);
    return x !== undefined && y !== undefined ? y - x : a < b ? 1 : a > b ? -1 : 0;
  });
  return order.map((c) => `${Math.round(sums.get(c)! * 100) / 100} ${c}`).join(', ');
}

export function whisperLabel(r: { whisper: string; priceType?: string; amount: number | null; currency: string | null } | undefined): string {
  if (!r) return '';
  const price = r.amount !== null && r.currency ? `${r.amount} ${r.currency}` : '';
  // An instant buyout (~b/o) is searched for, not whispered.
  if (r.whisper && r.priceType !== '~b/o') return price ? tr('items_trader_model.whisper_for', { price: price }) : tr('items_trader_model.whisper');
  return price ? tr('items_trader_model.search_for', { price: price }) : tr('items_trader_model.search');
}

/** The search for exactly one result: the weight window around it and its seller (`whisperButton`). */
export function exactQuery(last: { query?: { stats?: Array<{ value?: unknown }>; filters?: Record<string, unknown> } }, weight: number, account: string): unknown {
  const q = JSON.parse(JSON.stringify(last)) as { query: { stats: Array<{ value?: { min: number; max: number } }>; filters?: Record<string, unknown> } };
  if (q.query.stats[0]) q.query.stats[0].value = { min: Math.floor(weight) - 1, max: Math.round(weight) + 1 };
  q.query.filters ??= {};
  const tf = (q.query.filters.trade_filters ??= { filters: {} }) as { filters: Record<string, unknown> };
  tf.filters ??= {};
  tf.filters.account = { input: account };
  return q;
}

/** The status line for a text field of max price: only whole numbers. */
export function wholeNumber(s: string): number | undefined {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const CURRENCIES: Array<{ name: string; id: string | null }> = [
  { name: 'Chaos Orb Equivalent', id: null },
  { name: 'Chaos Orb', id: 'chaos' },
  { name: 'Divine Orb', id: 'divine' },
  { name: 'Orb of Alchemy', id: 'alch' },
  { name: 'Orb of Alteration', id: 'alt' },
  { name: 'Chromatic Orb', id: 'chrome' },
  { name: 'Exalted Orb', id: 'exalted' },
  { name: 'Blessed Orb', id: 'blessed' },
  { name: "Cartographer's Chisel", id: 'chisel' },
  { name: "Gemcutter's Prism", id: 'gcp' },
  { name: "Jeweller's Orb", id: 'jewellers' },
  { name: 'Orb of Scouring', id: 'scour' },
  { name: 'Orb of Regret', id: 'regret' },
  { name: 'Orb of Fusing', id: 'fusing' },
  { name: 'Orb of Chance', id: 'chance' },
  { name: 'Regal Orb', id: 'regal' },
  { name: 'Vaal Orb', id: 'vaal' },
];

/** The trade site's price filter option: "chaos_divine" is a chaos-equivalent price, anything else is that currency. */
export function priceOption(id: string | null): string {
  return id ?? 'chaos_divine';
}

/** `TradeHelpers.getTradeCategory`: the trade site's category and the key QueryMods lists a slot's mods under. */
export function categoryOf(slotName: string, itemType: string | undefined): { trade: string; key: string } | null {
  if (slotName.includes('Abyssal')) return { trade: 'jewel.abyss', key: 'AbyssJewel' };
  if (/^Weapon \d/.test(slotName)) {
    if (!itemType) return { trade: 'weapon.one', key: '1HWeapon' };
    const m: Record<string, [string, string]> = {
      Shield: ['armour.shield', 'Shield'],
      Quiver: ['armour.quiver', 'Quiver'],
      Bow: ['weapon.bow', 'Bow'],
      Staff: ['weapon.staff', 'Staff'],
      'Two Handed Sword': ['weapon.twosword', '2HSword'],
      'Two Handed Axe': ['weapon.twoaxe', '2HAxe'],
      'Two Handed Mace': ['weapon.twomace', '2HMace'],
      'Fishing Rod': ['weapon.rod', 'FishingRod'],
      'One Handed Sword': ['weapon.onesword', '1HSword'],
      'One Handed Axe': ['weapon.oneaxe', '1HAxe'],
      'One Handed Mace': ['weapon.onemace', '1HMace'],
      Sceptre: ['weapon.sceptre', 'Sceptre'],
      Wand: ['weapon.wand', 'Wand'],
      Dagger: ['weapon.dagger', 'Dagger'],
      Claw: ['weapon.claw', 'Claw'],
    };
    const hit = m[itemType];
    if (hit) return { trade: hit[0], key: hit[1] };
    if (itemType.includes('Two Handed')) return { trade: 'weapon.twomelee', key: '2HWeapon' };
    if (itemType.includes('One Handed')) return { trade: 'weapon.one', key: '1HWeapon' };
    return { trade: 'weapon', key: '1HWeapon' };
  }
  if (slotName === 'Body Armour') return { trade: 'armour.chest', key: 'Chest' };
  if (slotName === 'Helmet') return { trade: 'armour.helmet', key: 'Helmet' };
  if (slotName === 'Gloves') return { trade: 'armour.gloves', key: 'Gloves' };
  if (slotName === 'Boots') return { trade: 'armour.boots', key: 'Boots' };
  if (slotName === 'Amulet') return { trade: 'accessory.amulet', key: 'Amulet' };
  if (/^Ring \d$/.test(slotName)) return { trade: 'accessory.ring', key: 'Ring' };
  if (slotName === 'Belt') return { trade: 'accessory.belt', key: 'Belt' };
  if (slotName.includes('Abyssal')) return { trade: 'jewel.abyss', key: 'AbyssJewel' };
  if (slotName.includes('Jewel')) return { trade: 'jewel', key: 'Jewel' };
  if (slotName.includes('Flask')) return { trade: 'flask', key: 'Flask' };
  return null;
}

/** The slots whose items can carry eldritch implicits (`eldritchModSlots`). */
export const ELDRITCH_SLOTS = ['Body Armour', 'Helmet', 'Gloves', 'Boots', 'Amulet'];

/** The base a test item uses when the slot is empty. */
export function defaultTestBase(slotName: string): string {
  if (/^Weapon/.test(slotName)) return 'Driftwood Wand';
  if (slotName === 'Body Armour') return 'Plate Vest';
  if (slotName === 'Helmet') return 'Iron Hat';
  if (slotName === 'Gloves') return 'Iron Gauntlets';
  if (slotName === 'Boots') return 'Iron Greaves';
  if (/^Ring/.test(slotName)) return 'Iron Ring';
  if (slotName === 'Belt') return 'Leather Belt';
  if (/Jewel|Abyssal/.test(slotName)) return 'Viridian Jewel';
  if (/Flask/.test(slotName)) return 'Divine Life Flask';
  return 'Unset Amulet';
}

/** A slider position (0 to 100) as the weight it means: 0 is off, the rest runs from 0.01 to 1.00. */
export function weightOfSlider(v: number): number {
  return v <= 0 ? 0 : Math.round((0.01 + (v / 100) * 0.99) * 100) / 100;
}

export function sliderOfWeight(w: number): number {
  return w <= 0 ? 0 : w >= 1 ? 100 : Math.round(((w - 0.01) / 0.99) * 100);
}

