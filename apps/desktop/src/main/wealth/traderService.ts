/**
 * The Trader's calls to the trade site. Searches run on the player's session cookie when Wealth has one and without it when
 * not (the public site answers with lower limits). The cookie stays inside HttpTrade: nothing here reads, logs or returns it.
 */
import { CURRENCY_NAMES } from '../../shared/currencyNames.js';
import { exchangeUrl, parseCurrencyExchange, type CurrencyRates } from '../../shared/tradeRates.js';
import { tradeItemText } from '../../shared/tradeItemText.js';
import type { TraderFailure, TraderListing, TraderSearch, TraderSearchInput, TraderUrlInput } from '../../shared/trader.js';
import { GggError } from './ggg.js';
import { FETCH_MAX, type RawListing } from './trade.js';

export interface TraderTradeApi {
  search(league: string, query: unknown, realm?: string): Promise<{ id: string; total: number; ids: string[] }>;
  fetch(ids: string[], queryId: string, realm?: string): Promise<RawListing[]>;
  savedQuery(league: string, id: string, realm?: string): Promise<{ query?: Record<string, unknown>; sort?: Record<string, string> }>;
}

/** The text the game copies for an item, as the trade site's `extended.text` carries it (base64), else built from the item's fields. */
export function listingText(raw: RawListing): string {
  const ext = (raw.item as { extended?: { text?: unknown } } | undefined)?.extended?.text;
  if (typeof ext === 'string' && ext) {
    try {
      const t = Buffer.from(ext, 'base64').toString('utf8');
      if (t.trim()) return t.replace(/\r\n/g, '\n');
    } catch {
      /* fall through to the fields */
    }
  }
  return raw.item ? tradeItemText(raw.item)?.text ?? '' : '';
}

export function toListing(raw: RawListing): TraderListing | null {
  if (!raw.item) return null;
  const l = raw.listing;
  const p = l?.price;
  const online = l?.account?.online;
  return {
    id: raw.id,
    priceType: p?.type ?? '',
    amount: p && typeof p.amount === 'number' ? p.amount : null,
    currency: p && typeof p.currency === 'string' ? p.currency : null,
    whisper: l?.whisper ?? '',
    account: l?.account?.name ?? '',
    online: !!online,
    indexed: l?.indexed ?? '',
    text: listingText(raw),
  };
}

export function failure(e: unknown): TraderFailure {
  if (e instanceof GggError) {
    if (e.kind === 'rate-limited') return { ok: false, kind: 'rate-limited', message: e.message, retryAfterSec: e.retryAfterSec ?? 60 };
    if (e.kind === 'expired') return { ok: false, kind: 'expired', message: e.message };
    if (e.kind === 'bad-input' || e.kind === 'not-found') return { ok: false, kind: 'bad-query', message: e.message };
    return { ok: false, kind: 'down', message: e.message };
  }
  return { ok: false, kind: 'down', message: 'The trade site did not answer.' };
}

export class TraderService {
  private ratesCache = new Map<string, { at: number; rates: CurrencyRates }>();

  constructor(
    private readonly api: TraderTradeApi,
    private readonly o: { authenticated: () => boolean; now?: () => number; fetchFn?: typeof fetch; userAgent: string },
  ) {}

  auth(): { authenticated: boolean } {
    return { authenticated: this.o.authenticated() };
  }

  /** Runs a search and reads `pages` pages of 10 results. A page that fails after the first keeps what was read. */
  async search(i: TraderSearchInput): Promise<TraderSearch> {
    try {
      const s = await this.api.search(i.league, i.query, i.realm || 'pc');
      const pages = Math.min(10, Math.max(1, Math.floor(i.pages || 1)));
      const listings: TraderListing[] = [];
      for (let p = 0; p < pages; p++) {
        const ids = s.ids.slice(p * FETCH_MAX, (p + 1) * FETCH_MAX);
        if (!ids.length) break;
        try {
          for (const r of await this.api.fetch(ids, s.id, i.realm || 'pc')) {
            const l = toListing(r);
            if (l && l.text) listings.push(l);
          }
        } catch (e) {
          if (p === 0) throw e;
          break;
        }
      }
      return { ok: true, queryId: s.id, total: s.total, listings, query: i.query };
    } catch (e) {
      return failure(e);
    }
  }

  async fromUrl(i: TraderUrlInput): Promise<TraderSearch> {
    const m = /^(?:https?:\/\/)?(?:www\.)?pathofexile\.com\/trade\/search\/([^?#]+)/i.exec(i.url.trim());
    const parts = m ? m[1]!.split('/').filter(Boolean).map((x) => decodeURIComponent(x.replace(/\+/g, ' '))) : [];
    if (parts.length < 2 || parts.length > 3) return { ok: false, kind: 'bad-url', message: 'Invalid URL' };
    const realm = parts.length === 3 ? parts[0]! : 'pc';
    const league = parts[parts.length - 2]!;
    const id = parts[parts.length - 1]!;
    try {
      const saved = await this.api.savedQuery(league, id, realm);
      if (!saved.query) return { ok: false, kind: 'bad-query', message: 'Failed to get search query' };
      const weighted = (saved.query as { stats?: Array<{ type?: string }> }).stats?.[0]?.type === 'weight';
      const query = { ...saved, sort: weighted ? { 'statgroup.0': 'desc' } : { price: 'asc' } };
      delete (query as Record<string, unknown>).id;
      return this.search({ realm, league, query, pages: i.pages });
    } catch (e) {
      return failure(e);
    }
  }

  /** The exchange rates, read at most once an hour per realm. */
  async rates(realm: string): Promise<{ ok: true; rates: CurrencyRates } | { ok: false; message: string }> {
    const now = (this.o.now ?? Date.now)();
    const hit = this.ratesCache.get(realm);
    if (hit && now - hit.at < 61 * 60 * 1000) return { ok: true, rates: hit.rates };
    const f = this.o.fetchFn ?? fetch;
    const get = async (url: string): Promise<unknown> => {
      const r = await f(url, { headers: { 'User-Agent': this.o.userAgent, Accept: 'application/json' } });
      if (!r.ok) throw new Error(`answered ${r.status}`);
      return r.json();
    };
    try {
      const stat = (await get('https://www.pathofexile.com/api/trade/data/static')) as Parameters<typeof parseCurrencyExchange>[0];
      const cx = (await get(exchangeUrl(realm, Math.floor(now / 1000)))) as Parameters<typeof parseCurrencyExchange>[1];
      const rates = parseCurrencyExchange(stat, cx, CURRENCY_NAMES);
      this.ratesCache.set(realm, { at: now, rates });
      return { ok: true, rates };
    } catch (e) {
      return { ok: false, message: `Could not read the currency exchange (${e instanceof Error ? e.message : 'no answer'}).` };
    }
  }
}
