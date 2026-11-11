/**
 * The price book: poe.ninja's economy lines indexed for matching stash items to prices, and the matcher itself.
 *
 * Rules (issue 3, "item to price"):
 *  - Currency, scarabs, fossils, oils, essences, cards: exchange lines, joined by name.
 *  - Uniques: by name, then by variant only where several lines share a name. When the stash item doesn't tell us
 *    which variant it is, the price is a range and the total uses the low end.
 *  - Gems: variant is "level/quality", plus "c" if corrupted.
 *  - Cluster jewels: variant "N passives", name is the enchant text.
 *  - Base types: variant is the influence list; the line is for the item level (levelRequired).
 *  - No match is "unpriced", never zero.
 */
import type { Cat, CxQuote } from '../../shared/wealth.js';

/** A GGG currency exchange price, with what the app needs to show it as a line of its own. */
export interface CxPrice extends CxQuote {
  name: string;
  cat: Cat;
}

export interface PriceLine {
  id: string;
  name: string;
  variant?: string;
  baseType?: string;
  /** poe.ninja type it came from, like "UniqueArmour". */
  type: string;
  cat: Cat;
  /** Chaos orbs. */
  chaos: number;
  /** poe.ninja's own divine price (its stash rate, which differs a little from the exchange `divine`). */
  divineValue?: number;
  listings?: number;
  /** Last 7 days, oldest first, in chaos. May be empty. */
  spark: number[];
  links?: number;
  levelRequired?: number;
  gemLevel?: number;
  gemQuality?: number;
  corrupted?: boolean;
  /** Epoch ms the category this line came from was fetched. */
  at: number;
  art: string;
  artCat?: string;
}

export const EXCHANGE_TYPES: { type: string; cat: Cat }[] = [
  { type: 'Currency', cat: 'cur' },
  { type: 'Fragment', cat: 'frag' },
  { type: 'Scarab', cat: 'scar' },
  { type: 'DivinationCard', cat: 'card' },
  { type: 'Essence', cat: 'ess' },
  { type: 'Oil', cat: 'cur' },
  { type: 'Fossil', cat: 'cur' },
  { type: 'Resonator', cat: 'cur' },
  { type: 'DeliriumOrb', cat: 'cur' },
  { type: 'Omen', cat: 'cur' },
  { type: 'Tattoo', cat: 'cur' },
  { type: 'Runegraft', cat: 'cur' },
  { type: 'AllflameEmber', cat: 'cur' },
  { type: 'Ducat', cat: 'cur' },
  { type: 'EnshroudingCrystal', cat: 'cur' },
  { type: 'DjinnCoin', cat: 'cur' },
  { type: 'Artifact', cat: 'cur' },
  { type: 'Astrolabe', cat: 'frag' },
];

export const ITEM_TYPES: { type: string; cat: Cat }[] = [
  { type: 'UniqueWeapon', cat: 'uniq' },
  { type: 'UniqueArmour', cat: 'uniq' },
  { type: 'UniqueAccessory', cat: 'uniq' },
  { type: 'UniqueFlask', cat: 'uniq' },
  { type: 'UniqueJewel', cat: 'uniq' },
  { type: 'ForbiddenJewel', cat: 'uniq' },
  { type: 'UniqueTincture', cat: 'uniq' },
  { type: 'UniqueRelic', cat: 'uniq' },
  { type: 'SkillGem', cat: 'gem' },
  { type: 'ImbuedGem', cat: 'gem' },
  { type: 'ClusterJewel', cat: 'other' },
  { type: 'Map', cat: 'map' },
  { type: 'BlightedMap', cat: 'map' },
  { type: 'BlightRavagedMap', cat: 'map' },
  { type: 'UniqueMap', cat: 'map' },
  { type: 'ValdoMap', cat: 'map' },
  { type: 'Invitation', cat: 'frag' },
  { type: 'Memory', cat: 'frag' },
  { type: 'IncursionTemple', cat: 'other' },
  { type: 'ScryingOrb', cat: 'other' },
  { type: 'BaseType', cat: 'rare' },
  { type: 'Flask', cat: 'other' },
  { type: 'Beast', cat: 'other' },
  { type: 'Vial', cat: 'other' },
  { type: 'Wombgift', cat: 'other' },
  { type: 'Corpse', cat: 'other' },
  { type: 'Incubator', cat: 'other' },
  { type: 'ShrineBelt', cat: 'uniq' },
];

