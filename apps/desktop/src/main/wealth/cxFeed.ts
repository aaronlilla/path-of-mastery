/**
 * GGG's official Currency Exchange digests, as a second price source next to poe.ninja.
 *
 *   GET https://web.poecdn.com/api/currency-exchange[/<realm>][/<id>]     (public, no login)
 *   -> { next_change_id, markets: [{ league, market_pair, volume_traded, lowest_ratio, highest_ratio, ... }] }
 *
 * Hourly digests across all leagues, historical only. The id is a unix timestamp; the answer's next_change_id is the
 * following hour, and when it equals the id that was asked for we are at the end and wait for the next hour boundary.
 * We do not read the whole history: a first run jumps to CATCH_UP_HOURS ago, then follows next_change_id, then a call
 * is made only when a new hour can exist. Digests are cut down to the player's league and stored as one small rollup
 * per hour (price per currency in chaos, volume), the last KEEP_HOURS of them.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CURRENCY_NAMES } from '../../shared/currencyNames.js';
import type { Cat, CxQuote, CxStatus } from '../../shared/wealth.js';
import { RateLimiter } from './rateLimiter.js';

export const CHAOS_ID = 'Metadata/Items/Currency/CurrencyRerollRare';
export const DIVINE_ID = 'Metadata/Items/Currency/CurrencyModValues';
const BASE = 'https://web.poecdn.com/api/currency-exchange';
const HOUR = 3600;
/** A first run (or a gap longer than KEEP_HOURS) starts this far back, not at the first hour of history. */
export const CATCH_UP_HOURS = 24;
export const KEEP_HOURS = 48;
/** Prices are read from the newest hours with data, this many at most, volume-weighted. */
export const WINDOW_HOURS = 12;
const MAX_PER_RUN = 60;
const POLICY = 'currency-exchange';

export interface CxMarket {
  league: string;
  market_pair: string[];
  volume_traded?: Record<string, number>;
  lowest_ratio?: Record<string, number>;
  highest_ratio?: Record<string, number>;
}
export interface CxDigest {
  next_change_id: number;
  markets: CxMarket[];
}

/** One hour of one league: for each currency its chaos price and the units traded that hour; `divine` is a divine in chaos. */
export interface CxHour {
  t: number;
  divine: number | null;
  prices: Record<string, { c: number; v: number }>;
}

interface CxState {
  league: string;
  /** The id to ask for next. */
  next: number;
  /** Do not call before this (epoch ms): the next hour boundary once we have reached the end. */
  checkAfter: number;
  hours: CxHour[];
}

/**
 * Price of A in B for one market, the mid of the hour's lowest and highest ratio. A ratio dict holds how many of each
 * item changed hands per unit of exchange, so A costs ratio[B] / ratio[A] of B. Where only one of the two ratios is
 * usable that one is taken; none usable gives null.
 */
export function midPrice(m: CxMarket, a: string, b: string): number | null {
  const one = (r: Record<string, number> | undefined): number | null => {
    const x = r?.[a];
    const y = r?.[b];
    return typeof x === 'number' && typeof y === 'number' && x > 0 && y > 0 ? y / x : null;
  };
  const lo = one(m.lowest_ratio);
  const hi = one(m.highest_ratio);
  if (lo !== null && hi !== null) return (lo + hi) / 2;
  return lo ?? hi;
}

/**
 * Reduces one hourly digest to the player's league. For every market where one side is chaos or divine, the other
 * side's price is the mid of the lowest and highest ratio, weighted by the units of that currency traded in the market.
 * Divine-quoted prices are turned into chaos with the hour's own divine/chaos market. Several markets for one currency
 * are combined by the same volume weight. An hour with no divine/chaos market keeps only the chaos-quoted prices.
 */
export function reduceHour(d: CxDigest, league: string, t: number): CxHour {
  const mine = d.markets.filter((m) => m.league === league && Array.isArray(m.market_pair) && m.market_pair.length === 2);
  let divine: number | null = null;
  const dm = mine.find((m) => m.market_pair.includes(DIVINE_ID) && m.market_pair.includes(CHAOS_ID));
  if (dm) divine = midPrice(dm, DIVINE_ID, CHAOS_ID);
  const acc = new Map<string, { sum: number; v: number }>();
  const add = (id: string, chaos: number, v: number) => {
    if (!(chaos > 0) || !(v > 0)) return;
    const a = acc.get(id) ?? { sum: 0, v: 0 };
    a.sum += chaos * v;
    a.v += v;
    acc.set(id, a);
  };
  for (const m of mine) {
    const [x, y] = m.market_pair as [string, string];
    for (const [id, other] of [[x, y], [y, x]] as const) {
      if (id === CHAOS_ID) continue;
      const v = m.volume_traded?.[id] ?? 0;
      const p = midPrice(m, id, other);
      if (p === null) continue;
      if (other === CHAOS_ID) add(id, p, v);
      else if (other === DIVINE_ID && divine !== null && id !== DIVINE_ID) add(id, p * divine, v);
    }
  }
  const prices: CxHour['prices'] = {};
  for (const [id, a] of acc) prices[id] = { c: a.sum / a.v, v: a.v };
  return { t, divine, prices };
}

