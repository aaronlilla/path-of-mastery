import type { CatalogItem, TierInfo } from '../../../../shared/lootfilter/catalog.js';
import { sectionOfType } from '../../../../shared/lootfilter/sections.js';
import type { Rule } from '../../../../shared/lootfilter/types.js';
import type { LfValue } from '../../lfStore';
import { customNames, tierKeyOfItem } from '../shell/edits';
import { groupOfBuildRule } from '../customize/BuildTiers';
import { tr } from '../../../i18n';

/** What one chip on a card is: a named item, a rule made from the build, or the look of a tier that matches by rule (maps, gold). */
export type BoardChip =
  | { kind: 'item'; item: CatalogItem }
  | { kind: 'rule'; rule: Rule; name: string }
  | { kind: 'tier'; tier: TierInfo; name: string };

/** One card on the Overview: a short, curated slice of a Customize section. Everything on it is read from the real filter. */
export interface BoardCard {
  id: string;
  title: string;
  note: string;
  /** The Customize section the Edit button opens (a section id). */
  section: string;
  chips: BoardChip[];
  /** How many items the slice holds before the card trims it. */
  total: number;
  /** A reason the card is empty, shown instead of chips. */
  empty?: string;
}

/** How many chips each card keeps, as the design's cards do. */
const CAP = { rare: 6, mid: 7, leveling: 11, top: 8, build: 9, uniques: 8, maps: 7, gold: 3 };

export function priceOf(lf: LfValue, name: string): number | undefined {
  const p = lf.prices;
  if (!p) return undefined;
  return p.byName[name]?.chaos ?? p.uniqueByBase[name];
}

