/**
 * The Wealth service. Runs in the main process: it owns the session cookie, every network call to pathofexile.com and
 * poe.ninja, the snapshots on disk and the session tracker. The renderer only asks for views.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecureStorage } from '../secureStorage.js';
import {
  CAT_NAMES,
  emptyView,
  pickLeague,
  fmtChaos,
  type CxQuote,
  type MarketRow,
  type NetPoint,
  type SessionView,
  type InboxEntry,
  type StashRow,
  type StrategyView,
  type SyncStatus,
  type TabInfo,
  type WealthConnectInput,
  type WealthView,
} from '../../shared/wealth.js';
import { defaultCounted, flattenTabs, GggError, HttpGgg, newGggLimiter, tabColour, unreadableReason, validAccountName, type GggApi, type RawCharacter, type RawTab } from './ggg.js';
import { NinjaFeed, type PriceFeed } from './ninja.js';
import { CxFeed } from './cxFeed.js';
import type { SignInResult } from './poeSignIn.js';
import { PriceBook, priceItem, type GggItem, type ItemPrice } from './priceBook.js';
import { emptyTracker, SessionTracker, totals, type Run, type Snapshot, type TrackerState } from './sessions.js';
import { CURATED, priceStrategy, strategyFromRun } from './strategies.js';
import { IndexCache, sessionRow, type CommunityBackend } from './communityStrategies.js';
import tradeStatsJson from '../../renderer/items/tradeStats.json' with { type: 'json' };
import type { TradeStats } from '../../renderer/items/tradeQuery.js';
import type { ItemInfo } from '@pom/protocol';
import { emptyTradeStatus, type TradeItem, type TradeListing, type TradeStatus, type TravelResult } from '../../shared/wealthTrade.js';
import { travelToHideout } from './hideout.js';
import { CallLog } from './callLog.js';
import { Premium } from './premium.js';
import { sampleDataFrom, sampleTradeFetch, type SampleTradeFetch, type SampleTradeMode } from './sampleTrade.js';
import { HttpTrade, TradeSearcher, type TradeApi } from './trade.js';
import type { UpgradeEngine } from './upgrades.js';

export const FULL_SYNC_MS = 30 * 60 * 1000;
export const LOOT_IN_SESSION_MS = 3 * 60 * 1000;
export const LOOT_IDLE_MS = 15 * 60 * 1000;
const MAX_LOOT_TABS = 3;
const MAX_POINTS = 6000;

export interface WealthDeps {
  /** The community backend (strategy index and shared session results). Absent in tests and when the app has no account host. */
  community?: CommunityBackend;
  dir: string;
  secrets: SecureStorage;
  version: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchFn?: typeof fetch;
  /** Replaces the live GGG client (tests). */
  ggg?: GggApi;
  /** Builds the sample stash once prices are loaded (the dev switch). */
  sampleGgg?: (book: PriceBook, saved: Record<string, GggItem[]>) => GggApi;
  prices?: PriceFeed;
  /** GGG's currency exchange feed. Left out in tests that inject their own prices or fetch; pass one (or null) to override. */
  cx?: CxFeed | null;
  /** Dev switch: a sample stash stands in for the account and no cookie is needed. */
  sample?: boolean;
  /** Replaces the trade site client (tests). */
  trade?: TradeApi;
  /** Dev switch: how the sample trade site answers. */
  sampleTradeMode?: SampleTradeMode;
  emit?: (v: WealthView) => void;
  onAlert?: (msg: string) => void;
  /** The sign-in window: gives back the POESESSID and account name from the app's own partition. */
  signIn?: { open(): Promise<SignInResult>; clear(): Promise<void> };
  /** Desktop notification for an upgrade found by a background check. */
  osNotify?: (e: { title: string; body: string; listing?: TradeListing }) => void;
  /** Puts text on the clipboard (the whisper fallback of Travel to hideout). */
  copyText?: (text: string) => void;
  /** False when the machine is idle, locked or asleep (background upgrade checks pause). */
  active?: () => boolean;
  /** Start the background timers. Tests turn this off and call `tick` themselves. */
  timers?: boolean;
}

interface Persisted {
  account: string;
  league: string;
  connected: boolean;
  tabs: TabInfo[];
  /** Tabs the player has chosen, once they have chosen. */
  lastFullAt: number | null;
  lastLootAt: number | null;
  lastSyncAt: number | null;
  goal: string | null;
  alerts: Record<string, number>;
  /** How far a price must move, in percent, before an alert fires. Default 1. */
  alertPct?: number;
  favs: Record<string, boolean>;
  characters: { name: string; level: number; cls: string; league: string }[];
  privateProfile: boolean;
  /** When each tab was last read and when its contents last changed, by tab id. */
  tabRead: Record<string, number>;
  tabChanged: Record<string, number>;
  /** The bell: price alerts, goal reached, upgrade matches, finished snapshots. */
  inbox: InboxEntry[];
  inboxReadAt: number;
  /** The goal the bell already announced as reached, so it is told once. */
  goalHit: string | null;
  /** The player chose to share the numbers of finished strategy sessions. Off until they turn it on. */
  shareSessions: boolean;
  /** Runs whose numbers were already sent, by run id. */
  shared: Record<string, true>;
}

interface StashFile {
  t: number;
  perTab: Record<string, GggItem[]>;
}

const blank = (): Persisted => ({ account: '', league: '', connected: false, tabs: [], lastFullAt: null, lastLootAt: null, lastSyncAt: null, goal: null, alerts: {}, favs: {}, characters: [], privateProfile: false, tabRead: {}, tabChanged: {}, inbox: [], inboxReadAt: 0, goalHit: null, shareSessions: false, shared: {} });

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

const writing = new Map<string, Promise<void>>();

/** Writes to one file run one at a time: on Windows two renames onto the same file at once fail (EPERM). */
function writeJson(path: string, v: unknown): Promise<void> {
  const text = JSON.stringify(v);
  const run = (writing.get(path) ?? Promise.resolve()).then(async () => {
    await mkdir(join(path, '..'), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, path);
  });
  const tail = run.catch(() => undefined);
  writing.set(path, tail);
  void tail.then(() => writing.get(path) === tail && writing.delete(path));
  return run;
}

/**
 * Net worth history without the zeros an earlier build wrote while no prices were loaded: an account with items is
 * never worth nothing, so once any point is positive the zero points are gaps, not data.
 */
export function cleanSeries(series: NetPoint[]): NetPoint[] {
  return series.some((p) => p.nw > 0) ? series.filter((p) => p.nw > 0) : series;
}

/** One price line's identity across the stash and Market. */
export const lineIdOf = (l: { type: string; id: string }): string => `${l.type}:${l.id}`;

export class WealthService {
  readonly book = new PriceBook();
  private st: Persisted = blank();
  private tracker: SessionTracker = new SessionTracker(emptyTracker(), () => this.book.divine || 370);
  private series: NetPoint[] = [];
  private stash: StashFile = { t: 0, perTab: {} };
  private rowsCache: { rev: number; rows: StashRow[]; tabVals: Record<string, { value: number; items: number }>; nw: number; unpriced: number; unpricedCount: number } | null = null;
  private rev = 0;
  private cookie: string | null = null;
  private pendingPage0: { tabs: RawTab[]; items: GggItem[] } | null = null;
  /** Tabs read to count their items on the first visit: the first snapshot uses them instead of reading again. */
  private pendingTabs: { at: number; items: Record<string, GggItem[]> } | null = null;
  private busy = false;
  private phase: SyncStatus['phase'] = 'not-connected';
  private counting: { done: number; total: number; counts: Record<string, number>; running: boolean } | null = null;
  private message = '';
  private reading: SyncStatus['reading'] = null;
  private resumesAt: number | null = null;
  private downUntil = 0;
  private downCount = 0;
  private lastPriceAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ready: Promise<void>;
  private ggg: GggApi;
  private readonly feed: PriceFeed;
  private readonly cx: CxFeed | null;
  private cxJob: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly limiter;
  private leaguesCache: string[] | null = null;
  private readonly communityIndex: IndexCache | null;
  private sharing = false;
  private changeSubs = new Set<(v: WealthView) => void>();
  readonly log = new CallLog();
  readonly searcher: TradeSearcher;
  private tradeApi!: TradeApi;
  /** The Trader's trade client: the same limiter and call log, and it also searches without a cookie. */
  readonly traderApi: HttpTrade;
  readonly premium: Premium;
  /** The sample trade site's fetch, when the dev switch is on (tests flip its mode). */
  readonly sampleTrade: SampleTradeFetch | null;

