/**
 * Prices from poe.ninja's documented /poe1/api/ routes.
 *
 * Everything the rest of Wealth needs from prices sits behind `PriceFeed`: today it is the app polling poe.ninja every
 * 15 minutes; a Supabase cache could implement the same interface and replace it.
 * ETags are honoured, so an unchanged category costs a 304 with no body. Each category keeps its own fetch time, so
 * every price can show its source and age.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { PriceStatus } from '../../shared/wealth.js';
import { EXCHANGE_TYPES, ITEM_TYPES, PriceBook } from './priceBook.js';
import { ninjaBase, withNinjaFallback } from './ninjaUrl.js';

export interface PriceFeed {
  /** Reads whatever is cached on disk so prices exist before the first network call. */
  load(book: PriceBook): Promise<void>;
  /** Fetches what changed. Never throws: a failure leaves the cached prices in place and says so in the status. */
  refresh(book: PriceBook): Promise<PriceStatus>;
  status(): PriceStatus;
  readonly intervalMs: number;
  /** One category for another league, into a book of its own (never the player's). Optional: only the poe.ninja feed has it. */
  fetchCategory?(book: PriceBook, type: string, league: string): Promise<boolean>;
}

export interface NinjaOptions {
  league: () => string;
  cacheDir: string;
  userAgent: string;
  now?: () => number;
  fetchFn?: typeof fetch;
  /** Pause between requests so a full refresh stays polite. */
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called as each category finishes, so the screens can show real progress. */
  onProgress?: () => void;
}


interface CacheMeta {
  etag?: string;
  at: number;
}

