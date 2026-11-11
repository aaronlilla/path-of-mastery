/**
 * pathofexile.com character-window reads (stash tabs, characters, character items).
 *
 * The player's POESESSID is sent only to www.pathofexile.com and nowhere else. It is never put in a URL, a log line or
 * an error message. Every request goes through the shared rate limiter, which learns the limits from the response
 * headers. Endpoints are undocumented and can change; exact tab-entry fields are not verified until a real cookie is used.
 */
import type { GggItem } from './priceBook.js';
import { CallLog, checkCharacterItems, checkCharacters, checkStash, type ShapeProblem } from './callLog.js';
import { GGG_DEFAULT_LIMITS, RateLimiter } from './rateLimiter.js';

export type GggErrorKind = 'expired' | 'private' | 'rate-limited' | 'not-found' | 'down' | 'bad-input' | 'shape';

export class GggError extends Error {
  constructor(
    public readonly kind: GggErrorKind,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'GggError';
  }
}

export interface RawTab {
  n: string;
  i: number;
  id: string;
  type: string;
  colour?: { r: number; g: number; b: number };
  hidden?: boolean;
  children?: RawTab[];
}

export interface StashPage {
  numTabs: number;
  tabs?: RawTab[];
  items: GggItem[];
}

export interface RawCharacter {
  name: string;
  league: string;
  classId?: number;
  class?: string;
  level: number;
  experience?: number;
}

/** An item filter saved on the player's pathofexile.com account. `filter` (the text) comes only with a single read. */
export interface GggApi {
  stashTab(account: string, league: string, index: number, withTabs: boolean): Promise<StashPage>;
  characters(account: string): Promise<RawCharacter[]>;
  characterItems(account: string, character: string): Promise<{ items: GggItem[] }>;
  /** Next moment a request in this policy may go, or null. */
  resumesAt(policy: 'stash' | 'characters'): number | null;
  /**
   * Any character-window page, for the Import tab: the answer's text. `cookie` false reads it as a visitor would
   * (a public profile); true sends the session cookie. Absent on the sample source.
   */
  window?(path: string, query: Record<string, string>, opts: { cookie: boolean }): Promise<string>;
}

export const GGG_HOST = 'www.pathofexile.com';

/** Account names may carry a discriminator ("Name#1234"); the # must travel as %23. */
export function encodeAccount(name: string): string {
  return encodeURIComponent(name.trim());
}

