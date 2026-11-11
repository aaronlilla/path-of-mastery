import type { ItemInfo } from '@pom/protocol';

/**
 * The pathofexile.com trade search for an item, built the way upstream's Buy Similar popup builds it
 * (`Classes/CompareBuySimilar.lua`): category, base type, item level, defences and one filter per modifier that
 * the trade site has a stat for. Nothing is listed or bought here; the result is a link to open in the browser.
 */

export type TradeStats = Record<string, Record<string, string>>;

export const LISTED_STATUS: { label: string; value: 'securable' | 'available' | 'online' | 'any' }[] = [
  { label: 'Instant Buyout', value: 'securable' },
  { label: 'Instant Buyout & In Person', value: 'available' },
  { label: 'In Person (Online)', value: 'online' },
  { label: 'Any', value: 'any' },
];

export const REALMS: { label: string; id: string }[] = [
  { label: 'PC', id: 'pc' },
  { label: 'PS4', id: 'sony' },
  { label: 'Xbox', id: 'xbox' },
];

/** The minimum Buy similar starts a modifier at: a little under the item's own roll (about 90%), so the search finds items like it, not only items at least as good on every line. */
export function relaxedMin(roll: number): number {
  if (!Number.isFinite(roll) || roll <= 1) return roll;
  const r = roll * 0.9;
  return Number.isInteger(roll) ? Math.max(1, Math.floor(r)) : Math.floor(r * 10) / 10;
}

export interface TradeMod {
  key: string;
  /** The modifier as the item shows it. */
  text: string;
  type: string;
  /** The trade site's stat id, or undefined when it has none for this line. */
  id?: string;
  /** The value to search from (the line's first number, or the midpoint of a range). */
  value?: number;
}

export interface TradeDefence {
  key: string;
  label: string;
  tradeKey: 'ar' | 'ev' | 'es' | 'ward';
  value: number;
}

/** The trade site's category for an item in a slot (`TradeHelpers.getTradeCategory`). */
export function tradeCategory(slotName: string, info: ItemInfo): string | null {
  const t = info.type ?? '';
  if (/^Weapon \d/.test(slotName)) {
    const m: Record<string, string> = {
      Shield: 'armour.shield', Quiver: 'armour.quiver', Bow: 'weapon.bow', Staff: 'weapon.staff', 'Two Handed Sword': 'weapon.twosword', 'Two Handed Axe': 'weapon.twoaxe',
      'Two Handed Mace': 'weapon.twomace', 'Fishing Rod': 'weapon.rod', 'One Handed Sword': 'weapon.onesword', 'One Handed Axe': 'weapon.oneaxe', 'One Handed Mace': 'weapon.onemace',
      Sceptre: 'weapon.sceptre', Wand: 'weapon.wand', Dagger: 'weapon.dagger', Claw: 'weapon.claw',
    };
    if (m[t]) return m[t]!;
    if (t.includes('Two Handed')) return 'weapon.twomelee';
    if (t.includes('One Handed')) return 'weapon.one';
    return 'weapon';
  }
  if (slotName === 'Body Armour') return 'armour.chest';
  if (slotName === 'Helmet') return 'armour.helmet';
  if (slotName === 'Gloves') return 'armour.gloves';
  if (slotName === 'Boots') return 'armour.boots';
  if (slotName === 'Amulet') return 'accessory.amulet';
  if (/^Ring \d$/.test(slotName)) return 'accessory.ring';
  if (slotName === 'Belt') return 'accessory.belt';
  if (slotName.includes('Abyssal')) return 'jewel.abyss';
  if (slotName.includes('Jewel')) return 'jewel';
  if (slotName.includes('Flask')) return 'flask';
  return null;
}

const NUM = /-?\d+(?:\.\d+)?/g;

function template(line: string): string {
  return line.replace(NUM, '#');
}

/** `TradeHelpers.modLineValue`: the midpoint of "a to b", else the first number. */
function lineValue(line: string): number | undefined {
  const r = /(-?\d+(?:\.\d+)?) to (-?\d+(?:\.\d+)?)/.exec(line);
  if (r) return (parseFloat(r[1]!) + parseFloat(r[2]!)) / 2;
  const n = /-?\d+(?:\.\d+)?/.exec(line);
  return n ? parseFloat(n[0]) : undefined;
}

/** The trade site lists local modifiers as separate "(Local)" stats: on a weapon its physical damage, attack speed, leech, ...; on armour its own defences and block. */
const LOCAL_WEAPON = /^(One Handed|Two Handed|Bow|Staff|Wand|Dagger|Claw|Sceptre|Fishing Rod|Warstaff|Rune Dagger)/;
const LOCAL_ARMOUR = /^(Shield|Body Armour|Helmet|Gloves|Boots)/;
function isLocalLine(type: string, line: string): boolean {
  return LOCAL_WEAPON.test(type) || (LOCAL_ARMOUR.test(type) && /Armour|Evasion|Energy Shield|Ward|Block/i.test(line));
}

function lookup(stats: TradeStats, types: string[], line: string, local = false): string | undefined {
  const t = template(line);
  const base = [t, t.startsWith('+') ? t.slice(1) : '+' + t];
  const tries = local ? [...base.map((x) => x + ' (Local)'), ...base] : base;
  for (const type of types) {
    for (const x of tries) {
      const id = stats[type]?.[x];
      if (id) return id;
    }
  }
  return undefined;
}

