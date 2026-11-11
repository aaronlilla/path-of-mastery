/**
 * Currency values for the Trader's price sort and total, read from the public currency exchange the way upstream's
 * `TradeQueryClass:PullCXData` does: each currency is worth so many divine orbs in a league.
 *
 *   GET https://www.pathofexile.com/api/trade/data/static            ->  { result: [{ id, label, entries: [{ id, text }] }] }
 *   GET https://web.poecdn.com/api/currency-exchange/<hour>          ->  { markets: [{ league, market_pair, lowest_ratio, highest_stock }] }
 */

export interface StaticTradeData {
  result?: Array<{ id?: string; entries?: Array<{ id: string; text: string }> }>;
}

export interface CurrencyExchange {
  markets?: Array<{
    league: string;
    market_pair: [string, string];
    lowest_ratio?: Record<string, number>;
    highest_stock?: Record<string, number>;
  }>;
}

/** League -> currency id ("chaos", "exalted", "divine"...) -> value in divine orbs. */
export type CurrencyRates = Record<string, Record<string, number>>;

const DIVINE = 'Metadata/Items/Currency/CurrencyModValues';
const CHAOS = 'Metadata/Items/Currency/CurrencyRerollRare';
const GENERAL = new Set([DIVINE, CHAOS]);

export function parseCurrencyExchange(stat: StaticTradeData, cx: CurrencyExchange, names: Record<string, string>): CurrencyRates {
  const idOfName = new Map<string, string>();
  for (const [id, name] of Object.entries(names)) idOfName.set(name, id);
  const short = new Map<string, string>();
  for (const e of stat.result?.[0]?.entries ?? []) {
    if (e.id === 'sep') continue;
    const itemId = idOfName.get(e.text);
    if (itemId) short.set(itemId, e.id);
  }
  const leagues = new Map<string, Map<string, { currency: string; price: number; stock: number }>>();
  for (const m of cx.markets ?? []) {
    let from = m.market_pair[0];
    let to = m.market_pair[1];
    if (GENERAL.has(from) && to !== DIVINE) [from, to] = [to, from];
    const fromShort = short.get(from);
    const toShort = short.get(to);
    const ratio = m.lowest_ratio ?? {};
    if (!fromShort || !GENERAL.has(to) || !toShort || !ratio[from] || ratio[to] === undefined) continue;
    const entry = { currency: toShort, price: ratio[to]! / ratio[from]!, stock: m.highest_stock?.[from] ?? 0 };
    let l = leagues.get(m.league);
    if (!l) leagues.set(m.league, (l = new Map()));
    const have = l.get(fromShort);
    if (!have || have.stock < entry.stock) l.set(fromShort, entry);
  }
  const out: CurrencyRates = {};
  for (const [league, entries] of leagues) {
    const res: Record<string, number> = {};
    for (const [from, to] of entries) {
      if (to.currency === 'divine') res[from] = to.price;
      else {
        const div = entries.get(to.currency);
        if (div && div.currency === 'divine') res[from] = div.price * to.price;
      }
    }
    if (Object.keys(res).length) {
      res.divine = 1;
      out[league] = res;
    }
  }
  return out;
}

/** An amount of a currency in divine orbs, or null when the league has no rate for it. */
export function inDivines(rates: CurrencyRates | null | undefined, league: string, currency: string, amount: number): number | null {
  const r = rates?.[league]?.[currency];
  return r === undefined ? null : amount * r;
}

/** The URL of the exchange's hourly file (the one for the hour before now, which is always complete). */
export function exchangeUrl(realm: string, nowSec: number): string {
  const hour = 3600;
  const t = (Math.floor(nowSec / hour) - 1) * hour;
  return `https://web.poecdn.com/api/currency-exchange/${realm && realm !== 'pc' ? `${realm}/` : ''}${t}`;
}
