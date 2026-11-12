/**
 * A rate limiter driven by pathofexile.com's X-Rate-Limit headers.
 *
 * Header format (per the API docs, also sent by the character-window routes):
 *   X-Rate-Limit-Policy: stash-request-limit
 *   X-Rate-Limit-Rules: Ip
 *   X-Rate-Limit-Ip: 30:60:120,90:1800:600     max hits : period seconds : ban seconds
 *   X-Rate-Limit-Ip-State: 3:60:0,3:1800:0     hits so far : period seconds : seconds still banned
 *
 * Every request goes through `acquire(policy)`, which waits until sending would leave a safety margin under every
 * window, and never sends two requests closer together than `minGapMs`. A 429 is handled by `penalize`.
 */

export interface Limit {
  max: number;
  /** Window length in seconds. */
  period: number;
  /** Seconds of ban when the window is exceeded. */
  restrict: number;
}

export interface HeaderBag {
  get(name: string): string | null;
}

export interface RateLimiterOptions {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Minimum spacing between two requests in the same policy. The issue's rule is one request per 2 seconds. */
  minGapMs?: number;
  /** How many hits to leave unused under each window. */
  margin?: number;
  /** Limits to assume before the first response teaches us the real ones, keyed by policy. */
  defaults?: Record<string, Limit[]>;
}

interface Reported {
  hits: number;
  period: number;
  restricted: number;
  at: number;
}

interface PolicyState {
  limits: Limit[];
  /** Send times (ms) of our own requests, newest last. */
  sent: number[];
  reported: Reported[];
  blockedUntil: number;
  lastAt: number;
}

export function parseLimits(v: string | null | undefined): Limit[] {
  if (!v) return [];
  const out: Limit[] = [];
  for (const part of v.split(',')) {
    const [a, b, c] = part.trim().split(':').map((x) => Number(x));
    if (Number.isFinite(a) && Number.isFinite(b) && (a as number) > 0 && (b as number) > 0) out.push({ max: a as number, period: b as number, restrict: Number.isFinite(c) ? (c as number) : 0 });
  }
  return out;
}

export function parseState(v: string | null | undefined): { hits: number; period: number; restricted: number }[] {
  if (!v) return [];
  const out: { hits: number; period: number; restricted: number }[] = [];
  for (const part of v.split(',')) {
    const [a, b, c] = part.trim().split(':').map((x) => Number(x));
    if (Number.isFinite(a) && Number.isFinite(b)) out.push({ hits: a as number, period: b as number, restricted: Number.isFinite(c) ? (c as number) : 0 });
  }
  return out;
}

export class RateLimiter {
  private readonly policies = new Map<string, PolicyState>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minGap: number;
  private readonly margin: number;
  private readonly defaults: Record<string, Limit[]>;

  constructor(o: RateLimiterOptions) {
    this.now = o.now;
    this.sleep = o.sleep;
    this.minGap = o.minGapMs ?? 2000;
    this.margin = o.margin ?? 1;
    this.defaults = o.defaults ?? {};
  }

  private state(policy: string): PolicyState {
    let s = this.policies.get(policy);
    if (!s) {
      s = { limits: (this.defaults[policy] ?? []).map((l) => ({ ...l })), sent: [], reported: [], blockedUntil: 0, lastAt: -Infinity };
      this.policies.set(policy, s);
    }
    return s;
  }

  /** Milliseconds until a request in this policy may be sent; 0 means now. */
  waitTime(policy: string): number {
    const s = this.state(policy);
    const now = this.now();
    let until = Math.max(s.blockedUntil, s.lastAt + this.minGap);
    for (const lim of s.limits) {
      const winMs = lim.period * 1000;
      const inWin = s.sent.filter((t) => t > now - winMs);
      const rep = s.reported.find((r) => r.period === lim.period);
      const fresh = rep && rep.at + winMs > now ? rep : undefined;
      // What the server counted at its last report, plus what we sent after it.
      const repHits = fresh ? fresh.hits + s.sent.filter((t) => t >= fresh.at).length : 0;
      const room = lim.max - this.margin; // we may reach this many hits in the window
      const used = Math.max(inWin.length, repHits);
      if (used + 1 > room) {
        // Wait until enough hits leave the window. Our own sends have known times; hits only the server reported
        // are assumed to leave when its report ages out.
        const excess = used + 1 - room;
        const free = repHits > inWin.length && fresh ? fresh.at + winMs : (inWin[excess - 1] ?? now) + winMs;
        until = Math.max(until, free);
      }
    }
    return Math.max(0, until - now);
  }

