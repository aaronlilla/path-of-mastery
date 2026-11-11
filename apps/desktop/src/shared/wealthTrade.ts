/**
 * Types and small helpers for the trade-backed Wealth features (Upgrade watch). Plain data only:
 * the main process fills them from pathofexile.com's trade search and the engine, the renderer draws them.
 *
 * Shapes follow what the trade site's `fetch` endpoint returns (`result[]` entries of `{ id, listing, item }`), which
 * is GGG's Item object plus a listing. Exact field presence is not verified until a real cookie has been used.
 */

export type TradePhase = 'idle' | 'busy' | 'waiting' | 'expired' | 'down' | 'no-cookie';

export interface TradeStatus {
  phase: TradePhase;
  /** When the trade site may be asked again, while waiting. */
  resumesAt: number | null;
  message: string;
  lastOkAt: number | null;
  /** Requests sent to the trade site since the app started. */
  requests: number;
  /** The sample trade site (dev switch) stands in for pathofexile.com. */
  sample: boolean;
}

export const emptyTradeStatus = (): TradeStatus => ({ phase: 'idle', resumesAt: null, message: '', lastOkAt: null, requests: 0, sample: false });

export interface TradeProperty {
  name: string;
  values: [string, number][];
  displayMode?: number;
  type?: number;
}

/** GGG's Item object, the fields the app reads. */
export interface TradeItem {
  id?: string;
  name: string;
  typeLine: string;
  baseType?: string;
  /** 0 normal, 1 magic, 2 rare, 3 unique, 9 relic. */
  frameType: number;
  rarity?: string;
  ilvl?: number;
  icon?: string;
  identified?: boolean;
  corrupted?: boolean;
  fractured?: boolean;
  synthesised?: boolean;
  mirrored?: boolean;
  duplicated?: boolean;
  influences?: Record<string, boolean>;
  properties?: TradeProperty[];
  requirements?: TradeProperty[];
  sockets?: { group: number; attr?: string; sColour: string }[];
  enchantMods?: string[];
  implicitMods?: string[];
  explicitMods?: string[];
  craftedMods?: string[];
  fracturedMods?: string[];
  scourgeMods?: string[];
  crucibleMods?: string[];
  mutatedMods?: string[];
  flavourText?: string[];
  stackSize?: number;
  maxStackSize?: number;
  inventoryId?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  league?: string;
  note?: string;
}

export interface TradePrice {
  amount: number;
  /** The trade site's currency id, like "chaos", "divine" or "exalted". */
  currency: string;
}

export interface TradeListing {
  /** The listing id the fetch endpoint answered with. */
  id: string;
  /** ISO time the listing was indexed (the site's own clock). */
  indexed: string;
  price: TradePrice | null;
  /** Price in chaos orbs from the price book; null when the currency has no price line. */
  chaos: number | null;
  /** The currency could not be priced from the book (shown as the seller's own price). */
  seller: string;
  online: boolean;
  /** The whisper text the site offers. Copied to the clipboard on the player's click; never sent. */
  whisper: string;
  /** The site's signed token for "Travel to Hideout" (a JWT with an exp claim). Empty when the listing offers none. */
  hideoutToken?: string;
  /** The search that returned this listing, needed to fetch it again for a fresh token. */
  queryId?: string;
  item: TradeItem;
}

/** What a click on "Travel to hideout" did. `copied` is the whisper that was put on the clipboard as the fallback. */
export interface TravelResult {
  ok: boolean;
  /** One short line for a toast or notification. */
  text: string;
  /** The seller said the item is in demand; sending again with continue goes anyway. */
  inDemand?: boolean;
  copied?: boolean;
}

const NL = String.fromCharCode(10);

/** Text of the desktop alert for a new upgrade. Short enough that Windows does not cut it off. */
export function upgradeAlertText(a: { item: string; price: string; rankLabel: string; pct: number | null; hasHideoutToken: boolean }): { title: string; body: string } {
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
  const pct = a.pct === null ? null : Number((a.pct * 100).toFixed(1));
  const worth = pct === null ? `better than yours (${a.rankLabel})` : `${pct >= 0 ? '+' : ''}${pct}% ${a.rankLabel} over yours`;
  return {
    title: clip(`Upgrade found: ${a.item}`, 60),
    body: clip(`${a.price} · ${worth}`, 56) + NL + (a.hasHideoutToken ? 'CLICK TO TELEPORT' : 'CLICK TO COPY WHISPER'),
  };
}

