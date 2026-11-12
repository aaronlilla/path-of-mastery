/**
 * Live: follows a character from the game log (zone, level, deaths, passive points) and, within the rate budget, from
 * pathofexile.com (gear and an authoritative tree). DESIGN.md 4.2 to 4.6. Everything the world gives it comes in through
 * `LiveDeps`, so the tests drive it with a fake clock, a fake log and a fake GGG.
 */
import type { Guide, GuideStep, LevelingData, LevelingPlan, ZoneInfo } from '../../shared/leveling/types.js';
import { isTownAreaId, type LogEvent } from '../../shared/journey/logEvent.js';
import { nextSteps, position, stepsToTick, flatSteps } from '../../shared/journey/position.js';
import { decideTown, defenceCheck, defenceTrigger, townReasons, type DeathMark, type DefenceNumbers, type JevNoul, type ResistName, type TownFacts } from '../../shared/journey/townRules.js';
import { PassiveResolver, TreeTracker, treeDiff } from '../../shared/journey/treeTrack.js';
import type { LiveStateX } from '../../shared/journey/liveExtra.js';
import type { CharacterLink, DefenceCheck, TownAdvice } from '../../shared/journey/types.js';
import type { CharSync, SyncOutcome, SyncReason, SyncSnapshot } from './charSync.js';

export interface LiveCheckpoint {
  id: string;
  name: string;
  level: number;
  /** The whole tree at this checkpoint, in the order to take it. */
  tree: number[];
  detours: number[];
  /** Plan numbers (engine), when the checkpoint comes from a Journey plan. */
  numbers?: Record<string, number>;
}

export interface LiveBuild {
  buildKey: string;
  name: string;
  className: string;
  ascendancy: string;
  mainSkill: string;
  level: number;
  guide: Guide;
  plan: LevelingPlan;
  data: Pick<LevelingData, 'questExtras' | 'gems' | 'offers'>;
  checkpoints: LiveCheckpoint[];
  /** The passive tree graph, or null when its data is missing (tree tracking is off then). */
  resolver: PassiveResolver | null;
  /** True for class starts and ascendancy nodes: not counted against the passive points. */
  notCounted: (id: number) => boolean;
  nodeNames: Record<number, string>;
}

export interface LiveKbView {
  zones: readonly ZoneInfo[];
  /** The resistance penalty (negative or 0) for being in this act. */
  penaltyAtAct(act: number): number | null;
  /** Safe monster level range around a character level; null when the KB table is missing. */
  xpSafe(level: number): { below: number; above: number } | null;
  resistCap: number;
  dataPatch: { patch: string; behind: boolean; livePatch: string | null };
}

export interface LiveDeps {
  now(): number;
  /** Runs `fn` later; returns a cancel function. Pushes to the window are coalesced to at most one per `ms`. */
  later(fn: () => void, ms: number): () => void;
  kb: () => LiveKbView | null;
  loadBuild(buildKey: string): Promise<LiveBuild | null>;
  ticks: { get(buildKey: string): string[]; tick(buildKey: string, ids: string[], done: boolean): string[] };
  decisions: { get(buildKey: string): { kept: number[]; refund: number[] }; set(buildKey: string, d: { kept: number[]; refund: number[] }): void };
  sync: CharSync;
  jev: JevNoul | null;
  /** When false the rules alone decide, with no Jev advice. */
  hasAiAccess?: () => boolean;
  push(s: LiveStateX): void;
  clientLog: () => { found: boolean; path: string };
  /** Defence and resist numbers from the engine for the synced character (or null before the engine side exists). */
  numbers?: (snap: SyncSnapshot, cp: LiveCheckpoint | null, penalty: number) => Promise<DefenceNumbers | null>;
  /** Gear gaps from the synced character against the checkpoint's targets. */
  gaps?: (snap: SyncSnapshot, cp: LiveCheckpoint | null) => Promise<LiveStateX['gaps']>;
  onLinkChange?: (link: CharacterLink | null) => void;
}