export const NINJA_CAT_OF_TYPE: Record<string, Cat> = Object.fromEntries([...EXCHANGE_TYPES, ...ITEM_TYPES].map((x) => [x.type, x.cat]));
// Scarabs are listed under "Fragments" by poe.ninja but are their own group in the stash.
const ART_CAT: Record<string, string | undefined> = { SkillGem: 'gems', ImbuedGem: 'gems', BaseType: 'bases', Map: 'maps', BlightedMap: 'maps', UniqueMap: 'maps', BlightRavagedMap: 'maps', ValdoMap: 'maps', Beast: 'beasts' };

interface ExchangePayload {
  core?: { rates?: { divine?: number } };
  lines: { id: string; primaryValue: number; volumePrimaryValue?: number; sparkline?: { totalChange?: number; data?: (number | null)[] } }[];
  items: { id: string; name: string; category?: string }[];
}
interface ItemLine {
  id: number | string;
  name: string;
  variant?: string;
  baseType?: string;
  chaosValue: number;
  divineValue?: number;
  listingCount?: number;
  sparkLine?: { totalChange?: number; data?: (number | null)[] };
  links?: number;
  levelRequired?: number;
  gemLevel?: number;
  gemQuality?: number;
  corrupted?: boolean;
}
interface ItemPayload {
  lines: ItemLine[];
}

/** poe.ninja sparklines are percent change against the start of the window; this turns them back into prices, the start of the window first (8 points for 7 daily ones). */
export function sparkToPrices(now: number, sp?: { totalChange?: number; data?: (number | null)[] }): number[] {
  const data = sp?.data;
  if (!data || data.length < 2) return [];
  const lastKnown = [...data].reverse().find((x) => typeof x === 'number');
  if (lastKnown === undefined || lastKnown === null) return [];
  const total = typeof sp?.totalChange === 'number' ? sp.totalChange : lastKnown;
  const denom = 1 + total / 100;
  if (denom <= 0.0001) return [];
  const base = now / denom;
  const out: number[] = [];
  let prev: number | null = null;
  for (const d of data) {
    const v: number | null = typeof d === 'number' ? base * (1 + d / 100) : prev;
    if (v !== null) {
      out.push(Math.max(0, v));
      prev = v;
    } else out.push(NaN);
  }
  // Leading gaps take the first known value so the line keeps all its points.
  const first = out.find((x) => !Number.isNaN(x));
  if (first === undefined) return [];
  // The window's own start (0%) leads the line, so first to last is poe.ninja's 7-day change, not six days of it.
  return [base, ...out.map((x) => (Number.isNaN(x) ? first : x))];
}

const lc = (s: string) => s.toLowerCase();

export class PriceBook {
  private readonly byName = new Map<string, PriceLine[]>();
  private readonly fetched = new Map<string, number>();
  /** Chaos orbs per divine orb. */
  divine = 0;
  /** GGG currency exchange prices by lower-case name: the second source, used beside poe.ninja and where it has no line. */
  private cx = new Map<string, CxPrice>();

  setCx(list: CxPrice[]): void {
    this.cx = new Map(list.map((l) => [lc(l.name), l]));
  }

  cxFor(name: string): CxPrice | undefined {
    return this.cx.get(lc(name));
  }

  clear(): void {
    this.cx.clear();
    this.byName.clear();
    this.fetched.clear();
    this.divine = 0;
  }

  get size(): number {
    let n = 0;
    for (const v of this.byName.values()) n += v.length;
    return n;
  }

  setFetchedAt(type: string, at: number): void {
    this.fetched.set(type, at);
  }

  fetchedAt(type: string): number | undefined {
    return this.fetched.get(type);
  }

  /** Oldest and newest fetch time over every loaded type. */
  ages(): { oldest: number | null; newest: number | null } {
    const v: number[] = [...this.fetched.values()];
    return v.length ? { oldest: Math.min(...v), newest: Math.max(...v) } : { oldest: null, newest: null };
  }

  /** Drops every line that came from this type, so a refreshed type replaces the old one. */
  private drop(type: string): void {
    for (const [k, v] of this.byName) {
      const keep = v.filter((l) => l.type !== type);
      if (keep.length) this.byName.set(k, keep);
      else this.byName.delete(k);
    }
  }

  private put(l: PriceLine): void {
    const k = lc(l.name);
    const a = this.byName.get(k);
    if (a) a.push(l);
    else this.byName.set(k, [l]);
  }

