import type { TradeStats } from '../../renderer/items/tradeQuery.js';
import tradeStatsJson from '../../renderer/items/tradeStats.json' with { type: 'json' };
import { agoText, FRESH_LISTED, isFreshListing, listingAgeMin, type TradeListing } from '../../shared/wealthTrade.js';
import type { WealthService } from '../wealth/service.js';
import type { TradeListingOut, TradeSource } from './results.js';

const stats = tradeStatsJson as unknown as TradeStats;
const NUM = /-?\d+(?:\.\d+)?/g;

/** The trade site's stat id for a modifier line written as the game shows it ("+89 to maximum Life"), or undefined. */
export function statIdFor(text: string): string | undefined {
  const t = text.replace(NUM, '#').trim();
  const tries = [t, t.startsWith('+') ? t.slice(1) : '+' + t];
  for (const type of ['explicit', 'implicit', 'fractured', 'crafted', 'enchant', 'pseudo']) for (const x of tries) if (stats[type]?.[x]) return stats[type]![x];
  return undefined;
}

export function listingOut(l: TradeListing, divine: number, now: number): TradeListingOut {
  const it = l.item;
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    name: it.name || it.typeLine,
    base: it.baseType ?? it.typeLine,
    rarity: it.frameType === 3 ? 'Unique' : it.frameType === 2 ? 'Rare' : it.frameType === 1 ? 'Magic' : 'Normal',
    ilvl: it.ilvl ?? null,
    mods: [...(it.implicitMods ?? []), ...(it.fracturedMods ?? []), ...(it.explicitMods ?? []), ...(it.craftedMods ?? [])].slice(0, 14),
    asked: l.price ? `${l.price.amount} ${l.price.currency}` : 'no price',
    chaos: l.chaos === null ? null : round(l.chaos),
    divine: l.chaos === null || !(divine > 0) ? null : Math.round((l.chaos / divine) * 100) / 100,
    ageMinutes: listingAgeMin(l.indexed, now),
    ...(listingAgeMin(l.indexed, now) !== null ? { listed: agoText(listingAgeMin(l.indexed, now)!) } : {}),
    online: l.online,
  };
}

/**
 * Chaos per divine. Wealth loads prices only once its page is open, so an empty book starts the price fetch here; the
 * rate comes with its first category (Currency), so only that is waited for (every listing read divine null).
 */
async function divineRate(w: WealthService): Promise<number> {
  if (!w.book.divine) {
    let done = false;
    void w.refreshPrices().catch(() => undefined).finally(() => (done = true));
    for (let i = 0; i < 80 && !w.book.divine && !done; i++) await new Promise((r) => setTimeout(r, 100));
  }
  return w.book.divine || 0;
}

/** The assistant's view of Wealth's trade search and upgrade scan. Read-only, and every figure is a tool result. */
export function wealthTradeSource(w: WealthService): TradeSource {
  return {
    async search(q) {
      await w.whenReady();
      const div = await divineRate(w);
      const filters: { id: string; value?: { min: number } }[] = [];
      const unmatched: string[] = [];
      for (const m of q.mods ?? []) {
        const id = statIdFor(m.text);
        if (!id) unmatched.push(m.text);
        else filters.push({ id, ...(m.min !== undefined ? { value: { min: m.min } } : {}) });
      }
      // Online sellers only and listed within the last week, using the trade site's own status and "listed" filters.
      const query: Record<string, unknown> = { status: { option: 'online' }, stats: [{ type: 'and', filters }], filters: { trade_filters: { filters: { indexed: { option: FRESH_LISTED } } } } };
      if (q.name) query.name = q.name;
      if (q.type) query.type = q.type;
      if (q.category) query.filters = { ...(query.filters as object), type_filters: { filters: { category: { option: q.category } } } };
      const r = await w.premium.search({ query, sort: { price: 'asc' } }, q.limit ?? 8);
      if (!r.ok) return { ok: false, kind: r.kind, message: r.message, ...(r.retryAfterSec !== undefined ? { retryAfterSec: r.retryAfterSec } : {}) };
      return { ok: true, total: r.outcome.total, at: r.outcome.at, cached: r.outcome.cached, chaosPerDivine: div, listings: r.outcome.listings.filter((l) => isFreshListing(l, Date.now())).map((l) => listingOut(l, div, Date.now())), unmatchedMods: unmatched, link: r.outcome.link };
    },
    async upgrades(q) {
      const div = await divineRate(w);
      const r = await w.upgradeScan({ buildXml: q.buildXml, buildKey: q.buildKey, name: q.name, slots: [q.slot], rank: q.rank });
      if (!r.ok) return { ok: false, kind: r.kind, message: r.message };
      const scan = r.view.scans[q.slot];
      if (!scan) return { ok: false, kind: 'bad-query', message: `No equipped item was found in ${q.slot}.` };
      if (scan.error) return { ok: false, kind: scan.error.kind, message: scan.error.message };
      const round = (n: number) => Math.round(n * 1000) / 1000;
      return {
        ok: true,
        slot: q.slot,
        equipped: scan.equipped,
        rankStat: scan.rankStat,
        rankNow: scan.rankNow,
        total: scan.total,
        checked: scan.checked,
        rule: scan.rule,
        chaosPerDivine: div,
        link: scan.link,
        candidates: scan.candidates
          .filter((c) => !c.sold)
          .map((c) => ({
            ...listingOut(c.listing, div, Date.now()),
            gain: c.main ? { stat: c.main.statId, before: round(c.main.before), after: round(c.main.after), percent: c.main.pct === null ? null : round(c.main.pct * 100) } : null,
            ehpGain: c.ehp ? { before: round(c.ehp.before), after: round(c.ehp.after) } : null,
            others: c.others.map((o) => ({ stat: o.statId, before: round(o.before), after: round(o.after) })),
            held: c.held,
            scorePerDivine: c.score === null ? null : round(c.score),
            itemText: c.itemText.slice(0, 1500),
          })),
      };
    },
  };
}
