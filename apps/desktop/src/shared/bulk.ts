/**
 * Bulk board: listings that bulk sellers post from the Sell dialog and buyers answer with a whisper or an offer.
 * The rules here: online status comes from the app being open, a listing
 * expires 12 hours after its seller was last online, and two independent reports hide it pending review.
 */
import type { Cat } from './wealth.js';

export const EXPIRES_MS = 12 * 3600_000;
/** A listing seen online this recently counts as online. */
export const ONLINE_MS = 5 * 60_000;
/** Independent reports (different reporters) that hide a listing. */
export const REPORTS_TO_HIDE = 2;
/** The board is not offered in the nav until this many sellers have a live listing. */
export const SELLERS_TO_SHOW = 5;
export const MULT_MIN = 50;
export const MULT_MAX = 150;

export interface BulkOffer {
  id: string;
  from: string;
  /** Percent of market the buyer offers. */
  mult: number;
  at: number;
}

export interface BulkListing {
  id: string;
  seller: string;
  /** When the seller's app was last open (online status is "now minus this"). */
  lastOnlineAt: number;
  cat: Cat;
  items: { name: string; qty: number }[];
  /** What the lot is worth at market, in chaos, when it was posted. */
  marketChaos: number;
  /** Percent of market the seller asks. */
  mult: number;
  postedAt: number;
  vouches: number;
  /** Who reported it (one entry per reporter). */
  reporters: string[];
  /** True for the signed-in player's own listings. */
  mine?: boolean;
  /** Offers on a listing, seen by its seller only. */
  offers?: BulkOffer[];
  /** True when the signed-in player already vouched for or reported it. */
  voted?: 'vouch' | 'report';
}

export type BulkView =
  /** Community listings live on the backend: no account, no board. */
  | { status: 'needs-account'; listings: [] }
  | {
      status: 'ready';
      sample: boolean;
      me: string;
      divine: number;
      /** Listings from players using the app. */
      listings: BulkListing[];
      /** Made-up examples, shown apart under "Sample listings" while fewer than SELLERS_TO_SHOW real sellers have a live listing. Never mixed with `listings`. */
      sampleListings?: BulkListing[];
    }
  /** The backend could not be reached. */
  | { status: 'unavailable'; listings: []; error: string };

export const askChaos = (l: Pick<BulkListing, 'marketChaos' | 'mult'>): number => (l.marketChaos * l.mult) / 100;
export const isOnline = (l: Pick<BulkListing, 'lastOnlineAt'>, now: number): boolean => now - l.lastOnlineAt <= ONLINE_MS;
export const isExpired = (l: Pick<BulkListing, 'lastOnlineAt'>, now: number): boolean => now - l.lastOnlineAt > EXPIRES_MS;
export const isHidden = (l: Pick<BulkListing, 'reporters'>): boolean => new Set(l.reporters).size >= REPORTS_TO_HIDE;

/** Listings anyone can see: not expired, not hidden by reports. A seller always sees their own. */
export const live = (ls: BulkListing[], now: number): BulkListing[] => ls.filter((l) => l.mine || (!isExpired(l, now) && !isHidden(l)));

export const sellerCount = (ls: BulkListing[], now: number): number => new Set(live(ls, now).filter((l) => !l.mine).map((l) => l.seller)).size;

/** Whether the nav offers the board: enough other sellers are using it. */
export const boardOpen = (ls: BulkListing[], now: number): boolean => sellerCount(ls, now) >= SELLERS_TO_SHOW;

export type BulkSort = 'new' | 'price' | 'deal';

export interface BulkFilter {
  q: string;
  cat: Cat | 'all';
  onlineOnly: boolean;
  sort: BulkSort;
}

export function filterListings(ls: BulkListing[], f: BulkFilter, now: number): BulkListing[] {
  const q = f.q.trim().toLowerCase();
  const out = live(ls, now).filter(
    (l) =>
      !l.mine &&
      (f.cat === 'all' || l.cat === f.cat) &&
      (!f.onlineOnly || isOnline(l, now)) &&
      (!q || l.seller.toLowerCase().includes(q) || l.items.some((i) => i.name.toLowerCase().includes(q))),
  );
  // Online sellers first within any order, so the first row is someone who can answer.
  const by: Record<BulkSort, (a: BulkListing, b: BulkListing) => number> = {
    new: (a, b) => b.postedAt - a.postedAt,
    price: (a, b) => askChaos(a) - askChaos(b),
    deal: (a, b) => a.mult - b.mult,
  };
  return out.sort((a, b) => Number(isOnline(b, now)) - Number(isOnline(a, now)) || by[f.sort](a, b));
}

export const clampMult = (n: number): number => Math.min(MULT_MAX, Math.max(MULT_MIN, Math.round(Number.isFinite(n) ? n : 100)));

/** The lot in words: the first few items, then how many more. */
export function lotSummary(items: { name: string; qty: number }[], max = 3): string {
  const head = items.slice(0, max).map((i) => `${i.qty.toLocaleString('en-US')}x ${i.name}`).join(', ');
  return items.length > max ? `${head} and ${items.length - max} more` : head;
}

/** The line a buyer pastes into the game: whisper to the seller about the lot at the listed price. */
export function whisper(l: BulkListing, divine: number): string {
  const lot = lotSummary(l.items);
  const c = askChaos(l);
  const price = c >= divine * 0.2 ? `${(c / divine).toFixed(1)} divine` : `${Math.round(c)} chaos`;
  return `@${l.seller.split('#')[0]} Hi, I would like to buy your ${lot} listed on Path of Mastery for ${price} (${l.mult}% of market).`;
}