  addExchange(type: string, payload: ExchangePayload, at: number): void {
    this.drop(type);
    const cat = NINJA_CAT_OF_TYPE[type] ?? 'other';
    const names = new Map(payload.items.map((i) => [i.id, i]));
    for (const ln of payload.lines) {
      const it = names.get(ln.id);
      if (!it || typeof ln.primaryValue !== 'number') continue;
      this.put({ id: ln.id, name: it.name, type, cat, chaos: ln.primaryValue, spark: sparkToPrices(ln.primaryValue, ln.sparkline), at, art: it.name, ...(ART_CAT[type] ? { artCat: ART_CAT[type] } : {}) });
      if (ln.id === 'divine' && ln.primaryValue > 1) this.divine = ln.primaryValue;
    }
    if (!this.divine && payload.core?.rates?.divine) this.divine = 1 / payload.core.rates.divine;
    this.fetched.set(type, at);
  }

  addItems(type: string, payload: ItemPayload, at: number): void {
    this.drop(type);
    const cat = NINJA_CAT_OF_TYPE[type] ?? 'other';
    for (const ln of payload.lines) {
      if (typeof ln.chaosValue !== 'number') continue;
      this.put({
        id: String(ln.id),
        name: ln.name,
        ...(ln.variant ? { variant: ln.variant } : {}),
        ...(ln.baseType ? { baseType: ln.baseType } : {}),
        type,
        cat,
        chaos: ln.chaosValue,
        ...(typeof ln.divineValue === 'number' ? { divineValue: ln.divineValue } : {}),
        ...(ln.listingCount !== undefined ? { listings: ln.listingCount } : {}),
        spark: sparkToPrices(ln.chaosValue, ln.sparkLine),
        ...(ln.links ? { links: ln.links } : {}),
        ...(ln.levelRequired ? { levelRequired: ln.levelRequired } : {}),
        ...(ln.gemLevel !== undefined ? { gemLevel: ln.gemLevel } : {}),
        ...(ln.gemQuality !== undefined ? { gemQuality: ln.gemQuality } : {}),
        ...(ln.corrupted ? { corrupted: true } : {}),
        at,
        art: type === 'BaseType' ? (ln.baseType ?? ln.name) : ln.name,
        ...(ART_CAT[type] ? { artCat: ART_CAT[type] } : {}),
      });
    }
    this.fetched.set(type, at);
  }

  lines(name: string): PriceLine[] {
    return this.byName.get(lc(name)) ?? [];
  }

  all(): PriceLine[] {
    return [...this.byName.values()].flat();
  }
}

// ---- stash items -------------------------------------------------------------------------------------------------

export interface GggProperty {
  name: string;
  values: [string, number][];
}

/** The part of GGG's Item object that pricing uses. */
export interface GggItem {
  id?: string;
  name?: string;
  typeLine: string;
  baseType?: string;
  frameType?: number;
  stackSize?: number;
  maxStackSize?: number;
  ilvl?: number;
  icon?: string;
  identified?: boolean;
  corrupted?: boolean;
  fractured?: boolean;
  synthesised?: boolean;
  mutated?: boolean;
  foilVariation?: number;
  influences?: Record<string, boolean>;
  sockets?: { group: number; attr?: string; sColour?: string }[];
  properties?: GggProperty[];
  enchantMods?: string[];
  explicitMods?: string[];
  inventoryId?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  descrText?: string;
  note?: string;
  extended?: { category?: string; subcategories?: string[] };
}

export type PriceKind = 'exact' | 'range' | 'none';

export interface ItemPrice {
  /** Stable key that merges identical stacks. */
  key: string;
  name: string;
  base?: string;
  /** What tells this item from others of the same name: a gem's level and quality, a unique's links, a map's tier. */
  variant?: string;
  cat: Cat;
  qty: number;
  kind: PriceKind;
  /** True for items the app does not value at all: normal, magic and rare gear, jewels and flasks (their worth is in their rolls). */
  skip?: true;
  /** Low end per unit, chaos. Null when unpriced. */
  unit: number | null;
  hi: number | null;
  why?: string;
  line?: PriceLine;
  /** Set when poe.ninja has no line and GGG's currency exchange priced the item: `unit` is its chaos price. */
  cx?: CxPrice;
  art: string;
  artCat?: string;
  maxStack: number;
}

const FRAME = { normal: 0, magic: 1, rare: 2, unique: 3, gem: 4, currency: 5, card: 6, quest: 7, prophecy: 8, foil: 9, relic: 10 };

const num = (s: string | undefined): number => {
  const m = /-?\d+(\.\d+)?/.exec(s ?? '');
  return m ? Number(m[0]) : NaN;
};