  /** Waits until a request may go, then records it. */
  async acquire(policy: string): Promise<void> {
    for (let i = 0; i < 10000; i++) {
      const w = this.waitTime(policy);
      if (w <= 0) break;
      await this.sleep(w);
    }
    const s = this.state(policy);
    const t = this.now();
    s.sent.push(t);
    s.lastAt = t;
    const horizon = Math.max(0, ...s.limits.map((l) => l.period)) * 1000;
    if (horizon > 0) s.sent = s.sent.filter((x) => x > t - horizon);
    else s.sent = s.sent.slice(-50);
  }

  /** Learns the real limits and the server's own count from a response's headers. */
  update(policy: string, h: HeaderBag): void {
    const s = this.state(policy);
    const now = this.now();
    const rules = (h.get('x-rate-limit-rules') ?? '').split(',').map((r) => r.trim()).filter(Boolean);
    const limits: Limit[] = [];
    const reported: Reported[] = [];
    for (const r of rules) {
      limits.push(...parseLimits(h.get(`x-rate-limit-${r}`)));
      for (const st of parseState(h.get(`x-rate-limit-${r}-state`))) {
        // While banned the hit count means nothing: the ban end is what decides when we may send.
        if (st.restricted > 0) s.blockedUntil = Math.max(s.blockedUntil, now + st.restricted * 1000);
        else reported.push({ ...st, at: now });
      }
    }
    if (limits.length) s.limits = limits;
    if (reported.length) s.reported = reported;
  }

  /** A 429 or a restriction: nothing is sent in this policy for this long. */
  penalize(policy: string, seconds: number): void {
    const s = this.state(policy);
    s.blockedUntil = Math.max(s.blockedUntil, this.now() + Math.max(1, seconds) * 1000);
  }

  /**
   * A 429 on the trade site: the restriction is on the player's address, so nothing goes to pathofexile.com in any
   * policy for this long (the stash and the trade site share one budget).
   */
  penalizeAll(seconds: number): void {
    for (const k of new Set([...this.policies.keys(), ...Object.keys(this.defaults)])) this.penalize(k, seconds);
  }

  /** Epoch ms when the policy is next free, or null when it is free now. */
  resumesAt(policy: string): number | null {
    const w = this.waitTime(policy);
    return w > 0 ? this.now() + w : null;
  }

  limitsFor(policy: string): Limit[] {
    return this.state(policy).limits.map((l) => ({ ...l }));
  }
}

/** Limits read from live response headers, used until the first response says otherwise. */
export const GGG_DEFAULT_LIMITS: Record<string, Limit[]> = {
  stash: [
    { max: 30, period: 60, restrict: 120 },
    { max: 90, period: 1800, restrict: 600 },
    { max: 180, period: 7200, restrict: 3600 },
  ],
  characters: [
    { max: 15, period: 60, restrict: 120 },
    { max: 90, period: 1800, restrict: 600 },
    { max: 180, period: 7200, restrict: 3600 },
  ],
  // The trade site's own limits are not documented; these are deliberately below what its headers have shown
  // (search about 8 per 10 seconds, fetch about 12 per 4 seconds) and are replaced by the real headers at the first answer.
  'trade-search': [
    { max: 5, period: 10, restrict: 60 },
    { max: 12, period: 60, restrict: 120 },
    { max: 40, period: 300, restrict: 1800 },
  ],
  // Travel to Hideout is one click at a time; keep it far below anything a person could click.
  'trade-whisper': [
    { max: 3, period: 10, restrict: 60 },
    { max: 10, period: 120, restrict: 300 },
  ],
  'trade-fetch': [
    { max: 8, period: 4, restrict: 60 },
    { max: 12, period: 12, restrict: 60 },
  ],
};
