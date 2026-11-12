/**
 * Journey's reads of pathofexile.com (DESIGN.md 4.3). One sync is get-items plus get-passive-skills: 2 hits on the shared
 * `characters` rate policy. Journey takes at most half of every window and never waits in the limiter's queue ahead of
 * Wealth: with no room it skips, and the next trigger tries again.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CharacterRow, Realm } from '../../shared/characterImport.js';
import type { CharacterLink } from '../../shared/journey/types.js';
import { GggError } from '../wealth/ggg.js';
import type { WindowFetch } from '../character/api.js';

export interface LimiterView {
  limitsFor(policy: string): { max: number; period: number; restrict: number }[];
  waitTime(policy: string): number;
}

const POLICY = 'characters';
/** A hit may wait this long for the limiter's own spacing between two requests, and no longer. */
const MAX_GAP_WAIT_MS = 2500;

export interface BudgetRow {
  used: number;
  max: number;
  window: number;
}

/** Journey's own count of hits against half of every learned window. */
export class JourneyBudget {
  private sent: number[] = [];
  constructor(
    private readonly limiter: LimiterView,
    private readonly now: () => number,
  ) {}

  /** Half of each window, rounded down. */
  caps(): { cap: number; period: number }[] {
    return this.limiter.limitsFor(POLICY).map((l) => ({ cap: Math.floor(l.max / 2), period: l.period }));
  }

  private inWindow(period: number): number {
    const t = this.now() - period * 1000;
    return this.sent.filter((s) => s > t).length;
  }

  snapshot(): BudgetRow[] {
    return this.caps().map((c) => ({ used: this.inWindow(c.period), max: c.cap, window: c.period }));
  }

  /** True when `n` more hits stay inside half of every window. */
  room(n: number): boolean {
    return this.caps().every((c) => this.inWindow(c.period) + n <= c.cap);
  }

  /** The limiter's queue is empty enough that a hit does not wait behind anyone. */
  free(maxWaitMs = 0): boolean {
    return this.limiter.waitTime(POLICY) <= maxWaitMs;
  }

  /** Epoch ms when `n` hits fit again by our own count, or null when they fit now. */
  nextRoomAt(n: number): number | null {
    const now = this.now();
    let at = now;
    for (const c of this.caps()) {
      const win = c.period * 1000;
      const live = this.sent.filter((s) => s > now - win).sort((a, b) => a - b);
      const excess = live.length + n - c.cap;
      if (excess > 0) at = Math.max(at, (live[excess - 1] ?? now) + win);
    }
    const wait = this.limiter.waitTime(POLICY);
    if (wait > 0) at = Math.max(at, now + wait);
    return at > now ? at : null;
  }

  record(): void {
    const t = this.now();
    this.sent.push(t);
    const horizon = Math.max(0, ...this.caps().map((c) => c.period)) * 1000;
    if (horizon > 0) this.sent = this.sent.filter((s) => s > t - horizon);
  }

  /** The fetch every Journey read goes through: counted, and refused when it would wait behind others. */
  counted(win: WindowFetch): WindowFetch {
    return async (path, query, cookie) => {
      this.record();
      return win(path, query, cookie);
    };
  }
}

export interface SyncSnapshot {
  at: number;
  character: { name: string; cls: string; level: number; league: string };
  items: Record<string, unknown>;
  passives: Record<string, unknown>;
  /** The passive tree as node hashes (hashes plus the cluster and mastery-free extras). */
  hashes: number[];
}

export type SyncReason = 'link' | 'town' | 'checkpoint' | 'open' | 'manual';

export type SyncOutcome =
  | { kind: 'synced'; snapshot: SyncSnapshot }
  | { kind: 'skipped'; why: string; nextAt: number | null }
  | { kind: 'log-only'; why: string }
  | { kind: 'failed'; why: string; nextAt: number };

export interface CharSyncDeps {
  win: WindowFetch;
  /** True when a session cookie is held and signed in. */
  hasCookie: () => boolean;
  budget: JourneyBudget;
  now: () => number;
  /** userData/journey/live: a snapshot per character, so Journey opens from the cache at once. */
  cacheDir?: string;
}

const BASE_BACKOFF_MS = 3 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

