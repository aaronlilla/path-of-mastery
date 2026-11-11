/**
 * The Journey service for Live and the Link dialog: wires the knowledge base, the game log, the character reads and the
 * leveling progress into one LiveTracker. No electron imports, so tests drive it directly.
 */
import { join } from 'node:path';
import type { CharacterRow, Realm } from '../../shared/characterImport.js';
import type { BuildInfo, LiveStateX } from '../../shared/journey/liveExtra.js';
import { matchCharacter, socketedGems } from '../../shared/journey/match.js';
import type { CharacterMatch } from '../../shared/journey/ipcTypes.js';
import type { KnowledgeBase } from '../../shared/journey/kb.js';
import type { BudgetInfo, CharacterLink } from '../../shared/journey/types.js';
import type { JevNoul } from '../../shared/journey/townRules.js';
import type { WindowFetch } from '../character/api.js';
import { CharSync, JourneyBudget, listCharacterRows, type LimiterView } from './charSync.js';
import { LinkStore } from './linkStore.js';
import { LiveTracker, type LiveBuild, type LiveDeps, type LiveKbView } from './live.js';
import { loadLiveKb } from './liveKb.js';
import { readLogTail, subscribeLog, type LogBatch } from './logReader.js';
import { stat } from 'node:fs/promises';

export interface ServiceDeps {
  dir: string; // userData/journey
  now?: () => number;
  later?: LiveDeps['later'];
  kb: KnowledgeBase;
  loadBuild: (buildKey: string, name: string, xml: string) => Promise<LiveBuild>;
  ticks: LiveDeps['ticks'];
  win: WindowFetch;
  session: () => { connected: boolean; account: string };
  limiter: LimiterView;
  jev?: JevNoul | null;
  jevMode?: BudgetInfo['jev']['mode'];
  /** The Client.txt to follow, or '' when none is found. */
  logPath: () => Promise<string>;
  push: (s: LiveStateX) => void;
  hasAiAccess?: () => boolean;
  numbers?: LiveDeps['numbers'];
  gaps?: LiveDeps['gaps'];
  watchMs?: number;
}

export class JourneyService {
  readonly live: LiveTracker;
  readonly sync: CharSync;
  private readonly store: LinkStore;
  private readonly now: () => number;
  private kbView: LiveKbView | null = null;
  private build: LiveBuild | null = null;
  private watcher: { stop(): void } | null = null;
  private watching = '';
  private logFound = { found: false, path: '' };
  private offKb: (() => void) | null = null;
  private readonly budget_: JourneyBudget;

