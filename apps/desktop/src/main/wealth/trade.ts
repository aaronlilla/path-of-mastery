/**
 * The trade site's search and fetch endpoints on the player's POESESSID.
 *
 *   POST /api/trade/search/<league>          body { query, sort }  ->  { id, result: [listing ids], total }
 *   GET  /api/trade/fetch/<id,id,...>?query=<id>   (at most 10 ids)  ->  { result: [{ id, listing, item }] }
 *
 * The cookie goes only to www.pathofexile.com, never into a URL, a log line or an error text. Every request waits on
 * the shared rate limiter (the same one the stash client uses), which learns the real limits from the response
 * headers. A 429 waits out Retry-After and backs off every policy; a 403 is never retried. Nothing is listed, bought
 * or whispered for the player: the app reads listings and shows them.
 */
import { TRADE_CURRENCY, listingAgeMin, type TradeFailure, type TradeItem, type TradeListing, type TradeResult, type TradeSearchOutcome, type TradeStatus, emptyTradeStatus } from '../../shared/wealthTrade.js';
import { CallLog, checkTradeFetch, checkTradeSearch, type ShapeProblem } from './callLog.js';
import { GGG_HOST, GggError } from './ggg.js';
import type { PriceBook } from './priceBook.js';
import type { RateLimiter } from './rateLimiter.js';

export const FETCH_MAX = 10;
export const CACHE_MS = 5 * 60 * 1000;

export interface RawListing {
  id: string;
  listing?: {
    indexed?: string;
    whisper?: string;
    hideout_token?: string;
    account?: { name?: string; online?: unknown };
    price?: { type?: string; amount?: number; currency?: string } | null;
  };
  item?: TradeItem;
}

/** The trade site's answer to the hideout request, already sorted into what the caller must do. */
export type TravelReply =
  | { kind: 'ok' }
  | { kind: 'in-demand' }
  | { kind: 'refused'; status: number; code?: number; message: string }
  | { kind: 'rate-limited'; sec: number }
  | { kind: 'down'; message: string };

export interface TradeApi {
  search(league: string, query: unknown, realm?: string): Promise<{ id: string; total: number; ids: string[] }>;
  fetch(ids: string[], queryId: string, realm?: string): Promise<RawListing[]>;
  /** "Travel to Hideout": one POST, never retried. Absent on test doubles that do not travel. */
  travel?(token: string, cont?: boolean): Promise<TravelReply>;
  /** Epoch ms when a request may go again, or null. */
  resumesAt(): number | null;
}

export interface HttpTradeOptions {
  cookie: () => string | null;
  userAgent: string;
  limiter: RateLimiter;
  fetchFn?: typeof fetch;
  baseUrl?: string;
  log?: CallLog;
  /** Search without a cookie when there is none (the public trade site answers at lower limits). Wealth leaves this off. */
  anonymous?: boolean;
}

export class HttpTrade implements TradeApi {
  private readonly fetchFn: typeof fetch;
  private readonly base: string;

  constructor(private readonly o: HttpTradeOptions) {
    this.fetchFn = o.fetchFn ?? (((input, init) => fetch(input, init)) as typeof fetch); // read the global at call time: the proxy setting swaps it after this object exists
    this.base = o.baseUrl ?? `https://${GGG_HOST}`;
    const host = new URL(this.base).host;
    if (host !== GGG_HOST && !o.baseUrl?.startsWith('http://127.0.0.1')) throw new Error('The session cookie may only be sent to pathofexile.com.');
  }

  resumesAt(): number | null {
    const a = this.o.limiter.resumesAt('trade-search');
    const b = this.o.limiter.resumesAt('trade-fetch');
    return a === null ? b : b === null ? a : Math.max(a, b);
  }