export function validAccountName(name: string): boolean {
  return /^[^\s#/\\?&=]{2,32}(#\d{4})?$/.test(name.trim());
}

export interface HttpGggOptions {
  cookie: () => string | null;
  userAgent: string;
  limiter: RateLimiter;
  fetchFn?: typeof fetch;
  baseUrl?: string;
  /** Where each real call and each unexpected answer is recorded. */
  log?: CallLog;
}

export class HttpGgg implements GggApi {
  private readonly fetchFn: typeof fetch;
  private readonly base: string;

  constructor(private readonly o: HttpGggOptions) {
    this.fetchFn = o.fetchFn ?? (((input, init) => fetch(input, init)) as typeof fetch); // read the global at call time: the proxy setting swaps it after this object exists
    this.base = o.baseUrl ?? `https://${GGG_HOST}`;
    const host = new URL(this.base).host;
    if (host !== GGG_HOST && !o.baseUrl?.startsWith('http://127.0.0.1')) throw new Error('The session cookie may only be sent to pathofexile.com.');
  }

  resumesAt(policy: 'stash' | 'characters'): number | null {
    return this.o.limiter.resumesAt(policy);
  }

  private async get<T>(policy: 'stash' | 'characters', path: string, query: Record<string, string>, check?: (b: unknown) => ShapeProblem | null, body?: unknown): Promise<T> {
    const method = body === undefined ? 'GET' : 'POST';
    const cookie = this.o.cookie();
    if (!cookie) throw new GggError('expired', 'Not connected: there is no session cookie.');
    const qs = Object.entries(query).map(([k, v]) => `${k}=${v}`).join('&');
    const url = `${this.base}${path}?${qs}`;
    const lim = this.o.limiter;
    const wait = lim.waitTime(policy);
    const t0 = Date.now();
    await lim.acquire(policy);
    let res: Response;
    const note = (status: number, outcome: string, headers: Record<string, string>, extra = '') =>
      this.o.log?.record({ at: t0, method, endpoint: CallLog.endpoint(url), policy, status, ms: Date.now() - t0, headers, limiter: { waitedMs: wait, decision: (wait > 0 ? `waited ${(wait / 1000).toFixed(1)} s for a free slot` : 'sent at once') + extra, limits: lim.limitsFor(policy).map((l) => `${l.max}:${l.period}:${l.restrict}`).join(',') }, outcome });
    try {
      res = await this.fetchFn(url, { method, headers: { Cookie: `POESESSID=${cookie}`, 'User-Agent': this.o.userAgent, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual' });
    } catch {
      note(0, 'no answer', {});
      // Never include the URL or headers: the message is shown and may be logged.
      throw new GggError('down', "Path of Exile's website did not answer. You may be offline.");
    }
    lim.update(policy, res.headers);
    const hdr = CallLog.headersOf(res.headers);
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      const sec = Number.isFinite(ra) && ra > 0 ? ra : 60;
      lim.penalize(policy, sec);
      note(429, 'rate limited', hdr, `; blocked ${policy} for ${sec} s`);
      throw new GggError('rate-limited', `Path of Exile asked us to wait ${sec} seconds.`, sec);
    }
    if (res.status === 401 || res.status === 403) {
      note(res.status, 'refused', hdr, '; not retried');
      throw new GggError(policy === 'characters' ? 'private' : 'expired', policy === 'characters' ? 'Characters are private or the cookie expired.' : 'The session cookie was refused. It has probably expired.');
    }
    if (res.status >= 300 && res.status < 400) {
      note(res.status, 'redirected to login', hdr, '; not retried');
      throw new GggError('expired', 'Path of Exile sent us to the login page. The cookie has probably expired.');
    }
    if (res.status === 404) {
      note(404, 'not found', hdr);
      throw new GggError('not-found', 'Path of Exile has no such account or league.');
    }
    if (!res.ok) {
      note(res.status, 'server error', hdr);
      throw new GggError('down', `Path of Exile's website answered with ${res.status}.`);
    }
    let answer: unknown;
    try {
      answer = await res.json();
    } catch {
      note(res.status, 'not JSON', hdr);
      this.o.log?.diagnose({ endpoint: CallLog.endpoint(url), status: res.status, problem: 'The answer is not JSON.', missing: [], found: [], at: t0 });
      throw new GggError('shape', "Path of Exile's website sent something that is not data. A diagnostic you can copy is in the connection check.");
    }
    const bad = check?.(answer);
    if (bad) {
      note(res.status, 'shape mismatch', hdr);
      this.o.log?.diagnose({ endpoint: CallLog.endpoint(url), status: res.status, ...bad, at: t0 });
      throw new GggError('shape', `Path of Exile answered in a shape the app does not know. ${bad.problem} A diagnostic you can copy is in the connection check.`);
    }
    note(res.status, 'ok', hdr);
    return answer as T;
  }

  /** A refusal on the account's filters means the cookie is no good (there is no private-profile case here). */
  /** Reads a page and returns its text. Same limiter, errors and logging as the other reads; the cookie only goes when asked. */
  async window(path: string, query: Record<string, string>, opts: { cookie: boolean }): Promise<string> {
    const policy = 'characters' as const;
    const cookie = opts.cookie ? this.o.cookie() : null;
    if (opts.cookie && !cookie) throw new GggError('expired', 'Not connected: there is no session cookie.');
    const qs = Object.entries(query).map(([k, v]) => `${k}=${v}`).join('&');
    const url = `${this.base}${path}${qs ? '?' + qs : ''}`;
    const lim = this.o.limiter;
    const wait = lim.waitTime(policy);
    const t0 = Date.now();
    await lim.acquire(policy);
    const note = (status: number, outcome: string, headers: Record<string, string>, extra = '') =>
      this.o.log?.record({ at: t0, method: 'GET', endpoint: CallLog.endpoint(url), policy, status, ms: Date.now() - t0, headers, limiter: { waitedMs: wait, decision: (wait > 0 ? `waited ${(wait / 1000).toFixed(1)} s for a free slot` : 'sent at once') + extra, limits: lim.limitsFor(policy).map((l) => `${l.max}:${l.period}:${l.restrict}`).join(',') }, outcome });
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers: { ...(cookie ? { Cookie: `POESESSID=${cookie}` } : {}), 'User-Agent': this.o.userAgent, Accept: '*/*' }, redirect: 'manual' });
    } catch {
      note(0, 'no answer', {});
      throw new GggError('down', "Path of Exile's website did not answer. You may be offline.");
    }
    lim.update(policy, res.headers);
    const hdr = CallLog.headersOf(res.headers);
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      const sec = Number.isFinite(ra) && ra > 0 ? ra : 60;
      lim.penalize(policy, sec);
      note(429, 'rate limited', hdr, `; blocked ${policy} for ${sec} s`);
      throw new GggError('rate-limited', `Path of Exile asked us to wait ${sec} seconds.`, sec);
    }
    if (res.status === 401 || res.status === 403) {
      note(res.status, 'refused', hdr, '; not retried');
      throw new GggError(cookie ? 'expired' : 'private', cookie ? 'The session cookie was refused. It has probably expired.' : 'That profile is private or does not exist.');
    }
    if (res.status >= 300 && res.status < 400) {
      note(res.status, 'redirected', hdr, '; not retried');
      throw new GggError(cookie ? 'expired' : 'not-found', cookie ? 'Path of Exile sent us to the login page. The cookie has probably expired.' : 'Path of Exile has no such account.');
    }
    if (res.status === 404) {
      note(404, 'not found', hdr);
      throw new GggError('not-found', 'Path of Exile has no such account or character.');
    }
    if (!res.ok) {
      note(res.status, 'server error', hdr);
      throw new GggError('down', `Path of Exile's website answered with ${res.status}.`);
    }
    const text = await res.text();
    note(res.status, 'ok', hdr);
    return text;
  }

  stashTab(account: string, league: string, index: number, withTabs: boolean): Promise<StashPage> {
    return this.get<StashPage>('stash', '/character-window/get-stash-items', {
      league: encodeURIComponent(league),
      realm: 'pc',
      accountName: encodeAccount(account),
      tabs: withTabs ? '1' : '0',
      tabIndex: String(index),
    }, checkStash);
  }

  characters(account: string): Promise<RawCharacter[]> {
    return this.get<RawCharacter[]>('characters', '/character-window/get-characters', { accountName: encodeAccount(account) }, checkCharacters);
  }

  characterItems(account: string, character: string): Promise<{ items: GggItem[] }> {
    return this.get<{ items: GggItem[] }>('characters', '/character-window/get-items', { accountName: encodeAccount(account), character: encodeURIComponent(character) }, checkCharacterItems);
  }
}

