/**
 * Upgrade candidates for a build's slots, from real trade listings.
 *
 *  1. The rule for a slot becomes a trade search (the same search Buy Similar builds: category, the equipped item's own
 *     modifiers that the trade site has a stat for).
 *  2. The cheapest listings come back through the trade client (shared rate limiter, cached for 5 minutes).
 *  3. Each listing is written as item text and put in the slot on a scratch copy of the build, so the gain is the
 *     engine's number. Nothing here estimates a gain, and nothing is written to the player's build.
 *  4. The price is the listing's, converted to chaos with the price book (null when the currency has no line).
 *  5. Ranking is the percent gain in the ranking stat per divine paid (price floored at one chaos). Candidates that
 *     break a hard requirement (a capped resistance falls under its cap) are held back, never ranked.
 */
import type { BuildEdit, CommandName, CommandParams, CommandResult, ItemInfo, StatDelta, StatValue } from '@pom/protocol';
import { tradeCategory, tradeMods, type TradeMod, type TradeStats } from '../../renderer/items/tradeQuery.js';
import { formatStat, statMeta } from '../../shared/assistant/statLabels.js';
import { tradeItemText } from '../../shared/tradeItemText.js';
import { FRESH_LISTED, defaultRule, isFreshListing, type TradeItem, type BuildSlotInfo, type SlotScan, type StatGain, type TradeListing, type UpgradeCandidate, type WatchRule } from '../../shared/wealthTrade.js';
import { readEquipped, type ItemRead } from '../assistant/buildReaders.js';
import type { PriceBook } from './priceBook.js';
import { tradeLink, type TradeSearcher } from './trade.js';

export interface UpgradeEngine {
  send<K extends CommandName>(command: K, params: CommandParams<K>): Promise<CommandResult<K>>;
}

export interface UpgradeDeps {
  engine: UpgradeEngine;
  searcher: TradeSearcher;
  book: PriceBook;
  now: () => number;
  stats: TradeStats;
  league: () => string;
  /** Told what is worn in the slot being searched (the sample trade site builds its listings from it). */
  noteWorn?: (item: ItemInfo) => void;
}

const GEAR_SLOT = /^(Weapon [12]|Helmet|Body Armour|Gloves|Boots|Amulet|Ring \d|Belt)$/;

/** The slots of the build that can be searched, with what is in them. */
export function slotsOf(xml: string): BuildSlotInfo[] {
  return readEquipped(xml)
    .filter((i) => GEAR_SLOT.test(i.slot))
    .map((i) => ({ slot: i.slot, name: i.name, base: i.base, rarity: i.rarity }));
}

export const SLOT_ORDER = ['Weapon 1', 'Weapon 2', 'Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring 1', 'Ring 2', 'Belt'];

const RES = ['Fire', 'Cold', 'Lightning'] as const;

export interface SlotQuery {
  body: { query: Record<string, unknown>; sort: { price: string } };
  /** The rule in plain words. */
  rule: string;
  /** Modifiers the search asks for, for the plain-words rule. */
  asked: string[];
}

/**
 * The search for a slot. A unique is searched by name (better rolls of the same item). Anything else is searched by
 * category with a "count" group: at least about half of the equipped item's searchable modifiers, each from 90% of
 * the equipped roll, so the results are items at least as good as what the player wears, cheapest first.
 */