const enc = (s: string): string => encodeURIComponent(s);
const accountQuery = (account: string): string => account.replace(/#/g, '%23').replace(/ /g, '%20');

function parseJson(body: string): Record<string, unknown> {
  if (body.trim() === 'false') throw new GggError('shape', 'Path of Exile gave no data for that character.');
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    throw new GggError('shape', 'The answer was not data.');
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new GggError('shape', 'The answer was not data.');
  return j as Record<string, unknown>;
}

export class CharSync {
  private lastAt: number | null = null;
  private backoffMs = 0;
  private blockedUntil = 0;
  private dead: string | null = null;
  private busy: Promise<SyncOutcome> | null = null;
  private lastSnapshot: SyncSnapshot | null = null;

  constructor(private readonly d: CharSyncDeps) {}

  /** Why Journey has dropped to log-only, or null. */
  logOnlyReason(): string | null {
    if (!this.d.hasCookie()) return 'No Path of Exile session: connect in Wealth to read gear.';
    return this.dead;
  }
  lastSyncAt(): number | null {
    return this.lastAt;
  }
  snapshot(): SyncSnapshot | null {
    return this.lastSnapshot;
  }
  /** After the player reconnects in Wealth the session is trusted again. */
  clearDead(): void {
    this.dead = null;
  }
  /** Epoch ms when a sync may go, or null when now. */
  nextAllowedAt(): number | null {
    const now = this.d.now();
    let at = this.blockedUntil;
    const room = this.d.budget.nextRoomAt(2);
    if (room) at = Math.max(at, room);
    return at > now ? at : null;
  }
  budgetRows(): BudgetRow[] {
    return this.d.budget.snapshot();
  }

  private cacheFile(realm: Realm, character: string): string | null {
    return this.d.cacheDir ? join(this.d.cacheDir, `${realm}-${character.replace(/[^\w.-]/g, '_')}.json`) : null;
  }

  async loadCache(link: CharacterLink): Promise<SyncSnapshot | null> {
    const f = this.cacheFile(link.realm, link.character);
    if (!f) return null;
    try {
      const s = JSON.parse(await readFile(f, 'utf8')) as SyncSnapshot;
      if (typeof s.at !== 'number' || !Array.isArray(s.hashes)) return null;
      this.lastSnapshot = s;
      this.lastAt = s.at;
      return s;
    } catch {
      return null;
    }
  }

  private async saveCache(link: CharacterLink, s: SyncSnapshot): Promise<void> {
    const f = this.cacheFile(link.realm, link.character);
    if (!f) return;
    try {
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f + '.tmp', JSON.stringify(s), 'utf8');
      await rename(f + '.tmp', f);
    } catch {
      // a failed cache write costs nothing but a re-read
    }
  }

  /** One sync, coalesced: a second call while one runs returns the same run. */
  sync(link: CharacterLink, reason: SyncReason): Promise<SyncOutcome> {
    if (this.busy) return this.busy;
    this.busy = this.run(link, reason).finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private async run(link: CharacterLink, _reason: SyncReason): Promise<SyncOutcome> {
    void _reason;
    const lo = this.logOnlyReason();
    if (lo) return { kind: 'log-only', why: lo };
    const now = this.d.now();
    if (this.blockedUntil > now) return { kind: 'skipped', why: 'Waiting after an error.', nextAt: this.blockedUntil };
    if (!this.d.budget.room(2)) return { kind: 'skipped', why: 'Journey has used its half of the character reads.', nextAt: this.d.budget.nextRoomAt(2) };
    if (!this.d.budget.free(0)) return { kind: 'skipped', why: 'Another part of the app is reading characters.', nextAt: this.d.budget.nextRoomAt(2) };
    const win = this.d.budget.counted(this.d.win);
    const q = { accountName: accountQuery(link.account), character: enc(link.character), realm: link.realm };
    try {
      const items = parseJson(await win('/character-window/get-items', q, true));
      // the second hit waits at most for the limiter's own spacing
      if (!this.d.budget.free(MAX_GAP_WAIT_MS)) return { kind: 'failed', why: 'The second read had to wait behind other reads, so it was dropped.', nextAt: this.fail() };
      const passives = parseJson(await win('/character-window/get-passive-skills', q, true));
      const ch = (items.character ?? {}) as Partial<CharacterRow>;
      const hashes = Array.isArray(passives.hashes) ? (passives.hashes as unknown[]).map(Number).filter(Number.isFinite) : [];
      const snap: SyncSnapshot = {
        at: this.d.now(),
        character: { name: ch.name ?? link.character, cls: ch.class ?? '', level: typeof ch.level === 'number' ? ch.level : 0, league: ch.league ?? '' },
        items,
        passives,
        hashes,
      };
      this.lastAt = snap.at;
      this.lastSnapshot = snap;
      this.backoffMs = 0;
      this.blockedUntil = 0;
      await this.saveCache(link, snap);
      return { kind: 'synced', snapshot: snap };
    } catch (e) {
      if (e instanceof GggError) {
        if (e.kind === 'expired') {
          this.dead = 'Your Path of Exile session expired: reconnect in Wealth.';
          return { kind: 'log-only', why: this.dead };
        }
        if (e.kind === 'private') {
          this.dead = 'Profile is private: your own characters need the session cookie.';
          return { kind: 'log-only', why: this.dead };
        }
        return { kind: 'failed', why: e.kind === 'rate-limited' ? 'Path of Exile asked us to slow down.' : e.message, nextAt: this.fail(e.retryAfterSec) };
      }
      return { kind: 'failed', why: e instanceof Error ? e.message : String(e), nextAt: this.fail() };
    }
  }

  /** The interval doubles from 3 min up to 30 min (a 429 also keeps the limiter's own block). */
  private fail(retryAfterSec?: number): number {
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs ? this.backoffMs * 2 : BASE_BACKOFF_MS);
    const wait = Math.max(this.backoffMs, (retryAfterSec ?? 0) * 1000);
    this.blockedUntil = this.d.now() + wait;
    return this.blockedUntil;
  }
}

/** One get-characters hit for the link dialog. Not the profile page: the account name comes from the Wealth session. */
export async function listCharacterRows(win: WindowFetch, realm: Realm, account: string): Promise<CharacterRow[]> {
  const body = await win('/character-window/get-characters', { accountName: accountQuery(account), realm }, true);
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    throw new GggError('shape', 'The character list was not data.');
  }
  if (!Array.isArray(j)) throw new GggError('shape', 'The character list was not data.');
  const rows: CharacterRow[] = [];
  for (const r of j as Record<string, unknown>[]) {
    if (!r || typeof r.name !== 'string') continue;
    rows.push({
      name: r.name,
      league: typeof r.league === 'string' ? r.league : '?',
      class: typeof r.class === 'string' ? r.class : '?',
      ...(typeof r.classId === 'number' ? { classId: r.classId } : {}),
      level: typeof r.level === 'number' ? r.level : 0,
      realm: typeof r.realm === 'string' && (r.realm === 'xbox' || r.realm === 'sony' || r.realm === 'pc') ? (r.realm as Realm) : realm,
    });
  }
  return rows;
}