export interface CxLine extends CxQuote {
  id: string;
  name: string;
  cat: Cat;
}

/** The category a metadata id belongs to, from its path. */
export function catOfId(id: string): Cat {
  if (id.includes('/Scarabs/')) return 'scar';
  if (id.includes('/DivinationCards/')) return 'card';
  if (id.includes('/MapFragments/')) return 'frag';
  if (/\/Essence/i.test(id)) return 'ess';
  return 'cur';
}

/**
 * Prices per currency name from the stored hours: the newest WINDOW_HOURS hours that have the currency, volume-weighted.
 * `at` is the end of the newest hour used (the digest for hour t describes t .. t+1h), in ms. Divine is the volume-weighted
 * divine/chaos price over the hours that have one. Currencies the app has no name for are left out.
 */
export function pricesFromHours(hours: CxHour[], names: Record<string, string> = CURRENCY_NAMES): CxLine[] {
  const sorted = [...hours].sort((a, b) => b.t - a.t);
  let dSum = 0;
  let dN = 0;
  let dAt = 0;
  for (const h of sorted.slice(0, WINDOW_HOURS)) {
    if (h.divine !== null) {
      const w = h.prices[DIVINE_ID]?.v ?? 1;
      dSum += h.divine * w;
      dN += w;
      dAt = Math.max(dAt, h.t);
    }
  }
  const divineChaos = dN > 0 ? dSum / dN : null;
  const ids = new Set<string>();
  for (const h of sorted) for (const id of Object.keys(h.prices)) ids.add(id);
  const out: CxLine[] = [];
  for (const id of ids) {
    const name = names[id];
    if (!name) continue;
    let sum = 0;
    let vol = 0;
    let at = 0;
    let used = 0;
    for (const h of sorted) {
      const p = h.prices[id];
      if (!p) continue;
      if (used++ >= WINDOW_HOURS) break;
      sum += p.c * p.v;
      vol += p.v;
      at = Math.max(at, h.t);
    }
    if (vol <= 0) continue;
    const chaos = sum / vol;
    out.push({ id, name, cat: catOfId(id), chaos, divine: divineChaos ? chaos / divineChaos : null, volume: vol, at: (at + HOUR) * 1000 });
  }
  if (divineChaos !== null && !out.some((l) => l.id === DIVINE_ID) && names[DIVINE_ID]) {
    out.push({ id: DIVINE_ID, name: names[DIVINE_ID] as string, cat: 'cur', chaos: divineChaos, divine: 1, volume: 0, at: (dAt + HOUR) * 1000 });
  }
  if (out.length > 0 && names[CHAOS_ID]) out.push({ id: CHAOS_ID, name: names[CHAOS_ID] as string, cat: 'cur', chaos: 1, divine: divineChaos ? 1 / divineChaos : null, volume: 0, at: (sorted[0] ? sorted[0].t + HOUR : 0) * 1000 });
  return out;
}

export interface CxOptions {
  league: () => string;
  dir: string;
  userAgent: string;
  /** PC is the default realm. */
  realm?: string;
  now?: () => number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  limiter?: RateLimiter;
  onChange?: () => void;
}

export class CxFeed {
  private state: CxState | null = null;
  private job: Promise<void> | null = null;
  private lines: CxLine[] = [];
  private status: CxStatus = { ok: false, message: 'The exchange has not loaded yet.', at: null, hours: 0, loading: false };
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchFn: typeof fetch;
  private readonly limiter: RateLimiter;

  constructor(private readonly o: CxOptions) {
    this.now = o.now ?? Date.now;
    this.fetchFn = o.fetchFn ?? (((input, init) => fetch(input, init)) as typeof fetch); // read the global at call time: the proxy setting swaps it after this object exists
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    // Own limiter: the CDN is not pathofexile.com, and the stash/trade budget must not be spent on it. Headers refine this.
    this.limiter = o.limiter ?? new RateLimiter({ now: this.now, sleep: this.sleep, minGapMs: 2000, defaults: { [POLICY]: [{ max: 5, period: 10, restrict: 60 }] } });
  }

  private file(): string {
    return join(this.o.dir, `cx_${(this.o.realm ?? 'pc')}_${this.o.league().replace(/[^A-Za-z0-9]+/g, '_')}.json`);
  }