export function slotQuery(info: ItemInfo, slot: string, stats: TradeStats): SlotQuery {
  // Online sellers only, listed within the last week: the site's own filters, so an offline or stale listing is not searched for.
  const query: Record<string, unknown> = { status: { option: 'online' }, stats: [{ type: 'and', filters: [] as unknown[] }] };
  const fresh = { trade_filters: { filters: { indexed: { option: FRESH_LISTED } } } };
  query.filters = fresh;
  const unique = info.rarity === 'UNIQUE' || info.rarity === 'RELIC';
  if (unique) {
    const name = (info.title ?? info.name).replace(/^Foulborn\s+/, '').trim();
    query.name = name.replace(/^(.*?)\s+\d+$/, '$1');
    if (info.baseName) query.type = info.baseName;
    return { body: { query, sort: { price: 'asc' } }, rule: `Another ${name}, cheapest first`, asked: [] };
  }
  const cat = tradeCategory(slot, info);
  if (cat) query.filters = { ...fresh, type_filters: { filters: { category: { option: cat } } } };
  const mods = tradeMods(info, stats).filter((m) => m.id && (m.type === 'explicit' || m.type === 'fractured' || m.type === 'crafted') && m.value !== undefined);
  const picked = pickMods(mods);
  const filters = picked.map((m) => {
    const v = Math.floor((m.value as number) * 0.9);
    return { id: m.id as string, ...(v > 0 ? { value: { min: v } } : {}) };
  });
  if (filters.length >= 2) {
    const need = Math.max(2, Math.ceil(filters.length / 2));
    query.stats = [{ type: 'count', value: { min: need }, filters }];
    return { body: { query, sort: { price: 'asc' } }, rule: `${slot}: at least ${need} of ${filters.length} of your modifiers at 90% or better, cheapest first`, asked: picked.map((m) => m.text) };
  }
  return { body: { query, sort: { price: 'asc' } }, rule: `${slot}: any item in this slot's category, cheapest first`, asked: [] };
}

/** At most 6 modifiers, one per template, in the order the item shows them. */
function pickMods(mods: TradeMod[]): TradeMod[] {
  const seen = new Set<string>();
  const out: TradeMod[] = [];
  for (const m of mods) {
    if (seen.has(m.id as string)) continue;
    seen.add(m.id as string);
    out.push(m);
    if (out.length >= 6) break;
  }
  return out;
}

type Stat = number | string | boolean | null;

export function statMap(stats: StatValue[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of stats) if (typeof s.value === 'number') out[s.id] = s.value;
  return out;
}

function gain(id: string, before: number, after: number): StatGain {
  const delta = after - before;
  return { statId: id, label: statMeta(id).label, before, after, delta, pct: before !== 0 ? delta / Math.abs(before) : null, shown: formatStat(id, after) };
}

/** The ranking stat for the build: damage (Full DPS when the build has it, else Combined or Hit DPS) or defence. */
export function rankStatFor(base: Record<string, number>, rank: 'dps' | 'ehp'): string {
  if (rank === 'ehp') return 'TotalEHP';
  if ((base.FullDPS ?? 0) > 0) return 'FullDPS';
  if ((base.CombinedDPS ?? 0) > 0) return 'CombinedDPS';
  return 'TotalDPS';
}

/** Why a candidate is held back, or null. A resistance that sat at its cap must still be at its cap. */
export function heldReason(base: Record<string, number>, after: Record<string, number>, rule: WatchRule, rankStat = ''): string | null {
  if (rankStat && (base[rankStat] ?? 0) > 0 && (after[rankStat] ?? 0) <= 0) return 'The build cannot use its main skill with this item';
  if (!rule.keepResists) return null;
  for (const r of RES) {
    const id = `${r}Resist`;
    const cap = base[`${id}Max`] ?? 75;
    const b = base[id];
    const a = after[id];
    if (b !== undefined && a !== undefined && b >= cap && a < cap) return `Uncaps ${r.toLowerCase()} resistance (${Math.round(a)}% of ${Math.round(cap)}%)`;
  }
  return null;
}

/** Applies the changed stats of a preview on top of the baseline. */
export function applyDiff(base: Record<string, number>, changed: StatDelta[]): Record<string, number> {
  const out = { ...base };
  for (const c of changed) if (typeof c.after === 'number') out[c.statId] = c.after;
  return out;
}

export interface EvalItem {
  listing: TradeListing;
  itemText: string;
}

/** Turns listings into item texts, dropping the ones the engine cannot take (and saying how many). */
export function toEvalItems(listings: TradeListing[], badBases: string[]): { items: EvalItem[]; skipped: number } {
  const bad = new Set(badBases.map((b) => b.toLowerCase()));
  const items: EvalItem[] = [];
  let skipped = 0;
  for (const l of listings) {
    const t = tradeItemText(l.item);
    const base = (t?.base ?? l.item.typeLine ?? '').toLowerCase();
    if (!t || bad.has(base)) {
      skipped++;
      continue;
    }
    items.push({ listing: l, itemText: t.text });
  }
  return { items, skipped };
}