  constructor(private readonly d: WealthDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.limiter = newGggLimiter(this.now, this.sleep);
    this.communityIndex = d.community ? new IndexCache(d.community, this.now) : null;
    this.ggg = d.ggg ?? new HttpGgg({ cookie: () => this.cookie, userAgent: `PathOfMastery/${d.version} (contact: https://pathofmastery.gg)`, limiter: this.limiter, log: this.log, ...(d.fetchFn ? { fetchFn: d.fetchFn } : {}) });
    this.feed = d.prices ?? new NinjaFeed({ league: () => this.st.league || 'Standard', cacheDir: join(d.dir, 'prices'), userAgent: `PathOfMastery/${d.version} (contact: https://pathofmastery.gg)`, onProgress: () => this.publishSoon(), ...(d.fetchFn ? { fetchFn: d.fetchFn } : {}), now: this.now });
    this.cx = d.cx !== undefined ? d.cx : d.prices || d.fetchFn || d.ggg || d.sample ? null : new CxFeed({ league: () => this.st.league || 'Standard', dir: join(d.dir, 'cx'), userAgent: `PathOfMastery/${d.version} (contact: https://pathofmastery.gg)`, now: this.now, onChange: () => { this.book.setCx(this.cx?.current() ?? []); this.publishSoon(); } });
    this.log.setSecrets(() => [this.cookie ?? '', this.memCookie ?? '', this.st.account]);
    const ua = `PathOfMastery/${d.version} (contact: https://pathofmastery.gg)`;
    const stats = tradeStatsJson as unknown as TradeStats;
    this.sampleTrade = d.sample && !d.trade && !d.fetchFn ? sampleTradeFetch({ now: this.now, unique: (name, base, f) => this.sampleUnique(name, base, f), worn: () => [...this.worn.values()].flatMap((w) => this.wornItem(w, 1) ?? []), ...sampleDataFrom(stats, process.env.POM_ENGINE_DATA), ...(d.sampleTradeMode ? { mode: d.sampleTradeMode } : {}) }) : null;
    const tradeApi: TradeApi = d.trade ?? new HttpTrade({ cookie: () => this.cookie, userAgent: ua, limiter: this.limiter, log: this.log, fetchFn: this.sampleTrade ?? d.fetchFn ?? fetch });
    this.tradeApi = tradeApi;
    this.searcher = new TradeSearcher({ api: tradeApi, book: this.book, now: this.now, sleep: this.sleep, league: () => this.st.league || 'Standard', hasCookie: () => !!this.cookie, ...(d.sample ? { sample: true } : {}), onStatus: () => this.publishSoon() });
    this.traderApi = new HttpTrade({ cookie: () => (this.cookie === 'sample' ? null : this.cookie), anonymous: true, userAgent: ua, limiter: this.limiter, log: this.log, fetchFn: d.fetchFn ?? fetch });
    this.premium = new Premium({
      dir: d.dir,
      book: this.book,
      searcher: this.searcher,
      now: this.now,
      league: () => this.st.league || 'Standard',
      stats: async () => stats,
      rows: () => this.cache().rows,
      sessions: () => this.view().sessions,
      strategies: () => this.strategies(),
      networth: () => this.cache().nw,
      publish: () => this.publishSoon(),
      noteWorn: (item) => void this.worn.set(item.name.toLowerCase(), item),
      ...(d.osNotify ? { osNotify: d.osNotify } : {}),
      ...(d.active ? { active: d.active } : {}),
      ready: () => !!this.cookie && this.st.connected && this.searcher.status().phase !== 'expired' && this.searcher.status().phase !== 'no-cookie',
      notify: (e) => {
        this.addInbox({ kind: 'upgrade', ...e });
        void this.persist().catch(() => undefined);
      },
    });
    this.ready = this.init();
  }

  /** What is worn in the slots the Upgrade watch searched, by item name (the sample trade site builds its unique listings from it). */
  private worn = new Map<string, ItemInfo>();

  /** A sample listing of a named unique: the worn item with its rolls scaled up by `factor`, so a demo upgrade is a few percent, not a different item. */
  private sampleUnique(name: string, base: string, factor: number): TradeItem | null {
    const w = this.worn.get(name.toLowerCase());
    return w ? this.wornItem(w, factor, base) : null;
  }

  /** A worn item as the trade site lists it, with its rolls scaled by `factor`. */
  private wornItem(w: ItemInfo, factor: number, base = ''): TradeItem | null {
    if (!w.mods) return null;
    const scale = (t: string): string => (/^[+-]?[0-9]/.test(t) && /(increased|reduced| to )/.test(t) && !/(more|less|second|additional|Socketed)/.test(t) ? t.replace(/[0-9]+(?:[.][0-9]+)?/g, (n) => String(n.includes('.') ? Math.round(Number(n) * factor * 10) / 10 : Math.round(Number(n) * factor))) : t);
    const lines = (b: string) => w.mods!.filter((m) => m.bucket === b).map((m) => scale(m.text));
    return { name: w.name, typeLine: w.baseName ?? base, baseType: w.baseName ?? base, frameType: 3, ...(w.itemLevel ? { ilvl: w.itemLevel } : {}), identified: true, icon: '', implicitMods: lines('implicit'), explicitMods: lines('explicit') };
  }

  private pubTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pushes the view at most every 150 ms (the trade status changes often during a scan). */
  private publishSoon(): void {
    if (this.pubTimer) return;
    this.pubTimer = setTimeout(() => {
      this.pubTimer = null;
      this.publish();
    }, 150);
    this.pubTimer.unref?.();
  }

  /** Whether a session cookie is saved (the Trader's signed-in mode). The cookie itself never leaves this class. */
  traderAuthenticated(): boolean {
    return !!this.cookie && this.cookie !== 'sample';
  }