  private async persist(): Promise<void> {
    if (!this.state) return;
    await mkdir(this.o.dir, { recursive: true });
    const tmp = `${this.file()}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state), 'utf8');
    await rename(tmp, this.file());
  }

  /** Reads the stored hours for the current league, so prices exist before the first call. */
  async load(): Promise<CxLine[]> {
    const league = this.o.league();
    try {
      const s = JSON.parse(await readFile(this.file(), 'utf8')) as CxState;
      if (s.league === league && Array.isArray(s.hours)) this.state = s;
    } catch {
      /* no file, or a damaged one: start again */
    }
    if (!this.state || this.state.league !== league) this.state = { league, next: 0, checkAfter: 0, hours: [] };
    this.rebuild('Exchange prices from the last session.');
    return this.lines;
  }

  private rebuild(msg: string): void {
    this.lines = this.state ? pricesFromHours(this.state.hours) : [];
    const newest = this.lines.reduce((m, l) => Math.max(m, l.at), 0);
    this.status = { ok: this.lines.length > 0, message: this.lines.length ? msg : 'The exchange has not loaded yet.', at: newest || null, hours: this.state?.hours.length ?? 0, loading: false };
  }

  current(): CxLine[] {
    return this.lines;
  }

  getStatus(): CxStatus {
    return this.status;
  }

  /** Catches up and follows the digests. Never throws; at most one run at a time; does nothing before the next hour exists. */
  refresh(): Promise<CxLine[]> {
    return (this.job ??= this.run().finally(() => void (this.job = null))).then(() => this.lines);
  }

  private async run(): Promise<void> {
    if (!this.state || this.state.league !== this.o.league()) await this.load();
    const st = this.state as CxState;
    const nowMs = this.now();
    if (nowMs < st.checkAfter) return;
    const floorNow = Math.floor(nowMs / 1000 / HOUR) * HOUR;
    // Too old to follow (or never started): jump to a recent hour instead of walking history.
    const earliest = floorNow - CATCH_UP_HOURS * HOUR;
    if (!st.next || st.next < floorNow - KEEP_HOURS * HOUR) st.next = earliest;
    this.status = { ...this.status, loading: true };
    this.o.onChange?.();
    let err = '';
    try {
      for (let i = 0; i < MAX_PER_RUN; i++) {
        const id = st.next;
        const d = await this.get(id);
        if (d === 'end') {
          // The hour is not published yet: the next one exists once the next hour boundary has passed.
          err = '';
          st.checkAfter = (Math.floor(this.now() / 1000 / HOUR) + 1) * HOUR * 1000 + 60_000;
          break;
        }
        if (d === 'wait') {
          err = '';
          st.checkAfter = this.now() + 5 * 60 * 1000;
          break;
        }
        if (!d || typeof d.next_change_id !== 'number' || !Array.isArray(d.markets)) throw new Error('the exchange sent an unexpected answer');
        if (d.next_change_id === id) {
          // At the end: the next digest exists once the next hour boundary has passed.
          st.checkAfter = (Math.floor(this.now() / 1000 / HOUR) + 1) * HOUR * 1000 + 60_000;
          break;
        }
        const hour = reduceHour(d, st.league, id);
        st.hours = [...st.hours.filter((h) => h.t !== id), hour].sort((a, b) => a.t - b.t).slice(-KEEP_HOURS);
        st.next = d.next_change_id;
        await this.persist();
        this.rebuild('Exchange prices are current.');
        this.o.onChange?.();
        if (i === MAX_PER_RUN - 1) break;
      }
    } catch (e) {
      err = `The currency exchange did not answer (${e instanceof Error ? e.message : 'no answer'}). ${this.lines.length ? 'The last prices stay.' : 'No exchange prices yet.'}`;
      // A failure is retried at the next price refresh, not in a tight loop.
      st.checkAfter = this.now() + 10 * 60 * 1000;
    }
    await this.persist().catch(() => undefined);
    this.rebuild(this.lines.length ? 'Exchange prices are current.' : 'The exchange had no data for this league.');
    if (err) this.status = { ...this.status, ok: false, message: err };
    this.o.onChange?.();
  }

  /** One call, through the limiter. 'wait' = rate limited (Retry-After honoured). */
  private async get(id: number): Promise<CxDigest | 'wait' | 'end' | null> {
    await this.limiter.acquire(POLICY);
    const realm = this.o.realm && this.o.realm !== 'pc' ? `/${this.o.realm}` : '';
    const r = await this.fetchFn(`${BASE}${realm}/${id}`, { headers: { 'User-Agent': this.o.userAgent, Accept: 'application/json' } });
    this.limiter.update(POLICY, r.headers);
    if (r.status === 429) {
      const ra = Number(r.headers.get('retry-after'));
      this.limiter.penalize(POLICY, Number.isFinite(ra) && ra > 0 ? ra : 60);
      return 'wait';
    }
    // GGG answers 404 for an hour that has not been published yet: that is the end of the history, not a failure.
    if (r.status === 404) return 'end';
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as CxDigest;
  }
}