/** The searchable modifiers of an item, in the order the item shows them. */
export function tradeMods(info: ItemInfo, stats: TradeStats): TradeMod[] {
  const out: TradeMod[] = [];
  (info.mods ?? []).forEach((m, i) => {
    if (m.bucket === 'crucible' || m.unsupported) return;
    const types = m.crafted ? ['crafted', m.bucket === 'implicit' ? 'implicit' : 'explicit'] : m.fractured ? ['fractured', 'explicit'] : [m.bucket];
    for (const part of m.text.split('\n')) {
      const id = lookup(stats, types, part, isLocalLine(info.type ?? '', part));
      let value = lineValue(part);
      const type = id ? id.split('.')[0]! : m.bucket;
      // A reduced-by-N line searches the positive stat on the site, which the matching above found with the sign flipped.
      if (id && value !== undefined && /^-/.test(part) && stats[type]?.[template(part).replace(/^-/, '+')] === id) value = Math.abs(value);
      out.push({ key: `${i}:${out.length}`, text: part, type, id, value });
    }
  });
  return out;
}

export function tradeDefences(info: ItemInfo, armour: Record<string, number> | null): TradeDefence[] {
  if (!armour) return [];
  const defs: Array<[string, string, TradeDefence['tradeKey']]> = [['Armour', 'Armour', 'ar'], ['Evasion', 'Evasion', 'ev'], ['EnergyShield', 'Energy Shield', 'es'], ['Ward', 'Ward', 'ward']];
  return defs.flatMap(([key, label, tradeKey]) => ((armour[key] ?? 0) > 0 ? [{ key, label, tradeKey, value: Math.floor(armour[key]!) }] : []));
}

export interface TradeForm {
  realm: string;
  league: string;
  listed: 'securable' | 'available' | 'online' | 'any';
  category: string | null;
  /** Search by the base type. */
  baseType: boolean;
  ilvlMin?: number;
  ilvlMax?: number;
  /** Per defence key: the minimum and maximum, when enabled. */
  defences: Record<string, { min?: number; max?: number } | undefined>;
  /** Per mod key: enabled with an optional min and max. */
  mods: Record<string, { on: boolean; min?: number; max?: number } | undefined>;
}

function urlEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function isUniqueInfo(info: ItemInfo): boolean {
  return info.rarity === 'UNIQUE' || info.rarity === 'RELIC';
}

/** The search body (`{ query, sort }`) for the form's choices: what the link carries, and what the trade search endpoint takes. */
export function buildTradeQuery(info: ItemInfo, mods: TradeMod[], defs: TradeDefence[], f: TradeForm): { query: Record<string, unknown>; sort: { price: string } } {
  const query: Record<string, unknown> = { status: { option: f.listed }, stats: [{ type: 'and', filters: [] as unknown[] }] };
  const filters: Record<string, unknown> = {};
  if (isUniqueInfo(info)) {
    const name = (info.title ?? info.name).replace(/^Foulborn\s+/, '').trim();
    query.name = name.replace(/^(.*?)\s+\d+$/, '$1');
    query.type = info.baseName;
  } else {
    if (f.category) filters.type_filters = { filters: { category: { option: f.category } } };
    if (f.baseType) query.type = info.baseName;
    if (f.ilvlMin !== undefined || f.ilvlMax !== undefined) {
      const ilvl: Record<string, number> = {};
      if (f.ilvlMin !== undefined) ilvl.min = f.ilvlMin;
      if (f.ilvlMax !== undefined) ilvl.max = f.ilvlMax;
      filters.misc_filters = { filters: { ilvl } };
    }
    const armour: Record<string, { min?: number; max?: number }> = {};
    for (const d of defs) {
      const v = f.defences[d.key];
      if (v && (v.min !== undefined || v.max !== undefined)) armour[d.tradeKey] = v;
    }
    if (Object.keys(armour).length) filters.armour_filters = { filters: armour };
  }
  const list = (query.stats as Array<{ filters: unknown[] }>)[0]!.filters;
  for (const m of mods) {
    const s = f.mods[m.key];
    if (!s?.on || !m.id) continue;
    const filter: Record<string, unknown> = { id: m.id };
    const value: Record<string, number> = {};
    if (s.min !== undefined) value.min = s.min;
    if (s.max !== undefined) value.max = s.max;
    if (Object.keys(value).length) filter.value = value;
    list.push(filter);
  }
  if (Object.keys(filters).length) query.filters = filters;
  return { query, sort: { price: 'asc' } };
}

/** The search link for the form's choices. */
export function buildTradeUrl(info: ItemInfo, mods: TradeMod[], defs: TradeDefence[], f: TradeForm): string {
  const q = JSON.stringify(buildTradeQuery(info, mods, defs, f));
  let url = 'https://www.pathofexile.com/trade/search';
  if (f.realm && f.realm !== 'pc') url += '/' + f.realm;
  url += '/' + urlEncode(f.league || 'Standard').replace(/%20/g, '+');
  return `${url}?q=${urlEncode(q)}`;
}