export function newGggLimiter(now: () => number, sleep: (ms: number) => Promise<void>): RateLimiter {
  return new RateLimiter({ now, sleep, minGapMs: 2000, margin: 2, defaults: GGG_DEFAULT_LIMITS });
}

/** Flattens folder tabs into their children, in order, and drops hidden remove-only entries' flags into the result. */
export function flattenTabs(tabs: RawTab[] | undefined): RawTab[] {
  const out: RawTab[] = [];
  for (const t of tabs ?? []) {
    if (t.children?.length) out.push(...flattenTabs(t.children));
    else if (t.type !== 'Folder') out.push(t);
  }
  return out;
}

/** Tab types the character-window cannot give us items for, and why. */
export function unreadableReason(t: RawTab): string | undefined {
  if (t.type === 'MapStash') return 'paused by GGG';
  if (t.type === 'HeistLocker' || t.type === 'HeistStash' || t.type === 'UniqueStash') return 'not in the API';
  if (t.type === 'RemoveOnlyStash') return undefined; // readable, just not counted by default
  return undefined;
}

export function defaultCounted(t: RawTab): boolean {
  if (unreadableReason(t)) return false;
  if (t.type === 'RemoveOnlyStash') return false;
  if (/friend|trade/i.test(t.n)) return false;
  return true;
}

export function tabColour(t: RawTab): string {
  const c = t.colour;
  return c ? `rgb(${c.r},${c.g},${c.b})` : 'var(--text-muted)';
}