  /** The engine the upgrade scan calculates on. */
  attachEngine(e: UpgradeEngine): void {
    this.premium.attachEngine(e);
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------

  private async init(): Promise<void> {
    const p = join(this.d.dir);
    this.st = { ...blank(), ...(await readJson<Partial<Persisted>>(join(p, 'state.json'), {})) };
    this.tracker = new SessionTracker({ ...emptyTracker(), ...(await readJson<Partial<TrackerState>>(join(p, 'tracker.json'), {})) }, () => this.book.divine || 370);
    this.series = cleanSeries(await readJson<NetPoint[]>(join(p, 'series.json'), []));
    this.stash = await readJson<StashFile>(join(p, 'stash.json'), { t: 0, perTab: {} });
    if (this.d.sample) {
      this.cookie = 'sample';
      if (!this.st.account) {
        this.st.account = 'Kaelen#4821';
        this.st.connected = true;
      }
    } else if (this.st.connected) {
      this.cookie = this.loadCookie();
      if (!this.cookie) this.st.connected = false;
    }
    await this.feed.load(this.book);
    if (this.cx) this.book.setCx(await this.cx.load());
    // Prices read from the cache count as fetched when they were: a restart within the refresh interval does not fetch all categories again.
    this.lastPriceAt = this.book.ages().newest ?? 0;
    this.recompute();
    this.setPhase();
  }

  /** Forgets every snapshot, session and tab choice. The sample stash starts from a clean slate each launch. */
  async wipe(): Promise<void> {
    await this.ready;
    const keep = { account: this.st.account, league: this.st.league, connected: this.st.connected, shareSessions: this.st.shareSessions, shared: this.st.shared };
    this.st = { ...blank(), ...keep };
    this.tracker = new SessionTracker(emptyTracker(), () => this.book.divine || 370);
    this.series = [];
    this.stash = { t: 0, perTab: {} };
    this.bump();
    for (const f of ['state.json', 'tracker.json', 'series.json', 'stash.json']) await rm(join(this.d.dir, f), { force: true });
  }

  /** Builds the sample stash from the loaded prices. Fetches prices first when there are none yet. */
  async prepareSample(): Promise<GggApi | null> {
    await this.ready;
    if (!this.d.sampleGgg) return null;
    if (this.book.size === 0 && !this.hasHistory()) await this.refreshPrices();
    this.ggg = this.d.sampleGgg(this.book, this.stash.perTab);
    return this.ggg;
  }

  hasHistory(): boolean {
    return this.series.length >= 5;
  }

  /** Picks the current challenge league from the live list the first time it is needed. */
  async ensureLeague(): Promise<void> {
    if (this.st.league) return;
    this.st.league = pickLeague(await this.leagues());
    await this.persist();
  }

  /** Waits for the saved state to load. */
  async whenReady(): Promise<void> {
    await this.ready;
  }

  /** Set once the app has asked for background work; connecting again after a disconnect restarts it. */
  private wantTimers = false;

  start(): void {
    this.wantTimers = true;
    // Older sign-ins left the cookie in the sign-in window's store in clear text: empty it once the app is running.
    if (this.st.connected && !this.d.sample) void this.ready.then(() => this.d.signIn?.clear()).catch(() => undefined);
    if (this.timer || this.d.timers === false) return;
    this.timer = setInterval(() => void this.tick(), 20_000);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- for the Import tab -----------------------------------------------------------------------------------

  /** Whether a session is held, and the account it belongs to. The cookie itself never leaves this class. */
  importAccess(): { connected: boolean; account: string } {
    return { connected: !!this.cookie && !this.d.sample && this.st.connected, account: this.st.account };
  }

  /** The shared rate limiter's view of the characters policy, for Journey's half-budget (read only). */
  characterLimiter(): { limitsFor(policy: string): { max: number; period: number; restrict: number }[]; waitTime(policy: string): number } {
    return { limitsFor: (p) => this.limiter.limitsFor(p), waitTime: (p) => this.limiter.waitTime(p) };
  }

  /** A character-window page through the shared limiter. `cookie` true reads it as the connected player. */
  async characterWindow(path: string, query: Record<string, string>, cookie: boolean): Promise<string> {
    await this.ready;
    if (!this.ggg.window) throw new GggError('down', 'Reading characters is not available in this mode.');
    return this.ggg.window(path, query, { cookie });
  }

  // ---- cookie ------------------------------------------------------------------------------------------------

  private cookiePath(): string {
    return join(this.d.dir, 'session.bin');
  }

  private loadCookie(): string | null {
    try {
      if (!this.d.secrets.isAvailable()) return this.memCookie;
      return this.d.secrets.decrypt(readFileSync(this.cookiePath()));
    } catch {
      return this.memCookie;
    }
  }

  private memCookie: string | null = null;

  private async saveCookie(value: string): Promise<boolean> {
    this.memCookie = value;
    if (!this.d.secrets.isAvailable()) return false;
    await mkdir(this.d.dir, { recursive: true });
    await writeFile(this.cookiePath(), this.d.secrets.encrypt(value));
    return true;
  }

  private async dropCookie(): Promise<void> {
    this.cookie = null;
    this.memCookie = null;
    await rm(this.cookiePath(), { force: true });
  }

  // ---- state -------------------------------------------------------------------------------------------------

  private quiet = false;

  /** Holds back disk writes while history is replayed in bulk; `endBulk` writes once. */
  beginBulk(): void {
    this.quiet = true;
  }

  async endBulk(): Promise<void> {
    this.quiet = false;
    await this.persistAll();
    this.publish();
  }

  private async persist(): Promise<void> {
    if (this.quiet) return;
    await writeJson(join(this.d.dir, 'state.json'), this.st);
  }

  private async persistAll(): Promise<void> {
    if (this.quiet) return;
    await Promise.all([
      this.persist(),
      writeJson(join(this.d.dir, 'tracker.json'), this.tracker.state),
      writeJson(join(this.d.dir, 'series.json'), this.series),
      writeJson(join(this.d.dir, 'stash.json'), this.stash),
    ]);
    void this.shareClosed();
  }

  /** Sends the numbers of finished strategy sessions, once each, when the player turned sharing on and is signed in. A failure is tried again at the next save. */
  private async shareClosed(): Promise<void> {
    const c = this.d.community;
    if (!c || this.sharing || !this.st.shareSessions || !c.signedIn()) return;
    this.sharing = true;
    try {
      let sent = false;
      for (const r of this.tracker.state.closed) {
        if (this.st.shared[r.id]) continue;
        const row = sessionRow(r, this.book.divine, this.st.league);
        if (!row) continue;
        try {
          await c.submit(row);
        } catch {
          break;
        }
        this.st.shared[r.id] = true;
        sent = true;
      }
      if (sent) {
        this.communityIndex?.clear();
        await this.persist();
        this.publishSoon();
      }
    } finally {
      this.sharing = false;
    }
  }

  async setShareSessions(on: boolean): Promise<void> {
    await this.ready;
    this.st.shareSessions = !!on;
    await this.persist();
    this.publish();
    if (on) void this.shareClosed();
  }

  private setPhase(): void {
    if (!this.st.connected) this.phase = 'not-connected';
    else if (this.phase === 'not-connected') this.phase = 'idle';
  }

  private bump(): void {
    this.rev++;
    this.rowsCache = null;
  }

  private publish(): void {
    const v = this.view();
    this.d.emit?.(v);
    for (const cb of this.changeSubs) cb(v);
  }

  onChange(cb: (v: WealthView) => void): () => void {
    this.changeSubs.add(cb);
    return () => this.changeSubs.delete(cb);
  }

  // ---- rows and net worth ------------------------------------------------------------------------------------

  private recompute(): void {
    const tabsById = new Map(this.st.tabs.map((t) => [t.id, t]));
    const merged = new Map<string, { price: ItemPrice; qty: number; tabs: Record<string, number> }>();
    const tabVals: Record<string, { value: number; items: number }> = {};
    for (const [tabId, items] of Object.entries(this.stash.perTab)) {
      const tab = tabsById.get(tabId);
      if (tab && (!tab.counted || !tab.readable)) continue;
      for (const it of items) {
        const p = priceItem(this.book, it);
        if (p.skip) continue;
        const slot = (tabVals[tabId] ||= { value: 0, items: 0 });
        slot.items += p.qty;
        slot.value += (p.unit ?? 0) * p.qty;
        const m = merged.get(p.key);
        if (m) {
          m.qty += p.qty;
          m.tabs[tabId] = (m.tabs[tabId] ?? 0) + p.qty;
        } else merged.set(p.key, { price: p, qty: p.qty, tabs: { [tabId]: p.qty } });
      }
    }
    const rows: StashRow[] = [];
    let nw = 0;
    let unpriced = 0;
    let unpricedCount = 0;
    for (const m of merged.values()) {
      const p = m.price;
      const line = p.line;
      const at = line ? (this.book.fetchedAt(line.type) ?? null) : null;
      if (p.unit !== null) nw += p.unit * m.qty;
      else {
        unpriced++;
        unpricedCount += m.qty;
      }
      rows.push({
        key: p.key,
        name: p.name,
        ...(p.base ? { base: p.base } : {}),
        ...(p.variant ? { variant: p.variant } : {}),
        lineId: line ? lineIdOf(line) : null,
        cat: p.cat,
        qty: m.qty,
        unit: p.unit,
        hi: p.hi,
        priced: p.kind,
        ...(p.why ? { why: p.why } : {}),
        tabIds: Object.keys(m.tabs),
        spark: line?.spark ?? [],
        art: p.art,
        ...(p.artCat ? { artCat: p.artCat } : {}),
        maxStack: p.maxStack,
        ...(line?.listings !== undefined ? { listings: line.listings } : {}),
        source: line ? 'poe.ninja' : p.cx ? 'GGG currency exchange' : 'none',
        priceAt: line ? at : (p.cx?.at ?? null),
        ...(this.cxQuote(p.name, line) ? { cx: this.cxQuote(p.name, line) as CxQuote } : {}),
      });
    }
    rows.sort((a, b) => (b.unit ?? -1) * b.qty - (a.unit ?? -1) * a.qty);
    this.rowsCache = { rev: this.rev, rows, tabVals, nw, unpriced, unpricedCount };
  }

  private cache() {
    if (!this.rowsCache || this.rowsCache.rev !== this.rev) this.recompute();
    return this.rowsCache!;
  }

  private snapshotNow(t: number): Snapshot {
    const c = this.cache();
    const items: Snapshot['items'] = {};
    for (const r of c.rows) items[r.key] = { n: r.name, c: r.cat, q: r.qty, u: r.unit, a: r.art, ...(r.artCat ? { ac: r.artCat } : {}) };
    return { t, items };
  }

  private rate7d(): number {
    const week = this.now() - 7 * 24 * 3600_000;
    let net = 0;
    let hrs = 0;
    for (const r of [...this.tracker.state.closed, ...(this.tracker.state.run ? [this.tracker.state.run] : [])]) {
      if ((r.end ?? this.now()) < week) continue;
      net += totals(r).net;
      hrs += Math.max(1, ((r.end ?? this.now()) - r.start) / 60000) / 60;
    }
    return hrs > 0 ? net / hrs : 0;
  }

  private runView(r: Run): SessionView {
    const t = totals(r);
    const end = r.end ?? this.now();
    const minutes = Math.max(1, (end - r.start) / 60000);
    const items = (m: Run['gained']) => Object.values(m).sort((a, b) => b.value - a.value).map((i) => ({ key: i.key, name: i.name, cat: i.cat, qty: i.qty, value: i.value, art: i.art, ...(i.artCat ? { artCat: i.artCat } : {}), ...(i.transfer ? { transfer: true } : {}) }));
    const gi = items(r.gained);
    const si = items(r.spent);
    const pick = si.find((i) => i.cat === 'map') ?? si[0] ?? gi[0];
    return {
      id: r.id,
      icon: pick ? { name: pick.art, cat: pick.cat, ...(pick.artCat ? { artCat: pick.artCat } : {}) } : { name: 'Strand Map', cat: 'map' as const, artCat: 'maps' },
      name: r.name,
      custom: r.custom,
      start: r.start,
      end,
      running: r.end === null,
      manual: r.manual,
      minutes,
      revenue: t.revenue,
      cost: t.cost,
      net: t.net,
      perHour: t.net / (minutes / 60),
      mapsUsed: r.maps,
      snapshots: r.snapshots,
      gained: gi,
      spent: si,
      bars: r.bars,
      flags: r.flags,
      ...(r.strategyId ? { strategyId: r.strategyId } : {}),
      ...(r.published ? { published: true } : {}),
    };
  }

  view(): WealthView {
    const c = this.cache();
    const v = emptyView();
    const t = this.now();
    const tabs: TabInfo[] = this.st.tabs.map((x) => ({ ...x, value: c.tabVals[x.id]?.value ?? 0, items: c.tabVals[x.id]?.items ?? 0 }));
    const inv = Object.keys(this.stash.perTab).filter((k) => k.startsWith('char:') && !tabs.some((x) => x.id === k));
    for (const id of inv) tabs.push({ id, index: -1, name: id.slice(5), type: 'Inventory', colour: 'var(--text-muted)', readable: true, counted: true, value: c.tabVals[id]?.value ?? 0, items: c.tabVals[id]?.items ?? 0 });
    const sessions = [...(this.tracker.state.run ? [this.tracker.state.run] : []), ...this.tracker.state.closed].map((r) => this.runView(r));
    const mine = this.tracker.state.closed.filter((r) => r.published).map((r) => strategyFromRun(r, this.book.divine));
    const pr = this.feed.status();
    return {
      ...v,
      sync: this.syncStatus(),
      // A price age is only claimed when there are prices: an empty answer is not a fetch of anything.
      ...(this.cx ? { cx: this.cx.getStatus() } : {}),
      prices: { ...pr, fetchedAt: this.book.size > 0 ? this.book.ages().newest : null, oldestAt: this.book.size > 0 ? this.book.ages().oldest : null },
      divine: this.book.divine || 370,
      tabs,
      rows: c.rows,
      networth: c.nw,
      unpriced: c.unpriced,
      unpricedCount: c.unpricedCount,
      series: this.series,
      sessions,
      running: sessions.find((s) => s.running) ?? null,
      goal: this.st.goal,
      alerts: this.st.alerts,
      alertPct: this.alertPct(),
      favs: this.st.favs,
      community: { share: this.st.shareSessions, signedIn: !!this.d.community?.signedIn(), available: !!this.d.community },
      mine,
      characters: this.st.characters,
      rate7d: this.rate7d(),
      inbox: this.st.inbox,
      inboxUnread: this.st.inbox.filter((x) => x.at > this.st.inboxReadAt).length,
      trade: this.tradeStatus(),
      diag: this.log.diagnostics(),
      now: t,
    };
  }

  async connection() {
    await this.ready;
    return { calls: this.log.list(), diagnostics: this.log.diagnostics(), text: this.log.text() };
  }

  tradeStatus(): TradeStatus {
    const s = this.searcher.status();
    if (!this.st.connected && !this.d.sample) return { ...emptyTradeStatus(), phase: 'no-cookie', message: 'Connect your Path of Exile account to search the trade site.' };
    if (s.phase === 'waiting' && s.resumesAt && s.resumesAt <= this.now()) return { ...s, phase: 'idle', resumesAt: null, message: '' };
    return s;
  }

  private syncStatus(): SyncStatus {
    const t = this.now();
    const nextFull = this.st.lastFullAt ? this.st.lastFullAt + FULL_SYNC_MS : null;
    const running = !!this.tracker.state.run;
    const nextLoot = this.st.lastLootAt ? this.st.lastLootAt + (running ? LOOT_IN_SESSION_MS : LOOT_IDLE_MS) : null;
    let phase = this.phase;
    if (phase === 'rate-limited' && this.resumesAt && this.resumesAt <= t) phase = 'idle';
    return {
      phase,
      connected: this.st.connected,
      sample: !!this.d.sample,
      account: this.st.account,
      league: this.st.league,
      lastSyncAt: this.st.lastSyncAt,
      nextFullAt: nextFull,
      nextLootAt: nextLoot,
      reading: this.reading,
      resumesAt: this.resumesAt,
      message: this.message,
      privateProfile: this.st.privateProfile,
    };
  }

  // ---- the schedule ------------------------------------------------------------------------------------------

  /** Runs whatever is due. Safe to call at any time. */
  async tick(): Promise<void> {
    await this.ready;
    const t = this.now();
    if (this.tracker.tick(t)) {
      await this.persistAll();
      this.bump();
      this.publish();
    }
    if (!this.quiet && t - this.lastPriceAt >= this.feed.intervalMs) {
      this.lastPriceAt = t;
      await this.refreshPrices();
    }
    if (!this.quiet) await this.premium.pollTick().catch(() => undefined);
    if (this.busy || !this.st.connected || this.phase === 'expired') return;
    if (this.downUntil > t) return;
    if (this.resumesAt && this.resumesAt > t) return;
    const full = !this.st.lastFullAt || t - this.st.lastFullAt >= FULL_SYNC_MS;
    const loot = this.st.lastLootAt ? t - this.st.lastLootAt >= (this.tracker.state.run ? LOOT_IN_SESSION_MS : LOOT_IDLE_MS) : false;
    if (full) await this.sync('full');
    else if (loot) await this.sync('loot');
  }

  private priceJob: Promise<void> | null = null;
  /** The most price lines the book has held, to tell a thin book from a full one. */
  private bookPeak = 0;

  /** One price fetch at a time: a second caller while one runs gets that one's result, not another 46 requests. */
  /** The Retry button on the no-prices message. */
  async retryPrices(): Promise<void> {
    await this.ready;
    await this.refreshPrices();
  }

  // ---- the bell -----------------------------------------------------------------------------------------------

  /** Adds an entry to the bell. The caller saves and publishes. */
  addInbox(e: Omit<InboxEntry, 'id' | 'at'>): void {
    const at = this.now();
    this.st.inbox = [{ ...e, id: `${e.kind}:${at}:${Math.random().toString(36).slice(2, 7)}`, at }, ...this.st.inbox].slice(0, 30);
  }

  async readInbox(): Promise<void> {
    await this.ready;
    this.st.inboxReadAt = this.now();
    await this.persist();
    this.publish();
  }

  async clearInbox(): Promise<void> {
    await this.ready;
    this.st.inbox = [];
    this.st.inboxReadAt = this.now();
    await this.persist();
    this.publish();
  }

  async removeInbox(id: string): Promise<void> {
    await this.ready;
    this.st.inbox = this.st.inbox.filter((x) => x.id !== id);
    await this.persist();
    this.publish();
  }

  /** The price load in progress, or null (the assistant waits for it when a gem is not in the book yet). */
  loadingPrices(): Promise<void> | null {
    return this.priceJob;
  }

  refreshPrices(): Promise<void> {
    return (this.priceJob ??= this.fetchPrices().finally(() => void (this.priceJob = null)));
  }

  /** Catches the currency exchange up in the background: it never holds the poe.ninja refresh, and it calls out only when a new hour exists. */
  private refreshCx(): void {
    const cx = this.cx;
    if (!cx || this.cxJob) return;
    this.cxJob = cx
      .refresh()
      .then((lines) => {
        this.book.setCx(lines);
        this.bump();
        this.publishSoon();
      })
      .catch(() => undefined)
      .finally(() => void (this.cxJob = null));
  }

  private async fetchPrices(): Promise<void> {
    await this.ready;
    await this.ensureLeague();
    // Set before the fetch starts, so a tick or a second caller during it does not start another full fetch.
    this.lastPriceAt = this.now();
    const before = this.snapshotPrices();
    await this.feed.refresh(this.book);
    this.refreshCx();
    this.bump();
    this.checkAlerts(before);
    await this.persist().catch(() => undefined);
    this.publish();
  }

  /** Tells the bell once when the stash is worth the goal item. */
  private checkGoal(nw: number): void {
    const key = this.st.goal;
    if (!key || this.st.goalHit === key || this.book.size === 0) return;
    const m = this.marketRows().find((r) => r.key === key);
    if (!m || nw < m.chaos) return;
    this.st.goalHit = key;
    this.addInbox({ kind: 'goal', title: 'Goal reached', body: `Your stash is worth ${fmtChaos(nw, this.book.divine || 370)}, enough for ${m.name} at ${fmtChaos(m.chaos, this.book.divine || 370)}.`, go: { sub: 'market', patch: { mi: m.key, mq: '', mcat: 'all' } } });
  }

  private snapshotPrices(): Record<string, number> {
    const o: Record<string, number> = {};
    for (const k of Object.keys(this.st.alerts)) {
      const m = this.marketRows().find((r) => r.key === k);
      if (m) o[k] = m.chaos;
    }
    return o;
  }

  private checkAlerts(before: Record<string, number>): void {
    void before;
    const rows = Object.keys(this.st.alerts).length ? this.marketRows() : [];
    for (const [k, base] of Object.entries(this.st.alerts)) {
      const m = rows.find((r) => r.key === k);
      if (!m || base <= 0) continue;
      const ch = m.chaos / base - 1;
      if (Math.abs(ch) >= this.alertPct() / 100 - 1e-9) {
        this.st.alerts[k] = m.chaos;
        const msg = `${m.name} moved ${ch > 0 ? 'up' : 'down'} ${Math.abs(Math.round(ch * 100))}%`;
        this.addInbox({ kind: 'price', title: 'Price alert', body: `${msg}, now ${fmtChaos(m.chaos, this.book.divine || 370)}.`, go: { sub: 'market', patch: { mi: m.key, mq: '', mcat: 'all' } } });
        this.d.onAlert?.(msg);
      }
    }
  }

  /** One read. `full` reads every counted tab; `loot` reads the few tabs loot goes into. */
  async sync(kind: 'full' | 'loot'): Promise<void> {
    await this.ready;
    if (this.busy || !this.st.connected) return;
    this.busy = true;
    this.message = '';
    try {
      this.phase = 'reading';
      await this.read(kind);
      this.downCount = 0;
      this.downUntil = 0;
      this.resumesAt = null;
      // A disconnect that landed during the read keeps the not-connected phase.
      if (this.st.connected) this.phase = 'idle';
    } catch (e) {
      this.onSyncError(e);
    } finally {
      this.reading = null;
      this.busy = false;
      await this.persist().catch(() => {});
      this.publish();
    }
  }

  private onSyncError(e: unknown): void {
    if (!(e instanceof GggError)) {
      this.phase = 'down';
      this.message = 'Something went wrong while reading your stash.';
      return;
    }
    if (e.kind === 'expired') {
      this.phase = 'expired';
      this.message = 'Your Path of Exile session cookie expired. Paste a new one to keep syncing. Your data stays.';
    } else if (e.kind === 'rate-limited') {
      this.phase = 'rate-limited';
      this.resumesAt = this.now() + (e.retryAfterSec ?? 60) * 1000;
      this.message = `Waiting for GGG. Reading resumes in ${Math.round((e.retryAfterSec ?? 60))}s.`;
    } else if (e.kind === 'shape') {
      this.phase = 'down';
      this.message = e.message;
      this.downCount++;
      this.downUntil = this.now() + 5 * 60_000;
    } else if (e.kind === 'down') {
      this.phase = 'down';
      this.downCount++;
      const wait = Math.min(30 * 60_000, 2 * 60_000 * 2 ** Math.min(this.downCount - 1, 4));
      this.downUntil = this.now() + wait;
      this.message = `Path of Exile's API isn't responding${this.st.lastSyncAt ? '. Last good read ' + new Date(this.st.lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}. Retrying with backoff.`;
    } else {
      this.phase = 'down';
      this.message = e.message;
    }
  }

  /** Waits out a rate limit inside a read, then lets the caller retry. */
  private async waitFor(policy: 'stash' | 'characters', retryAfterSec: number): Promise<void> {
    this.phase = 'rate-limited';
    this.resumesAt = this.now() + retryAfterSec * 1000;
    this.publish();
    await this.sleep(retryAfterSec * 1000);
    this.resumesAt = null;
    this.phase = 'reading';
    void policy;
  }

  private async withRetry<T>(policy: 'stash' | 'characters', fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof GggError && e.kind === 'rate-limited' && i < 2 && (e.retryAfterSec ?? 60) <= 120) {
          await this.waitFor(policy, e.retryAfterSec ?? 60);
          continue;
        }
        throw e;
      }
    }
  }

  private pickLootTabs(): TabInfo[] {
    const counted = this.st.tabs.filter((t) => t.counted && t.readable);
    // The first counted tab (currency) always; then the tab that changed most recently; then the tab read longest
    // ago, so every counted tab is still looked at between full reads.
    const first = counted[0];
    const others = counted.filter((t) => t !== first);
    const mapTabIds = new Set(this.cache().rows.filter((r) => r.cat === 'map').flatMap((r) => r.tabIds));
    const mapTab = others.find((t) => mapTabIds.has(t.id));
    const changed = [...others].filter((t) => t !== mapTab).sort((a, b) => (this.st.tabChanged[b.id] ?? 0) - (this.st.tabChanged[a.id] ?? 0) || (this.cache().tabVals[b.id]?.value ?? 0) - (this.cache().tabVals[a.id]?.value ?? 0))[0];
    const stale = [...others].filter((t) => t !== changed).sort((a, b) => (this.st.tabRead[a.id] ?? 0) - (this.st.tabRead[b.id] ?? 0))[0];
    return [first, mapTab, changed, stale].filter((x): x is TabInfo => !!x).slice(0, MAX_LOOT_TABS);
  }

  private noteRead(tabId: string, items: GggItem[], t: number): void {
    const sig = (xs: GggItem[]) => xs.reduce((s, i) => s + (i.stackSize ?? 1), 0) + ':' + xs.length;
    const prev = this.stash.perTab[tabId];
    if (prev && sig(prev) !== sig(items)) this.st.tabChanged[tabId] = t;
    this.st.tabRead[tabId] = t;
  }

  private async read(kind: 'full' | 'loot'): Promise<void> {
    const t0 = this.now();
    const acct = this.st.account;
    const league = this.st.league;
    const perTab: Record<string, GggItem[]> = kind === 'full' ? {} : { ...this.stash.perTab };
    let targets: TabInfo[];

    if (kind === 'full') {
      let page0 = this.pendingPage0;
      this.pendingPage0 = null;
      if (!page0) {
        const p = await this.withRetry('stash', () => this.ggg.stashTab(acct, league, 0, true));
        page0 = { tabs: flattenTabs(p.tabs), items: p.items ?? [] };
      }
      this.mergeTabList(page0.tabs);
      targets = this.st.tabs.filter((x) => x.counted && x.readable);
      const t0tab = this.st.tabs.find((x) => x.index === 0);
      if (t0tab && t0tab.counted && t0tab.readable) {
        perTab[t0tab.id] = page0.items;
        this.noteRead(t0tab.id, page0.items, this.now());
      }
    } else {
      targets = this.pickLootTabs();
    }

    const toRead = targets.filter((x) => !(kind === 'full' && x.index === 0));
    const total = toRead.length + 1;
    let done = kind === 'full' ? 1 : 0;
    this.reading = { done, total, label: 'Reading your stash' };
    this.publish();
    const pre = kind === 'full' && this.pendingTabs && this.now() - this.pendingTabs.at < 10 * 60_000 ? this.pendingTabs.items : {};
    this.pendingTabs = null;
    for (const tab of toRead) {
      this.reading = { done, total, label: `Reading ${tab.name} · ${done} of ${total}` };
      this.publish();
      try {
        const p = pre[tab.id] ? { items: pre[tab.id] } : await this.withRetry('stash', () => this.ggg.stashTab(acct, league, tab.index, false));
        perTab[tab.id] = p.items ?? [];
        this.noteRead(tab.id, perTab[tab.id]!, this.now());
      } catch (e) {
        if (e instanceof GggError && e.kind === 'not-found') {
          tab.readable = false;
          tab.why = 'not readable';
        } else throw e;
      }
      done++;
    }

    // Characters: their inventories hold loot that has not reached a tab.
    this.reading = { done, total, label: 'Reading your characters' };
    this.publish();
    try {
      if (kind === 'full' || !this.st.characters.length) {
        const cs = await this.withRetry('characters', () => this.ggg.characters(acct));
        this.st.characters = (cs ?? []).filter((c: RawCharacter) => c.league === league).map((c) => ({ name: c.name, level: c.level, cls: c.class ?? '', league: c.league }));
      }
      this.st.privateProfile = false;
      for (const k of Object.keys(perTab)) if (k.startsWith('char:')) delete perTab[k];
      const top = [...this.st.characters].sort((a, b) => b.level - a.level).slice(0, 2);
      for (const c of top) {
        const r = await this.withRetry('characters', () => this.ggg.characterItems(acct, c.name));
        perTab[`char:${c.name}`] = (r.items ?? []).filter((i) => !i.inventoryId || i.inventoryId === 'MainInventory');
      }
    } catch (e) {
      if (e instanceof GggError && (e.kind === 'private' || e.kind === 'expired')) {
        // The stash read worked, so the cookie is fine: the profile is private. Tabs still count.
        this.st.privateProfile = true;
      } else if (e instanceof GggError && e.kind === 'not-found') {
        this.st.privateProfile = true;
      } else throw e;
    }

    this.stash = { t: t0, perTab };
    const t = this.now();
    this.st.lastSyncAt = t;
    if (kind === 'full') this.st.lastFullAt = t;
    this.st.lastLootAt = t;
    this.bump();
    const snap = this.snapshotNow(t);
    const nw = this.cache().nw;
    // Without prices every item reads as unpriced and the total as zero. That is a missing measurement, not a fact: nothing is recorded (no chart point, no session diff) until prices exist.
    // The same holds while a price fetch is running or has lost most of the book: item keys depend on which prices exist, so a half-loaded book would read as items spent and gained.
    this.bookPeak = Math.max(this.bookPeak, this.book.size);
    const priced = this.book.size > 0 && this.book.divine > 0 && !this.priceJob && this.book.size >= this.bookPeak * 0.5;
    const changed = priced ? this.tracker.onSnapshot(snap) : false;
    if (priced) this.series.push({ t, nw });
    this.checkGoal(nw);
    if (this.series.length > MAX_POINTS) this.series = this.series.filter((_, i) => i % 2 === 0 || i > this.series.length - 2000);
    void changed;
    await this.persistAll();
  }

  private mergeTabList(raw: RawTab[]): void {
    const prior = new Map(this.st.tabs.map((t) => [t.id, t]));
    this.st.tabs = raw.map((r) => {
      const p = prior.get(r.id);
      const why = unreadableReason(r);
      return {
        id: r.id,
        index: r.i,
        name: r.n,
        type: r.type,
        colour: tabColour(r),
        readable: !why && p?.why !== 'not readable',
        ...(why ? { why } : p?.why ? { why: p.why } : {}),
        counted: p ? p.counted && !why : defaultCounted(r),
        value: 0,
        items: 0,
      };
    });
  }

  // ---- renderer-facing actions -------------------------------------------------------------------------------

  async get(): Promise<WealthView> {
    await this.ready;
    return this.view();
  }

  async leagues(): Promise<string[]> {
    if (this.leaguesCache) return this.leaguesCache;
    const fallback = this.d.sample ? ['Allflame', 'Hardcore Allflame', 'Standard', 'Hardcore'] : ['Standard', 'Hardcore'];
    if (this.d.sample) return fallback;
    try {
      const f = this.d.fetchFn ?? fetch;
      const r = await f('https://www.pathofexile.com/api/leagues?type=main&compact=1', { headers: { 'User-Agent': `PathOfMastery/${this.d.version} (contact: https://pathofmastery.gg)` } });
      const j = (await r.json()) as { id: string }[];
      const ids = j.map((x) => x.id).filter((x) => !/SSF|Solo|Ruthless/i.test(x));
      this.leaguesCache = ids.length ? ids : fallback;
    } catch {
      this.leaguesCache = fallback;
    }
    return this.leaguesCache;
  }

  /**
   * The first visit's tab list shows how many items each tab holds. GGG gives that only by reading the tab, so each
   * readable tab is read once here (spaced by the limiter) and kept for the first snapshot, which then reads nothing twice.
   */
  /** How far the first count of the tabs has got, so the screen can fill in tab by tab instead of waiting for all of them. */
  countProgress(): { done: number; total: number; counts: Record<string, number>; waitMs: number; running: boolean } {
    const c = this.counting;
    return { done: c?.done ?? 0, total: c?.total ?? 0, counts: { ...(c?.counts ?? {}) }, waitMs: c?.running ? Math.max(0, this.limiter.waitTime('stash')) : 0, running: !!c?.running };
  }

  async countTabs(): Promise<Record<string, number>> {
    await this.ready;
    const out: Record<string, number> = {};
    this.counting = { done: 0, total: this.st.tabs.filter((t) => t.readable).length, counts: out, running: true };
    const kept: Record<string, GggItem[]> = {};
    const pieces = (xs: GggItem[]) => xs.reduce((a, i) => a + Math.max(1, i.stackSize ?? 1), 0);
    const first = this.pendingPage0;
    for (const tab of this.st.tabs) {
      if (!tab.readable) continue;
      try {
        let items: GggItem[];
        if (tab.index === 0 && first) items = first.items;
        else items = (await this.withRetry('stash', () => this.ggg.stashTab(this.st.account, this.st.league, tab.index, false))).items ?? [];
        out[tab.id] = pieces(items);
        kept[tab.id] = items;
      } catch {
        /* a tab that cannot be read just shows no count */
      }
      if (this.counting) this.counting.done++;
    }
    if (this.counting) this.counting.running = false;
    this.pendingTabs = { at: this.now(), items: kept };
    this.phase = 'idle';
    return out;
  }

  async connect(input: WealthConnectInput): Promise<{ ok: true; tabs: TabInfo[]; saved: boolean; account: string } | { ok: false; error: string; kind: string; retryAfterSec?: number }> {
    await this.ready;
    const account = input.account.trim();
    const cookie = input.poesessid.trim();
    if (!validAccountName(account)) return { ok: false, error: 'That does not look like an account name. It is the name on your pathofexile.com profile, like Name#1234.', kind: 'bad-input' };
    if (!this.d.sample && !/^[A-Za-z0-9%._-]{16,128}$/.test(cookie)) return { ok: false, error: 'That does not look like a POESESSID. It is a 32-character code from your browser cookies.', kind: 'bad-input' };
    await this.ensureLeague();
    const league = input.league || this.st.league;
    // While GGG's block is on, the request would sit in the rate limiter for the whole block with no word to the player.
    const until = this.ggg.resumesAt('stash');
    if (until !== null && until - this.now() > 3000) {
      const sec = Math.ceil((until - this.now()) / 1000);
      return { ok: false, error: `Path of Exile asked us to wait. You can connect again in ${sec} seconds.`, kind: 'rate-limited', retryAfterSec: sec };
    }
    const prevCookie = this.cookie;
    this.cookie = this.d.sample ? 'sample' : cookie;
    try {
      const p = await this.ggg.stashTab(account, league, 0, true);
      const tabs = flattenTabs(p.tabs);
      this.pendingPage0 = { tabs, items: p.items ?? [] };
      const sameAcct = this.st.account === account && this.st.league === league;
      const leagueChanged = !!this.st.league && this.st.league !== league;
      this.st.account = account;
      this.st.league = league;
      this.st.connected = true;
      if (!sameAcct) {
        this.st.tabs = [];
        this.stash = { t: 0, perTab: {} };
        this.st.lastFullAt = null;
        this.st.lastLootAt = null;
      }
      this.mergeTabList(tabs);
      const saved = this.d.sample ? true : await this.saveCookie(cookie);
      this.phase = 'idle';
      if (this.wantTimers) this.start();
      this.message = saved ? '' : 'Secure storage is not available on this PC, so the cookie is kept only until the app closes.';
      await this.persist();
      this.bump();
      // A different league has different prices: fetch them now instead of waiting for the next refresh.
      if (leagueChanged) {
        this.lastPriceAt = this.now();
        void this.refreshPrices();
      }
      return { ok: true, tabs: this.st.tabs.map((x) => ({ ...x })), saved, account };
    } catch (e) {
      this.cookie = prevCookie;
      if (e instanceof GggError) {
        const msg: Record<string, string> = {
          expired: 'Path of Exile did not accept that cookie. Copy a fresh POESESSID from your browser and try again.',
          'not-found': 'Path of Exile has no stash for that account and league. Check the account name and the league.',
          'rate-limited': `Path of Exile asked us to wait ${e.retryAfterSec ?? 60} seconds. Try again then.`,
          down: "Path of Exile's website did not answer. You may be offline: check your connection, then try again in a minute.",
          private: 'Path of Exile did not accept that cookie.',
        };
        return { ok: false, error: msg[e.kind] ?? e.message, kind: e.kind, ...(e.kind === 'rate-limited' ? { retryAfterSec: e.retryAfterSec ?? 60 } : {}) };
      }
      return { ok: false, error: 'Could not connect.', kind: 'down' };
    }
  }

  /** Whether a pathofexile.com session is connected, and for which account. Never the cookie. */
  gggAccount(): { connected: boolean; account: string } {
    return { connected: !!this.cookie && this.st.connected, account: this.st.account };
  }

  /** Connect through the sign-in window. The cookie goes from the window's partition straight into connect(): it is never returned. */
  async signIn(): ReturnType<WealthService['connect']> {
    await this.ready;
    if (!this.d.signIn) return { ok: false, error: 'Signing in through a window is not available here. Paste a cookie instead.', kind: 'no-window' };
    const r = await this.d.signIn.open();
    if (!r.ok) return { ok: false, error: r.message, kind: r.reason };
    const c = await this.connect({ account: r.account, poesessid: r.cookie });
    // The cookie now lives only encrypted in this app; the sign-in window's own store keeps it in clear, so empty it.
    if (c.ok) await this.d.signIn.clear().catch(() => undefined);
    return c;
  }

  /** Logs out: stops the background timers, forgets the session cookie and the sign-in window's cookies. Snapshots, sessions and history stay. */
  async disconnect(): Promise<void> {
    await this.ready;
    this.stop();
    await this.d.signIn?.clear().catch(() => undefined);
    await this.dropCookie();
    this.st.connected = false;
    this.phase = 'not-connected';
    this.message = '';
    await this.persist();
    this.publish();
  }

  async setCounted(ids: string[]): Promise<WealthView> {
    await this.ready;
    const on = new Set(ids);
    for (const t of this.st.tabs) t.counted = t.readable && on.has(t.id);
    this.bump();
    await this.persist();
    // Re-count what we already hold; the next read fetches any tab that was just switched on.
    const missing = this.st.tabs.some((t) => t.counted && t.readable && !(t.id in this.stash.perTab));
    this.publish();
    if (missing && this.st.connected && !this.busy) this.st.lastFullAt = null;
    return this.view();
  }

  async firstSnapshot(): Promise<WealthView> {
    await this.ready;
    this.st.lastFullAt = null;
    await this.sync('full');
    if (this.phase === 'idle' && this.st.lastSyncAt) {
      const kinds = this.cache().rows.length;
      this.addInbox({ kind: 'snapshot', title: 'First snapshot saved', body: `${kinds} kinds of item read from ${this.st.tabs.filter((t) => t.counted && t.readable).length} tabs. Net worth updates every 2 minutes.`, go: { sub: 'overview' } });
      await this.persist().catch(() => undefined);
      this.publish();
    }
    return this.view();
  }

  async syncNow(): Promise<void> {
    await this.ready;
    if (this.phase === 'expired' || !this.st.connected) return;
    this.downUntil = 0;
    const t = this.now();
    // A full read is allowed every 30 minutes. In between, "sync now" reads the busiest tabs.
    await this.sync(!this.st.lastFullAt || t - this.st.lastFullAt >= FULL_SYNC_MS ? 'full' : 'loot');
  }

  async startSession(name: string, strategyId?: string): Promise<void> {
    await this.ready;
    this.tracker.startManual(this.now(), name.trim() || 'Session', strategyId);
    await this.persistAll();
    this.publish();
  }

  async endSession(): Promise<void> {
    await this.ready;
    if (this.tracker.end(this.now())) {
      await this.persistAll();
      this.publish();
    }
  }

  /** Runs the player deleted this launch, so Undo can bring one back. */
  private deleted = new Map<string, Run>();

  async deleteSession(id: string): Promise<void> {
    await this.ready;
    const copy = this.tracker.find(id);
    if (copy) this.deleted.set(id, structuredClone(copy));
    if (this.tracker.remove(id)) {
      await this.persistAll();
      this.publish();
    }
  }

  /** Undo for deleteSession. False when it was not deleted this launch or the slot it needs is taken. */
  async restoreSession(id: string): Promise<boolean> {
    await this.ready;
    const run = this.deleted.get(id);
    if (!run || !this.tracker.restore(run)) return false;
    this.deleted.delete(id);
    await this.persistAll();
    this.publish();
    return true;
  }

  async renameSession(id: string, name: string): Promise<void> {
    await this.ready;
    const r = this.tracker.find(id);
    if (!r || !name.trim()) return;
    r.name = name.trim();
    r.custom = true;
    await this.persistAll();
    this.publish();
  }

  async markTransfer(id: string, key: string, on: boolean): Promise<void> {
    await this.ready;
    const r = this.tracker.find(id);
    if (!r) return;
    for (const m of [r.gained, r.spent]) if (m[key]) m[key]!.transfer = on || undefined;
    await this.persistAll();
    this.publish();
  }

  async publishSession(id: string): Promise<void> {
    await this.ready;
    const r = this.tracker.find(id);
    if (!r) return;
    r.published = true;
    await this.persistAll();
    this.publish();
  }

  async setFav(id: string, on: boolean): Promise<void> {
    await this.ready;
    if (on) this.st.favs[id] = true;
    else delete this.st.favs[id];
    await this.persist();
    this.publish();
  }

  async setGoal(key: string | null): Promise<void> {
    await this.ready;
    this.st.goal = key;
    this.st.goalHit = null;
    await this.persist();
    this.publish();
  }

  private alertPct(): number {
    const p = this.st.alertPct;
    return typeof p === 'number' && p > 0 ? p : 1;
  }

  async setAlertPct(pct: number): Promise<void> {
    await this.ready;
    if (!Number.isFinite(pct) || pct <= 0) return;
    this.st.alertPct = Math.min(100, Math.round(pct * 10) / 10);
    await this.persist();
    this.publish();
  }

  async setAlert(key: string, on: boolean): Promise<void> {
    await this.ready;
    if (on) {
      const m = this.marketRows().find((r) => r.key === key);
      if (m) this.st.alerts[key] = m.chaos;
    } else delete this.st.alerts[key];
    await this.persist();
    this.publish();
  }

  // ---- market and strategies ---------------------------------------------------------------------------------

  /** GGG's exchange quote for a name, only for currency-like lines (the exchange trades nothing else). */
  private cxQuote(name: string, line?: { cat: string }): CxQuote | undefined {
    if (line && !['cur', 'frag', 'scar', 'card', 'ess'].includes(line.cat)) return undefined;
    const g = this.book.cxFor(name);
    return g ? { chaos: g.chaos, divine: g.divine, volume: g.volume, at: g.at } : undefined;
  }

  marketRows(): MarketRow[] {
    const out: MarketRow[] = [];
    const seen = new Set<string>();
    for (const l of this.book.all()) {
      let ok = false;
      let name = l.name;
      let variant: string | undefined;
      if (l.cat === 'cur' || l.cat === 'frag' || l.cat === 'scar' || l.cat === 'card' || l.cat === 'ess') ok = true;
      else if (l.cat === 'uniq' && !l.links && l.type !== 'UniqueMap') {
        // One row per unique: its cheapest version, labelled when that version has a variant.
        const cheapest = this.book.lines(l.name).filter((x) => x.cat === 'uniq' && !x.links).sort((a, b) => a.chaos - b.chaos)[0];
        if (cheapest !== l) continue;
        ok = true;
        if (l.variant) variant = `Cheapest version: ${l.variant}`;
      }
      else if (l.cat === 'gem' && l.variant === '20/20') {
        ok = true;
        variant = 'Level 20 · 20% quality';
      }
      if (!ok) continue;
      const key = `${l.cat}|${name}${variant ? '|' + variant : ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, lineId: lineIdOf(l), kind: l.type, name, cat: l.cat, chaos: l.chaos, spark: l.spark, ...(l.listings !== undefined ? { listings: l.listings } : {}), art: l.art, ...(l.artCat ? { artCat: l.artCat } : {}), ...(l.baseType ? { base: l.baseType } : {}), ...(variant ? { variant } : {}), ...(this.cxQuote(name, l) ? { cx: this.cxQuote(name, l) as CxQuote } : {}) });
    }
    return out;
  }

  async market(): Promise<MarketRow[]> {
    await this.ready;
    return this.marketRows();
  }

  private std = new Map<string, { book: PriceBook; at: number }>();

  /** What the same item costs in the Standard league, from poe.ninja (one request per category, kept for an hour). Null when Standard has no line for it. */
  async standardPrice(key: string): Promise<{ chaos: number | null; divine: number; at: number; failed?: boolean }> {
    await this.ready;
    const leagueDivine = this.book.divine || 370;
    const row = this.marketRows().find((r) => r.key === key);
    const mine = row ? this.book.lines(row.name).filter((l) => l.cat === row.cat).sort((a, b) => a.chaos - b.chaos)[0] : undefined;
    if (!row || !mine || !this.feed.fetchCategory) return { chaos: null, divine: leagueDivine, at: this.now(), failed: true };
    const load = async (type: string): Promise<{ book: PriceBook; at: number } | null> => {
      let hit = this.std.get(type);
      if (!hit || this.now() - hit.at > 3600_000) {
        const book = new PriceBook();
        if (!(await this.feed.fetchCategory!(book, type, 'Standard'))) return null;
        hit = { book, at: this.now() };
        this.std.set(type, hit);
      }
      return hit;
    };
    const hit = await load(mine.type);
    // A Standard chaos figure is only meaningful against Standard's own chaos-per-divine rate, which the Currency category carries.
    const rate = mine.type === 'Currency' ? hit : await load('Currency');
    if (!hit || !rate || !(rate.book.divine > 0)) return { chaos: null, divine: leagueDivine, at: this.now(), failed: true };
    const cands = hit.book.lines(row.name).filter((l) => l.cat === row.cat && (row.cat !== 'uniq' || !l.links)).sort((a, b) => a.chaos - b.chaos);
    return { chaos: cands[0]?.chaos ?? null, divine: rate.book.divine, at: hit.at };
  }

  async strategies(): Promise<StrategyView[]> {
    await this.ready;
    const c = this.cache();
    const byName = new Map<string, number>();
    for (const r of c.rows) byName.set(r.name, (byName.get(r.name) ?? 0) + r.qty);
    const runs = [...this.tracker.state.closed];
    const index = (await this.communityIndex?.get(this.st.league)) ?? null;
    return CURATED.map((d) => {
      const v = priceStrategy(d, { book: this.book, have: (n) => byName.get(n) ?? 0, runs });
      const r = index?.find((x) => x.strategyId === d.id);
      return r ? { ...v, community: { players: r.players, sessions: r.sessions, medianPerHour: r.medianDivinePerHour, verified: r.verified } } : v;
    });
  }

  async upgradeView(buildKey: string, xml: string) {
    await this.ready;
    return this.premium.upgradeView(buildKey, xml);
  }
  async upgradePrefs(patch: Parameters<Premium['setPrefs']>[0]) {
    await this.ready;
    return this.premium.setPrefs(patch);
  }
  async upgradeWatched() {
    await this.ready;
    return this.premium.watched();
  }
  async upgradeScan(input: Parameters<Premium['scan']>[0]) {
    await this.ready;
    return this.premium.scan(input);
  }
  async upgradeRule(buildKey: string, slot: string, patch: Parameters<Premium['setRule']>[2]) {
    await this.ready;
    return this.premium.setRule(buildKey, slot, patch);
  }
  async upgradeDismiss(buildKey: string, slot: string, key: string, why: 'base' | 'price') {
    await this.ready;
    return this.premium.dismiss(buildKey, slot, key, why);
  }

  /** The trade site's "Travel to Hideout" for one listing; falls back to copying the whisper. `cont` sends it again after "in demand". */
  async travelToListing(listing: TradeListing, cont = false): Promise<TravelResult> {
    await this.ready;
    return travelToHideout({ api: this.tradeApi, now: this.now, copy: (t) => this.d.copyText?.(t) }, listing, !!cont);
  }

  categoryNames(): typeof CAT_NAMES {
    return CAT_NAMES;
  }
}