  constructor(private readonly d: ServiceDeps) {
    this.now = d.now ?? Date.now;
    this.store = new LinkStore(join(d.dir, 'links.json'));
    const budget = new JourneyBudget(d.limiter, this.now);
    this.budget_ = budget;
    this.sync = new CharSync({ win: d.win, hasCookie: () => d.session().connected, budget, now: this.now, cacheDir: join(d.dir, 'live') });
    this.live = new LiveTracker({
      now: this.now,
      later: d.later ?? ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      }),
      kb: () => this.kbView,
      loadBuild: async () => this.build,
      ticks: d.ticks,
      decisions: { get: (k) => this.store.decisions(k), set: (k, v) => this.store.setDecisions(k, v) },
      sync: this.sync,
      jev: d.jev ?? null,
      ...(d.hasAiAccess ? { hasAiAccess: d.hasAiAccess } : {}),
      push: d.push,
      clientLog: () => this.logFound,
      ...(d.numbers ? { numbers: d.numbers } : {}),
      ...(d.gaps ? { gaps: d.gaps } : {}),
    });
  }

  async init(): Promise<void> {
    this.kbView = await loadLiveKb(this.d.kb);
    this.offKb = this.d.kb.onChange(() => void loadLiveKb(this.d.kb).then((v) => (this.kbView = v)));
  }

  dispose(): void {
    this.watcher?.stop();
    this.watcher = null;
    this.watching = '';
    this.offKb?.();
    this.live.dispose();
  }

  /** The build Journey follows. Starts the log watch, opens from the saved link, and returns what the screens need. */
  async setBuild(req: { buildKey: string; name: string; xml: string }): Promise<BuildInfo> {
    if (!this.kbView) this.kbView = await loadLiveKb(this.d.kb);
    const b = await this.d.loadBuild(req.buildKey, req.name, req.xml);
    this.build = b;
    await this.live.setBuild(b);
    await this.startLog();
    const saved = this.store.link(req.buildKey);
    if (saved && this.live.getLink()?.character !== saved.character) await this.live.setLink(saved);
    return {
      buildKey: b.buildKey,
      name: b.name,
      className: b.className,
      ascendancy: b.ascendancy,
      mainSkill: b.mainSkill,
      level: b.level,
      guide: b.guide,
      gems: Object.fromEntries(Object.entries(b.data.gems).map(([k, g]) => [k, { name: g.name, colour: g.colour }])),
      nodeNames: b.nodeNames,
    };
  }

  private async startLog(): Promise<void> {
    const p = await this.d.logPath();
    this.logFound = { found: !!p, path: p };
    if (!p) {
      this.watcher?.stop();
      this.watcher = null;
      this.watching = '';
      this.live.invalidateLogContext();
      return;
    }
    if (this.watching === p) return;
    this.watcher?.stop();
    this.live.invalidateLogContext();
    this.watching = p;
    let seeding = true;
    const buffered: LogBatch[] = [];
    const deliver = (batch: LogBatch) => {
      if (this.watching !== p) return;
      if (batch.statuses.some(status => status.kind === 'gap' || status.kind === 'error')) this.live.invalidateLogContext();
      else for (const envelope of batch.envelopes) if (envelope.origin === 'live') this.live.onEvent(envelope.event);
    };
    const watcher = subscribeLog(p, batch => {
      if (seeding) buffered.push(batch);
      else deliver(batch);
    }, { intervalMs: this.d.watchMs ?? 500 });
    this.watcher = watcher;
    await watcher.ready;
    // the recent past: zone and level, without ticking steps
    try {
      const tail = await readLogTail(p, 512 * 1024);
      if (this.watching === p) this.live.seed(tail.envelopes.map(e => e.event));
    } catch {
      /* the file may not exist yet */
    }
    seeding = false;
    for (const batch of buffered) deliver(batch);
  }

  async setLink(link: CharacterLink | null): Promise<LiveStateX> {
    const key = link?.buildKey ?? this.build?.buildKey;
    if (key) this.store.setLink(key, link);
    return this.live.setLink(link);
  }

  state(): LiveStateX {
    return this.live.state();
  }

  async syncNow(): Promise<LiveStateX> {
    await this.live.runSync('manual');
    return this.live.state();
  }

  private matchBuild(league?: string) {
    const b = this.build;
    if (!b) throw new Error('Pick a build first.');
    const ls = b.plan.skills[0];
    return { className: b.className, ascendancy: b.ascendancy, level: b.level, mainSkill: b.mainSkill, ...(league ? { league } : {}), ...(ls && ls.name !== b.mainSkill ? { levelingSkill: ls.name } : {}) };
  }

  private lastList: { at: number; realm: Realm; account: string; rows: CharacterRow[] } | null = null;
  private gemsSeen = new Map<string, string[]>();

  /** The account's characters with how well each fits the build. One get-characters hit, at most once per 5 minutes. */
  async chars(req: { realm: Realm; league?: string }): Promise<{ rows: (CharacterRow & { match: CharacterMatch })[]; account: string }> {
    const sess = this.d.session();
    if (!sess.connected) throw new Error('Connect Path of Exile in Wealth first, or type a character name instead.');
    const fresh = this.lastList && this.lastList.realm === req.realm && this.now() - this.lastList.at < 5 * 60_000;
    if (!fresh) {
      if (!this.budget_.room(1)) throw new Error('Journey has used its half of the character reads for now.');
      const rows = await listCharacterRows(this.budget_.counted(this.d.win), req.realm, sess.account);
      this.lastList = { at: this.now(), realm: req.realm, account: sess.account, rows };
    }
    const mb = this.matchBuild(req.league);
    const rows = this.lastList!.rows.filter((r) => !req.league || r.league === req.league).map((r) => ({ ...r, match: matchCharacter(mb, r, this.gemsSeen.has(r.name) ? { gems: this.gemsSeen.get(r.name)! } : null) }));
    return { rows, account: this.lastList!.account };
  }

  /** Reads one character's items (one hit) and matches the gems. */
  async checkGems(req: { realm: Realm; character: string }): Promise<{ match: CharacterMatch }> {
    const sess = this.d.session();
    const row = this.lastList?.rows.find((r) => r.name === req.character);
    if (!sess.connected || !row) throw new Error('Open the character list first.');
    const budget = this.budget_;
    if (!budget.room(1)) throw new Error('Journey has used its half of the character reads for now.');
    const body = await budget.counted(this.d.win)('/character-window/get-items', { accountName: sess.account.replace(/#/g, '%23'), character: encodeURIComponent(req.character), realm: req.realm }, true);
    const gems = socketedGems(JSON.parse(body));
    this.gemsSeen.set(req.character, gems);
    return { match: matchCharacter(this.matchBuild(), row, { gems }) };
  }

  budget(): BudgetInfo {
    const v = this.kbView;
    return {
      ggg: this.sync.budgetRows(),
      jev: { mode: this.d.jevMode ?? (process.env.TYPESAFE_API_KEY ? 'env' : 'off'), tokensToday: 0 },
      claude: null,
      data: v?.dataPatch ?? { patch: '', behind: false, livePatch: null },
    };
  }

  /** Used by tests: how long ago the file was touched. */
  static async fileAge(p: string): Promise<number> {
    return Date.now() - (await stat(p)).mtimeMs;
  }
}
