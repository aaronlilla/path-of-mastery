// The build solver as the app runs it: one solve at a time, polled about once a second, shared by the
// Solve panel and the assistant's solve tools. A result becomes ONE apply/undo card (a proposal whose single edit is
// the whole build as `setXml`), so Apply and Ctrl+Z each take one step.
import { availableParallelism } from 'node:os';
import { z } from 'zod';
import type { SolveGoal, SolvePlanLead, SolvePriority, SolveSnapshot, SolveStall } from '@pom/protocol';
import type { AssessedCandidate, Proposal, SolveCpu, SolveDetails, SolveState } from '../../shared/assistant/types.js';
import { buildSidebar, DEFAULT_NUMBER_FORMAT, minionDisplayStats, normaliseOutput } from '../../renderer/displayStats.js';
import { cardTile } from '../../shared/dpsTile.js';
import { CLASSES, parseXml, type XmlNode } from '../../shared/buildXml.js';
import { readSpecSummaries } from '../../shared/treeSets.js';
import { assessCandidate, resultHash } from './assess.js';
import { keepAnswers, opensWizard, prefillFromAsk, sameAsk } from './solveAsk.js';
import { keptFor, withKept } from './skeletons.js';
import { readConfig, readEquipped, readSkills, xmlHash } from './buildReaders.js';
import type { ProposalStore } from './proposals.js';
import { auditBuild } from './audit.js';
import { playerObjections } from './objections.js';
import { changeRows, deltasOf, need, pickChanges, statMap, ToolError, xmlOf, type AssistantEngine, type Scalar, type ToolContext, type ToolDef } from './tools.js';
import type { TreeData } from './treeData.js';

/** "Until done" (0) by default: a solve ends on its result (every target met, or the search stopped gaining); the timed entries stay for a player who picks one. */
export const DEFAULT_SOLVE_BUDGET_MS = 0;
export const NEED_MODE = 'Pick what the build is for to run: mapping, bossing or both.';
export const NEED_WEALTH = 'Pick how rich you are to run: league start, mid league, rich or mirror.';

/** The AI's build plan, sent in the goal (the contract with the engine; kept here until packages/protocol carries it). */
export interface PlanLead { name: string; className?: string; ascendancy?: string; uniques?: string[]; supports?: string[]; keystones?: string[]; why?: string }
export interface SolvePlan { leads: PlanLead[] }
/** How a run ended (same contract): met, or stalled with each lead's best values against the need. */
export interface SolveEnd { reason: 'met' | 'stalled'; leads?: Array<{ name: string; values: Array<{ name: string; value: number; need: number }>; limiting?: string; moreTimeHelps?: boolean }> }
export const planOf = (g: SolveGoal | null | undefined): SolvePlan | undefined => (g as (SolveGoal & { plan?: SolvePlan }) | null | undefined)?.plan;
export const endOf = (s: SolveSnapshot | null | undefined): SolveEnd | undefined => (s as (SolveSnapshot & { end?: SolveEnd }) | null | undefined)?.end;

/** The snapshot with result `index`'s EHP shown as the sidebar reads it (TotalEHP in the open build's own config), or null when nothing changes. The solver's own score can differ (it may count a flask, such as Replica Rumi's, as always on). */
export function withSidebarEhp(snap: SolveSnapshot, index: number, ehp: number): SolveSnapshot | null {
  const r = snap.results[index];
  const t = r?.targets.find((x) => x.metric === 'ehp');
  if (!r || !t || t.shown === ehp) return null;
  return { ...snap, results: snap.results.map((x, i) => (i === index ? { ...x, targets: x.targets.map((y) => (y === t ? { ...y, shown: ehp } : y)) } : x)) };
}

