/**
 * Types and small helpers shared by the Wealth service (main process), the preload bridge and the Wealth screens.
 * Plain data only. All money is in chaos orbs; the divine rate travels with every view so the screens never guess it.
 */

import type { TradeListing, TravelResult, UpgradePrefs, TradeFailure, TradeStatus, UpgradeScanInput, UpgradeView, WatchedBuild, WatchRule } from './wealthTrade.js';
import { emptyTradeStatus } from './wealthTrade.js';
import type { CallEntry, Diagnostic } from './wealthDiag.js';
import type { BulkView } from './bulk.js';

export type Cat = 'cur' | 'frag' | 'scar' | 'map' | 'rare' | 'uniq' | 'card' | 'ess' | 'gem' | 'other';

export const CAT_NAMES: Record<Cat, string> = {
  cur: 'Currency',
  frag: 'Fragments',
  scar: 'Scarabs',
  map: 'Maps',
  rare: 'Rares',
  uniq: 'Uniques',
  card: 'Divination',
  ess: 'Essences',
  gem: 'Gems',
  other: 'Everything else',
};

/** The current challenge league: the first listed league that is not Standard, Hardcore, SSF or Ruthless. Standard when there is none. */
export function pickLeague(ids: string[]): string {
  return ids.find((x) => !/Standard|Hardcore|SSF|Solo|Ruthless/i.test(x)) ?? 'Standard';
}

/** "12.4 div" for a big number, "340c" for a small one: the same rule the design uses. */
export function fmtChaos(c: number, divine: number): string {
  if (!Number.isFinite(c)) return '—';
  const a = Math.abs(c);
  if (a >= divine * 0.2) return `${(c / divine).toFixed(1)} div`;
  // Under one chaos the price is a fraction, not zero: "0.4c", never "0c".
  if (a > 0 && a < 1) return a < 0.01 ? (c < 0 ? '−' : '') + '<0.01c' : `${Number(c.toFixed(a < 0.1 ? 2 : 1))}c`;
  return `${Math.round(c).toLocaleString('en-US')}c`;
}

/** The Market's Standard price line. While the ask is out it is blank, and says "Checking…" only once `slow` (a DelayedFlag)
 *  turns on: a cached or quick answer goes straight from blank to the price, never flashing "Checking…" for a frame or two. */
export function standardPriceText(sel: { key: string } | null | undefined, std: { key: string; chaos: number | null; divine: number; failed?: boolean } | null, slow: boolean): string {
  // The ask just before failed (poe.ninja not reachable): the new one is shown the same until it answers, so "Not available" does not blink out for the frames in between.
  if (sel && std?.failed && std.key !== sel.key) return 'Not available';
  if (!sel || !std || std.key !== sel.key) return slow ? 'Checking…' : '';
  return std.chaos !== null ? fmtChaos(std.chaos, std.divine) : std.failed ? 'Not available' : 'Not listed';
}

export function fmtSigned(c: number, divine: number): string {
  return (c >= 0 ? '+' : '−') + fmtChaos(Math.abs(c), divine);
}

/** Percentage with a real minus sign, like "+12%" or "−3%". */
export function fmtPct(v: number): string {
  const p = Math.round(v * 100);
  return p === 0 ? '0%' : (p > 0 ? '+' : '−') + Math.abs(p) + '%';
}