const TOWN_SYNC_GAP_MS = 3 * 60_000;
const PUSH_MS = 250;
const MAX_EVENTS = 4000;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export class LiveTracker {
  private link: CharacterLink | null = null;
  private build: LiveBuild | null = null;
  private events: LogEvent[] = [];
  private tracker: TreeTracker | null = null;
  private treeSource: 'log' | 'sync' | 'none' = 'none';
  private deaths: DeathMark[] = [];
  private defence: DefenceCheck | null = null;
  private town: TownAdvice | null = null;
  private townZoneKey = '';
  private lastTownAt: number | null = null;
  private prevTownAt: number | null = null;
  private lastTownAct = 0;
  private prevTownAct = 0;
  private lastZoneKey = '';
  private visited = new Set<string>();
  private pendingArea: { id: string; level: number } | null = null;
  private knownPlaying = false;
  private characterChanged = false;
  private snap: SyncSnapshot | null = null;
  private syncError: string | undefined;
  private gaps: LiveStateX['gaps'] = null;
  private numbers: DefenceNumbers | null = null;
  private lastPushed = 0;
  private cancelPush: (() => void) | null = null;
  private lastCheckpointLevel = 0;
  private townSeq = 0;
  private lastState: LiveStateX | null = null;

  constructor(private readonly d: LiveDeps) {}

  // ---- setup ----

  getLink(): CharacterLink | null {
    return this.link;
  }

  buildKey(): string | null {
    return this.build?.buildKey ?? null;
  }

  /** The build Journey follows. Replaces the one before. */
  async setBuild(b: LiveBuild): Promise<void> {
    this.build = b;
    const kb = this.d.kb();
    void kb;
    this.rebuildTracker();
    this.d.sync.clearDead();
    await this.pushNow();
  }

  /** Starts following a character (or stops with null). Opens from the cache at once; one sync follows. */
  async setLink(link: CharacterLink | null): Promise<LiveStateX> {
    this.link = link;
    this.snap = null;
    this.knownPlaying = false;
    this.characterChanged = false;
    this.events = [];
    this.pendingArea = null;
    this.deaths = [];
    this.defence = null;
    this.town = null;
    this.gaps = null;
    this.numbers = null;
    this.syncError = undefined;
    this.d.onLinkChange?.(link);
    if (link) {
      const cached = await this.d.sync.loadCache(link);
      if (cached) this.adoptSnapshot(cached, false);
    }
    this.rebuildTracker();
    if (link) void this.runSync('link');
    return this.state();
  }

  /** Seed the zone and level from the recent log, without ticking steps. */
  seed(events: LogEvent[]): void {
    this.events = events.slice(-MAX_EVENTS);
    for (const e of this.events) {
      if (e.t === 'zone') this.visited.add(e.name.toLowerCase());
      if (e.t === 'level' && this.link && same(e.char, this.link.character)) {
        this.lastCheckpointLevel = e.level;
      }
    }
    this.rebuildTracker();
  }

  private rebuildTracker(): void {
    const b = this.build;
    if (!b?.resolver) {
      this.tracker = null;
      this.treeSource = 'none';
      return;
    }
    const base = this.snap ? this.snap.hashes : [];
    this.tracker = new TreeTracker(b.resolver, base);
    this.treeSource = this.snap ? 'sync' : 'log';
  }

  private adoptSnapshot(s: SyncSnapshot, rebuild = true): void {
    this.snap = s;
    this.lastCheckpointLevel = Math.max(this.lastCheckpointLevel, s.character.level);
    if (rebuild) {
      this.tracker?.reset(s.hashes);
      this.treeSource = 'sync';
    }
  }

  // ---- the log ----

  invalidateLogContext(): void {
    this.knownPlaying = false;
    this.pendingArea = null;
    this.events = [];
    this.rebuildTracker();
    this.pushSoon();
  }

  /** One log event. Cheap: heavy work (sync, engine numbers) is started, not awaited. */
  onEvent(e: LogEvent): void {
    const b = this.build;
    const selected = this.link?.character;
    if (selected && e.t === 'level' && !same(selected, e.char)) {
      this.invalidateLogContext();
      this.characterChanged = true;
      return;
    }
    if (!selected || this.characterChanged || !this.knownPlaying && e.t !== 'level') return;
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    const follow = this.link?.character ?? null;
    switch (e.t) {
      case 'area':
        this.pendingArea = { id: e.id, level: e.level };
        break;
      case 'zone':
        this.onZone(e);
        break;
      case 'level': {
        if (follow && !same(follow, e.char)) break;
        this.knownPlaying = true;
        const cp = b?.checkpoints.find((c) => c.level > this.lastCheckpointLevel && c.level <= e.level);
        const prev = this.lastCheckpointLevel;
        this.lastCheckpointLevel = e.level;
        if (cp && prev > 0 && this.link) void this.runSync('checkpoint');
        break;
      }
      case 'death': {
        if (follow && !same(follow, e.char)) break;
        this.knownPlaying = true;
        const pos = position({ events: this.events, follow, zones: this.d.kb()?.zones ?? [], guide: b?.guide ?? null });
        this.deaths.push({ at: e.at, zone: pos.zone?.id || pos.zone?.name || '?' });
        const n = defenceTrigger(this.deaths, e.at);
        if (n > 0) void this.makeDefence(n);
        break;
      }
      case 'passive':
        if (this.tracker && this.build) {
          const wanted = this.wanted();
          this.tracker.apply(e, wanted);
        }
        break;
      default:
        break;
    }
    this.pushSoon();
  }

  private wanted(): ReadonlySet<number> {
    const cp = this.nextCheckpoint();
    return new Set(cp?.tree ?? []);
  }

  private onZone(e: Extract<LogEvent, { t: 'zone' }>): void {
    const b = this.build;
    const kb = this.d.kb();
    const area = this.pendingArea;
    this.pendingArea = null;
    const key = `${area?.id ?? e.name}:${e.at}`;
    this.lastZoneKey = key;
    this.visited.add(e.name.toLowerCase());
    this.town = null;
    // the steps this arrival completes
    if (b && this.link) {
      const ticked = new Set(this.d.ticks.get(b.buildKey));
      const ids = stepsToTick(b.guide, ticked, e.name);
      if (ids.length) this.d.ticks.tick(b.buildKey, ids, true);
    }
    // a town or hideout: gear changes happen here
    const kz = kb?.zones.find((z) => (area ? z.id === area.id : false) || same(z.name, e.name));
    const isTown = (area ? isTownAreaId(area.id) : false) || !!kz?.town;
    if (isTown) {
      this.prevTownAt = this.lastTownAt;
      this.prevTownAct = this.lastTownAct;
      this.lastTownAt = e.at;
      this.lastTownAct = kz?.act ?? this.lastTownAct;
      const last = this.d.sync.lastSyncAt();
      if (this.link && (last === null || this.d.now() - last >= TOWN_SYNC_GAP_MS)) void this.runSync('town');
    }
    // town advice is judged on zones with a waypoint (every town has one), at most once per zone
    if ((kz?.waypoint || isTown) && this.townZoneKey !== key) {
      this.townZoneKey = key;
      void this.evaluateTown(key, isTown);
    }
  }

  // ---- sync ----

  /** A sync for the reason; the outcome updates numbers, tree and gaps. */
  async runSync(reason: SyncReason): Promise<SyncOutcome | null> {
    const link = this.link;
    if (!link) return null;
    const out = await this.d.sync.sync(link, reason);
    if (out.kind === 'synced') {
      this.syncError = undefined;
      this.adoptSnapshot(out.snapshot);
      this.lastCheckpointLevel = Math.max(this.lastCheckpointLevel, out.snapshot.character.level);
      await this.refreshEngineSide();
    } else if (out.kind === 'failed') this.syncError = out.why;
    else if (out.kind === 'log-only') this.syncError = out.why;
    else if (out.kind === 'skipped') this.syncError = reason === 'manual' ? out.why : this.syncError;
    await this.pushNow();
    return out;
  }

  /** Engine numbers and gaps for the synced character: once per sync, never per zone. */
  private async refreshEngineSide(): Promise<void> {
    const snap = this.snap;
    if (!snap) return;
    const cp = this.nextCheckpoint();
    const kb = this.d.kb();
    const pen = kb?.penaltyAtAct(this.currentAct()) ?? 0;
    try {
      if (this.d.numbers) this.numbers = await this.d.numbers(snap, cp, pen);
      if (this.d.gaps) this.gaps = await this.d.gaps(snap, cp);
    } catch {
      this.numbers = null;
      this.gaps = null;
    }
  }

  private async makeDefence(n: number): Promise<void> {
    const cp = this.nextCheckpoint();
    let nums = this.numbers;
    if (!nums && cp?.numbers) nums = planNumbers(cp.numbers, this.d.kb()?.resistCap ?? 75);
    this.defence = defenceCheck(n, nums);
    await this.pushNow();
  }

  // ---- town advice ----

  private async evaluateTown(key: string, inTown: boolean): Promise<void> {
    const seq = ++this.townSeq;
    const facts = await this.townFacts(inTown);
    if (!facts) return;
    const read = townReasons(facts);
    const minutes = this.prevTownAt === null || this.lastTownAt === null ? null : Math.round((this.lastTownAt - this.prevTownAt) / 60_000);
    const advice = await decideTown(read, { minutesSinceTown: minutes, zonesToWaypoint: inTown ? 0 : null, policy: 'The route plan is followed.' }, (this.d.hasAiAccess?.() ?? true) ? this.d.jev : null);
    if (seq !== this.townSeq || this.townZoneKey !== key) return;
    this.town = advice;
    await this.pushNow();
  }

  private currentAct(): number {
    const pos = position({ events: this.events, follow: this.link?.character ?? null, zones: this.d.kb()?.zones ?? [], guide: this.build?.guide ?? null });
    if (pos.zone?.act) return pos.zone.act;
    return 1;
  }

  private async townFacts(inTown: boolean): Promise<TownFacts | null> {
    const b = this.build;
    if (!b) return null;
    const kb = this.d.kb();
    const ticked = new Set(this.d.ticks.get(b.buildKey));
    const pos = position({ events: this.events, follow: this.link?.character ?? null, zones: kb?.zones ?? [], guide: b.guide, syncedLevel: this.snap?.character.level ?? null });
    const level = pos.level ?? 0;
    const planGems = new Set<string>();
    if (b.plan.swap) planGems.add(b.plan.swap.gemId);
    for (const s of b.plan.skills) {
      planGems.add(s.gemId);
      for (const g of s.supports) planGems.add(g);
    }
    const passed = (zone: string): boolean => this.visited.has(zone.toLowerCase());
    const gemsReady: TownFacts['gemsReady'] = [];
    for (const { step } of flatSteps(b.guide)) {
      if (ticked.has(step.id)) continue;
      if (step.kind === 'quest-reward' && passed(step.zone) && gemReachable(b, step.gemId, level)) {
        gemsReady.push({ name: step.take, main: planGems.has(step.gemId), text: `${step.quest} is done: take ${step.take}` });
      } else if (step.kind === 'buy' && passed(step.zone)) {
        for (const g of step.gems) if (gemReachable(b, g.gemId, level)) gemsReady.push({ name: g.name, main: planGems.has(g.gemId), text: `${step.npc} now sells ${g.name}` });
      }
    }
    // the next zone on the route and what its act does to resistances
    const nextArrive = nextSteps(b.guide, ticked, 40).find((s): s is Extract<GuideStep, { kind: 'arrive' }> => s.kind === 'arrive');
    const cur = pos.zone?.act ?? 0;
    const nextAct = nextArrive ? (kb?.zones.find((z) => z.id === nextArrive.zoneId)?.act ?? flatSteps(b.guide).find((f) => f.step.id === nextArrive.id)?.act ?? cur) : cur;
    const curPen = kb?.penaltyAtAct(cur) ?? 0;
    const nextPen = kb?.penaltyAtAct(nextAct) ?? curPen;
    const resistCliff: TownFacts['resistCliff'] = [];
    if (this.numbers && nextPen < curPen && kb) {
      const delta = nextPen - curPen;
      for (const r of ['fire', 'cold', 'light', 'chaos'] as ResistName[]) {
        const have = this.numbers.res[r];
        if (have === undefined || (r === 'chaos' && this.numbers.res.chaos === undefined)) continue;
        const after = have + delta;
        if (r !== 'chaos' && after < kb.resistCap) resistCliff.push({ resist: r, after, need: kb.resistCap, why: `in act ${nextAct}` });
      }
    }
    // a gap a vendor can fill: only when a new act town was entered and the gaps are known
    const vendorScan = inTown && this.gaps && this.gaps.length && this.lastTownAct !== this.prevTownAct ? 'You are in a new town and your gear has gaps a vendor may fill.' : null;
    const xp = this.xpState(level, pos.zone?.areaLevel ?? 0);
    const levelGap = nextArrive && kb ? this.nextZoneGap(level, nextArrive.areaLevel) : xp?.state === 'under' ? { under: xp.by, areaLevel: pos.zone?.areaLevel ?? 0 } : null;
    return { gemsReady, linkUpgrade: this.snap ? linkUpgrade(this.snap) : null, flaskUpgrade: null, resistCliff, vendorScan, levelGap };
  }

  private nextZoneGap(level: number, areaLevel: number): { under: number; areaLevel: number } | null {
    const safe = this.d.kb()?.xpSafe(level);
    if (!safe || !level || !areaLevel) return null;
    const under = areaLevel - level - safe.above;
    return under > 0 ? { under, areaLevel } : null;
  }

  private xpState(level: number, areaLevel: number): LiveStateX['xp'] {
    const safe = this.d.kb()?.xpSafe(level);
    if (!safe || !level || !areaLevel) return null;
    const over = level - areaLevel - safe.below;
    if (over > 0) return { state: 'over', by: over };
    const under = areaLevel - level - safe.above;
    if (under > 0) return { state: 'under', by: under };
    return { state: 'ok', by: 0 };
  }

  dismissTown(): void {
    this.town = null;
    this.pushSoon();
  }

  // ---- off-plan choices ----

  offPlan(node: number, op: 'keep' | 'refund'): void {
    const b = this.build;
    if (!b) return;
    const cur = this.d.decisions.get(b.buildKey);
    const kept = new Set(cur.kept);
    const refund = new Set(cur.refund);
    if (op === 'keep') {
      kept.add(node);
      refund.delete(node);
    } else {
      refund.add(node);
      kept.delete(node);
    }
    this.d.decisions.set(b.buildKey, { kept: [...kept], refund: [...refund] });
    this.pushSoon();
  }

  tick(ids: string[], done: boolean): void {
    if (!this.build) return;
    this.d.ticks.tick(this.build.buildKey, ids, done);
    this.pushSoon();
  }

  // ---- state ----

  private nextCheckpoint(): LiveCheckpoint | null {
    const b = this.build;
    if (!b || !b.checkpoints.length) return null;
    const pos = position({ events: this.events, follow: this.link?.character ?? null, zones: this.d.kb()?.zones ?? [], guide: b.guide, syncedLevel: this.snap?.character.level ?? null });
    const level = pos.level ?? 1;
    const live = this.tracker?.allocated();
    const open = b.checkpoints.filter((c) => c.level >= level && (!live || c.tree.some((n) => !live.has(n) && !b.notCounted(n))));
    return open[0] ?? b.checkpoints[b.checkpoints.length - 1] ?? null;
  }

  state(): LiveStateX {
    const b = this.build;
    const kb = this.d.kb();
    const follow = this.link?.character ?? null;
    const pos = position({
      events: this.events,
      follow,
      zones: kb?.zones ?? [],
      guide: b?.guide ?? null,
      syncedLevel: this.snap?.character.level ?? null,
      syncedChar: this.snap ? { name: this.snap.character.name, cls: this.snap.character.cls } : null,
    });
    const ticked = new Set(b ? this.d.ticks.get(b.buildKey) : []);
    const cp = this.nextCheckpoint();
    const dec = b ? this.d.decisions.get(b.buildKey) : { kept: [], refund: [] };
    let treeD: LiveStateX['treeDiff'] = null;
    if (b && this.tracker && cp) {
      const quest = questPoints(b, ticked);
      const earned = pos.level !== null ? pos.level - 1 + quest : null;
      const diff = treeDiff(this.tracker.allocated(), cp.tree, [...cp.detours, ...dec.kept], earned, b.notCounted);
      treeD = { toTake: diff.toTake, offPlan: diff.offPlan, unspent: diff.unspent };
    }
    const logOnly = this.d.sync.logOnlyReason();
    const mode: LiveStateX['mode'] = !this.d.clientLog().found ? 'no-log' : this.snap && !logOnly ? 'live' : 'log-only';
    const notes: string[] = [];
    if (logOnly) notes.push(logOnly);
    if (this.tracker && b?.resolver && !b.resolver.hasIdTable()) notes.push('Passive points are matched by name until the knowledge base has the passive id table. A sync corrects them.');
    if (!this.knownPlaying && this.link) notes.push(`Playing: unknown. Assuming ${this.link.character}.`);
    if (this.build && !this.tracker) notes.push('The passive tree data for this build is missing, so the tree is not tracked.');
    const nextAt = this.d.sync.nextAllowedAt();
    const char = pos.char ?? (this.link && pos.level !== null ? { name: this.link.character, cls: '', level: pos.level } : undefined);
    const st: LiveStateX = {
      link: this.link,
      mode,
      ...(char ? { char } : {}),
      ...(pos.zone ? { zone: pos.zone } : {}),
      next: b ? nextSteps(b.guide, ticked, 5) : [],
      treeDiff: treeD,
      gaps: this.gaps,
      town: this.town,
      defence: this.defence,
      sync: { at: this.d.sync.lastSyncAt(), nextAllowedAt: nextAt, budget: this.d.sync.budgetRows(), ...(this.syncError ? { error: this.syncError } : {}) },
      dataPatch: kb?.dataPatch ?? { patch: '', behind: false, livePatch: null },
      buildKey: b?.buildKey ?? null,
      buildName: b?.name ?? null,
      playing: this.link ? { name: this.link.character, known: this.knownPlaying } : null,
      xp: pos.level !== null && pos.zone ? this.xpState(pos.level, pos.zone.areaLevel) : null,
      checkpoint: cp ? { id: cp.id, name: cp.name, level: cp.level } : null,
      ticked: [...ticked],
      names: { nodes: b?.nodeNames ?? {}, gems: gemNames(b) },
      notes,
      logPath: this.d.clientLog().path,
      deaths: this.deaths.length,
      kept: dec.kept,
      refund: dec.refund,
      treeSource: this.tracker ? this.treeSource : 'none',
      aiAccess: this.d.hasAiAccess?.() ?? true,
      stepsLeft: b ? flatSteps(b.guide).filter((f) => !ticked.has(f.step.id)).length : 0,
    };
    this.lastState = st;
    return st;
  }

  last(): LiveStateX | null {
    return this.lastState;
  }

  // ---- pushes: at most one every 250 ms ----

  private pushSoon(): void {
    if (this.cancelPush) return;
    const wait = Math.max(0, this.lastPushed + PUSH_MS - this.d.now());
    this.cancelPush = this.d.later(() => {
      this.cancelPush = null;
      this.lastPushed = this.d.now();
      this.d.push(this.state());
    }, wait);
  }

  private async pushNow(): Promise<void> {
    this.cancelPush?.();
    this.cancelPush = null;
    this.lastPushed = this.d.now();
    this.d.push(this.state());
  }

  dispose(): void {
    this.cancelPush?.();
    this.cancelPush = null;
  }
}