/** The cards, in the design's order, filled from the catalog, the rules and the prices. Nothing here is made up. */
export function buildBoard(lf: LfValue): BoardCard[] {
  const cat = lf.catalog;
  if (!cat) return [];
  const rules = lf.doc.rules;
  const byTier = new Map<string, CatalogItem[]>();
  for (const it of cat.items) {
    const k = tierKeyOfItem(rules, it);
    const l = byTier.get(k);
    if (l) l.push(it);
    else byTier.set(k, [it]);
  }
  const rank = (it: CatalogItem): number => priceOf(lf, it.name) ?? -1;
  const sorted = (l: CatalogItem[]): CatalogItem[] => l.map((x, i) => ({ x, i })).sort((a, b) => rank(b.x) - rank(a.x) || a.i - b.i).map((e) => e.x);
  /** Tier by tier, the priciest first inside each tier, the way a section reads top to bottom. */
  const inTiers = (tiers: TierInfo[]): CatalogItem[] => tiers.flatMap((t) => sorted(byTier.get(t.key) ?? []));
  const out: BoardCard[] = [];
  const items = (id: string, title: string, section: string, note: string, list: CatalogItem[], cap: number, empty?: string): void => {
    out.push({ id, title, section, note, chips: list.slice(0, cap).map((item) => ({ kind: 'item', item })), total: list.length, ...(empty && !list.length ? { empty } : {}) });
  };

  // Currency: NeverSink's numbered tiers, top to bottom. S and A are rare, B and C are mid, the rest is for leveling.
  const cur = (cat.types.find((t) => t.type === 'currency')?.tiers ?? []).filter((t) => t.tier !== 'restex' && t.kind !== 'Hide');
  const numbered = (t: TierInfo): number => Number(/^t(\d+)/.exec(t.tier)?.[1] ?? 99);
  const rare = cur.filter((t) => numbered(t) <= 2);
  const mid = cur.filter((t) => numbered(t) >= 3 && numbered(t) <= 4);
  const low = cur.filter((t) => numbered(t) > 4);
  items('rare', tr('lootfilter_advanced_overview_board.rare_currency'), 'currency', tr('lootfilter_advanced_overview_board.trade_currency_divine_orbs_and'), inTiers(rare), CAP.rare);
  items('mid', tr('lootfilter_advanced_overview_board.mid_currency'), 'currency', tr('lootfilter_advanced_overview_board_2.common_crafting_currency_worth_picking_up'), inTiers(mid), CAP.mid);
  items('low', tr('lootfilter_advanced_overview_board.leveling_currency'), 'currency', tr('lootfilter_advanced_overview_board.shown_in_the_campaign_strictness'), inTiers(low), CAP.leveling);

  // The most valuable named items right now, by poe.ninja price.
  if (lf.prices) {
    const top = cat.items.filter((it) => (priceOf(lf, it.name) ?? 0) > 0).sort((a, b) => rank(b) - rank(a));
    items('top', tr('lootfilter_advanced_overview_board.top_value_items'), 'currency', tr('lootfilter_advanced_overview_board.the_most_valuable_named_items', { league: lf.prices.league }), top, CAP.top);
  } else {
    items('top', tr('lootfilter_advanced_overview_board.top_value_items'), 'currency', tr('lootfilter_advanced_overview_board.needs_poe_ninja_prices'), [], CAP.top, lf.pricesLoading ? tr('lootfilter_advanced_overview_board.prices_are_loading') : tr('lootfilter_advanced_overview_board.prices_could_not_be_loaded'));
  }

  // Your build: the rules made from the open build, upgrades first, then bases, then gems.
  const mine = rules.filter((r) => r.source === 'build' && r.enabled).sort((a, b) => ['up', 'base', 'gem'].indexOf(groupOfBuildRule(a)) - ['up', 'base', 'gem'].indexOf(groupOfBuildRule(b)) || a.priority - b.priority);
  const asc = lf.build?.info.ascendClassName || lf.build?.info.className;
  out.push({
    id: 'build',
    title: tr('lootfilter_advanced_overview_board.build_items'),
    section: 'build',
    note: tr('lootfilter_advanced_overview_board.made_from_your_asc_build', { asc: asc ? asc + ' ' : '' }),
    chips: mine.slice(0, CAP.build).map((rule) => ({ kind: 'rule', rule, name: customNames(rule)[0] ?? rule.name ?? tr('lootfilter_advanced_overview_board_2.rule') })),
    total: mine.length,
    ...(mine.length ? {} : { empty: lf.build ? tr('lootfilter_advanced_overview_board.no_rules_came_from_your') : tr('lootfilter_advanced_overview_board.no_build_is_open_so') }),
  });

  // Uniques, by the value of the best unique on each base.
  const uniq = cat.items.filter((it) => sectionOfType(it.type).id === 'uniques').sort((a, b) => rank(b) - rank(a));
  items('uniq', tr('lootfilter_buildfilter_model.uniques'), 'uniques', tr('lootfilter_advanced_overview_board.unique_items_by_the_value'), uniq, CAP.uniques);

  // Maps match by tier, not by name: draw each tier's look on a sample name, then the special maps NeverSink names.
  const mapTiers = cat.types.find((t) => t.type === 'maps')?.tiers ?? [];
  const mapTier = (n: number): TierInfo | undefined => mapTiers.find((t) => new RegExp(`^maps_[a-d]_t${n}$`).test(t.tier));
  const valdo = cat.items.find((it) => it.type === 'maps->nightmare');
  const mapChips: BoardChip[] = [];
  const addMap = (n: number): void => {
    const tier = mapTier(n);
    if (tier && tier.kind !== 'Hide') mapChips.push({ kind: 'tier', tier, name: tr('lootfilter_advanced_overview_board_2.map_tier', { n: n }) });
  };
  addMap(16);
  if (valdo) mapChips.push({ kind: 'item', item: valdo });
  for (const n of [15, 14, 11, 6, 1]) addMap(n);
  out.push({ id: 'maps', title: tr('lootfilter_advanced_overview_board.maps'), section: 'maps', note: tr('lootfilter_advanced_overview_board.map_tiers_and_valdo_s'), chips: mapChips.slice(0, CAP.maps), total: mapChips.length, ...(mapChips.length ? {} : { empty: tr('lootfilter_advanced_overview_board.neversink_has_no_map_tiers') }) });

  // Gold: the pile sizes NeverSink tiers, largest first.
  const goldTiers = (cat.types.find((t) => t.type === 'gold')?.tiers ?? []).filter((t) => /^stack\d$/.test(t.tier) && t.kind !== 'Hide');
  const goldAt = (t: TierInfo): number => {
    const b = cat.blocks.find((x) => x.tag && x.tag.type === 'gold' && x.tag.tier === t.tier);
    const c = b?.conditions.find((x) => x.key === 'StackSize');
    return Number(c?.values[0] ?? 0);
  };
  out.push({
    id: 'gold',
    title: tr('lootfilter_advanced_overview_board.gold'),
    section: 'gold',
    note: tr('lootfilter_advanced_overview_board.gold_piles_by_size_picked'),
    chips: goldTiers.slice(0, CAP.gold).map((tier) => ({ kind: 'tier', tier, name: tr('lootfilter_advanced_overview_board_2.gold', { US: goldAt(tier).toLocaleString('en-US') }) })),
    total: goldTiers.length,
    ...(goldTiers.length ? {} : { empty: tr('lootfilter_advanced_overview_board.neversink_has_no_gold_tiers') }),
  });
  return out;
}