export interface TradeSearchOutcome {
  queryId: string;
  /** Matches on the site. */
  total: number;
  listings: TradeListing[];
  /** Epoch ms the answer came from the site (or from the 5 minute cache). */
  at: number;
  cached: boolean;
  /** The search link the player can open in a browser. */
  link: string;
}

export const TRADE_ERROR_KINDS = ['expired', 'rate-limited', 'down', 'bad-query', 'no-cookie'] as const;
export type TradeErrorKind = (typeof TRADE_ERROR_KINDS)[number];

export interface TradeFailure {
  ok: false;
  kind: TradeErrorKind;
  message: string;
  /** Seconds until a retry is allowed, for a rate limit. */
  retryAfterSec?: number;
}

export type TradeResult<T> = ({ ok: true } & T) | TradeFailure;

// ---- prices ------------------------------------------------------------------------------------------------------

/** Trade-site currency ids and the poe.ninja line each is priced from. "chaos" is the unit itself. */
export const TRADE_CURRENCY: Record<string, { name: string; short: string }> = {
  chaos: { name: 'Chaos Orb', short: 'c' },
  divine: { name: 'Divine Orb', short: 'div' },
  exalted: { name: 'Exalted Orb', short: 'ex' },
  mirror: { name: 'Mirror of Kalandra', short: 'mirror' },
  alch: { name: 'Orb of Alchemy', short: 'alch' },
  vaal: { name: 'Vaal Orb', short: 'vaal' },
  chrome: { name: 'Chromatic Orb', short: 'chrome' },
  jewellers: { name: "Jeweller's Orb", short: 'jeweller' },
  fusing: { name: 'Orb of Fusing', short: 'fuse' },
  chance: { name: 'Orb of Chance', short: 'chance' },
  scour: { name: 'Orb of Scouring', short: 'scour' },
  regret: { name: 'Orb of Regret', short: 'regret' },
  gcp: { name: "Gemcutter's Prism", short: 'gcp' },
  alt: { name: 'Orb of Alteration', short: 'alt' },
  aug: { name: 'Orb of Augmentation', short: 'aug' },
  transmute: { name: 'Orb of Transmutation', short: 'transmute' },
  blessed: { name: 'Blessed Orb', short: 'blessed' },
  annul: { name: 'Orb of Annulment', short: 'annul' },
  ancient: { name: 'Ancient Orb', short: 'ancient' },
  regal: { name: 'Regal Orb', short: 'regal' },
  bauble: { name: "Glassblower's Bauble", short: 'bauble' },
  wisdom: { name: 'Scroll of Wisdom', short: 'wisdom' },
  portal: { name: 'Portal Scroll', short: 'portal' },
};

/** What the seller asked, in their own words: "4 divine", "30 chaos". */
export function sellerPrice(p: TradePrice | null): string {
  if (!p) return 'No price';
  const c = TRADE_CURRENCY[p.currency];
  const amount = Number.isInteger(p.amount) ? String(p.amount) : String(Math.round(p.amount * 100) / 100);
  return `${amount} ${c ? c.short.replace(/^c$/, 'chaos').replace(/^div$/, 'divine') : p.currency}`;
}

/** Minutes since the listing was indexed; null when the time did not parse. */
/** The trade site's own "listed within" option the assistant and the upgrade scan search with, and the same limit in minutes. */
export const FRESH_LISTED = '1week';
export const FRESH_MAX_MIN = 7 * 24 * 60;

/** True for a seller who is online and a listing indexed within the last week (the site's filters, checked again on what came back). */
export function isFreshListing(l: { online: boolean; indexed: string }, now: number): boolean {
  const age = listingAgeMin(l.indexed, now);
  return l.online && age !== null && age <= FRESH_MAX_MIN;
}

export function listingAgeMin(indexed: string, now: number): number | null {
  const t = Date.parse(indexed);
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 60000)) : null;
}