function gemNames(b: LiveBuild | null): Record<string, { name: string; colour: string }> {
  const out: Record<string, { name: string; colour: string }> = {};
  if (!b) return out;
  for (const [id, g] of Object.entries(b.data.gems)) out[id] = { name: g.name, colour: g.colour };
  return out;
}

/** Quest passive points taken so far: the hand-in steps that are ticked. */
export function questPoints(b: LiveBuild, ticked: ReadonlySet<string>): number {
  let n = 0;
  for (const { step } of flatSteps(b.guide)) {
    if (step.kind !== 'handin' || !ticked.has(step.id)) continue;
    for (const q of step.questIds) n += b.data.questExtras[q]?.passives ?? 0;
  }
  return n;
}

function gemReachable(b: LiveBuild, gemId: string, level: number): boolean {
  if (!level) return false;
  const offers = b.data.offers[gemId];
  if (!offers) return true;
  const rows = offers[b.guide.class] ?? Object.values(offers)[0] ?? [];
  const lv = Math.min(...rows.map((o) => o.level), 999);
  return lv <= level;
}

/** A body armour or main weapon with more links in the inventory than the one equipped. */
function linkUpgrade(s: SyncSnapshot): string | null {
  const items = (s.items as { items?: { inventoryId?: string; typeLine?: string; sockets?: { group: number }[]; properties?: { name: string }[] }[] }).items ?? [];
  const links = (i: (typeof items)[number]): number => {
    const g = new Map<number, number>();
    for (const k of i.sockets ?? []) g.set(k.group, (g.get(k.group) ?? 0) + 1);
    return Math.max(0, ...g.values());
  };
  const sig = (i: (typeof items)[number]): string => (i.properties ?? []).map((p) => p.name).filter((n) => /^(Armour|Evasion Rating|Energy Shield|Physical Damage|Elemental Damage|Chaos Damage)$/.test(n)).sort().join('|');
  const slots = items.filter((i) => i.inventoryId === 'BodyArmour' || i.inventoryId === 'Weapon');
  for (const inv of items.filter((i) => i.inventoryId === 'MainInventory')) {
    const n = links(inv);
    if (n < 5) continue;
    for (const eq of slots) {
      if (links(eq) < n && sig(eq) && sig(eq) === sig(inv)) return `You carry a ${n}-linked ${inv.typeLine ?? 'item'}: swap it in`;
    }
  }
  return null;
}

function planNumbers(nums: Record<string, number>, cap: number): DefenceNumbers {
  const pick = (...keys: string[]): number | undefined => {
    for (const k of keys) if (typeof nums[k] === 'number') return nums[k];
    return undefined;
  };
  const res: DefenceNumbers['res'] = {};
  const f = pick('FireResist', 'fireRes', 'res-fire');
  const c = pick('ColdResist', 'coldRes', 'res-cold');
  const l = pick('LightningResist', 'lightRes', 'res-light');
  const ch = pick('ChaosResist', 'chaosRes', 'res-chaos');
  if (f !== undefined) res.fire = f;
  if (c !== undefined) res.cold = c;
  if (l !== undefined) res.light = l;
  if (ch !== undefined) res.chaos = ch;
  const life = pick('Life', 'life');
  const lifeFloor = pick('LifeFloor', 'lifeFloor');
  return { source: 'plan', ...(life !== undefined ? { life } : {}), ...(lifeFloor !== undefined ? { lifeFloor } : {}), res, resCap: cap };
}