export function propValue(it: GggItem, name: string): string | undefined {
  return it.properties?.find((p) => p.name === name)?.values?.[0]?.[0];
}

export function maxLinks(it: GggItem): number {
  const c: Record<number, number> = {};
  for (const s of it.sockets ?? []) c[s.group] = (c[s.group] ?? 0) + 1;
  return Math.max(0, ...Object.values(c));
}

export function influenceNames(it: GggItem): string[] {
  const order = ['shaper', 'elder', 'crusader', 'redeemer', 'hunter', 'warlord'];
  const names: Record<string, string> = { shaper: 'Shaper', elder: 'Elder', crusader: 'Crusader', redeemer: 'Redeemer', hunter: 'Hunter', warlord: 'Warlord' };
  return order.filter((k) => it.influences?.[k]).map((k) => names[k] as string);
}

const stripQuality = (s: string) => s.replace(/^(Superior|Blighted|Blight-ravaged)\s+/i, '').trim();

const pickRange = (cands: PriceLine[]): { lo: PriceLine; hi: PriceLine } => {
  const s = [...cands].sort((a, b) => a.chaos - b.chaos);
  return { lo: s[0] as PriceLine, hi: s[s.length - 1] as PriceLine };
};

function result(base: Omit<ItemPrice, 'kind' | 'unit' | 'hi' | 'line' | 'art' | 'artCat'> & { art?: string; artCat?: string }, cands: PriceLine[], why?: string): ItemPrice {
  if (!cands.length) return { ...base, kind: 'none', unit: null, hi: null, art: base.art ?? base.name, ...(base.artCat ? { artCat: base.artCat } : {}), ...(why ? { why } : {}) };
  const { lo, hi } = pickRange(cands);
  const range = hi.chaos > lo.chaos * 1.0001;
  return {
    ...base,
    kind: range ? 'range' : 'exact',
    unit: lo.chaos,
    hi: range ? hi.chaos : null,
    line: lo,
    art: base.art ?? lo.art,
    ...(base.artCat ?? lo.artCat ? { artCat: (base.artCat ?? lo.artCat) as string } : {}),
    ...(range && why ? { why } : {}),
  };
}