  /**
   * What the site's "Travel to Hideout" button does: POST /api/trade/whisper { token, continue? } with the session cookie
   * (header only), JSON body. The answer is { success: true } or { success: false } (in demand: send again with
   * continue) or { error: { code, message } }. One request through the trade limiter; a 4xx is never retried.
   */
  async travel(token: string, cont = false): Promise<TravelReply> {
    const cookie = this.o.cookie();
    if (!cookie) return { kind: 'refused', status: 0, message: 'Not connected: there is no session cookie.' };
    const policy = 'trade-whisper';
    const lim = this.o.limiter;
    const t0 = Date.now();
    const wait = lim.waitTime(policy);
    await lim.acquire(policy);
    const url = `${this.base}/api/trade/whisper`;
    const note = (status: number, outcome: string, headers: Record<string, string>, extra = '') =>
      this.o.log?.record({ at: t0, method: 'POST', endpoint: CallLog.endpoint(url), policy, status, ms: Date.now() - t0, headers, limiter: { waitedMs: wait, decision: (wait > 0 ? `waited ${(wait / 1000).toFixed(1)} s for a free slot` : 'sent at once') + extra, limits: lim.limitsFor(policy).map((l) => `${l.max}:${l.period}:${l.restrict}`).join(',') }, outcome });
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: { Cookie: `POESESSID=${cookie}`, 'User-Agent': this.o.userAgent, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, ...(cont ? { continue: true } : {}) }),
        redirect: 'manual',
      });
    } catch {
      note(0, 'no answer', {});
      return { kind: 'down', message: 'The trade site did not answer.' };
    }
    lim.update(policy, res.headers);
    const hdr = CallLog.headersOf(res.headers);
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      const sec = Number.isFinite(ra) && ra > 0 ? ra : 60;
      lim.penalizeAll(sec);
      note(429, 'rate limited', hdr, `; every policy blocked for ${sec} s`);
      return { kind: 'rate-limited', sec };
    }
    type WhisperBody = { success?: boolean; error?: { code?: number; message?: string } };
    let body = null as WhisperBody | null;
    try {
      body = (await res.json()) as WhisperBody;
    } catch {
      body = null;
    }
    if (res.status >= 300 && res.status < 400) {
      note(res.status, 'redirected to login', hdr, '; not retried');
      return { kind: 'refused', status: res.status, message: 'The trade site sent us to the login page. The cookie has probably expired.' };
    }
    if (!res.ok || body?.error) {
      note(res.status, 'refused', hdr, '; not retried');
      if (res.status >= 500) return { kind: 'down', message: `The trade site answered with ${res.status}.` };
      const code = typeof body?.error?.code === 'number' ? body.error.code : undefined;
      return { kind: 'refused', status: res.status, ...(code !== undefined ? { code } : {}), message: String(body?.error?.message ?? `The trade site answered with ${res.status}.`).slice(0, 160) };
    }
    note(res.status, body?.success ? 'ok' : 'in demand', hdr);
    return body?.success ? { kind: 'ok' } : { kind: 'in-demand' };
  }

  private async call<T>(policy: 'trade-search' | 'trade-fetch', url: string, init: { method: 'GET' | 'POST'; body?: string }, check?: (b: unknown) => ShapeProblem | null): Promise<T> {
    const cookie = this.o.cookie();
    if (!cookie && !this.o.anonymous) throw new GggError('expired', 'Not connected: there is no session cookie.');
    const lim = this.o.limiter;
    const wait = lim.waitTime(policy);
    const t0 = Date.now();
    await lim.acquire(policy);
    const note = (status: number, outcome: string, headers: Record<string, string>, extra = '') =>
      this.o.log?.record({ at: t0, method: init.method, endpoint: CallLog.endpoint(url), policy, status, ms: Date.now() - t0, headers, limiter: { waitedMs: wait, decision: (wait > 0 ? `waited ${(wait / 1000).toFixed(1)} s for a free slot` : 'sent at once') + extra, limits: lim.limitsFor(policy).map((l) => `${l.max}:${l.period}:${l.restrict}`).join(',') }, outcome });
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: init.method,
        headers: {
          ...(cookie ? { Cookie: `POESESSID=${cookie}` } : {}),
          'User-Agent': this.o.userAgent,
          Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
        redirect: 'manual',
      });
    } catch {
      note(0, 'no answer', {});
      // Never include the URL or headers: the message is shown and may be logged.
      throw new GggError('down', "The trade site did not answer.");
    }
    lim.update(policy, res.headers);
    const hdr = CallLog.headersOf(res.headers);
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      const sec = Number.isFinite(ra) && ra > 0 ? ra : 60;
      // The restriction is on the address, not the endpoint: every policy backs off.
      lim.penalizeAll(sec);
      note(429, 'rate limited', hdr, `; every policy blocked for ${sec} s`);
      throw new GggError('rate-limited', `The trade site asked us to wait ${sec} seconds.`, sec);
    }
    if (res.status === 401 || res.status === 403) {
      note(res.status, 'refused', hdr, '; not retried');
      throw new GggError('expired', cookie ? 'The trade site refused the session cookie. It has probably expired.' : 'The trade site refused the request.');
    }
    if (res.status >= 300 && res.status < 400) {
      note(res.status, 'redirected to login', hdr, '; not retried');
      throw new GggError('expired', 'The trade site sent us to the login page. The cookie has probably expired.');
    }
    if (res.status === 400) {
      note(400, 'search refused', hdr);
      let msg = 'The trade site did not understand that search.';
      try {
        const j = (await res.json()) as { error?: { message?: string } };
        if (j.error?.message) msg = `The trade site refused that search: ${String(j.error.message).slice(0, 160)}`;
      } catch {
        /* keep the plain message */
      }
      throw new GggError('bad-input', msg);
    }
    if (res.status === 404) {
      note(404, 'not found', hdr);
      throw new GggError('not-found', 'The trade site has no such league or search.');
    }
    if (!res.ok) {
      note(res.status, 'server error', hdr);
      throw new GggError('down', `The trade site answered with ${res.status}.`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      note(res.status, 'not JSON', hdr);
      this.o.log?.diagnose({ endpoint: CallLog.endpoint(url), status: res.status, problem: 'The answer is not JSON.', missing: [], found: [], at: t0 });
      throw new GggError('shape', 'The trade site sent something that is not data. A diagnostic you can copy is in the connection check.');
    }
    const bad = check?.(body);
    if (bad) {
      note(res.status, 'shape mismatch', hdr);
      this.o.log?.diagnose({ endpoint: CallLog.endpoint(url), status: res.status, ...bad, at: t0 });
      throw new GggError('shape', `The trade site answered in a shape the app does not know. ${bad.problem} A diagnostic you can copy is in the connection check.`);
    }
    note(res.status, 'ok', hdr);
    return body as T;
  }

  async search(league: string, query: unknown, realm = 'pc'): Promise<{ id: string; total: number; ids: string[] }> {
    const path = realm && realm !== 'pc' ? `${realm}/${encodeURIComponent(league)}` : encodeURIComponent(league);
    const r = await this.call<{ id: string; total?: number; result: unknown[] }>('trade-search', `${this.base}/api/trade/search/${path}`, { method: 'POST', body: JSON.stringify(query) }, checkTradeSearch);
    return { id: r.id, total: typeof r.total === 'number' ? r.total : r.result.length, ids: r.result.filter((x): x is string => typeof x === 'string') };
  }

  /** The query behind a saved trade search (a pasted `.../trade/search/league/id` link). */
  async savedQuery(league: string, id: string, realm = 'pc'): Promise<{ query?: Record<string, unknown>; sort?: Record<string, string> }> {
    const path = realm && realm !== 'pc' ? `${realm}/${encodeURIComponent(league)}` : encodeURIComponent(league);
    return this.call('trade-search', `${this.base}/api/trade/search/${path}/${encodeURIComponent(id)}`, { method: 'GET' });
  }

  async fetch(ids: string[], queryId: string, realm = 'pc'): Promise<RawListing[]> {
    if (!ids.length) return [];
    const list = ids.slice(0, FETCH_MAX).map((i) => encodeURIComponent(i)).join(',');
    const q = `query=${encodeURIComponent(queryId)}${realm && realm !== 'pc' ? `&realm=${realm}` : ''}`;
    const r = await this.call<{ result?: unknown }>('trade-fetch', `${this.base}/api/trade/fetch/${list}?${q}`, { method: 'GET' }, checkTradeFetch);
    return (r.result as (RawListing | null)[]).filter((x): x is RawListing => !!x && typeof x.id === 'string').map(withModStrings);
  }
}