export interface Scratch {
  buildId: string;
  base: Record<string, number>;
  close(): Promise<void>;
}

/** A scratch copy of the build to calculate on; the player's build is never touched. */
export async function openScratch(engine: UpgradeEngine, xml: string): Promise<Scratch> {
  const { buildId } = await engine.send('loadBuild', { buildXml: xml });
  const { stats } = await engine.send('getStats', { buildId });
  return {
    buildId,
    base: statMap(stats as StatValue[]),
    close: () => engine.send('closeBuild', { buildId }).then(() => undefined, () => undefined),
  };
}

export interface ScanOptions {
  rule: WatchRule;
  rank: 'dps' | 'ehp';
  limit: number;
  /** Divine in chaos, for the budget and the score. */
  divine: number;
}

const modLines = (it: TradeItem): string[] => [...(it.implicitMods ?? []), ...(it.fracturedMods ?? []), ...(it.explicitMods ?? []), ...(it.craftedMods ?? [])].flatMap((m) => m.split('\n'));
const stripTags = (l: string): string => l.replace(/\{[^}]*\}/g, '').replace(/\s*\((?:implicit|crafted|fractured|enchant)\)\s*$/i, '').trim();
const numsOf = (l: string): number[] => (l.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
const shape = (l: string): string => l.replace(/-?\d+(?:\.\d+)?/g, '#');

/**
 * True when a listing is the item already worn or a worse copy of it: the same name and base, every modifier one the
 * worn item also has, none rolled higher. Such a listing is not an upgrade whatever else the calculation says.
 */
export function notBetterThanWorn(worn: { name: string; base: string; text: string }, item: TradeItem): boolean {
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  if (!same(item.name || item.typeLine, worn.name) || !same(item.baseType ?? item.typeLine, worn.base)) return false;
  const have = new Map<string, number[][]>();
  for (const raw of worn.text.split(/\r?\n/)) {
    const l = stripTags(raw);
    if (!/\d|[a-z]/i.test(l)) continue;
    const k = shape(l);
    have.set(k, [...(have.get(k) ?? []), numsOf(l)]);
  }
  for (const raw of modLines(item)) {
    const l = stripTags(raw);
    const mine = have.get(shape(l));
    if (!mine) return false;
    const n = numsOf(l);
    if (!mine.some((m) => n.length === m.length && n.every((v, i) => v <= (m[i] ?? Infinity)))) return false;
  }
  return true;
}

/** Listings that are the same item (name, base, every modifier) become one candidate, the cheapest, with a count. */
export function collapseIdentical(cs: UpgradeCandidate[]): UpgradeCandidate[] {
  const groups = new Map<string, UpgradeCandidate[]>();
  for (const c of cs) {
    const it = c.listing.item;
    const sig = [it.name, it.typeLine, it.baseType ?? '', ...modLines(it).map(stripTags).sort()].join('|');
    groups.set(sig, [...(groups.get(sig) ?? []), c]);
  }
  return [...groups.values()].map((g) => {
    const best = [...g].sort((a, b) => (a.priceChaos ?? Infinity) - (b.priceChaos ?? Infinity))[0]!;
    return g.length > 1 ? { ...best, copies: g.length } : best;
  });
}

/** Scans one slot on an open scratch copy. */
export async function scanSlot(d: UpgradeDeps, scratch: Scratch, equipped: ItemRead, opts: ScanOptions): Promise<SlotScan> {
  const { rule } = opts;
  const rankStat = rankStatFor(scratch.base, opts.rank);
  const rankNow = scratch.base[rankStat] ?? null;
  const out: SlotScan = { slot: equipped.slot, equipped: equipped.name, equippedBase: equipped.base, at: d.now(), link: '', total: 0, checked: 0, candidates: [], rankStat, rankLabel: statMeta(rankStat).label, rankNow, rule: '' };
  let info: ItemInfo;
  try {
    info = (await d.engine.send('itemInfo', { buildId: scratch.buildId, itemText: equipped.text })).item;
  } catch (e) {
    return { ...out, error: { kind: 'engine', message: `The engine could not read the item in ${equipped.slot}: ${e instanceof Error ? e.message : String(e)}` } };
  }
  d.noteWorn?.(info);
  const q = slotQuery(info, equipped.slot, d.stats);
  out.rule = q.rule;
  out.link = tradeLink(d.league(), q.body);
  const r = await d.searcher.search(q.body, { limit: opts.limit });
  if (!r.ok) return { ...out, error: { kind: r.kind, message: r.message } };
  out.total = r.outcome.total;
  out.at = r.outcome.at;
  if (r.outcome.link) out.link = r.outcome.link;
  const { items } = toEvalItems(r.outcome.listings.filter((l) => isFreshListing(l, d.now())), rule.badBases);
  const budgetChaos = rule.budgetDiv !== null ? rule.budgetDiv * opts.divine : null;
  for (const it of items) {
    if (notBetterThanWorn({ name: equipped.name, base: equipped.base, text: equipped.text }, it.listing.item)) continue;
    let changed: StatDelta[];
    try {
      const res = await d.engine.send('previewEdit', { buildId: scratch.buildId, edit: { kind: 'setItem', slot: equipped.slot, itemText: it.itemText } as BuildEdit, full: true });
      if (res.blocked) continue;
      changed = res.statDiff.changed;
    } catch {
      continue; // The engine could not take this item; it is not ranked and not shown.
    }
    out.checked++;
    const after = applyDiff(scratch.base, changed);
    const stat = (id: string): StatGain | null => (scratch.base[id] !== undefined && after[id] !== undefined ? gain(id, scratch.base[id]!, after[id]!) : null);
    const main = stat(rankStat);
    const ehp = stat('TotalEHP');
    const used = new Set([rankStat, 'TotalEHP', 'FullDPS', 'CombinedDPS', 'TotalDPS']);
    const others = changed
      .filter((c) => typeof c.after === 'number' && typeof c.before === 'number' && !used.has(c.statId) && /^(Life|EnergyShield|Mana|Armour|Evasion|(Fire|Cold|Lightning|Chaos)Resist|Str|Dex|Int|BlockChance|SpellBlockChance)$/.test(c.statId))
      .map((c) => gain(c.statId, c.before as number, c.after as number))
      .filter((g) => g.delta !== 0)
      .sort((a, b) => Math.abs(b.pct ?? 0) - Math.abs(a.pct ?? 0))
      .slice(0, 2);
    const priceChaos = it.listing.chaos;
    const pct = main?.pct ?? null;
    const held = heldReason(scratch.base, after, rule, rankStat);
    const score = priceChaos !== null && pct !== null && pct > 0 ? (pct * 100) / (Math.max(priceChaos, 1) / opts.divine) : null;
    out.candidates.push({
      key: it.listing.id,
      slot: equipped.slot,
      listing: it.listing,
      itemText: it.itemText,
      main,
      ehp,
      others,
      priceChaos,
      score,
      held,
      overBudget: budgetChaos !== null && priceChaos !== null && priceChaos > budgetChaos ? priceChaos - budgetChaos : null,
      sold: false,
    });
  }
  out.candidates = rankCandidates(collapseIdentical(out.candidates), rule);
  return out;
}

/**
 * Ranking: gains that clear the rule's minimum come first, best score (percent gain per divine) first; then gains
 * with no price; then the rest by size of gain. Held-back candidates go last.
 */
export function rankCandidates(cs: UpgradeCandidate[], rule: WatchRule): UpgradeCandidate[] {
  const pct = (c: UpgradeCandidate) => (c.main?.pct ?? -Infinity) * 100;
  const tier = (c: UpgradeCandidate) => (c.held ? 4 : pct(c) < rule.minGainPct ? 3 : c.score === null ? 2 : 1);
  return [...cs].sort((a, b) => tier(a) - tier(b) || (tier(a) === 1 ? (b.score as number) - (a.score as number) : pct(b) - pct(a)));
}

/** Matches of the last scan: candidates that clear the rule and are not held back. */
export function matchesOf(scan: SlotScan | undefined, rule: WatchRule): UpgradeCandidate[] {
  return (scan?.candidates ?? []).filter((c) => !c.held && (c.main?.pct ?? -Infinity) * 100 >= rule.minGainPct);
}

export { defaultRule };
export type { Stat };