/** Matches one stash item to a price. Pure: the book and the item decide. */
export function priceItem(book: PriceBook, it: GggItem): ItemPrice {
  const frame = it.frameType ?? 0;
  const qty = Math.max(1, it.stackSize ?? 1);
  const maxStack = Math.max(1, it.maxStackSize ?? 1);
  const typeLine = stripQuality(it.typeLine ?? '');
  const nm = (it.name ?? '').trim();
  const mk = (cat: Cat, key: string, name: string, extra: { base?: string; variant?: string } = {}) => ({ key, name, cat, qty, maxStack, ...extra });

  // ---- unique ----
  if (frame === FRAME.unique || frame === FRAME.relic) {
    const name = nm || typeLine;
    const foul = !!it.mutated || /^Foulborn /i.test(name);
    const wanted = foul && !/^Foulborn /i.test(name) ? `Foulborn ${name}` : name;
    let cands = book.lines(wanted).filter((l) => l.cat === 'uniq' || l.cat === 'map');
    if (!cands.length && foul) cands = book.lines(name).filter((l) => l.cat === 'uniq');
    const links = maxLinks(it);
    if (cands.length > 1 && cands.some((c) => c.links)) {
      const fit = cands.filter((c) => (c.links ?? 0) <= links);
      if (fit.length) cands = fit;
    }
    // Mageblood's versions differ by how many flasks it applies, and the item's own text says which.
    const flasks = /Leftmost (\d) Magic Utility Flasks?/i.exec((it.explicitMods ?? []).join(' '))?.[1];
    if (flasks && cands.length > 1) {
      const fit = cands.filter((c) => c.variant === `${flasks} Flasks` || c.variant === `${flasks} Flask`);
      if (fit.length) cands = fit;
    }
    const baseKeys = cands.length ? `${wanted}|${links >= 5 ? links : 0}${flasks ? `|${flasks}f` : ''}` : wanted;
    const uv = [links >= 5 ? `${links} links` : '', flasks ? `${flasks} flask${flasks === '1' ? '' : 's'}` : ''].filter(Boolean).join(' · ');
    const r = result(mk('uniq', `u|${baseKeys}`, name, { base: it.baseType ?? it.typeLine, ...(uv ? { variant: uv } : {}) }), cands, cands.length > 1 ? 'Several versions; the low end is counted' : undefined);
    if (!cands.length) return { ...r, artCat: 'uniques', art: name, why: 'No poe.ninja price for this unique' };
    return { ...r, artCat: 'uniques', art: name };
  }

  // ---- gem ----
  if (frame === FRAME.gem) {
    const lvl = num(propValue(it, 'Level'));
    const q = num(propValue(it, 'Quality'));
    const corrupted = !!it.corrupted;
    const all = book.lines(typeLine).filter((l) => l.type === 'SkillGem' || l.type === 'ImbuedGem');
    const sameC = all.filter((l) => !!l.corrupted === corrupted);
    const wantL = Number.isFinite(lvl) ? lvl : 1;
    const wantQ = Number.isFinite(q) ? q : 0;
    const exact = sameC.filter((l) => l.gemLevel === wantL && (l.gemQuality ?? 0) === wantQ);
    let cands = exact;
    let why: string | undefined;
    if (!cands.length) {
      // The nearest line at or below this gem's level and quality: never price a gem above what it is.
      const below = sameC.filter((l) => (l.gemLevel ?? 0) <= wantL && (l.gemQuality ?? 0) <= wantQ);
      if (below.length) {
        const bestL = Math.max(...below.map((l) => l.gemLevel ?? 0));
        const atL = below.filter((l) => (l.gemLevel ?? 0) === bestL);
        const bestQ = Math.max(...atL.map((l) => l.gemQuality ?? 0));
        cands = atL.filter((l) => (l.gemQuality ?? 0) === bestQ);
        why = 'No line for this exact level and quality; the next lower one is used';
      }
    }
    const r = result(mk('gem', `g|${typeLine}|${wantL}/${wantQ}${corrupted ? 'c' : ''}`, typeLine, { base: `Level ${wantL}${wantQ ? ` · ${wantQ}% quality` : ''}${corrupted ? ' · corrupted' : ''}`, variant: `${wantL}/${wantQ}${corrupted ? ' corrupted' : ''}` }), cands.length > 1 ? [cands[0] as PriceLine] : cands, why);
    return { ...r, artCat: 'gems', art: typeLine, ...(cands.length === 0 ? { why: 'No poe.ninja price for this gem' } : why ? { why } : {}) };
  }

  // ---- stackable and everything with a plain name (currency, scarabs, fossils, cards, essences...) ----
  if (frame === FRAME.currency || frame === FRAME.card || frame === FRAME.normal || frame === FRAME.magic) {
    const stack = book.lines(typeLine).filter((l) => l.type !== 'BaseType' && l.type !== 'SkillGem' && !l.type.startsWith('Unique'));
    if (stack.length) {
      const cat = (stack[0] as PriceLine).cat;
      return result(mk(cat, `s|${typeLine}`, typeLine), stack.length > 1 ? [stack.sort((a, b) => a.chaos - b.chaos)[0] as PriceLine] : stack);
    }
    // poe.ninja has no line: GGG's own exchange price stands in. Never a made-up number when it has none either.
    if (frame === FRAME.currency || frame === FRAME.card) {
      const g = book.cxFor(typeLine);
      if (g) return { ...result(mk(g.cat, `s|${typeLine}`, typeLine), []), kind: 'exact', unit: g.chaos, cx: g, art: typeLine, why: 'poe.ninja has no price; this is the GGG currency exchange price' };
    }
  }

  // ---- maps ----
  if (propValue(it, 'Map Tier') !== undefined || /Map$/.test(typeLine)) {
    const cands = book.lines(typeLine).filter((l) => l.cat === 'map');
    const tier = propValue(it, 'Map Tier');
    const r = result(mk('map', `m|${typeLine}|${tier ?? ''}`, typeLine, tier ? { variant: `Tier ${tier}` } : {}), cands.length ? [pickRange(cands).lo] : [], 'Ordinary maps have no poe.ninja price');
    return { ...r, art: tier ? `${typeLine} (Tier ${tier})` : typeLine, artCat: 'maps' };
  }

  // ---- normal, magic and rare gear, jewels and flasks are not valued: what they are worth is in their rolls, which no
  //      price feed covers. They are left out of the stash, the totals and the unpriced count altogether.
  if (frame === FRAME.rare || frame === FRAME.normal || frame === FRAME.magic) {
    return { ...result(mk('other', `x|${typeLine}`, nm || typeLine), []), skip: true };
  }

  return result(mk('other', `o|${typeLine}|${nm}`, nm || typeLine), [], 'No poe.ninja price for this item');
}