/** "1.2M", "62k". */
const short = (v: number) => (Math.abs(v) >= 1e6 ? `${+(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `${Math.round(v / 1e3)}k` : `${Math.round(v)}`);

/** Targets the best is under a fifth of, as a line the AI must say with its ratio ("DPS 400k of 3M: 13%, 7.5x short"), or ''. */
export function farOffLine(vals: Array<{ name: string; value: number; need: number }>): string {
  const far = vals.filter((v) => v.need > 0 && v.value < v.need / 5).map((v) => `${v.name} ${short(v.value)} of ${short(v.need)}: ${Math.round((v.value / v.need) * 100)}%, ${+(v.need / Math.max(v.value, 1)).toFixed(1)}x short`);
  return far.length ? `Far off (best under a fifth of the ask): ${far.join('; ')}. Say this ratio plainly in your answer, with the numbers as getSolve placeholders, not just that it stalled.` : '';
}

/** What the AI reads after a stall: each lead's best against the need, what limits it, whether time helps (the panel sends it as a chat turn). */
export function replanText(round: number, end: SolveEnd): string {
  const leads = (end.leads ?? []).map((l) => `- ${l.name}: ${l.values.map((v) => `${v.name} ${short(v.value)} of ${short(v.need)}`).join(', ')}${l.limiting ? `; limited by ${l.limiting}` : ''}; ${l.moreTimeHelps ? 'more time would help' : 'more time would not help'}.`);
  return [
    `Solve update, round ${round}: the solver stalled. No lead reached every target. Best per lead against the need:`,
    ...(leads.length ? leads : ['- (the solver gave no per-lead results)']),
    farOffLine((end.leads ?? []).flatMap((l) => l.values)),
    'Write new or adjusted leads that answer these limits and call startSolve with the same goal and the new plan: it runs at once. Only if no credible lead is left: call stopSolve with verdict, then applySolveResult for the best build, and tell the player plainly.',
  ].filter(Boolean).join('\n');
}

/** What the AI reads when leads stall while the others run (or every lead has stalled and the solver waits): one line per lead. */
const IDLE_HEAD = 'Solve update: every lead has stalled and the solver is waiting for you.';
export function stallText(stalls: SolveStall[], idle: boolean): string {
  const lines = stalls.map((l) => `- ${l.name}: ${l.values.map((v) => `${v.name} ${short(v.value)} of ${short(v.need)}`).join(', ') || 'no build yet'}${l.limiting ? `; limited by ${l.limiting}` : ''}; ${l.moreTimeHelps ? 'more time would help' : 'more time would not help'}.`);
  return [
    idle ? `${IDLE_HEAD} Stalled leads:` : 'Solve update: these leads stalled short of the goal while the others keep running:',
    ...lines,
    farOffLine(stalls.flatMap((l) => l.values)),
    idle
      ? 'Send leads that answer these limits with addLeads (the solve picks them up at once), or, only if no credible lead is left, call stopSolve with verdict, then applySolveResult for the best build, and tell the player plainly.'
      : "For each, judge as a seasoned player why it stalled. If a swap answers its limit, call addLeads with the new lead (replaces: the stalled lead's name); the other leads keep running. Do not stop the solve while other leads still run.",
  ].filter(Boolean).join('\n');
}

/** The best build's misses, as the end message shows them: "DPS 1.6M of 3M (47% short)". */
export function gapLines(snap: SolveSnapshot | null): string[] {
  const r = snap?.results[snap.picks?.[0] ?? 0];
  if (!r) return [];
  const miss = (name: string, v: number, need: number) => `${name} ${short(v)} of ${short(need)} (${Math.round((1 - v / need) * 100)}% short)`;
  return [...r.targets.filter((t) => t.target !== null && !t.met).map((t) => miss(t.name, t.shown ?? t.value, t.target!)), ...r.limits.filter((l) => !l.met).map((l) => miss(l.name, l.value, l.need))];
}

/**
 * The one turn the AI gets when a solve ends (met, stopped gaining, or the player's Stop; not the AI's own stop): read the assessed builds, explain the options, offer one.
 * On a target miss it also gets the frontier answer: best at X is Y, Z needs about N, buy these first (planBudget, upgradeCandidates).
 */
export function finishText(snap: SolveSnapshot, stopped = false): string {
  const gaps = gapLines(snap);
  const n = `${snap.results.length} build${snap.results.length === 1 ? '' : 's'}`;
  const end = endOf(snap);
  const head = stopped ? `Solve update: the player stopped the solve with ${n} so far.` : end?.reason === 'stalled' ? `Solve update: the solve stopped gaining and ended with ${n}.` : `Solve update: the solve finished with ${n}.`;
  const held = (end?.leads ?? []).filter((l) => l.limiting).map((l) => `${l.name}: ${l.limiting}`);
  if (!gaps.length) return [head, 'Every target is met. Do the closing steps from your instructions: getSolve, openSolveDraft on the best pick, checkBuild, repair what a player would fix, checkBuild again. Then in a few lines say what you fixed, what is left, what the repaired build reaches and what it costs, and offer to apply it. Do not call proposeDraft or applySolveResult until the player says yes.'].join('\n');
  return [
    head,
    `The best build misses: ${gaps.join('; ')}.`,
    held.length ? `What holds each lead back: ${held.join('; ')}.` : '',
    farOffLine((snap.results[snap.picks?.[0] ?? 0]?.targets ?? []).filter((t) => t.target).map((t) => ({ name: t.name, value: t.shown ?? t.value, need: t.target! }))),
    'Call getSolve, then planBudget and upgradeCandidates (the weakest slot, within the stated budget) and answer as the frontier: "the best at your budget is Y; the target needs about N more; buy these first", every number a placeholder, every buy with its price and engine gain from those tools and never one they do not list. Say what this search reached and what limits it, never that the goal cannot be reached. Tell them Keep improving searches on from the best build. Before you offer it, do the closing steps from your instructions on the best build: openSolveDraft, checkBuild, repair what a player would fix, checkBuild again, and say what you fixed and what is left. Offer to apply the repaired build. Do not call proposeDraft or applySolveResult until the player says yes.',
  ].filter(Boolean).join('\n');
}

const IDLE: SolveState = { buildKey: null, goal: null, timeBudgetMs: DEFAULT_SOLVE_BUDGET_MS, cpu: 'normal', goalRev: 0, status: 'idle', snapshot: null };

/** Threads for a CPU mode; undefined lets the engine take every core but two. */
export function threadsFor(cpu: SolveCpu, cores = availableParallelism()): number | undefined {
  return cpu === 'gentle' ? Math.max(1, Math.floor(cores / 4)) : undefined;
}

export interface SolveDeps {
  engine: AssistantEngine;
  open: () => { buildId: string; buildKey: string; name: string } | null;
  proposals: ProposalStore;
  tree: TreeData;
  /** Every state change; `reveal` asks the panel to show itself (the assistant opened a goal). */
  push: (state: SolveState, reveal: boolean) => void;
  pollMs?: number;
  /** Live unique prices in divine orbs (the Wealth price feed), sent with each solve for its wealth tier. */
  uniquePrices?: () => Promise<Record<string, number> | null>;
  /** The tool context the assessment checks run with (the app's service gives it); without it a result is `unresolved`. */
  toolContext?: () => ToolContext | null;
  /** Jev's shortlist for a goal: the order the solver tests candidates in. Null or absent: today's order. */
  shortlist?: (goal: SolveGoal) => Promise<SolvePriority | null>;
}

export class SolveError extends Error {}

export class SolveManager {
  private s: SolveState = IDLE;
  private solveId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Stalled lead ids already sent to the AI in a Solve update, and whether the idle wait was told (per solve). */
  private told = new Set<number>();
  private idleTold = false;
  /** Bumped when a solve is cancelled, so a launch still waiting on the kept build's first row does not start its search after a Stop. */
  private launchSeq = 0;
  /** The kept build's own start row (snapshot and text) from its first, one-try solve: kept on screen, and served by `resultXml`, until the search's own solve lists the same row. */
  private keptRow: { snap: SolveSnapshot; id: string; xml: string } | null = null;
  /** The player's message the form was opened from, so the AI's late plan for it merges into the form instead of replacing it. */
  private asked: string | null = null;

  constructor(private readonly deps: SolveDeps) {}

  get state(): SolveState {
    return this.s;
  }

  private set(patch: Partial<SolveState>, reveal = false): void {
    this.s = { ...this.s, ...patch };
    if (patch.error === undefined && 'error' in patch) delete this.s.error;
    this.deps.push(this.s, reveal);
  }

  private open() {
    const o = this.deps.open();
    if (!o) throw new SolveError('No build is open in Path of Mastery.');
    return o;
  }

  /** Shows the Solve panel as it is. */
  reveal(): void {
    this.deps.push(this.s, true);
  }

  /** Puts a goal in the Solve form. Nothing runs until `run` (the player's Run button, or "go"). */
  async setGoal(goal: SolveGoal, opts: { timeBudgetMs?: number; cpu?: SolveCpu } = {}, from: 'panel' | 'assistant' = 'panel', notes: string[] = []): Promise<SolveState> {
    const o = this.open();
    this.warmPrices(goal);
    // A panel edit on the open build only updates the stored goal ("go" runs it); results on screen stay, a running solve is untouched.
    if (from === 'panel' && this.s.buildKey === o.buildKey && this.s.status !== 'ready' && this.s.status !== 'idle') {
      this.set({ goal, ...(opts.timeBudgetMs ? { timeBudgetMs: opts.timeBudgetMs } : {}), ...(opts.cpu ? { cpu: opts.cpu } : {}) });
      return this.s;
    }
    if (from === 'assistant') this.asked = null;
    const round = from === 'assistant' && this.s.status === 'stalled' && this.s.buildKey === o.buildKey ? (this.s.round ?? 1) + 1 : 1;
    if (this.s.status === 'running') await this.stop(false);
    this.set(
      {
        buildKey: o.buildKey,
        round,
        replan: undefined,
        verdict: undefined,
        goal,
        ...(opts.timeBudgetMs ? { timeBudgetMs: opts.timeBudgetMs } : {}),
        ...(opts.cpu ? { cpu: opts.cpu } : {}),
        goalRev: this.s.goalRev + (from === 'assistant' ? 1 : 0),
        ...(from === 'assistant' ? { modeStated: !!goal.assume?.playMode } : {}),
        ...(notes.length ? { notes } : { notes: undefined }),
        status: 'ready',
        snapshot: null,
        error: undefined,
        block: undefined,
        startFrom: undefined,
        question: undefined,
        from,
      },
      from === 'assistant',
    );
    return this.s;
  }

  /** The kept build's unique prices, asked for while the player is still answering the questions, so its first check on Run does not wait on a cold price feed. */
  private warmed = new Set<string>();
  private warmPrices(goal: SolveGoal): void {
    const kept = keptFor(goal);
    const prices = this.deps.toolContext?.()?.prices;
    if (!kept || !prices || this.warmed.has(kept.id)) return;
    this.warmed.add(kept.id);
    const names = [...new Set(readEquipped(kept.xml).filter((i) => /unique/i.test(i.rarity) && i.name).map((i) => i.name))];
    void Promise.resolve(prices.lookup(names)).catch(() => this.warmed.delete(kept.id));
  }

  /** Opens the form from a build ask read from the player's words, before the AI has answered. Never starts a run; a solve in progress is left alone. */
  async openFromAsk(request: string, goal: SolveGoal): Promise<void> {
    if (this.s.status === 'running' || this.s.status === 'shortlisting' || this.s.status === 'stalled') return;
    await this.setGoal(goal, {}, 'assistant');
    this.asked = request;
  }

  /** The message the form (or the run started from it) belongs to, for the AI's goal that arrives for it; undefined once it does not. */
  askedFor(request?: string): string | undefined {
    const live = this.asked && this.s.buildKey === this.deps.open()?.buildKey && this.s.goal && (this.s.status === 'ready' || this.s.status === 'running' || this.s.status === 'shortlisting');
    return live && (!request || sameAsk(this.asked!, request)) ? this.asked! : undefined;
  }

  /** The AI's goal (already holding the player's answers, see keepAnswers) for the ask the form was opened from; a run already started goes on untouched (the plan waits for the next run). */
  mergeLate(goal: SolveGoal, opts: { timeBudgetMs?: number; cpu?: SolveCpu } = {}, notes: string[] = []): SolveState {
    if (this.s.status !== 'ready') {
      this.set({ goal, notes: notes.length ? notes : undefined });
      return this.s;
    }
    this.set({ goal, ...(opts.timeBudgetMs ? { timeBudgetMs: opts.timeBudgetMs } : {}), ...(opts.cpu ? { cpu: opts.cpu } : {}), goalRev: this.s.goalRev + 1, modeStated: !!goal.assume?.playMode, notes: notes.length ? notes : undefined, from: 'assistant' }, true);
    return this.s;
  }

  /** Starts the search on the open build, with the goal given or the one in the form. */
  async run(goal?: SolveGoal, opts: { timeBudgetMs?: number; cpu?: SolveCpu } = {}): Promise<SolveState> {
    return this.launch(goal, opts, 1);
  }

  /** "Keep improving": another run that starts from the best build so far (the engine keeps its tree and items as the start and lists it as a row, so nothing found is lost) with the next seed. */
  async keepImproving(): Promise<SolveState> {
    const o = this.open();
    const snap = this.s.snapshot;
    if (!this.solveId || this.s.buildKey !== o.buildKey || !this.s.goal || (this.s.status !== 'done' && this.s.status !== 'stopped') || !snap?.results.length) throw new SolveError('Keep improving needs a finished solve with a result on the open build.');
    const xml = await this.resultXml(snap.picks?.[0] ?? 0);
    return this.launch(this.s.goal, {}, (this.s.block ?? 1) + 1, xml);
  }

  /** One run of search for `goal` (`block` counts Keep improving: 1, 2, ...); `startXml` (Keep improving) is the build it starts from instead of the open build. */
  private async launch(goal: SolveGoal | undefined, opts: { timeBudgetMs?: number; cpu?: SolveCpu }, block: number, startXml?: string): Promise<SolveState> {
    const o = this.open();
    const asked = goal ?? (this.s.buildKey === o.buildKey ? this.s.goal : null);
    if (!asked?.skill?.trim()) throw new SolveError('The goal needs a main skill first.');
    if (!asked.wealth) throw new SolveError(NEED_WEALTH);
    if (!asked.assume?.playMode) throw new SolveError(NEED_MODE);
    // A kept build for this gem, ascendancy and tier is the start (PLAN.md slice 3): the first row is a whole, checked build. Keep improving starts from its own best instead.
    const kept = startXml ? null : keptFor(asked);
    const g = kept ? withKept(asked, kept) : asked;
    const seedXml = startXml ?? kept?.xml;
    const startFrom = kept ? { label: `Kept build, ${kept.tier === 'league-start' ? 'league start' : 'mid league'}`, level: kept.level, gearDivines: kept.gearDivines } : undefined;
    await this.cancelEngine();
    const timeBudgetMs = opts.timeBudgetMs ?? this.s.timeBudgetMs;
    const cpu = opts.cpu ?? this.s.cpu;
    const threads = threadsFor(cpu);
    let priority: SolvePriority | null = null;
    if (this.deps.shortlist && !kept) {
      this.set({ buildKey: o.buildKey, goal: g, timeBudgetMs, cpu, status: 'shortlisting', snapshot: null, error: undefined });
      priority = await this.deps.shortlist(g).catch(() => null);
    }
    const uniquePrices = await this.deps.uniquePrices?.().catch(() => null);
    const runPatch = { buildKey: o.buildKey, goal: g, timeBudgetMs, cpu, status: 'running' as const, error: undefined, question: undefined, block, startFrom };
    const token = this.launchSeq;
    let seed = seedXml;
    let shown: SolveSnapshot | null = null;
    this.keptRow = null;
    if (kept) {
      this.records.clear();
      this.resultRec.clear();
      const first = await this.keptFirstRow(kept.xml, g, uniquePrices, (snap, id) => {
        this.solveId = id;
        this.set({ ...runPatch, snapshot: snap });
      }).catch(() => null);
      if (token !== this.launchSeq) return this.s;
      if (first) {
        seed = first.xml;
        shown = first.snap;
        this.keptRow = { snap: first.snap, id: first.snap.results.find((r) => r.start)?.id ?? '', xml: first.xml };
      }
    }
    // The solver copies the build text at start, so the scratch copy can be closed at once.
    const from = seed ? (await this.deps.engine.send('loadBuild', { buildXml: seed })).buildId : o.buildId;
    let solveId: string;
    try {
      const options = { ...(timeBudgetMs ? { timeBudgetMs } : {}), ...(block > 1 ? { seed: block - 1 } : {}), ...(threads ? { threads } : {}) };
      ({ solveId } = await this.deps.engine.send('solveStart', { buildId: from, goal: { ...g, ...(priority ? { priority } : {}), ...(uniquePrices ? { uniquePrices } : {}) }, options }));
    } catch (e) {
      if (this.s.status === 'shortlisting') this.set({ status: 'ready' });
      throw e;
    } finally {
      if (seed) await this.deps.engine.send('closeBuild', { buildId: from }).catch(() => undefined);
    }
    this.solveId = solveId;
    if (!kept) {
      this.records.clear();
      this.resultRec.clear();
    }
    this.told = new Set();
    this.idleTold = false;
    // The kept row stays on screen until the search's first poll replaces it (same build, same id: its check carries over).
    this.set({ ...runPatch, snapshot: shown });
    this.schedule();
    return this.s;
  }

  /**
   * The kept build's own start row, listed and checked while the CPU is still free (under a running search one assessment takes tens of seconds). Returns the row's text and snapshot,
   * or null when the engine gives no row in time (the search then starts from the kept file and the row is checked when the player opens it).
   */
  private async keptFirstRow(xml: string, goal: SolveGoal, uniquePrices: Record<string, number> | null | undefined, show: (snap: SolveSnapshot, id: string) => void): Promise<{ xml: string; snap: SolveSnapshot } | null> {
    const { buildId } = await this.deps.engine.send('loadBuild', { buildXml: xml });
    let id: string;
    try {
      ({ solveId: id } = await this.deps.engine.send('solveStart', { buildId, goal: { ...goal, ...(uniquePrices ? { uniquePrices } : {}) }, options: { ...{ maxEvals: 1 }, threads: 1 } }));
    } finally {
      await this.deps.engine.send('closeBuild', { buildId }).catch(() => undefined);
    }
    for (const until = Date.now() + 10_000; Date.now() < until; await new Promise((r) => setTimeout(r, 200))) {
      const snap = await this.deps.engine.send('solveStep', { solveId: id, budgetMs: 0 });
      const at = snap.results.findIndex((r) => r.start);
      if (at >= 0) {
        show(snap, id);
        await this.assess(at).catch(() => undefined);
        return { xml: await this.resultXml(at), snap };
      }
      if (snap.error || snap.done) break;
    }
    await this.deps.engine.send('solveCancel', { solveId: id }).catch(() => undefined);
    return null;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), this.deps.pollMs ?? 1000);
  }

  private async poll(): Promise<void> {
    this.timer = null;
    const id = this.solveId;
    if (!id || this.s.status !== 'running') return;
    try {
      let snap = await this.deps.engine.send('solveStep', { solveId: id, budgetMs: 0 });
      if (id !== this.solveId || this.s.status !== 'running') return;
      // the search lists its start row a second or two after it starts: the kept row stays on screen meanwhile instead of vanishing
      if (this.keptRow && !snap.results.length) snap = { ...snap, results: this.keptRow.snap.results, picks: this.keptRow.snap.picks };
      // A planned run that stalls goes back to the AI for new leads (the panel sends `replan` as a chat turn); met or unplanned ends.
      const end = endOf(snap);
      const planned = !!planOf(this.s.goal)?.leads.length;
      const stalled = !snap.error && snap.done && end?.reason === 'stalled' && planned;
      // Each lead that stalls goes to the AI at once: one Solve update per new batch (the panel holds at most one pending turn and merges).
      const live = planned && !snap.error && !snap.done;
      const fresh = live ? (snap.stalls ?? []).filter((x) => !this.told.has(x.id)) : [];
      const idle = live && !!snap.idle;
      const tell = fresh.length > 0 || (idle && !this.idleTold);
      for (const x of fresh) this.told.add(x.id);
      if (idle) this.idleTold = true;
      // A solve that ends (met, or out of leads without a stall) gives the AI exactly one finish turn, keyed once per solve.
      const finished = !snap.error && snap.done && !stalled;
      const update = stalled ? { replan: replanText(this.s.round ?? 1, end!), replanKey: `${id}:end` } : finished ? { replan: finishText(snap), replanKey: `${id}:finish` } : tell ? { replan: stallText(fresh.length ? fresh : (snap.stalls ?? []), idle), replanKey: `${id}:${[...this.told].join(',')}${idle ? ':idle' : ''}` } : {};
      this.set({ snapshot: snap, status: snap.error ? 'error' : stalled || idle ? 'stalled' : snap.done ? 'done' : 'running', error: snap.error, ...update });
      if (this.s.status === 'running') this.schedule();
    } catch (e) {
      if (id === this.solveId) this.set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async cancelEngine(): Promise<void> {
    this.launchSeq++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // (stalled: the engine may be idle waiting for leads; it still holds the solve)
    if (this.solveId && (this.s.status === 'running' || this.s.status === 'stalled')) await this.deps.engine.send('solveCancel', { solveId: this.solveId }).catch(() => undefined);
  }

  /** The AI's new or replacement leads, into the running solve (they join its lead loop); a solve that already ended starts again with them. */
  async addLeads(leads: SolvePlanLead[]): Promise<SolveState> {
    const o = this.open();
    if (!this.solveId || this.s.buildKey !== o.buildKey || !this.s.goal || (this.s.status !== 'running' && this.s.status !== 'stalled')) throw new SolveError('There is no running solve for the open build; start one with startSolve.');
    const r = await this.deps.engine.send('solveAddLeads', { solveId: this.solveId, leads });
    if (!r.running) return this.run({ ...this.s.goal, plan: { leads } } as SolveGoal);
    this.idleTold = false;
    this.set({ goal: { ...this.s.goal, plan: { leads: [...(planOf(this.s.goal)?.leads ?? []), ...leads] } } as SolveGoal, status: 'running', replan: undefined, replanKey: undefined });
    this.schedule();
    return this.s;
  }

  /** Ends a planned run the AI has no credible leads left for: its reason plus the best build's misses, in the panel. */
  async finish(why: string): Promise<SolveState> {
    if (this.s.status === 'running' || this.s.status === 'stalled') await this.stop(false);
    this.set({ status: 'done', replan: undefined, replanKey: undefined, verdict: { why, gaps: gapLines(this.s.snapshot) } });
    return this.s;
  }

  /** Stops the search; the results found so far stay. The player's Stop gives the AI its one closing turn (`closing`); the AI's own stop does not. */
  async stop(closing = true): Promise<SolveState> {
    // stalled: waiting on the AI's next leads (the engine idles); Stop ends the loop there too
    if ((this.s.status !== 'running' && this.s.status !== 'stalled') || !this.solveId) return this.s;
    const id = this.solveId;
    const ends = closing && this.s.status === 'running';
    await this.cancelEngine();
    const snap = await this.deps.engine.send('solveStep', { solveId: id, budgetMs: 0 }).catch(() => this.s.snapshot);
    // The same key as a run's own end: one closing turn per solve, whichever way it ends.
    const update = ends && snap?.results.length ? { replan: finishText(snap, true), replanKey: `${id}:finish` } : { replan: undefined, replanKey: undefined };
    this.set({ status: 'stopped', snapshot: snap, ...update });
    return this.s;
  }

  /** An assistant turn ended. When it answered "every lead has stalled" and added no lead (the run still waits), the run ends here with its closing turn instead of waiting for ever. */
  async turnEnded(text: string): Promise<void> {
    const id = this.solveId;
    if (!id || this.s.status !== 'stalled' || !this.s.snapshot?.idle || !text.includes(IDLE_HEAD)) return;
    await this.cancelEngine();
    const snap = await this.deps.engine.send('solveStep', { solveId: id, budgetMs: 0 }).catch(() => this.s.snapshot);
    if (id !== this.solveId || this.s.status !== 'stalled') return;
    this.set({ status: 'done', snapshot: snap, ...(snap?.results.length ? { replan: finishText(snap), replanKey: `${id}:finish` } : { replan: undefined, replanKey: undefined }) });
  }

  /** The open build changed: a solve belongs to the build it was started on, so another build drops it. */
  setBuild(buildKey: string | null): void {
    // null is the panel letting go for a moment (an effect re-running); only another build drops the solve.
    if (this.s.buildKey === null || buildKey === null || this.s.buildKey === buildKey) return;
    void this.cancelEngine();
    this.solveId = null;
    this.asked = null;
    this.records.clear();
    this.resultRec.clear();
    this.set({ ...IDLE, block: undefined, question: undefined, goalRev: this.s.goalRev, timeBudgetMs: this.s.timeBudgetMs, cpu: this.s.cpu });
  }

  private resultCount(): number {
    return this.s.snapshot?.results.length ?? 0;
  }

  async resultXml(index: number): Promise<string> {
    const o = this.open();
    if (!this.solveId || this.s.buildKey !== o.buildKey) throw new SolveError('There is no solve for the open build.');
    if (!Number.isInteger(index) || index < 0 || index >= this.resultCount()) throw new SolveError(`There is no result ${index}; the solve has ${this.resultCount()}.`);
    // By the record id, so a re-sort between the list and the fetch cannot hand back another build; the text must hash to that id.
    const id = this.s.snapshot?.results[index]?.id;
    if (id && id === this.keptRow?.id) return this.keptRow.xml;
    if (!id) return (await this.deps.engine.send('solveResult', { solveId: this.solveId, index })).xml;
    const { xml } = await this.deps.engine.send('solveResult', { solveId: this.solveId, id });
    if (resultHash(xml) !== id) throw new SolveError('The solver returned a different build than result ' + (index + 1) + ' of the list. Open the result again.');
    return xml;
  }

  /** Assessed records by id, frozen when a result is assessed. Apply takes an id from here, never a result's index, which a re-sort moves. */
  private records = new Map<string, { rec: AssessedCandidate; xml: string; title: string; summary: string; assumptions: string[] }>();
  /** The engine's id of a result (the hash of its text) to the id of its record (the hash of the text Apply sets, which differs when fixes were made). */
  private resultRec = new Map<string, string>();

  /** One assessment at a time: each opens scratch builds and the engine keeps only six (it drops the oldest), so rows asked together would close each other's copies. */
  private assessChain: Promise<unknown> = Promise.resolve();

  /** Fetches result `index` once, assesses it against the open build and freezes the record (an unchanged result on an unchanged build reuses its record). */
  private assess(index: number) {
    const run = this.assessChain.then(() => this.assessNow(index));
    this.assessChain = run.catch(() => undefined);
    return run;
  }

  private async assessNow(index: number) {
    const o = this.open();
    const xml = await this.resultXml(index);
    const liveXml = (await this.deps.engine.send('getBuildXml', { buildId: o.buildId })).buildXml;
    const hit = this.records.get(this.resultRec.get(resultHash(xml)) ?? '');
    if (hit && hit.rec.sourceRevision === xmlHash(liveXml)) return { ...hit, liveXml };
    const r = this.s.snapshot?.results[index];
    const sidebar = await this.tileOf(xml).catch(() => undefined);
    const ctx = this.deps.toolContext?.() ?? ({ engine: this.deps.engine, open: this.deps.open, proposals: this.deps.proposals, tree: this.deps.tree, origin: 'panel' } as ToolContext);
    const { rec, xml: applyXml } = await assessCandidate(ctx, { solveId: this.solveId!, xml, liveBuildId: o.buildId, liveXml, ...(sidebar ? { sidebar } : {}), ...(r?.targets ? { targets: r.targets } : {}) });
    // The card shows the build Apply sets: with fixes, its tile is read from the fixed text.
    if (applyXml !== xml) {
      const t = await this.tileOf(applyXml).catch(() => undefined);
      if (t) rec.sidebar = t;
    }
    const entry = {
      rec,
      xml: applyXml,
      title: `Solver result ${index + 1}: ${r?.ascendancy ?? r?.className ?? 'build'}`,
      summary: (r?.targets ?? []).map((t) => `${t.name} ${Math.round(t.shown ?? t.value).toLocaleString('en-US')}`).join(' · '),
      assumptions: [...(r?.assumptions ?? []), ...(this.s.snapshot?.assumptions ?? [])],
    };
    this.records.set(rec.id, entry);
    this.resultRec.set(rec.xmlHash, rec.id);
    return { ...entry, liveXml };
  }

  /** Result `index` as the assessment leaves it: the build with the listed fixes (`xml`), its record, and the open build's text. */
  fixedResult(index: number) {
    return this.assess(index);
  }

  /** What the checks found for the rows the AI reads: the picks (or the first three rows), assessed now when the panel has not done it yet. */
  async checked(): Promise<Map<number, ReturnType<typeof recordView>>> {
    const out = new Map<number, ReturnType<typeof recordView>>();
    const snap = this.s.snapshot;
    if (!this.solveId || !snap?.results.length) return out;
    for (const i of (snap.picks?.length ? snap.picks : snap.results.map((_, k) => k)).slice(0, 3)) {
      if (snap.results[i]?.start) continue;
      try {
        out.set(i, recordView((await this.assess(i)).rec));
      } catch {
        // the row stays unchecked: no verdict is better than a wrong one
      }
    }
    return out;
  }

  /** The assistant's one question, as buttons in the panel. */
  ask(text: string, options: string[]): SolveState {
    this.set({ question: { text, options } }, true);
    return this.s;
  }

  /** A result next to the open build: what changes per layer and the engine's stat deltas (nothing is changed). */
  async details(index: number): Promise<SolveDetails & { xml: string; baseHash: string }> {
    const d = await this.view(await this.assess(index));
    // the card shows the sidebar's EHP, not the solver's (its config differs)
    const ehp = d.deltas.find((x) => x.statId === 'TotalEHP')?.after;
    const snap = this.s.snapshot && typeof ehp === 'number' ? withSidebarEhp(this.s.snapshot, index, ehp) : null;
    if (snap) this.set({ snapshot: snap });
    return { index, ...d.out };
  }

  private async view(a: Awaited<ReturnType<SolveManager['assessNow']>>) {
    const o = this.open();
    const pv = await this.deps.engine.send('previewEdit', { buildId: o.buildId, edit: { kind: 'setXml', xml: a.xml }, full: true });
    const scalar = (v: unknown): v is Scalar => v === null || typeof v !== 'object';
    const deltas = pv.statDiff.changed.filter((c) => scalar(c.before) && scalar(c.after)).map((c) => ({ statId: c.statId, before: c.before as Scalar, after: c.after as Scalar }));
    const diff = await solveLayers(a.liveXml, a.xml, this.deps.tree, a.assumptions);
    return { deltas, out: { ...diff, changes: pickChanges(deltas, 8), xml: a.xml, baseHash: a.rec.sourceRevision, assessed: a.rec, ...(a.rec.sidebar ? { tile: a.rec.sidebar } : {}) } };
  }

  /** The sidebar's first tile for a result: its XML loaded as a scratch build and read the way Sidebar.tsx reads it (the minion's rows come from buildSidebar, which hides some). */
  private async tileOf(xml: string): Promise<NonNullable<SolveDetails['tile']>> {
    const { buildId } = await this.deps.engine.send('loadBuild', { buildXml: xml });
    try {
      const [{ stats }, skill] = await Promise.all([this.deps.engine.send('getStats', { buildId }), this.deps.engine.send('mainSkill', { buildId })]);
      const raw = Object.fromEntries(stats.map((x) => [x.id, x.value])) as Record<string, unknown>;
      const minionBy = new Map<string, number>();
      if (raw.Minion && typeof raw.Minion === 'object') for (const r of buildSidebar(normaliseOutput(raw.Minion as Record<string, unknown>), new Set(skill.minion?.flags ?? []), DEFAULT_NUMBER_FORMAT, minionDisplayStats, 'minion').rows) if (!minionBy.has(r.stat)) minionBy.set(r.stat, r.value);
      return cardTile((id) => (id.startsWith('Minion.') ? minionBy.get(id.slice(7)) : typeof raw[id] === 'number' ? (raw[id] as number) : undefined));
    } finally {
      await this.deps.engine.send('closeBuild', { buildId }).catch(() => undefined);
    }
  }

  /** ONE card for a result: the whole build as one `setXml` edit, applied or undone in one step. `ref` is a record id from the card (the panel) or a result index (the assistant, assessed right here); an id never re-reads the list. */
  async propose(ref: number | string, origin: 'panel' | 'external', store: Pick<ProposalStore, 'create'> = this.deps.proposals, buildId?: string): Promise<Proposal> {
    const o = this.open();
    let a: Awaited<ReturnType<SolveManager['assessNow']>>;
    if (typeof ref === 'number') a = await this.assess(ref);
    else {
      const e = this.records.get(ref);
      if (!e) throw new SolveError('This result is no longer in the solve. Open it again.');
      a = { ...e, liveXml: (await this.deps.engine.send('getBuildXml', { buildId: o.buildId })).buildXml };
    }
    if (xmlHash(a.liveXml) !== a.rec.sourceRevision) throw new SolveError('The open build changed after this card was drawn, so its numbers are out of date. Open the result again.');
    // "Not ready" cannot be made or used in game: no card, so nothing can apply it.
    if (a.rec.verdict === 'notReady') throw new SolveError(`${a.title} is not ready, so it cannot be applied: ${a.rec.why}`);
    const d = (await this.view(a)).out;
    return store.create({
      buildId: buildId ?? o.buildId,
      buildKey: o.buildKey,
      removedIds: d.removedIds,
      addedIds: d.addedIds,
      title: a.title,
      summary: a.summary,
      edits: [{ kind: 'setXml', xml: d.xml }],
      kind: 'changes',
      removed: [],
      added: [],
      lines: d.layers.map((l) => l.text),
      gems: [],
      changes: d.changes,
      origin,
      baseHash: d.baseHash,
    });
  }
}

// ---- what changes per layer ------------------------------------------------------------------------------------

function kid(n: XmlNode | undefined, tag: string): XmlNode | undefined {
  return n?.children.find((c) => c.tag === tag);
}

function buildAttrs(xml: string): Record<string, string> {
  try {
    return kid(parseXml(xml), 'Build')?.attrs ?? {};
  } catch {
    return {};
  }
}

const list = (xs: string[], max = 6) => (xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', '));

/** One plain line per layer that differs between the open build and a solver result. */
export async function solveLayers(beforeXml: string, afterXml: string, tree: Pick<TreeData, 'classes' | 'all'>, assumptions: string[] = []): Promise<Pick<SolveDetails, 'layers' | 'addedIds' | 'removedIds'>> {
  const layers: SolveDetails['layers'] = [];
  const specOf = (xml: string) => {
    const s = readSpecSummaries(xml);
    return s.specs[s.active - 1] ?? s.specs[0];
  };
  const a = specOf(beforeXml);
  const b = specOf(afterXml);
  const version = b?.treeVersion ?? a?.treeVersion ?? '';

  // class, ascendancy, level, bandit
  const { classes } = await tree.classes(version).catch(() => ({ classes: [] as Array<{ classId: number; name: string; ascendancies: Array<{ ascendClassId: number; name: string }> }> }));
  const who = (s: typeof a) => {
    if (!s) return 'none';
    const c = classes.find((x) => x.classId === s.classId);
    const asc = c?.ascendancies.find((x) => x.ascendClassId === s.ascendClassId)?.name;
    return asc ? `${c?.name ?? `class ${s.classId}`} (${asc})` : (c?.name ?? `class ${s.classId}`);
  };
  const cls: string[] = [];
  if (a?.classId !== b?.classId || a?.ascendClassId !== b?.ascendClassId) cls.push(`${who(a)} → ${who(b)}`);
  const ba = buildAttrs(beforeXml);
  const bb = buildAttrs(afterXml);
  if ((ba.level ?? '') !== (bb.level ?? '') && bb.level) cls.push(`level ${ba.level ?? '?'} → ${bb.level}`);
  if ((ba.bandit ?? 'None') !== (bb.bandit ?? 'None')) cls.push(`bandit ${bb.bandit === 'None' || !bb.bandit ? 'kill all' : bb.bandit}`);
  if (cls.length) layers.push({ layer: 'class', text: `Class: ${cls.join(', ')}` });

  // tree
  const before = new Set(a?.nodes ?? []);
  const after = new Set(b?.nodes ?? []);
  const addedIds = [...after].filter((id) => !before.has(id));
  const removedIds = [...before].filter((id) => !after.has(id));
  const masteryKey = (s: typeof a) => new Set((s?.masteries ?? []).map(([n, e]) => `${n}:${e}`));
  const ma = masteryKey(a);
  const mb = masteryKey(b);
  const masteryChanges = [...mb].filter((k) => !ma.has(k)).length;
  if (addedIds.length || removedIds.length || masteryChanges) {
    const all = await tree.all(version).catch(() => new Map<number, { name: string; type: string }>());
    const notable = addedIds.map((id) => all.get(id)).filter((n): n is { name: string; type: string } => !!n && (n.type === 'Notable' || n.type === 'Keystone')).map((n) => n.name);
    const bits = [`allocate ${addedIds.length}`, `remove ${removedIds.length}`];
    if (masteryChanges) bits.push(`${masteryChanges} mastery ${masteryChanges === 1 ? 'effect' : 'effects'}`);
    layers.push({ layer: 'tree', text: `Tree: ${bits.join(', ')}${notable.length ? `; ${list(notable)}` : ''}` });
  }

  // gems: the enabled gems of the active skill set, by name
  const gemNames = (xml: string) => new Set(readSkills(xml).filter((g) => g.enabled).flatMap((g) => g.gems.filter((x) => x.enabled && x.name).map((x) => x.name)));
  const ga = gemNames(beforeXml);
  const gb = gemNames(afterXml);
  const gemAdd = [...gb].filter((g) => !ga.has(g));
  const gemDrop = [...ga].filter((g) => !gb.has(g));
  const main = readSkills(afterXml).find((g) => g.isMain);
  if (gemAdd.length || gemDrop.length) {
    const bits: string[] = [];
    if (main) bits.push(`main link ${main.gems.filter((x) => x.enabled).map((x) => x.name).join(' + ')}`);
    if (gemAdd.length) bits.push(`add ${list(gemAdd, 8)}`);
    if (gemDrop.length) bits.push(`remove ${list(gemDrop, 8)}`);
    layers.push({ layer: 'gems', text: `Gems: ${bits.join('; ')}` });
  }

  // items, by slot
  const slots = (xml: string) => new Map(readEquipped(xml).map((i) => [i.slot, i.name || i.base]));
  const ia = slots(beforeXml);
  const ib = slots(afterXml);
  const itemBits: string[] = [];
  for (const slot of new Set([...ia.keys(), ...ib.keys()])) {
    const x = ia.get(slot);
    const y = ib.get(slot);
    if (x !== y) itemBits.push(`${slot} ${y ? (x ? `${x} → ${y}` : y) : `empty (was ${x})`}`);
  }
  if (itemBits.length) layers.push({ layer: 'items', text: `Items: ${list(itemBits, 5)}` });

  // config assumptions: changed inputs, plus what the solver says it assumed
  const ca = new Map(readConfig(beforeXml).map((c) => [c.name, c.value]));
  const cb = new Map(readConfig(afterXml).map((c) => [c.name, c.value]));
  const cfg: string[] = [];
  for (const k of new Set([...ca.keys(), ...cb.keys()])) {
    if (ca.get(k) === cb.get(k)) continue;
    const v = cb.get(k);
    cfg.push(v === undefined ? `${k} default` : v === true ? `${k} on` : v === false ? `${k} off` : `${k} ${String(v)}`);
  }
  if (cfg.length || assumptions.length) layers.push({ layer: 'config', text: `Config: ${list(assumptions.length ? assumptions : cfg, 10)}` });

  return { layers, addedIds, removedIds };
}

// ---- the assistant's solve tools ---------------------------------------------------------------------------------

const names = (max: number) => z.array(z.string().min(1).max(100)).max(max).optional();
export const SolveGoalSchema = z.object({
  skill: z.string().min(1).max(100).describe('Main skill gem name, e.g. "Poisonous Concoction".'),
  className: z.string().max(20).optional().describe('Set whenever the player names a class (Templar, Witch, Marauder, ...), even with an ascendancy: the solver then only tries that class. Without it the solver tries every class that fits the skill.'),
  ascendancy: z.string().max(40).optional().describe('Set whenever the player names an ascendancy; otherwise the solver tries the ascendancies of the classes that fit the skill.'),
  level: z.number().int().min(1).max(100).optional().describe('Character level: its passive points, every quest point, 8 ascendancy points, gem and item levels.'),
  targets: z
    .array(
      z.object({
        name: z.string().min(1).max(60).describe('Short name the player sees, e.g. "DPS".'),
        metric: z.string().max(60).optional().describe('dps (default; bare "DPS" = single target, no cull, the tested figure) | hit | dot | boss | full (Full DPS, only when asked for by name) | clear (pack clear, only when asked for by name) | ehp (TotalEHP) | maxhit:<fire|cold|lightning|chaos|physical> | pool | life | es | resist:<element> | stat:<engine output key>'),
        value: z.number().positive().optional().describe('The number the player wants; leave out for "as high as possible".'),
        weight: z.number().positive().max(10).optional(),
      }),
    )
    .max(6)
    .optional(),
  limits: z
    .object({
      resists: z.number().min(0).max(90).nullable().optional().describe('Elemental resists at least this (default 75); null turns it off.'),
      pool: z.number().min(0).max(100000).nullable().optional().describe('Life at least this (energy shield counts for energy shield builds); leave out for the wealth-tier floor; null turns it off.'),
      attributes: z.boolean().optional(),
      reservation: z.boolean().optional(),
      warnings: z.boolean().optional(),
      cost: z.boolean().optional(),
      extra: z.array(z.object({ name: z.string().max(60).optional(), stat: z.string().min(1).max(60), min: z.number().optional(), max: z.number().optional() })).max(8).optional(),
    })
    .optional()
    .describe('Hard limits; all on by default (resists 75, life floor of the wealth tier, attributes, reservation, no warnings, sustainable cost). Only loosen what the player asks.'),
  gems: z.object({ require: names(12), ban: names(12) }).optional(),
  items: z
    .object({
      rarities: z.array(z.enum(['normal', 'magic', 'rare', 'unique'])).max(4).optional(),
      mustUse: names(12).describe('Uniques the build must use.'),
      neverUse: names(12).describe('Uniques it must never use.'),
      lockSlots: z.array(z.string().min(1).max(40)).max(20).optional().describe('Slots kept as they are, e.g. "Weapon 1".'),
      slotRarities: z
        .record(z.string().min(1).max(40), z.array(z.enum(['normal', 'magic', 'rare', 'unique'])).min(1).max(4))
        .optional()
        .describe('Rarities one slot may hold, e.g. {"Weapon 1": ["unique"]}. Use it when the player says "a unique weapon/helmet/..." without naming the item; the solver then picks the best unique for that slot.'),
    })
    .optional(),
  assume: z
    .object({
      flasks: z.boolean().optional(),
      flasksAlways: z.boolean().optional(),
      flaskUptime: z.enum(['mapping', 'bossing']).optional(),
      ailments: z.boolean().optional(),
      charges: z.boolean().optional(),
      playMode: z.enum(['mapping', 'bossing', 'both']).optional().describe('What the player does with the build: mapping (normal map monsters; kill-based effects count), bossing (pinnacle boss, no kill effects) or both (must be good at both). Set it only when the player said which; otherwise leave it out and the panel asks.'),
      configOn: z.array(z.string().min(1).max(80)).max(40).optional().describe('Config switch keys the player wants on (e.g. "conditionOnConsecratedGround"), usually offers from an earlier result the player accepted. The solver sets them on every candidate.'),
    })
    .optional()
    .describe('Config the solver may assume (normal uptime only). Flasks count only when the build sustains them: flaskUptime mapping (default) counts charges from kills too, bossing only charges the build generates; flasksAlways: true counts every flask as always on (only when the player says so). Every other config switch the solver sets per candidate from what the build has (Fortify support -> Fortified, melee strike -> 15 units from the enemy, ...); each result lists them (configOn) and offers close calls with what they add (offers).'),
  rolls: z.enum(['typical', 'perfect']).optional().describe('Crafted rares: typical (default, the middle of the top two tiers) or perfect (best tier, top roll; only when the player asks).'),
  wealth: z
    .enum(['league-start', 'mid-league', 'rich', 'mirror'])
    .optional()
    .describe(
      "How rich the player is; it limits the gear the solver may use. league-start: normal rares, bench crafts, essences, cheap uniques. mid-league: + one influence, low eldritch implicits, fossils, cluster jewels, any priced unique within the whole-build budget of about 10 divines. rich: + two influences, top eldritch, one corruption implicit, uniques up to about 20 divines. mirror: everything. Set it ONLY when the player says how rich they are (or their budget); never guess. If they did not, leave it out and ask them in your reply. The solve cannot run without it.",
    ),
  plan: z
    .object({
      leads: z
        .array(
          z.object({
            name: z.string().min(1).max(80).describe('Short lead name in player words, e.g. "Pathfinder flask poison".'),
            className: z.string().max(20).optional(),
            ascendancy: z.string().max(40).optional(),
            uniques: names(8).describe('Key uniques this lead is built on.'),
            supports: names(8).describe('Main-link support gems.'),
            keystones: names(6),
            why: z.string().max(200).optional().describe('One clause: how it scales damage and reaches the defence ask.'),
          }),
        )
        .min(1)
        .max(6),
    })
    .optional()
    .describe('Your build plan as a seasoned player: 3 to 5 distinct leads (different ascendancy, weapon or damage route) for the solver to test first.'),
  bandit: z.enum(['None', 'Oak', 'Kraityn', 'Alira']).optional(),
  passivePoints: z.number().int().min(0).max(200).optional(),
  ascendancyPoints: z.number().int().min(0).max(8).optional(),
});

function solver(ctx: ToolContext): SolveManager {
  if (!ctx.solve) throw new ToolError('The build solver is not available here.');
  return ctx.solve;
}

const round = (v: number) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100);

/** A record as the AI reads it: the verdict, what a player would fault (`blocks`: cannot be made or used in game), the fixes the assessment made with their engine change, the targets after them, and how much of the kit has a market price. */
export function recordView(rec: AssessedCandidate) {
  return {
    verdict: rec.verdict,
    why: rec.why,
    ...(rec.findings.length ? { findings: rec.findings.map((f) => ({ text: f.text, ...(f.hard && !f.fix ? { blocks: true } : {}), ...(f.fix ? { fix: f.fix } : {}) })) } : {}),
    ...(rec.fixes.length ? { fixesMade: rec.fixes.map((f) => ({ what: f.what, change: f.delta })) } : {}),
    ...(rec.goal?.length ? { targetsAfterFixes: rec.goal } : {}),
    price: rec.price.coverage === null ? null : { divines: rec.price.divines, uniquesPriced: Math.round(rec.price.coverage * 100), ...(rec.price.unpriced.length ? { unpriced: rec.price.unpriced } : {}) },
  };
}

/** The solve as the assistant reads it: progress and one compact row per trade-off build; `checked` adds each assessed row's record. */
export function solveView(st: SolveState, checked?: Map<number, ReturnType<typeof recordView>>) {
  const snap = st.snapshot;
  return {
    status: st.status,
    ...(st.error ? { error: st.error } : {}),
    goal: st.goal,
    timeBudgetSeconds: st.timeBudgetMs ? Math.round(st.timeBudgetMs / 1000) : null,
    cpu: st.cpu,
    ...(st.round ? { round: st.round } : {}),
    ...(st.verdict ? { verdict: st.verdict } : {}),
    ...(endOf(snap)?.leads ? { leadResults: endOf(snap)!.leads } : {}),
    ...(snap
      ? {
          progress: { layer: snap.layer, candidate: snap.candidate ?? null, elapsedSeconds: Math.round(snap.elapsedMs / 1000), evaluations: snap.evaluations },
          assumptions: snap.assumptions ?? [],
          ...(snap.honestSummary ? { honestSummary: snap.honestSummary } : {}),
          // The solver's best leads that differ, best first (indexes into results); absent while it has none.
          ...(snap.picks?.length ? { picks: snap.picks } : {}),
          ...(snap.leads?.length ? { leadsTried: snap.leads.length, leadsLeft: snap.leads.filter((l) => l.status !== 'dropped').length } : {}),
          results: snap.results.map((r, i) => ({
            index: i,
            build: r.ascendancy ? `${r.className} (${r.ascendancy})` : r.className,
            ...(r.lead ? { lead: { label: r.lead.label, weapon: r.lead.weapon.name, damage: r.lead.damage, crit: r.lead.crit, ...(r.lead.differs.length ? { differs: r.lead.differs } : {}), ...(r.lead.similar ? { similar: true } : {}) } } : {}),
            ...(r.costDivines !== undefined && !r.start ? { costDivines: round(r.costDivines) } : {}),
            ...(r.bossChips?.length ? { bossOneShots: r.bossChips } : {}),
            ...(r.bossBreakdown ? { bossBreakdown: r.bossBreakdown } : {}),
            ...(r.life !== undefined ? { life: round(r.life) } : {}),
            ...(r.energyShield !== undefined ? { energyShield: round(r.energyShield) } : {}),
            ...(r.start ? { yourBuild: true } : {}),
            ...(r.belowStart ? { belowYourBuild: true } : {}),
            ...(r.honest?.flagged ? { honestRecheck: r.honest.text } : {}),
            targets: r.targets.map((t) => ({ name: t.name, value: round(t.shown ?? t.value), target: t.target === null ? null : round(t.target), met: t.met })),
            limitsMet: r.limitsMet,
            ...(r.checks?.some((c) => c.status === 'unmet') ? { basicsMissing: r.checks.filter((c) => c.status === 'unmet').map((c) => `${c.label} (${c.level})`) } : {}),
            blocking: r.blocking ? (r.blocking.kind === 'limit' ? `limit: ${r.blocking.name}` : `target: ${r.blocking.name}`) : null,
            mainLink: r.gems.main,
            ...(checked?.get(i) ? { assessed: checked.get(i) } : {}),
          })),
        }
      : {}),
  };
}

const unsolved = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    throw e instanceof SolveError ? new ToolError(e.message) : e;
  }
};

const CLASS_ASC: Array<[string, string[]]> = CLASSES.map((c) => [c.name, c.ascendancies]);
const OWN_BUILD = /\b(my|this|current|open)\s+(build|character|char)\b|\bimprove\b/i;

/** The goal's class and ascendancy only when the player named them or works on the open build: the open build's class is not a plan (a pconc ask once got Templar). */
export function namedOnly(request: string, goal: SolveGoal): SolveGoal {
  if (OWN_BUILD.test(request)) return goal;
  const has = (w: string) => new RegExp(`\\b${w}\\b`, 'i').test(request);
  const out = { ...goal };
  const cls = CLASS_ASC.find(([c]) => c.toLowerCase() === (goal.className ?? '').toLowerCase());
  if (goal.className && !has(goal.className) && !cls?.[1].some(has)) delete out.className;
  if (goal.ascendancy && !has(goal.ascendancy)) delete out.ascendancy;
  return out;
}
const SLOT_WORDS: Array<[string, string]> = [['weapon', 'Weapon 1'], ['helmet', 'Helmet'], ['body armour', 'Body Armour'], ['gloves', 'Gloves'], ['boots', 'Boots'], ['amulet', 'Amulet'], ['belt', 'Belt']];

/** What the player's message asked for (a class, an ascendancy, a unique in a slot) that `goal` does not hold. Plain matching. */
export function droppedConstraints(request: string, goal: SolveGoal): string[] {
  const text = request.toLowerCase();
  const has = (w: string) => new RegExp(`\\b${w.toLowerCase()}\\b`).test(text);
  const out: string[] = [];
  const g = goal as SolveGoal & { className?: string };
  const goalClass = (g.className || CLASS_ASC.find(([, a]) => a.some((x) => x.toLowerCase() === (g.ascendancy ?? '').toLowerCase()))?.[0] || '').toLowerCase();
  for (const [cls, ascs] of CLASS_ASC) {
    if (cls !== 'Scion' && has(cls) && goalClass !== cls.toLowerCase()) out.push(`You asked for ${cls}; the goal ${goalClass ? `is set to ${goalClass}` : 'allows any class'}.`);
    for (const a of ascs) if (has(a) && (g.ascendancy ?? '').toLowerCase() !== a.toLowerCase()) out.push(`You asked for ${a}; the goal ${g.ascendancy ? `is set to ${g.ascendancy}` : 'allows any ascendancy'}.`);
  }
  const items = (goal.items ?? {}) as { slotRarities?: Record<string, string[]>; mustUse?: string[]; lockSlots?: string[] };
  for (const [word, slot] of SLOT_WORDS) {
    if (!new RegExp(`\\bunique\\s+${word}\\b`).test(text)) continue;
    const r = Object.entries(items.slotRarities ?? {}).find(([k]) => k.toLowerCase() === slot.toLowerCase())?.[1];
    if (!r?.includes('unique') && !items.mustUse?.length && !items.lockSlots?.includes(slot)) out.push(`You asked for a unique ${word}; the goal lets ${slot} be any rarity.`);
  }
  return out;
}

export const SOLVE_TOOLS: ToolDef[] = [
  {
    name: 'startSolve',
    chip: 'Set up solve',
    description:
      "Turns the player's request and your build plan (goal.plan) into a build solver goal, opens it in the Solve panel. The panel asks Wealth and Mapping/Bossing/Both every time, filled from the player's own words, and the solve starts when the player presses Run. It runs until every target is met within the hard limits, or until the search stops gaining, then ends by itself with an answer; the player can press Keep improving to search on from the best build. The solver tests your leads first, then searches class/ascendancy, gems, tree and items for builds that reach the targets within the hard limits.",
    shape: {
      goal: SolveGoalSchema,
      timeBudgetSeconds: z.number().int().min(10).max(3600).optional().describe('Only when the player asks for a time limit.'),
      cpu: z.enum(['normal', 'gentle']).optional().describe('gentle uses a quarter of the cores so the PC stays quick.'),
      request: z.string().max(2000).optional().describe("The player's own message that asked for this solve, verbatim. The panel checks the goal against it and warns about anything dropped."),
    },
    run: (args, ctx) =>
      unsolved(async () => {
        const s = solver(ctx);
        if (typeof args.request === 'string' && !opensWizard(args.request)) return { note: 'This is a one-item or fix ask, not a build ask: answer it with the item and build tools. Do not open the Solve panel.' };
        const parsed = SolveGoalSchema.parse(args.goal) as SolveGoal;
        // The app keeps the player's message itself: the checks below run even when `request` is left out.
        const request = typeof args.request === 'string' ? args.request : s.askedFor();
        const merge = s.askedFor(request) !== undefined;
        // Tier and mode come from the player's own words only; the panel shows them filled and the player presses Run.
        const read = request !== undefined ? prefillFromAsk(request, namedOnly(request, parsed)) : parsed;
        const goal = merge ? keepAnswers(s.state.goal!, read) : read;
        const opts = { ...(typeof args.timeBudgetSeconds === 'number' ? { timeBudgetMs: args.timeBudgetSeconds * 1000 } : {}), ...(args.cpu === 'gentle' || args.cpu === 'normal' ? { cpu: args.cpu as SolveCpu } : {}) };
        const notes = request !== undefined ? droppedConstraints(request, goal) : [];
        if (merge) s.mergeLate(goal, opts, notes);
        else await s.setGoal(goal, opts, 'assistant', notes);
        const warn = notes.length ? ` The panel warns: ${notes.join(' ')} Fix the goal with startSolve if that was a mistake.` : '';
        return { ...solveView(s.state), note: 'The goal and your plan are in the Solve panel with Wealth and Mapping/Bossing/Both filled only from what the player said; the rest stay blank. Nothing runs until the player checks them and presses Run: show your plan as a short list and tell them in one line to check the questions and press Run. Do not ask them in chat.' + warn };
      }),
  },
  {
    name: 'addLeads',
    chip: 'Swap leads',
    description:
      'Adds new or replacement leads to the running solve (after a "Solve update" says a lead stalled). They join at once; the other leads keep running and the best builds so far stay. Set replaces to the stalled lead\'s name when a lead swaps one out.',
    shape: {
      leads: z
        .array(SolveGoalSchema.shape.plan.unwrap().shape.leads.element.extend({ replaces: z.string().max(80).optional().describe('The stalled lead this one replaces.') }))
        .min(1)
        .max(4),
    },
    run: (args, ctx) =>
      unsolved(async () => {
        const st = await solver(ctx).addLeads(args.leads as SolvePlanLead[]);
        return { ...solveView(st), note: 'The new leads are in the running solve. Tell the player in one line what you swapped and why.' };
      }),
  },
  {
    name: 'getSolve',
    chip: 'Read solve',
    description:
      'The current solve: status, progress (layer, elapsed, evaluations) and up to 8 trade-off builds, each with its target values, whether every hard limit is met and what blocks the goal. The picks (or the first three rows) also carry `assessed`: the verdict (ready, fix, objections = needs fixes but can be applied, notReady = cannot be made or used in game and cannot be applied), what a player would fault, the fixes already made with their engine change, the targets after them and the price cover. Report them as a compact table, one row per build, with placeholders for the numbers.',
    shape: {},
    run: async (_args, ctx) => {
      const s = solver(ctx);
      return solveView(s.state, await s.checked());
    },
  },
  {
    name: 'openSolveDraft',
    chip: 'Open result as draft',
    description:
      "Opens result `index` of the solve (an index from getSolve) as a draft with the assessment's fixes already in. Read it, run checkBuild with its draftId, repair what is edit-sized with editDraft and the ranking tools (bestSupport, bestUnique, spendPoints, takeNode, planBudget and upgradeCandidates all take draftId), run checkBuild again, then offer it with proposeDraft: one card and one Undo, compared with the player's open build. The open build is not touched. A 'not ready' row opens and is repaired the same way. Its numbers are the engine's on the draft.",
    shape: { index: z.number().int().min(0).max(7) },
    run: (args, ctx) =>
      unsolved(async () => {
        if (!ctx.drafts) throw new ToolError('Drafts are not available here.');
        const open = need(ctx);
        const a = await solver(ctx).fixedResult(Number(args.index));
        const openXml = await xmlOf(ctx, open.buildId);
        const d = await ctx.drafts.create(a.xml, { name: a.title, from: 'open', baseKey: open.buildKey, baseHash: xmlHash(openXml) }, await statMap(ctx, open.buildId));
        // The card compares with the open build, not with the result: its start is the open build's tree and numbers, and the first lines say what the result changes.
        d.startAllocated = (await ctx.engine.send('treeState', { buildId: open.buildId })).tree.allocated;
        d.lines.push(...(await solveLayers(openXml, a.xml, ctx.tree, a.assumptions)).layers.map((l) => l.text));
        d.kinds.add('setXml');
        return {
          draftId: d.id,
          name: d.name,
          assessed: recordView(a.rec),
          changesFromOpenBuild: changeRows(pickChanges(deltasOf(d.startStats, await statMap(ctx, d.buildId)), 10)),
          note: 'The draft is this result with its listed fixes. Nothing in the open build changed. Repair with editDraft, check with checkBuild, then offer it with proposeDraft.',
        };
      }),
  },
  {
    name: 'checkBuild',
    chip: 'Check as a player',
    description:
      "What a seasoned player would fault in the open build or a draft (draftId): the player checks (reservation, sustain, accuracy, resist caps, flasks, auras, a craft or item that cannot exist in game, weapon, ...) and the audit's fatal findings with their ready edits. Run it on a draft after your edits to see what is left. Each line is a fault to fix with an edit, unless it only describes how the build is played (flask charges, kills, uptime): that is a notice, left as it is.",
    shape: { draftId: z.string().max(20).optional() },
    run: async (args, ctx) => {
      const b = need(ctx, args);
      const xml = await xmlOf(ctx, b.buildId);
      const o = await playerObjections(ctx, b.buildId, xml);
      const a = await auditBuild(ctx, b.buildId, xml);
      return {
        objections: o.found.map((x) => ({ n: x.n, text: x.text, ...(x.blocks ? { blocks: true } : {}) })),
        ...(o.failed.length ? { couldNotRun: o.failed } : {}),
        auditFatal: a.findings.filter((f) => f.fatal).map((f) => ({ id: f.id, text: f.shown, ...(f.fix ? { fix: f.fix } : {}), ...(f.edits?.length ? { edits: f.edits } : {}) })),
        note: 'Nothing was changed. A check that could not run (couldNotRun) is not a pass.',
      };
    },
  },
  {
    name: 'askPlayer',
    chip: 'Ask the player',
    description:
      "Asks the player ONE short question as two or three buttons in the Solve panel, only when the answer changes which build is made (which ascendancy, which defence style, a must-use item the words hint at). Never for what the Solve form already holds (budget, mapping or bossing, targets, level, class) and never for something a tool can read. The tap comes back as the player's next message. Write the question in one line in your reply too, then end the turn.",
    shape: { question: z.string().min(5).max(160), options: z.array(z.string().min(1).max(40)).min(2).max(3) },
    run: (args, ctx) =>
      unsolved(async () => {
        solver(ctx).ask(String(args.question), args.options as string[]);
        return { asked: true, note: 'The buttons are in the panel. End your turn with the question in one line; do not answer it yourself.' };
      }),
  },
  {
    name: 'stopSolve',
    chip: 'Stop solve',
    description: 'Stops the running solve. The builds found so far stay readable and can still be applied. With verdict it ends a stalled run you have no credible leads left for: the panel shows your reason and the best build\'s misses (gaps).',
    shape: { verdict: z.string().min(1).max(400).optional().describe('Only when no credible lead is left: in player terms, what this search reached and what limits it, in player terms.') },
    run: (args, ctx) => unsolved(async () => (typeof args.verdict === 'string' ? solveView(await solver(ctx).finish(args.verdict)) : solveView(await solver(ctx).stop(false)))),
  },
  {
    name: 'applySolveResult',
    chip: 'Propose solve result',
    description:
      "Puts one trade-off build (index from getSolve) into the open build as ONE change: class, tree, gems, items and config, with the engine's before and after numbers per layer. In the app's own panel it goes in at once as one Undo step and the app highlights the changed nodes with an Undo button; the result says whether it went in (buildChanged).",
    shape: { index: z.number().int().min(0).max(7) },
    run: (args, ctx) =>
      unsolved(async () => {
        // Through the tool's proposal store, so the panel's live apply (and the gate's checks) see it like proposeEdit.
        const p = await solver(ctx).propose(Number(args.index), ctx.origin, ctx.proposals, ctx.open()?.buildId);
        return { proposalId: p.id, status: 'waiting for the player to click Apply or Dismiss', layers: p.lines, changes: changeRows(p.changes), note: 'The panel now shows this card. Do not say it is applied.' };
      }),
  },
];

