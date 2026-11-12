import { clampMult, SELLERS_TO_SHOW, sellerCount, type BulkListing, type BulkView } from '../../shared/bulk.js';
import type { BoardBackend } from './communityStrategies.js';
import type { Cat } from '../../shared/wealth.js';

export interface PostInput {
  cat: Cat;
  items: { name: string; qty: number }[];
  marketChaos: number;
  mult: number;
  /** The name this listing is posted under (chosen per listing). The account name when left out. */
  seller?: string;
}

export type BoardResult = { ok: true } | { ok: false; error: string };

/** Where Bulk board listings live. The real one is the Supabase backend (needs an account, project down: #4); the sample one is in memory. */
export interface BoardFeed {
  view(): Promise<BulkView>;
  post(i: PostInput): Promise<BoardResult>;
  vouch(id: string): Promise<BoardResult>;
  report(id: string): Promise<BoardResult>;
  offer(id: string, mult: number): Promise<BoardResult>;
  remove(id: string): Promise<BoardResult>;
}

const NEEDS = 'The Bulk board needs a Path of Mastery account.';

export class NeedsAccountFeed implements BoardFeed {
  async view(): Promise<BulkView> {
    return { status: 'needs-account', listings: [] };
  }
  private no = async (..._a: unknown[]): Promise<BoardResult> => ({ ok: false, error: NEEDS });
  post = this.no;
  vouch = this.no;
  report = this.no;
  offer = this.no;
  remove = this.no;
}

const ME = 'Kaelen#4821';
const H = 3600_000;
/** [seller, minutes since last online, category, lot, mult %, hours since posted, vouches] */
const SEED: [string, number, Cat, [string, number, number][], number, number, number][] = [
  ['Tyrel#1102', 1, 'cur', [['Divine Orb', 40, 377]], 98, 0.4, 12],
  ['Mirabel#7731', 2, 'scar', [['Gilded Breach Scarab', 120, 14], ['Polished Sulphite Scarab', 60, 9]], 92, 1.5, 31],
  ['Odd_Yoke#3390', 3, 'cur', [['Exalted Orb', 300, 9]], 101, 2, 5],
  ['Sable#0458', 90, 'ess', [['Deafening Essence of Greed', 80, 6]], 95, 3.5, 2],
  ['Quillon#5517', 4, 'frag', [["Timeless Karui Splinter", 800, 0.5], ['Simulacrum Splinter', 600, 0.8]], 105, 5, 18],
  ['Hexwright#2209', 200, 'cur', [['Orb of Annulment', 60, 38]], 90, 7, 0],
  ['Brann#8841', 6, 'card', [['The Doctor', 3, 1100]], 103, 9, 44],
  ['Lysa#6023', 1, 'scar', [['Horned Scarab of Bloodlines', 30, 55]], 96, 10, 9],
];

/** The made-up examples (not from players). */
export const sampleListings = (t: number): BulkListing[] =>
  SEED.map(([seller, mins, cat, lot, mult, hrs, vouches], i) => ({
    id: `s${i}`,
    seller,
    lastOnlineAt: t - mins * 60_000,
    cat,
    items: lot.map(([name, qty]) => ({ name, qty })),
    marketChaos: lot.reduce((a, [, q, u]) => a + q * u, 0),
    mult,
    postedAt: t - hrs * H,
    vouches,
    reporters: [],
  }));

export class SampleBoardFeed implements BoardFeed {
  private list: BulkListing[];
  private n = 0;
  constructor(
    private now: () => number,
    private divine: () => number,
  ) {
    this.list = sampleListings(now());
  }

  async view(): Promise<BulkView> {
    const t = this.now();
    // The signed-in seller is online while the app is open.
    const listings = this.list.map((l) => (l.mine ? { ...l, lastOnlineAt: t } : l));
    return { status: 'ready', sample: true, me: ME, divine: this.divine(), listings };
  }

  private find(id: string) {
    return this.list.find((l) => l.id === id);
  }

  async post(i: PostInput): Promise<BoardResult> {
    if (!i.items.length || i.marketChaos <= 0) return { ok: false, error: 'Nothing priced to post.' };
    const t = this.now();
    this.list.unshift({ id: `m${++this.n}`, seller: ME, lastOnlineAt: t, cat: i.cat, items: i.items, marketChaos: i.marketChaos, mult: clampMult(i.mult), postedAt: t, vouches: 0, reporters: [], mine: true, offers: [{ id: `o${this.n}`, from: 'Corvin#9015', mult: clampMult(i.mult - 4), at: t }] });
    return { ok: true };
  }