const MOD_KEYS = ['enchantMods', 'implicitMods', 'explicitMods', 'craftedMods', 'fracturedMods', 'scourgeMods', 'crucibleMods', 'mutatedMods'] as const;

/** The trade site can send a modifier as an object ({ description, ... }) instead of a line of text; every reader here takes lines, so turn each into its description. */
export function withModStrings(l: RawListing): RawListing {
  const it = l.item;
  if (!it) return l;
  const item: Record<string, unknown> = { ...it };
  for (const k of MOD_KEYS) {
    const xs = item[k];
    if (!Array.isArray(xs)) continue;
    item[k] = xs.map((m: unknown) => (typeof m === 'string' ? m : typeof (m as { description?: unknown } | null)?.description === 'string' ? (m as { description: string }).description : '')).filter(Boolean);
  }
  return { ...l, item: item as unknown as TradeItem };
}

// ---- the searcher: cache, retry, status, prices -------------------------------------------------------------------

/** Chaos for a listed price using the price book; null when the currency has no line (never zero). */
export function priceInChaos(book: PriceBook, price: { amount: number; currency: string } | null): number | null {
  if (!price || !Number.isFinite(price.amount) || price.amount < 0) return null;
  if (price.currency === 'chaos') return price.amount;
  if (price.currency === 'divine') return book.divine > 0 ? price.amount * book.divine : null;
  const c = TRADE_CURRENCY[price.currency];
  if (!c) return null;
  const line = book.lines(c.name).find((l) => l.type === 'Currency' || l.cat === 'cur') ?? book.lines(c.name)[0];
  return line ? price.amount * line.chaos : null;
}