/** Minutes as the player says them: "just now", "1 minute ago", "3 hours ago" (never "1 minutes ago"). */
export function agoText(min: number): string {
  if (min < 1) return 'just now';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const h = Math.round(min / 60);
  return `${h} hour${h === 1 ? '' : 's'} ago`;
}

// ---- Upgrade watch -----------------------------------------------------------------------------------------------

/** A calculated change in one stat, straight from the engine. */
export interface StatGain {
  statId: string;
  label: string;
  before: number;
  after: number;
  /** after - before. */
  delta: number;
  /** Relative change, 0.068 for +6.8%. Null when the stat was zero before. */
  pct: number | null;
  /** Written the way the app writes this stat. */
  shown: string;
}

export interface UpgradeCandidate {
  /** Stable key: the listing id. */
  key: string;
  slot: string;
  listing: TradeListing;
  /** Item text in upstream format the engine calculated. */
  itemText: string;
  /** The ranking stat's change, from the engine. */
  main: StatGain | null;
  ehp: StatGain | null;
  /** Other stats that moved most, in the app's stat order. */
  others: StatGain[];
  /** Every figure above is the engine's; the price is the listing's, converted with the price book. */
  priceChaos: number | null;
  /** Gain per divine: the ranking stat's percent gain divided by the price in divines (price floored at 1 chaos). Null when unpriced or no gain. */
  score: number | null;
  /** Why it was held back: it breaks a hard requirement. */
  held: string | null;
  overBudget: number | null;
  sold: boolean;
  /** How many listings were this same item (same name, base and modifiers); only the cheapest is kept. Absent when one. */
  copies?: number;
}

export interface SlotScan {
  slot: string;
  /** Name of the item in the slot now. */
  equipped: string;
  equippedBase: string;
  at: number;
  /** The search link for the slot's rule. */
  link: string;
  total: number;
  checked: number;
  candidates: UpgradeCandidate[];
  /** The ranking stat (FullDPS, or CombinedDPS, or TotalEHP) and its value now. */
  rankStat: string;
  rankLabel: string;
  rankNow: number | null;
  /** The slot's rule in plain words, for the list. */
  rule: string;
  error?: { kind: string; message: string };
}

export interface WatchRule {
  /** Smallest gain in the ranking stat, as a percent, that counts as a match. */
  minGainPct: number;
  /** Most the player will pay for this slot, in divine. Null means no limit. */
  budgetDiv: number | null;
  /** Hold back anything that uncaps a capped resistance. */
  keepResists: boolean;
  /** Base types the player said no to. */
  badBases: string[];
  /** Pause: the slot is not scanned. */
  off: boolean;
}

export const defaultRule = (): WatchRule => ({ minGainPct: 3, budgetDiv: null, keepResists: true, badBases: [], off: false });

export interface UpgradeScanInput {
  /** The build the scan is for: its file text and a stable key. */
  buildXml: string;
  buildKey: string;
  name: string;
  /** Slots to scan; all equipped slots when absent. */
  slots?: string[];
  /** Ranking choice: damage or defence. */
  rank?: 'dps' | 'ehp';
  /** Listings to fetch per slot, up to 10. */
  limit?: number;
}

export interface BuildSlotInfo {
  slot: string;
  name: string;
  base: string;
  rarity: string;
}

/** One checked build in the watch list: its slots, each slot's rule and its count of open matches. */
export interface WatchedBuild {
  key: string;
  slots: { slot: string; rule: WatchRule; matches: number }[];
}

export interface UpgradeView {
  slots: BuildSlotInfo[];
  rules: Record<string, WatchRule>;
  scans: Record<string, SlotScan>;
  /** Epoch ms of the last scan of this build. */
  scannedAt: number | null;
  /** Background checks: the player's two switches and what the poller is doing. */
  prefs: UpgradePrefs;
  poll: { state: 'off' | 'no-cookie' | 'idle' | 'on' | 'backoff'; nextAt: number | null; message: string };
}

export interface UpgradePrefs {
  /** Check the watched builds every 10 minutes while the app runs. */
  poll: boolean;
  /** Also raise a desktop notification when a background check finds an upgrade. */
  os: boolean;
}