export class NinjaFeed implements PriceFeed {
  readonly intervalMs = 15 * 60 * 1000;
  private meta = new Map<string, CacheMeta>();
  private last: PriceStatus = { source: 'poe.ninja', fetchedAt: null, oldestAt: null, ok: false, message: 'Prices have not loaded yet.', lines: 0, loading: false, progress: null, failed: false };
  private readonly now: () => number;
  private readonly fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: NinjaOptions) {
    this.now = o.now ?? Date.now;
    // our backend first, poe.ninja directly when it fails (ninjaUrl.ts)
    this.fetchFn = withNinjaFallback((url: string, init?: RequestInit) => (o.fetchFn ?? fetch)(url, init), this.now); // read the global at call time: the proxy setting swaps it after this object exists
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private file(type: string): string {
    return join(this.o.cacheDir, `${this.o.league().replace(/[^A-Za-z0-9]+/g, '_')}_${type}.json`);
  }

  private apply(book: PriceBook, type: string, exchange: boolean, body: unknown, at: number): void {
    if (exchange) book.addExchange(type, body as Parameters<PriceBook['addExchange']>[1], at);
    else book.addItems(type, body as Parameters<PriceBook['addItems']>[1], at);
  }

  async load(book: PriceBook): Promise<void> {
    try {
      this.meta = new Map(Object.entries(JSON.parse(await readFile(join(this.o.cacheDir, 'meta.json'), 'utf8')) as Record<string, CacheMeta>));
    } catch {
      this.meta = new Map();
    }
    for (const [exchange, list] of [[true, EXCHANGE_TYPES], [false, ITEM_TYPES]] as const) {
      for (const t of list) {
        const m = this.meta.get(`${this.o.league()}:${t.type}`);
        if (!m) continue;
        try {
          this.apply(book, t.type, exchange, JSON.parse(await readFile(this.file(t.type), 'utf8')), m.at);
        } catch {
          /* a damaged cache file is refetched */
          this.meta.delete(`${this.o.league()}:${t.type}`);
        }
      }
    }
    this.last = this.summarise(book, book.size > 0, book.size > 0 ? 'Prices from the last session.' : 'Prices have not loaded yet.');
  }

  private summarise(book: PriceBook, ok: boolean, message: string): PriceStatus {
    const a = book.ages();
    return { source: 'poe.ninja', fetchedAt: a.newest, oldestAt: a.oldest, ok, message, lines: book.size, loading: false, progress: null, failed: false };
  }

  status(): PriceStatus {
    return this.last;
  }

  async refresh(book: PriceBook): Promise<PriceStatus> {
    const league = this.o.league();
    this.last = { ...this.last, loading: true, progress: { done: 0, total: EXCHANGE_TYPES.length + ITEM_TYPES.length } };
    this.o.onProgress?.();
    await mkdir(this.o.cacheDir, { recursive: true });
    let failed = 0;
    let changed = 0;
    let done = 0;
    let firstError = '';
    const jobs: { type: string; exchange: boolean }[] = [...EXCHANGE_TYPES.map((t) => ({ type: t.type, exchange: true })), ...ITEM_TYPES.map((t) => ({ type: t.type, exchange: false }))];
    for (const j of jobs) {
      const key = `${league}:${j.type}`;
      const url = `${ninjaBase()}/economy/${j.exchange ? 'exchange' : 'stash'}/current/${j.exchange ? '' : 'item/'}overview?league=${encodeURIComponent(league)}&type=${j.type}`;
      const prior = this.meta.get(key);
      const headers: Record<string, string> = { 'User-Agent': this.o.userAgent, Accept: 'application/json' };
      if (prior?.etag && book.fetchedAt(j.type) !== undefined) headers['If-None-Match'] = prior.etag;
      try {
        const res = await this.fetchFn(url, { headers });
        const at = this.now();
        if (res.status === 304 && prior) {
          this.meta.set(key, { ...prior, at });
          // Lines are already in the book; only their age moves.
          this.touch(book, j.type, j.exchange, at);
        } else if (res.ok) {
          const text = await res.text();
          const body = JSON.parse(text);
          this.apply(book, j.type, j.exchange, body, at);
          const etag = res.headers.get('etag') ?? undefined;
          this.meta.set(key, { ...(etag ? { etag } : {}), at });
          const tmp = `${this.file(j.type)}.${randomUUID()}.tmp`;
          await writeFile(tmp, text, 'utf8');
          await rename(tmp, this.file(j.type));
          changed++;
        } else {
          failed++;
          firstError ||= `poe.ninja answered ${res.status} for ${j.type}.`;
        }
      } catch {
        failed++;
        firstError ||= 'poe.ninja did not answer.';
      }
      done++;
      this.last = { ...this.last, loading: true, progress: { done, total: jobs.length } };
      this.o.onProgress?.();
      await this.sleep(this.o.gapMs ?? 250);
    }
    await writeFile(join(this.o.cacheDir, 'meta.json'), JSON.stringify(Object.fromEntries(this.meta)), 'utf8').catch(() => {});
    const ok = book.size > 0;
    const msg = failed === 0 ? (changed ? 'Prices refreshed.' : 'Prices are current.') : ok ? `${firstError} ${failed} of ${jobs.length} categories kept their last prices. The app tries again in 15 minutes.` : `${firstError} No prices are loaded, so values show as unpriced. The app tries again in 15 minutes.`;
    // poe.ninja answering with nothing (a league it has no data for) is as good as not answering: say so, with the league's name.
    const none = book.size === 0 && failed === 0;
    const msg2 = none ? `poe.ninja has no prices for ${league}. Values show as unpriced until it does. Check the league name, or try again.` : msg;
    this.last = { ...this.summarise(book, ok, msg2), failed: failed > 0 || none };
    return this.last;
  }

  /** One category of another league, used for the Standard price in Market. One request; false when poe.ninja did not answer. */
  async fetchCategory(book: PriceBook, type: string, league: string): Promise<boolean> {
    const exchange = EXCHANGE_TYPES.some((x) => x.type === type);
    const url = `${ninjaBase()}/economy/${exchange ? 'exchange' : 'stash'}/current/${exchange ? '' : 'item/'}overview?league=${encodeURIComponent(league)}&type=${type}`;
    try {
      const res = await this.fetchFn(url, { headers: { 'User-Agent': this.o.userAgent, Accept: 'application/json' } });
      if (!res.ok) return false;
      this.apply(book, type, exchange, await res.json(), this.now());
      return true;
    } catch {
      return false;
    }
  }

  private touch(book: PriceBook, type: string, exchange: boolean, at: number): void {
    // Re-adding from the cached file would cost a parse; the book only needs the new time.
    book.setFetchedAt(type, at);
    void exchange;
  }
}