export function tradeLink(league: string, query: unknown, realm = 'pc'): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  let url = 'https://www.pathofexile.com/trade/search';
  if (realm && realm !== 'pc') url += '/' + realm;
  url += '/' + enc(league || 'Standard').replace(/%20/g, '+');
  return `${url}?q=${enc(JSON.stringify(query))}`;
}

/** The short link the site itself shows for a search it has saved: league and search id, no query in the address. */
export function tradeIdLink(league: string, id: string, realm = 'pc'): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
  return `https://www.pathofexile.com/trade/search/${realm && realm !== 'pc' ? realm + '/' : ''}${enc(league || 'Standard')}/${encodeURIComponent(id)}`;
}

export interface SearcherOptions {
  api: TradeApi;
  book: PriceBook;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  league: () => string;
  /** Called whenever the status changes. */
  onStatus?: (s: TradeStatus) => void;
  hasCookie: () => boolean;
  sample?: boolean;
}

interface CacheEntry {
  at: number;
  out: Omit<TradeSearchOutcome, 'cached'>;
}

export class TradeSearcher {
  private st: TradeStatus;
  private cache = new Map<string, CacheEntry>();
  /** Searches run one after another: the limiter already spaces them, and the status stays truthful. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: SearcherOptions) {
    this.st = { ...emptyTradeStatus(), sample: !!o.sample };
  }

  status(): TradeStatus {
    return { ...this.st };
  }

  private set(p: Partial<TradeStatus>): void {
    this.st = { ...this.st, ...p };
    this.o.onStatus?.(this.status());
  }

  private fail(e: unknown): TradeFailure {
    if (e instanceof GggError) {
      if (e.kind === 'rate-limited') {
        const sec = e.retryAfterSec ?? 60;
        this.set({ phase: 'waiting', resumesAt: this.o.now() + sec * 1000, message: `Waiting for the trade site. It asked us to pause for ${sec} seconds.` });
        return { ok: false, kind: 'rate-limited', message: e.message, retryAfterSec: sec };
      }
      if (e.kind === 'expired') {
        this.set({ phase: 'expired', resumesAt: null, message: 'The trade site refused the session cookie. Reconnect to keep searching.' });
        return { ok: false, kind: 'expired', message: e.message };
      }
      if (e.kind === 'shape') {
        this.set({ phase: 'down', resumesAt: null, message: e.message });
        return { ok: false, kind: 'down', message: e.message };
      }
      if (e.kind === 'bad-input' || e.kind === 'not-found') {
        this.set({ phase: 'idle', resumesAt: null, message: '' });
        return { ok: false, kind: 'bad-query', message: e.message };
      }
    }
    this.set({ phase: 'down', resumesAt: null, message: "The trade site isn't responding. Try again in a minute." });
    return { ok: false, kind: 'down', message: e instanceof Error ? e.message : "The trade site isn't responding." };
  }

  /** Waits (visibly) when the limiter says to, then runs `fn`; a 429 is waited out once or twice, a 403 never retried. */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      const wait = this.o.api.resumesAt();
      const t = this.o.now();
      if (wait !== null && wait - t > 4000) this.set({ phase: 'waiting', resumesAt: wait, message: `Waiting for the trade site. It resumes in ${Math.max(1, Math.round((wait - t) / 1000))} seconds.` });
      else this.set({ phase: 'busy', resumesAt: null, message: '' });
      try {
        const r = await fn();
        this.set({ phase: 'idle', resumesAt: null, message: '', lastOkAt: this.o.now(), requests: this.st.requests + 1 });
        return r;
      } catch (e) {
        if (e instanceof GggError && e.kind === 'rate-limited' && i < 2 && (e.retryAfterSec ?? 60) <= 120) {
          const sec = e.retryAfterSec ?? 60;
          this.set({ phase: 'waiting', resumesAt: this.o.now() + sec * 1000, message: `Waiting for the trade site. It asked us to pause for ${sec} seconds.`, requests: this.st.requests + 1 });
          await this.o.sleep(sec * 1000);
          continue;
        }
        this.set({ requests: this.st.requests + 1 });
        throw e;
      }
    }
  }

  /** Searches and fetches the first `limit` listings (at most 10: one fetch call). */
  search(query: unknown, opts: { limit?: number; realm?: string; fresh?: boolean } = {}): Promise<TradeResult<{ outcome: TradeSearchOutcome }>> {
    const run = this.chain.then(() => this.runSearch(query, opts));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async runSearch(query: unknown, opts: { limit?: number; realm?: string; fresh?: boolean }): Promise<TradeResult<{ outcome: TradeSearchOutcome }>> {
    const league = this.o.league();
    const realm = opts.realm ?? 'pc';
    const limit = Math.min(FETCH_MAX, Math.max(1, opts.limit ?? FETCH_MAX));
    const key = `${realm}|${league}|${limit}|${JSON.stringify(query)}`;
    const hit = this.cache.get(key);
    const now = this.o.now();
    if (!opts.fresh && hit && now - hit.at < CACHE_MS) return { ok: true, outcome: { ...hit.out, cached: true } };
    if (!this.o.hasCookie()) {
      this.set({ phase: 'no-cookie', message: 'Connect your Path of Exile account to search the trade site.' });
      return { ok: false, kind: 'no-cookie', message: 'There is no session cookie. Connect your account in Wealth first.' };
    }
    try {
      const s = await this.guarded(() => this.o.api.search(league, query, realm));
      const ids = s.ids.slice(0, limit);
      const raw = ids.length ? await this.guarded(() => this.o.api.fetch(ids, s.id, realm)) : [];
      const at = this.o.now();
      const listings: TradeListing[] = [];
      for (const r of raw) {
        if (!r.item) continue; // The listing was removed between the search and the fetch.
        const p = r.listing?.price;
        const price = p && typeof p.amount === 'number' && typeof p.currency === 'string' ? { amount: p.amount, currency: p.currency } : null;
        listings.push({
          id: r.id,
          indexed: r.listing?.indexed ?? '',
          price,
          chaos: priceInChaos(this.o.book, price),
          seller: r.listing?.account?.name ?? '',
          online: !!r.listing?.account?.online,
          whisper: r.listing?.whisper ?? '',
          ...(r.listing?.hideout_token ? { hideoutToken: r.listing.hideout_token } : {}),
          queryId: s.id,
          item: r.item,
        });
      }
      const out: Omit<TradeSearchOutcome, 'cached'> = { queryId: s.id, total: s.total, listings, at, link: s.id ? tradeIdLink(league, s.id, realm) : tradeLink(league, query, realm) };
      this.cache.set(key, { at, out });
      if (this.cache.size > 80) this.cache.delete(this.cache.keys().next().value as string);
      return { ok: true, outcome: { ...out, cached: false } };
    } catch (e) {
      return this.fail(e);
    }
  }

  /** The cheapest-first listings' age in minutes, for evidence lines. */
  static age(l: TradeListing, now: number): number | null {
    return listingAgeMin(l.indexed, now);
  }
}