export function fmtAge(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

/** How long ago, as a sentence part: "just now", "1 min ago", "2 h ago", "yesterday", "3 d ago". Never "just now ago". */
export function fmtAgo(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  if (h < 48) return 'yesterday';
  return `${Math.floor(h / 24)} d ago`;
}

/** "4 min old", or "fetched just now" (never "just now old"). */
export function fmtOld(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'fetched just now';
  if (m < 60) return `${m} min old`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h old`;
  if (h < 48) return 'a day old';
  return `${Math.floor(h / 24)} d old`;
}

/** Whole-number percentages of `values` that add up to exactly 100 (largest remainder), so a breakdown never reads 99 or 101. */
export function sharesOf(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return values.map(() => 0);
  const exact = values.map((v) => (v / total) * 100);
  const out = exact.map(Math.floor);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i]!++;
    left--;
  }
  return out;
}

/** Always hours and minutes, like the design's session list ("0h 34m"). */
export function fmtHM(min: number): string {
  const m = Math.max(0, Math.round(min));
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtDuration(min: number): string {
  const m = Math.max(0, Math.round(min));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

// ---- stash tabs and sync ---------------------------------------------------------------------------------------

export interface TabInfo {
  id: string;
  index: number;
  name: string;
  type: string;
  /** CSS colour from the tab's own colour in the game. */
  colour: string;
  readable: boolean;
  /** Why it is not counted or readable ("paused by GGG", "not in the API"). */
  why?: string;
  counted: boolean;
  /** Value of what is in it at the last read, in chaos. */
  value: number;
  items: number;
}

export type SyncPhase = 'not-connected' | 'idle' | 'reading' | 'rate-limited' | 'expired' | 'down' | 'paused';

export interface SyncStatus {
  phase: SyncPhase;
  connected: boolean;
  /** True while the sample stash (dev switch) stands in for the real account. */
  sample: boolean;
  account: string;
  league: string;
  lastSyncAt: number | null;
  /** When the next full read is due. */
  nextFullAt: number | null;
  nextLootAt: number | null;
  reading: { done: number; total: number; label: string } | null;
  resumesAt: number | null;
  message: string;
  /** The characters could not be read (profile is private). Tabs still count. */
  privateProfile: boolean;
}

/** GGG's official Currency Exchange price for one currency in the player's league. */
export interface CxQuote {
  /** Chaos orbs per unit: the volume-weighted mid of the hour's lowest and highest ratio over the newest hours. */
  chaos: number;
  /** Divine orbs per unit. Null when the league had no divine/chaos market in those hours. */
  divine: number | null;
  /** Units traded in the hours the price is read from. */
  volume: number;
  /** End of the newest hourly digest used, epoch ms. */
  at: number;
}

export interface CxStatus {
  ok: boolean;
  message: string;
  /** Newest digest end, epoch ms. */
  at: number | null;
  /** Hourly digests stored for the league. */
  hours: number;
  loading: boolean;
}

export interface PriceStatus {
  source: string;
  fetchedAt: number | null;
  /** Oldest category in the book. */
  oldestAt: number | null;
  ok: boolean;
  message: string;
  lines: number;
  /** A fetch is running now. */
  loading: boolean;
  /** Categories fetched so far, while loading. */
  progress: { done: number; total: number } | null;
  /** A fetch finished and failed, so the error banner may show. False before the first fetch ends. */
  failed: boolean;
}

// ---- items -------------------------------------------------------------------------------------------------------

export interface StashRow {
  key: string;
  name: string;
  base?: string;
  /** What tells it from others of the same name ("21/20 corrupted", "6 links", "Tier 16"). */
  variant?: string;
  /** The price line this row is priced from, the same id Market rows carry. Null when unpriced. */
  lineId: string | null;
  cat: Cat;
  qty: number;
  /** Low-end unit price in chaos, null when nothing prices this item. */
  unit: number | null;
  /** High end when the price is a range. */
  hi: number | null;
  priced: 'exact' | 'range' | 'none';
  why?: string;
  tabIds: string[];
  /** 7-day price history, oldest first, in chaos. Empty when there is none. */
  spark: number[];
  /** Name to look the art up by. */
  art: string;
  artCat?: string;
  maxStack: number;
  listings?: number;
  source: string;
  /** Epoch ms of the price this row uses. */
  priceAt: number | null;
  /** GGG's currency exchange price for the same item, when it has one. Shown beside poe.ninja's, or alone when poe.ninja has none. */
  cx?: CxQuote;
}

export interface NetPoint {
  t: number;
  nw: number;
}

export interface SessionItem {
  key: string;
  name: string;
  cat: Cat;
  qty: number;
  value: number;
  art: string;
  artCat?: string;
  transfer?: boolean;
}

export interface SessionView {
  id: string;
  name: string;
  /** The name the player gave, if any. */
  custom: boolean;
  start: number;
  end: number;
  running: boolean;
  manual: boolean;
  minutes: number;
  revenue: number;
  cost: number;
  net: number;
  /** Net chaos per hour. */
  perHour: number;
  mapsUsed: number;
  snapshots: number;
  gained: SessionItem[];
  spent: SessionItem[];
  /** Value added per snapshot interval, in chaos (signed). */
  bars: { t: number; v: number }[];
  /** "Trade" and "Check this" notes. */
  flags: string[];
  strategyId?: string;
  published?: boolean;
  /** Art for the session list: what was used up most, else what came in most. */
  icon: { name: string; cat: Cat; artCat?: string };
}

export interface MarketRow {
  key: string;
  /** The price line this row shows, so owned items match it exactly and never by name alone. */
  lineId: string;
  /** poe.ninja type of the line ("UniqueWeapon", "ForbiddenJewel"): the item class a picture is chosen by when the item has none. */
  kind?: string;
  name: string;
  cat: Cat;
  chaos: number;
  spark: number[];
  listings?: number;
  art: string;
  artCat?: string;
  base?: string;
  variant?: string;
  /** GGG's currency exchange price for this item, when it trades there. */
  cx?: CxQuote;
}

/** One line in the bell: kept on disk, so it survives a restart, until the player clears it. */
export interface InboxEntry {
  id: string;
  at: number;
  kind: 'price' | 'goal' | 'upgrade' | 'snapshot';
  title: string;
  body: string;
  /** Where the entry's button goes: the screen, what to select there, and (upgrade matches) which build's watch list. */
  go?: { sub: string; patch?: Record<string, unknown>; build?: string };
}

export interface WealthView {
  sync: SyncStatus;
  prices: PriceStatus;
  /** The GGG currency exchange feed (second price source). */
  cx?: CxStatus;
  /** Chaos orbs per divine orb. */
  divine: number;
  tabs: TabInfo[];
  rows: StashRow[];
  /** Total of everything counted, priced items only (low end). */
  networth: number;
  unpriced: number;
  unpricedCount: number;
  series: NetPoint[];
  sessions: SessionView[];
  running: SessionView | null;
  goal: string | null;
  alerts: Record<string, number>;
  /** Percent a price must move before its alert fires; default 1. */
  alertPct: number;
  favs: Record<string, boolean>;
  /** Sharing finished strategy sessions with the community index: the player's switch, whether they are signed in, and whether the app can reach the backend at all. */
  community: { share: boolean; signedIn: boolean; available: boolean };
  mine: StrategyView[];
  tags: Record<string, string>;
  characters: { name: string; level: number; cls: string; league: string }[];
  /** Net chaos per hour over the last 7 days of sessions. */
  rate7d: number;
  /** The bell, newest first. */
  inbox: InboxEntry[];
  /** How many entries arrived since the bell was last opened. */
  inboxUnread: number;
  /** The trade site: idle, busy, waiting for a rate limit, cookie refused, down. */
  trade: TradeStatus;
  /** Answers the app did not recognise, newest last: copyable, names only. */
  diag: Diagnostic[];
  now: number;
}

export interface StrategyLine {
  /** poe.ninja line name (an exact item name). */
  name: string;
  /** Quantity per map. */
  perMap: number;
}

export interface StrategyDef {
  id: string;
  name: string;
  tags: string[];
  difficulty: 'Easy' | 'Medium' | 'Hard';
  map: string;
  mapNote: string;
  avoid: string;
  needs: string;
  note: string;
  mapsPerHour: number;
  scarabs: StrategyLine[];
  device: StrategyLine[];
  loot: StrategyLine[];
  atlas: { n: string; kind: 'keystone' | 'notable' | 'node' | 'mastery' }[];
  atlasPoints: string;
  /** The yields above are estimates by the app's author until sessions confirm them. */
  source: string;
}

export interface StrategyView extends StrategyDef {
  mine?: boolean;
  /** Where the numbers come from: the author's estimate, or the player's own sessions. */
  basis: 'estimate' | 'measured';
  sessionsUsed: number;
  /** Per hour, in chaos. */
  revenue: number;
  cost: number;
  net: number;
  costPerMap: number;
  /** 7-day price history of the net per map, oldest first, chaos. */
  spark: number[];
  scarabRows: { name: string; perMap: number; unit: number | null; have: number; art: string; artCat?: string }[];
  deviceRows: { name: string; perMap: number; unit: number | null; have: number; art: string; artCat?: string }[];
  lootRows: { name: string; perMap: number; perHour: number; art: string; artCat?: string }[];
  /** Items missing for 10 maps, valued. */
  missing: number;
  yours: { perHour: number; sessions: number } | null;
  unpriced: string[];
  /** The community index for this strategy: different players besides the app author who shared sessions. Absent when nobody has, or the index could not be read. */
  community?: { players: number; sessions: number; medianPerHour: number; verified: boolean };
}

export interface GoalInfo {
  key: string;
}

export const emptyView = (): WealthView => ({
  sync: {
    phase: 'not-connected',
    connected: false,
    sample: false,
    account: '',
    league: '',
    lastSyncAt: null,
    nextFullAt: null,
    nextLootAt: null,
    reading: null,
    resumesAt: null,
    message: '',
    privateProfile: false,
  },
  prices: { source: 'poe.ninja', fetchedAt: null, oldestAt: null, ok: false, message: 'Prices have not loaded yet.', lines: 0, loading: false, progress: null, failed: false },
  divine: 370,
  tabs: [],
  rows: [],
  networth: 0,
  unpriced: 0,
  unpricedCount: 0,
  series: [],
  sessions: [],
  running: null,
  goal: null,
  alerts: {},
  alertPct: 1,
  favs: {},
  community: { share: false, signedIn: false, available: false },
  mine: [],
  tags: {},
  characters: [],
  inbox: [],
  inboxUnread: 0,
  rate7d: 0,
  trade: emptyTradeStatus(),
  diag: [],
  now: Date.now(),
});

export interface WealthConnectInput {
  account: string;
  poesessid: string;
  league?: string;
}

export interface WealthTabPick {
  ids: string[];
}

export interface WealthApi {
  get(): Promise<WealthView>;
  market(): Promise<MarketRow[]>;
  /** The same item's price in the Standard league (poe.ninja), or null when Standard has no line for it. */
  /** `divine` is Standard's own chaos per divine: a Standard price shown in divines uses it, never the league's rate. */
  standardPrice(key: string): Promise<{ chaos: number | null; divine: number; at: number; failed?: boolean }>;
  strategies(): Promise<StrategyView[]>;
  /** Saves the cookie in the OS keychain, checks it with one read and lists the tabs. */
  connect(input: WealthConnectInput): Promise<{ ok: true; tabs: TabInfo[]; saved: boolean; account: string } | { ok: false; error: string; kind: string; retryAfterSec?: number }>;
  /** Opens the Path of Exile sign-in window. The cookie never reaches the renderer: this returns the tab list only. */
  signIn(): Promise<{ ok: true; tabs: TabInfo[]; saved: boolean; account: string } | { ok: false; error: string; kind: string; retryAfterSec?: number }>;
  disconnect(): Promise<void>;
  setCounted(ids: string[]): Promise<WealthView>;
  /** First snapshot after connecting. Resolves when the first read is saved. */
  firstSnapshot(): Promise<WealthView>;
  syncNow(): Promise<void>;
  /** Asks poe.ninja for prices again (the Retry on the no-prices message). */
  retryPrices(): Promise<void>;
  /** Items held per tab id, for the first visit's tab list (reads each readable tab once). */
  countTabs(): Promise<Record<string, number>>;
  /** Progress of that count: tabs done, tabs to do, the counts so far, and how long until the next read is allowed. */
  countProgress(): Promise<{ done: number; total: number; counts: Record<string, number>; waitMs: number; running: boolean }>;
  /** Marks the bell read. */
  readInbox(): Promise<void>;
  /** Empties the bell. */
  clearInbox(): Promise<void>;
  /** Removes one entry from the bell. */
  removeInbox(id: string): Promise<void>;
  startSession(name: string, strategyId?: string): Promise<void>;
  endSession(): Promise<void>;
  deleteSession(id: string): Promise<void>;
  /** Undo for deleteSession (this launch only). False when it cannot be put back. */
  restoreSession(id: string): Promise<boolean>;
  renameSession(id: string, name: string): Promise<void>;
  markTransfer(id: string, key: string, on: boolean): Promise<void>;
  publishSession(id: string): Promise<void>;
  setFav(id: string, on: boolean): Promise<void>;
  /** Turns sharing of finished strategy sessions (strategy, hours, maps, net divine per hour) on or off. */
  setShareSessions(on: boolean): Promise<void>;
  setGoal(key: string | null): Promise<void>;
  setAlert(key: string, on: boolean): Promise<void>;
  /** Sets the percent a price must move before an alert fires (default 1). */
  setAlertPct(pct: number): Promise<void>;
  /** The connection check: each real call, its status, the rate-limit headers and what the limiter decided. */
  connection(): Promise<{ calls: CallEntry[]; diagnostics: Diagnostic[]; text: string }>;
  upgradeView(buildKey: string, xml: string): Promise<UpgradeView>;
  /** Builds that have been checked before, for the watch list. */
  upgradeWatched(): Promise<WatchedBuild[]>;
  upgradeScan(input: UpgradeScanInput): Promise<{ ok: true; view: UpgradeView } | TradeFailure | { ok: false; kind: 'engine'; message: string }>;
  upgradeRule(buildKey: string, slot: string, patch: Partial<WatchRule>): Promise<void>;
  upgradePrefs(patch: Partial<UpgradePrefs>): Promise<void>;
  upgradeDismiss(buildKey: string, slot: string, key: string, why: 'base' | 'price'): Promise<void>;
  /** Travel to the seller's hideout like the trade site's button; copies the whisper when that cannot work. */
  travelToListing(listing: TradeListing, cont?: boolean): Promise<TravelResult>;
  boardView(): Promise<BulkView>;
  boardPost(i: { cat: Cat; items: { name: string; qty: number }[]; marketChaos: number; mult: number; seller?: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  boardVouch(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  boardReport(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  boardOffer(id: string, mult: number): Promise<{ ok: true } | { ok: false; error: string }>;
  boardRemove(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  onChange(cb: (v: WealthView) => void): () => void;
  onAlert(cb: (msg: string) => void): () => void;
  leagues(): Promise<string[]>;
  /** Asks where to save, then writes the file. Resolves to the path, or null when cancelled. */
  exportCsv(name: string, text: string): Promise<string | null>;
}

/**
 * What the player holds of one Market row. A row is one price line (a gem at 20/20, a unique's cheapest version), so a
 * stash row counts only when it is priced from that very line. Other things with the same name (a level 21 corrupted
 * gem, a 6-linked unique) are not that item: they come back as `others`, never merged into the count.
 */
export function ownedOf(rows: StashRow[], m: Pick<MarketRow, 'lineId' | 'name' | 'cat'>): { qty: number; value: number; others: { qty: number; value: number; kinds: number }; versions: OwnedVersion[] } {
  const out = { qty: 0, value: 0, others: { qty: 0, value: 0, kinds: 0 }, versions: [] as OwnedVersion[] };
  for (const r of rows) {
    // The very line is the very item, whatever its stash name; other things of the same name are other versions.
    const exact = r.lineId !== null && r.lineId === m.lineId;
    if (!exact && (r.name !== m.name || r.cat !== m.cat)) continue;
    const value = (r.unit ?? 0) * r.qty;
    out.versions.push({ label: r.cat === 'gem' ? (r.base ?? r.variant ?? '') : (r.variant ?? r.base ?? ''), qty: r.qty, value, exact });
    if (exact) {
      out.qty += r.qty;
      out.value += value;
    } else {
      out.others.qty += r.qty;
      out.others.value += value;
      out.others.kinds++;
    }
  }
  out.versions.sort((a, b) => Number(b.exact) - Number(a.exact) || b.value - a.value);
  return out;
}

export interface OwnedVersion {
  /** "Level 21 · 23% quality · corrupted", "6 links", or empty for the plain item. */
  label: string;
  qty: number;
  value: number;
  /** Priced from the Market row's own line. */
  exact: boolean;
}

/** A priced stash row as a Market row of its own: the version the player holds that Market's list does not show. */
export function marketRowOfStash(r: StashRow): MarketRow {
  const label = r.cat === 'gem' ? (r.base ?? r.variant) : (r.variant ?? r.base);
  return {
    key: `own|${r.key}`,
    lineId: r.lineId ?? r.key,
    name: r.name,
    cat: r.cat,
    chaos: r.unit ?? 0,
    spark: r.spark,
    ...(r.listings !== undefined ? { listings: r.listings } : {}),
    art: r.art,
    ...(r.artCat ? { artCat: r.artCat } : {}),
    ...(r.base && r.cat !== 'gem' ? { base: r.base } : {}),
    ...(label ? { variant: `${label} · yours` } : { variant: 'Yours' }),
  };
}

/**
 * The rows Market lists: its own price lines, plus a row for each priced version the player holds that none of them
 * shows, so that "In my stash only" (every owned row) and a search (every owned version of what was searched) are complete.
 */
export function marketRowsFor(market: MarketRow[], stash: StashRow[], opts: { q: string; owned: boolean }): MarketRow[] {
  const q = opts.q.trim().toLowerCase();
  if (!opts.owned && !q) return market;
  const shown = new Set(market.map((m) => m.lineId));
  const extra = stash.filter((r) => r.lineId !== null && r.unit !== null && !shown.has(r.lineId) && (opts.owned || r.name.toLowerCase().includes(q))).map(marketRowOfStash);
  // Two stash rows on one line (a unique with and without links) are one Market row.
  const seen = new Set<string>();
  return [...market, ...extra.filter((e) => (seen.has(e.lineId) ? false : (seen.add(e.lineId), true)))];
}

export interface CompareLine {
  label: string;
  /** What the session did. Null when the session has too little to say (no maps counted). */
  yours: number | null;
  /** What the strategy expects. */
  expected: number;
  /** yours minus expected, null when yours is. */
  diff: number | null;
  unit: 'chaos' | 'items' | 'maps';
}

/**
 * A session set against a strategy's expected figures: net per hour, cost per map, items gained per map and maps per
 * hour. Everything per map needs the session's map count; with none it says null instead of guessing.
 */
export function compareSession(session: Pick<SessionView, 'minutes' | 'perHour' | 'cost' | 'mapsUsed' | 'gained'>, st: Pick<StrategyView, 'net' | 'costPerMap' | 'mapsPerHour' | 'lootRows'>): CompareLine[] {
  const maps = session.mapsUsed;
  const hours = session.minutes / 60;
  const gainedQty = session.gained.filter((g) => !g.transfer).reduce((a, g) => a + g.qty, 0);
  const line = (label: string, yours: number | null, expected: number, unit: CompareLine['unit']): CompareLine => ({ label, yours, expected, diff: yours === null ? null : yours - expected, unit });
  return [
    line('Net per hour', session.perHour, st.net, 'chaos'),
    line('Cost per map', maps > 0 ? session.cost / maps : null, st.costPerMap, 'chaos'),
    line('Items gained per map', maps > 0 ? gainedQty / maps : null, st.lootRows.reduce((a, r) => a + r.perMap, 0), 'items'),
    line('Maps per hour', maps > 0 && hours > 0 ? maps / hours : null, st.mapsPerHour, 'maps'),
  ];
}

/** The GGG currency exchange line for a detail panel: its price, how old it is and how much traded behind it. `fmt` prints a chaos amount. */
export function cxText(q: CxQuote, now: number, fmt: (chaos: number) => string): string {
  return `${fmt(q.chaos)} · ${fmtOld(now - q.at)}${q.volume > 0 ? ` · ${Math.round(q.volume).toLocaleString()} traded` : ''}`;
}
