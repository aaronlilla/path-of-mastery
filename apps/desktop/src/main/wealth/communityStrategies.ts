import { createHash } from 'node:crypto';
import { totals, type Run } from './sessions.js';

/** The backend with the Bulk board calls present. */
export type BoardBackend = CommunityBackend & { userName(): string; bulk: NonNullable<CommunityBackend['bulk']> };

/** What the Wealth screen needs from the community backend (the cloud API in the app, a fake in tests). */
export interface CommunityBackend {
  index(league: string): Promise<IndexRow[]>;
  submit(row: SessionRow): Promise<void>;
  signedIn(): boolean;
  /** The signed-in player's account name (the default seller name), or '' when signed out. */
  userName?(): string;
  /** The Bulk board calls. */
  bulk?: {
    view(league: string): Promise<import('../accounts/cloudApi.js').BulkRow[]>;
    post(i: { league: string; seller: string; cat: string; items: { name: string; qty: number }[]; marketChaos: number; mult: number }): Promise<void>;
    heartbeat(): Promise<void>;
    vote(id: string, kind: 'vouch' | 'report'): Promise<void>;
    offer(id: string, mult: number, fromName: string): Promise<void>;
    remove(id: string): Promise<void>;
  };
}

export interface IndexRow {
  strategyId: string;
  /** Different players other than the app author. */
  players: number;
  sessions: number;
  medianDivinePerHour: number;
  verified: boolean;
}

export interface SessionRow {
  strategyId: string;
  league: string;
  patch: string;
  runHash: string;
  hours: number;
  maps: number;
  netDivinePerHour: number;
}

/** A finished strategy session shorter than this says too little to share. */
export const MIN_SHARE_HOURS = 0.33;

/** The numbers of one finished session, or null when it is not one to share: no strategy, still running, too short. Only numbers leave the PC. */
export function sessionRow(run: Run, divine: number, league: string): SessionRow | null {
  if (!run.strategyId || run.end === null || !league || !(divine > 0)) return null;
  const hours = Math.round(((run.end - run.start) / 3_600_000) * 100) / 100;
  if (hours < MIN_SHARE_HOURS || hours > 24) return null;
  const net = totals(run).net / divine / hours;
  if (!Number.isFinite(net) || Math.abs(net) > 1000) return null;
  const runHash = createHash('sha256').update(`${run.id}|${run.start}|${run.strategyId}`).digest('hex');
  return { strategyId: run.strategyId, league, patch: '', runHash, hours, maps: Math.min(400, Math.max(0, Math.round(run.maps))), netDivinePerHour: Math.round(net * 1000) / 1000 };
}

/** The community index of the league, read at most every 10 minutes. A failure keeps the last answer, or none. */
export class IndexCache {
  private at = 0;
  private league = '';
  private rows: IndexRow[] | null = null;
  constructor(
    private readonly backend: CommunityBackend,
    private readonly now: () => number,
    private readonly ttlMs = 10 * 60_000,
  ) {}
  async get(league: string): Promise<IndexRow[] | null> {
    if (!league) return null;
    if (this.league === league && this.rows && this.now() - this.at < this.ttlMs) return this.rows;
    try {
      this.rows = await this.backend.index(league);
      this.league = league;
      this.at = this.now();
    } catch {
      if (this.league !== league) this.rows = null;
    }
    return this.rows;
  }
  clear(): void {
    this.at = 0;
  }
}
