import type { PriceSource } from './results.js';

/** The part of the Wealth service the assistant reads prices through. */
export interface PriceBookHost {
  whenReady(): Promise<void>;
  refreshPrices(): Promise<void>;
  /** The price load in progress (the feed fills the book one category at a time, gems after the currencies), or null. */
  loadingPrices?(): Promise<void> | null;
  book: {
    size: number;
    divine: number;
    lines(name: string): Array<{ name: string; variant?: string; chaos: number; listings?: number; type: string }>;
    ages(): { oldest: number | null; newest: number | null };
  };
}

/**
 * What refunding passives costs: one Orb of Regret per point ("Grants a passive skill refund point", datamined game
 * files), priced from poe.ninja. A five-point respec was once called free. Ascendancy points are counted but not priced.
 */
export async function respecCost(prices: PriceSource | undefined, points: number, ascendancyPoints = 0) {
  if (points <= 0 && ascendancyPoints <= 0) return null;
  const r = await prices?.lookup(['Orb of Regret']).catch(() => null);
  const each = r?.lines[0]?.find((l) => l.name === 'Orb of Regret')?.chaos;
  const chaos = each !== undefined ? Math.round(each * points * 10) / 10 : null;
  return {
    refundedPoints: points,
    orbsOfRegret: points,
    ...(chaos !== null ? { chaos, shown: `${points} Orb${points === 1 ? '' : 's'} of Regret, about ${chaos}c`, priceAgeMinutes: r?.fetchedAt ? Math.max(0, Math.round((Date.now() - r.fetchedAt) / 60000)) : null } : { shown: `${points} Orb${points === 1 ? '' : 's'} of Regret` }),
    ...(ascendancyPoints > 0 ? { ascendancyPointsRefunded: ascendancyPoints } : {}),
    source: 'Orb of Regret: "Grants a passive skill refund point" (datamined game files); price from poe.ninja',
  };
}

const MIN_LISTINGS = 3;

/** The cheapest price of every unique in divine orbs, by name and by `name|variant` (5- and 6-link copies left out), for the solver's wealth tier. Null: no prices loaded. */
export function uniqueDivines(w: { book: { size: number; divine: number; all(): Array<{ name: string; variant?: string; chaos: number; divineValue?: number; type: string; links?: number; listings?: number }> } }): Record<string, number> | null {
  const div = w.book.divine;
  if (!div || w.book.size === 0) return null;
  const out: Record<string, number> = {};
  for (const l of w.book.all()) {
    if (!l.type.startsWith('Unique') || (l.links ?? 0) >= 5) continue;
    // 3: one or two cheap listings are bait or a mispriced stray, not a market; entries without a count are kept
    if (l.listings !== undefined && l.listings < MIN_LISTINGS) continue;
    // poe.ninja's own divine price when it has one, so a 1-divine unique is exactly 1.0
    const v = l.divineValue ?? l.chaos / div;
    if (!(l.name in out) || v < out[l.name]!) out[l.name] = v;
    // name|variant too, so a dear variant is not costed as the cheap one
    if (l.variant) {
      const k = `${l.name}|${l.variant}`;
      if (!(k in out) || v < out[k]!) out[k] = v;
    }
  }
  return out;
}

/** Prices for the assistant from the Wealth price book (poe.ninja). Loads the book first when it is empty. */
export function wealthPriceSource(w: PriceBookHost): PriceSource {
  return {
    async lookup(names) {
      let message: string | undefined;
      try {
        await w.whenReady();
        if (w.book.size === 0) await w.refreshPrices();
      } catch (e) {
        message = `The price feed did not answer: ${e instanceof Error ? e.message : String(e)}`;
      }
      // a name the book does not have yet while the feed is still loading (the gem category comes late on a first load): wait for it, up to 8 s
      // (Enlighten was "not found" at plan time and left out of the total spend)
      const job = names.some((n) => w.book.lines(n).length === 0) ? w.loadingPrices?.() : null;
      if (job) await Promise.race([job.catch(() => undefined), new Promise((res) => setTimeout(res, 8000))]);
      if (w.book.size === 0 && !message) message = 'No prices are loaded yet.';
      return {
        source: 'poe.ninja',
        fetchedAt: w.book.ages().newest,
        chaosPerDivine: w.book.divine,
        lines: names.map((n) => w.book.lines(n).map((l) => ({ name: l.name, ...(l.variant ? { variant: l.variant } : {}), chaos: l.chaos, ...(l.listings !== undefined ? { listings: l.listings } : {}), type: l.type }))),
        ...(message ? { message } : {}),
      };
    },
  };
}
