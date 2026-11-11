/**
 * Background checks for the Upgrade watch: which build to look at next, and when.
 *
 * One build per turn, the stalest one, no more often than every EVERY_MS per build. After a rate limit or an outage the
 * next turn waits at least as long as the trade site asked (its Retry-After, which the limiter already holds) and
 * otherwise 5 minutes, doubling to an hour while it keeps failing. Nothing runs while the session cookie is refused or
 * missing, while the machine is idle or asleep, or while a check the player started is still going.
 */
export const EVERY_MS = 10 * 60_000;
export const MIN_GAP_MS = 2 * 60_000;
export const BACKOFF_MIN_MS = 5 * 60_000;
export const BACKOFF_MAX_MS = 60 * 60_000;

export interface PollBuild {
  key: string;
  scannedAt: number | null;
}

export type PollScan = { ok: true } | { ok: false; kind: string; message: string };

export interface PollDeps {
  now: () => number;
  /** The player's switch. */
  enabled: () => boolean;
  /** False when the machine is idle, locked or asleep. */
  active: () => boolean;
  /** False without a working session cookie. */
  ready: () => boolean;
  /** A check the player started is running. */
  busy: () => boolean;
  builds: () => PollBuild[];
  scan: (key: string) => Promise<PollScan>;
  /** When the trade site said it may be asked again. */
  resumesAt: () => number | null;
}

export type PollState = 'off' | 'no-cookie' | 'idle' | 'on' | 'backoff';

export class UpgradePoller {
  private nextAt = 0;
  private backoff = 0;
  private running = false;
  private failed = '';

  constructor(private readonly d: PollDeps) {}

  status(): { state: PollState; nextAt: number | null; message: string } {
    const state: PollState = !this.d.enabled() ? 'off' : !this.d.ready() ? 'no-cookie' : this.backoff > 0 && this.nextAt > this.d.now() ? 'backoff' : !this.d.active() ? 'idle' : 'on';
    return { state, nextAt: state === 'on' || state === 'backoff' ? this.nextAt || null : null, message: state === 'backoff' ? this.failed : '' };
  }

  /** One turn; returns what it did, for tests and the log. */
  async tick(): Promise<'off' | 'no-cookie' | 'idle' | 'busy' | 'wait' | 'none' | 'ran' | 'failed'> {
    const t = this.d.now();
    if (!this.d.enabled()) return 'off';
    if (!this.d.ready()) return 'no-cookie';
    if (!this.d.active()) return 'idle';
    if (this.running || this.d.busy()) return 'busy';
    if (t < this.nextAt) return 'wait';
    const due = this.d
      .builds()
      .filter((b) => t - (b.scannedAt ?? 0) >= EVERY_MS)
      .sort((a, b) => (a.scannedAt ?? 0) - (b.scannedAt ?? 0));
    const b = due[0];
    if (!b) return 'none';
    this.running = true;
    try {
      const r = await this.d.scan(b.key);
      const n = this.d.now();
      if (r.ok) {
        this.backoff = 0;
        this.failed = '';
        this.nextAt = n + Math.max(MIN_GAP_MS, Math.floor(EVERY_MS / Math.max(1, this.d.builds().length)));
        return 'ran';
      }
      this.failed = r.message;
      if (r.kind === 'rate-limited' || r.kind === 'down') {
        this.backoff = Math.min(BACKOFF_MAX_MS, this.backoff ? this.backoff * 2 : BACKOFF_MIN_MS);
        const resume = this.d.resumesAt();
        this.nextAt = Math.max(n + this.backoff, resume ?? 0);
      } else {
        // A refused cookie or a missing engine will not mend by asking again; ready() keeps the cookie case still.
        this.nextAt = n + BACKOFF_MAX_MS;
      }
      return 'failed';
    } finally {
      this.running = false;
    }
  }
}