  async vouch(id: string): Promise<BoardResult> {
    const l = this.find(id);
    if (!l || l.mine) return { ok: false, error: 'You cannot vouch for this listing.' };
    if (!l.voted) {
      l.vouches++;
      l.voted = 'vouch';
    }
    return { ok: true };
  }

  async report(id: string): Promise<BoardResult> {
    const l = this.find(id);
    if (!l || l.mine) return { ok: false, error: 'You cannot report this listing.' };
    if (!l.reporters.includes(ME)) l.reporters.push(ME);
    l.voted = 'report';
    return { ok: true };
  }

  async offer(id: string, mult: number): Promise<BoardResult> {
    const l = this.find(id);
    if (!l || l.mine) return { ok: false, error: 'Offers go to other sellers.' };
    // Offers are seen by the seller only; in the sample nobody else is listening, so this only checks the range.
    clampMult(mult);
    return { ok: true };
  }

  async remove(id: string): Promise<BoardResult> {
    const i = this.list.findIndex((l) => l.id === id && l.mine);
    if (i < 0) return { ok: false, error: 'That is not your listing.' };
    this.list.splice(i, 1);
    return { ok: true };
  }
}

const plain = (e: unknown): string => (e instanceof Error ? e.message : 'Could not reach the Bulk board.');

/** The real board: listings of players using the app, kept on the community backend. Made-up examples appear only apart, as "Sample listings". */
export class CloudBoardFeed implements BoardFeed {
  constructor(
    private readonly c: BoardBackend,
    private readonly league: () => Promise<string> | string,
    private readonly divine: () => number,
    private readonly now: () => number,
  ) {}

  async view(): Promise<BulkView> {
    let rows;
    try {
      rows = await this.c.bulk.view((await this.league()) || 'Standard');
    } catch (e) {
      return { status: 'unavailable', listings: [], error: plain(e) };
    }
    // The signed-in player's listings stay alive while the app is open.
    if (this.c.signedIn()) void this.c.bulk.heartbeat().catch(() => undefined);
    const listings: BulkListing[] = rows.map((r) => ({
      id: r.id,
      seller: r.seller,
      lastOnlineAt: r.lastOnlineAt,
      cat: r.cat as BulkListing['cat'],
      items: r.items,
      marketChaos: r.marketChaos,
      mult: r.mult,
      postedAt: r.postedAt,
      vouches: r.vouches,
      reporters: [],
      ...(r.mine ? { mine: true, offers: r.offers } : {}),
      ...(r.voted ? { voted: r.voted } : {}),
    }));
    const t = this.now();
    return { status: 'ready', sample: false, me: this.c.userName(), divine: this.divine(), listings, sampleListings: sellerCount(listings, t) < SELLERS_TO_SHOW ? sampleListings(t) : [] };
  }

  private async run(f: () => Promise<void>): Promise<BoardResult> {
    try {
      await f();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: plain(e) };
    }
  }

  async post(i: PostInput): Promise<BoardResult> {
    if (!this.c.signedIn()) return { ok: false, error: 'Sign in to post to the Bulk board.' };
    const seller = (i.seller ?? '').trim() || this.c.userName();
    if (seller.length < 2) return { ok: false, error: 'Give the listing a name of at least 2 characters.' };
    if (!i.items.length || !(i.marketChaos > 0)) return { ok: false, error: 'Nothing priced to post.' };
    const league = (await this.league()) || 'Standard';
    return this.run(() => this.c.bulk.post({ league, seller, cat: i.cat, items: i.items, marketChaos: i.marketChaos, mult: clampMult(i.mult) }));
  }
  vouch(id: string): Promise<BoardResult> {
    return this.run(() => this.c.bulk.vote(id, 'vouch'));
  }
  report(id: string): Promise<BoardResult> {
    return this.run(() => this.c.bulk.vote(id, 'report'));
  }
  offer(id: string, mult: number): Promise<BoardResult> {
    return this.run(() => this.c.bulk.offer(id, clampMult(mult), this.c.userName() || 'Player'));
  }
  remove(id: string): Promise<BoardResult> {
    return this.run(() => this.c.bulk.remove(id));
  }
}
