import type { AtlasPlan, AtlasStep, StepId } from '@pom/mastery-contracts';
import type { PriorityResult } from '../../../shared/atlas/solver/priority.js';
import type { SolverInput, WorkerMessage } from '../../../shared/atlas/solver/protocol.js';
import { inspectAllocation, type AtlasGraph } from '../../../shared/atlas/graph.js';
import { choicesFromPlan, emptyChoices, mark, markOf, move, moveTo, parseBudget, PREFERENCE_IDLE_MS, prepareRequest, requestKey, rowPlan, setCustom, setSustain, toPreferences,
  type Choices, type Mark, type PrepareRequest, type RowPlan, type Sustain } from '../../../shared/atlas/suggestions/choices.js';
import { mechanicRows, sustainRows, type MechanicRow, type SustainGroups } from '../../../shared/atlas/suggestions/mechanics.js';
import { applyBlocked, applyEdit, destinationPlan, proposalFromResult, STALE_TEXT, type Current, type Proposal, type ResultRow } from '../../../shared/atlas/suggestions/proposal.js';
import { editPlan } from '../editor/presenter.js';
import type { AtlasEditorSession, EditorRecord } from '../editor/session.js';
import { tr } from '../../i18n';

export interface OptimizerPort {
  /** Main binds the choices to this exact source and returns the solver input. */
  prepare(request: PrepareRequest): Promise<{ input: SolverInput; qualified: boolean }>;
  find(input: SolverInput): Promise<void> | void;
  continueSolving(): Promise<void> | void;
  cancel(): Promise<void> | void;
  /** Re-validates a preview against the plan as it is now; throws `The plan changed. Recalculate this preview.` */
  freeze(current: SolverInput): Promise<PriorityResult>;
  onMessage(listener: (message: WorkerMessage) => void): () => void;
}
export type RunStatus = 'idle' | 'preparing' | 'running' | 'complete' | 'stopped' | 'error';
export type OptimizerState = {
  choices: Choices; budgetText: string; budgetError: string | null; rowPlan: RowPlan; mechanics: MechanicRow[];
  sustainAvailable: boolean; sustainReason: string; sustainNames: { some: string; more: string } | null;
  status: RunStatus; error: string | null; proposal: Proposal | null;
  /** True when the preview no longer matches what is in the panel or the plan. */
  stale: boolean; blocked: string | null; checking: boolean;
  stopped: { label: string; actions: readonly string[] } | null;
  findDisabled: string | null; applied: boolean; dataLabel: string; qualified: boolean; capText: string; cap: number | null;
  pinned: boolean; ready: boolean;
};
export type OptimizerOptions = {
  session: AtlasEditorSession; port: OptimizerPort;
  names?: Readonly<Record<string, string>>; sustain?: SustainGroups | null;
  uuid?: () => string; debounceMs?: number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void };
};
type View = { record: EditorRecord; plan: AtlasPlan; step: AtlasStep; graph: AtlasGraph; qualified: boolean };
/** The open plan's selected step and its tree data, or null while either is missing. */
export function planView(s: AtlasEditorSession['state']): View | null {
  const record = s.record, plan = s.plan, step = plan && s.selected ? plan.stepsById[s.selected] : undefined;
  const graph = record?.canvas?.graph ?? record?.view.data?.graph;
  if (!record || !plan || !step || !graph || !record.view.data) return null;
  return { record, plan, step, graph, qualified: record.view.data.qualification === 'qualified' };
}
const NO_TARGETS = tr('atlas_optimizer_controller.choose_at_least_one_mechanic');

/**
 * Drives the optimizer: choices -> main-side solver -> an immutable proposal -> one tree-only edit.
 * It never writes the plan except through the editor session: preferences at an explicit Find, the tree at Apply.
 */
export class OptimizerController {
  private listeners = new Set<() => void>();
  private state!: OptimizerState;
  private choices: Choices = emptyChoices(0);
  private budgetText = '0';
  private run: { requestId: string; key: string; req: PrepareRequest } | null = null;
  private status: RunStatus = 'idle';
  private error: string | null = null;
  private proposal: Proposal | null = null;
  private stopped: OptimizerState['stopped'] = null;
  private applied = false;
  private pinned = false;
  private timer: unknown = null;
  private generation = 0;
  private unsubscribe: (() => void)[] = [];
  private openedFor: string | null = null;
  readonly uuid: () => string;
  constructor(readonly o: OptimizerOptions) {
    this.uuid = o.uuid ?? (() => crypto.randomUUID());
    this.unsubscribe.push(o.port.onMessage(m => this.accept(m)), o.session.subscribe(() => this.sessionChanged()));
    this.reopen(); this.state = this.build();
  }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.state;
  dispose(): void { this.clearTimer(); this.unsubscribe.forEach(fn => fn()); this.listeners.clear(); void this.o.port.cancel(); }
  private emit(): void { this.state = this.build(); this.listeners.forEach(fn => fn()); }

  // ---- source ----
  view(): View | null { return planView(this.o.session.state); }
  private mechanics(v: View): { rows: MechanicRow[]; sustain: ReturnType<typeof sustainRows> } {
    return { rows: mechanicRows(v.graph, v.record.view.data!.taxonomy, this.o.names), sustain: sustainRows(v.graph, this.o.sustain ?? null) };
  }
  private reopen(): void {
    const v = this.view(); if (!v) return;
    const key = `${v.record.source.objectId}:${v.step.stepId}`;
    if (this.openedFor === key) return;
    this.openedFor = key;
    const repair = inspectAllocation(v.graph, v.step.allocatedIds);
    this.choices = choicesFromPlan(v.plan, v.step, this.mechanics(v).rows, this.o.sustain ?? null, !repair.missingIds.length && !repair.disconnectedIds.length);
    this.budgetText = String(this.choices.budget);
    this.proposal = null; this.status = 'idle'; this.run = null; this.stopped = null; this.applied = false;
  }
  private sessionChanged(): void { this.reopen(); this.emit(); }
  current(): Current | null {
    const v = this.view(); if (!v) return null;
    return { revisionId: v.record.source.revisionId, stepId: v.step.stepId, allocatedIds: v.step.allocatedIds, datasetHash: v.plan.dataset.contentHash, budget: this.choices.budget,
      ownership: v.record.ownership, preview: !!this.o.session.state.preview };
  }
  cap(v: View | null = this.view()): number | null {
    const costs = v?.record.view.data?.costs;
    return costs?.status === 'known' && costs.value.maximumPoints.status === 'known' ? costs.value.maximumPoints.value : null;
  }
  private request(v: View, requestId: string): PrepareRequest {
    const m = this.mechanics(v);
    return prepareRequest({ requestId, dataset: v.plan.dataset, baseRevision: v.record.source, step: v.step, choices: this.choices, plan: rowPlan(this.choices, m.rows, m.sustain) });
  }

  // ---- choices ----
  change(fn: (c: Choices, rows: MechanicRow[]) => Choices): void {
    const v = this.view(); if (!v) return;
    this.choices = fn(this.choices, this.mechanics(v).rows);
    this.afterChange();
  }
  setMark(targetId: string, to: Mark): void { this.change(c => mark(c, targetId, to)); }
  markOf(targetId: string): Mark { return markOf(this.choices, targetId); }
  move(targetId: string, delta: number): void { this.change(c => move(c, targetId, delta)); }
  moveTo(targetId: string, index: number): void { this.change(c => moveTo(c, targetId, index)); }
  setSustain(level: Sustain): void { this.change(c => setSustain(c, level, this.o.sustain ?? null)); }
  setCustom(targetId: string, nodeIds: readonly string[] | null): void { this.change(c => setCustom(c, targetId, nodeIds)); }
  setRetain(on: boolean): void { this.change(c => ({ ...c, retainCurrent: on })); }
  setBudgetText(text: string): void {
    this.budgetText = text;
    const parsed = parseBudget(text, this.cap());
    if (parsed.ok) { this.choices = { ...this.choices, budget: parsed.value }; this.afterChange(); } else { this.cancelWork(); this.emit(); }
  }
  stepBudget(delta: number): void {
    const parsed = parseBudget(this.budgetText, this.cap()), base = parsed.ok ? parsed.value : this.choices.budget, cap = this.cap();
    this.setBudgetText(String(Math.max(0, cap === null ? base + delta : Math.min(cap, base + delta))));
  }
  private afterChange(): void {
    this.budgetText = String(this.choices.budget);
    this.applied = false; this.cancelWork(); this.stopped = null;
    this.scheduleLive(); this.emit();
  }
  private findBlock(): string | null {
    const v = this.view(); if (!v) return tr('atlas_optimizer_controller.tree_data_is_unavailable_the');
    const plan = rowPlan(this.choices, ...(() => { const m = this.mechanics(v); return [m.rows, m.sustain] as const; })());
    if (!this.choices.priority.length) return NO_TARGETS;
    if (parseBudget(this.budgetText, this.cap()).ok === false) return (parseBudget(this.budgetText, this.cap()) as { message: string }).message;
    if (plan.unverified.length) return tr('atlas_optimizer_controller.targets_unverified_join', { unverified: plan.unverified.join(', ') });
    if (!plan.rows.length) return tr('atlas_optimizer_controller.these_mechanics_are_unavailable_in');
    if (v.graph.costs.status !== 'known') return tr('atlas_optimizer_controller.the_point_cost_model_is');
    return null;
  }

  // ---- solving ----
  private clearTimer(): void { if (this.timer !== null) { (this.o.timers?.clear ?? clearTimeout as (h: unknown) => void)(this.timer); this.timer = null; } }
  private scheduleLive(): void {
    this.clearTimer();
    if (this.findBlock()) return;
    this.status = 'preparing';
    this.timer = (this.o.timers?.set ?? ((fn, ms) => setTimeout(fn, ms)))(() => { this.timer = null; void this.start(false); }, this.o.debounceMs ?? PREFERENCE_IDLE_MS);
  }
  private cancelWork(): void {
    this.clearTimer(); this.generation++;
    if (this.status === 'running' || this.status === 'preparing') void this.o.port.cancel();
    this.run = null; if (this.status !== 'idle') this.status = 'idle';
  }
  /** `Find paths`: restarts at once and keeps the choices with the plan. */
  async find(): Promise<void> { this.clearTimer(); await this.start(true); }
  private async start(persist: boolean): Promise<void> {
    const block = this.findBlock(), generation = ++this.generation;
    if (block) { this.error = null; this.emit(); return; }
    this.status = 'preparing'; this.error = null; this.stopped = null; this.emit();
    try {
      if (persist) await this.persist();
      if (generation !== this.generation) return;
      const v = this.view(); if (!v) return;
      const requestId = this.uuid(), req = this.request(v, requestId);
      const { input } = await this.o.port.prepare(req);
      if (generation !== this.generation) return;
      this.run = { requestId, key: requestKey(req), req }; this.proposal = null; this.status = 'running'; this.applied = false;
      await this.o.port.find(input);
    } catch (e) {
      if (generation !== this.generation) return;
      this.status = 'error'; this.error = tr('atlas_optimizer_controller_2.could_not_find_paths_your_tree'); void e;
    }
    this.emit();
  }
  private async persist(): Promise<void> {
    const v = this.view(); if (!v) return;
    const prefs = toPreferences(this.choices, this.mechanics(v).rows);
    if (JSON.stringify(prefs) === JSON.stringify(v.plan.optimizerPreferences)) return;
    this.o.session.replacePlan({ ...structuredClone(v.plan), optimizerPreferences: prefs }, tr('atlas_optimizer_controller.saved_optimizer_choices'));
    await this.o.session.flush();
  }
  async continueSolving(): Promise<void> { if (this.status !== 'stopped') return; this.status = 'running'; this.stopped = null; this.emit(); await this.o.port.continueSolving(); }
  cancel(): void { this.cancelWork(); this.emit(); }
  private accept(m: WorkerMessage): void {
    const run = this.run, v = this.view();
    if (!run || !v || m.identity.requestId !== run.requestId) return; // stale or foreign
    if (m.type === 'error') { this.status = 'error'; this.error = tr('atlas_optimizer_controller_2.could_not_find_paths_your_tree'); this.emit(); return; }
    if (m.type === 'stopped') {
      this.status = m.reason === 'complete' ? 'complete' : m.reason === 'cancelled' ? 'idle' : 'stopped';
      this.stopped = m.actions.length ? { label: m.label, actions: m.actions } : null; this.emit(); return;
    }
    this.proposal = this.fromResult(m.result, v, run.req); this.emit();
  }
  private fromResult(result: PriorityResult, v: View, req: PrepareRequest): Proposal {
    const m = this.mechanics(v), names: Record<string, string> = {}, nodes: Record<string, readonly string[]> = {}, avoided: Record<string, readonly string[]> = {};
    for (const row of [...m.rows, ...(m.sustain ? [m.sustain.some, m.sustain.more] : [])]) { names[row.targetId] = row.name; }
    for (const row of req.rows) nodes[row.targetId] = row.targetIds;
    for (const id of this.choices.avoided) { const mech = m.rows.find(r => r.targetId === id); if (mech) avoided[mech.name] = mech.nodeIds; }
    const unavailable: ResultRow[] = rowPlan(this.choices, m.rows, m.sustain).unavailable.map(u => ({ targetId: u.targetId, name: u.name, priority: 0, tone: 'unavailable', label: u.label, detail: '', tooltip: u.label, basisIds: [], targetNodeIds: [] }));
    return proposalFromResult(result, { step: v.step, baseRevision: v.record.source, datasetHash: v.plan.dataset.contentHash, qualified: v.qualified, mechanics: m.rows,
      rowNames: names, rowNodes: nodes, avoidedNames: avoided, unavailable });
  }

  state0(): OptimizerState { return this.state; }
  pin(on: boolean): void { this.pinned = on; this.emit(); }
  discard(): void { this.cancelWork(); this.proposal = null; this.stopped = null; this.pinned = false; this.emit(); }
  async recalculate(): Promise<void> { this.proposal = null; await this.find(); }
  /** Commits the tree edit only. Returns an error text, or null on success. */
  async apply(): Promise<string | null> {
    const p = this.proposal, v = this.view(), run = this.run;
    if (!p || !v || !run) return STALE_TEXT;
    const now = this.current()!, blocked = applyBlocked(p, now, v.graph, this.choices.budget, true);
    if (blocked) { this.emit(); return blocked; }
    if (run.key !== requestKey(this.request(v, run.requestId))) return this.markStale();
    try {
      const { input } = await this.o.port.prepare(this.request(v, run.requestId));
      const frozen = await this.o.port.freeze(input);
      if (JSON.stringify(frozen.allocatedIds) !== JSON.stringify(p.afterIds)) return this.markStale();
    } catch { return this.markStale(); }
    const error = this.commit(p);
    if (error) { this.emit(); return error; }
    this.proposal = null; this.status = 'idle'; this.applied = true; this.pinned = false; this.emit();
    return null;
  }
  private commit(p: Proposal): string | null {
    const before = this.o.session.state.error;
    this.o.session.edit(applyEdit(p));
    const error = this.o.session.state.error;
    return error && error !== before ? error : null;
  }
  /** Rule and AI chips: recheck against the plan as it is now, then one tree-only edit. */
  async applyProposal(p: Proposal): Promise<string | null> {
    const v = this.view(), now = this.current();
    if (!v || !now) return STALE_TEXT;
    const blocked = applyBlocked(p, now, v.graph, this.choices.budget);
    if (blocked) return blocked;
    const error = this.commit(p); this.applied = !error; this.emit(); return error;
  }
  private markStale(): string { this.emit(); return STALE_TEXT; }
  async undo(): Promise<void> { await this.o.session.historyAction('undo'); this.applied = false; this.emit(); }
  /** `Add as alternative` / `Add next step`: one saved edit, the Run default is not changed. */
  addDestination(kind: 'alternative' | 'next'): string | null {
    const p = this.proposal, v = this.view();
    if (!p || !v) return STALE_TEXT;
    if (this.current() && (p.baseAllocatedIds.join() !== [...v.step.allocatedIds].sort().join() || p.stepId !== v.step.stepId)) return STALE_TEXT;
    try {
      const next = destinationPlan(v.plan, p, kind, this.o.session.stepId() as StepId, this.uuid(), v.record.source ? this.o.session.limits : this.o.session.limits,
        (plan, e, limits, graph) => editPlan(plan, e as Parameters<typeof editPlan>[1], limits, graph), v.graph);
      this.o.session.replacePlan(next, kind === 'alternative' ? tr('atlas_optimizer_controller.added_alternative_from_preview') : tr('atlas_optimizer_controller.added_step_from_preview'));
      this.proposal = null; this.emit(); return null;
    } catch (e) { return e instanceof Error ? e.message : tr('atlas_optimizer_controller.could_not_add_this_step'); }
  }

  // ---- state ----
  private build(): OptimizerState {
    const v = this.view(), m = v ? this.mechanics(v) : { rows: [] as MechanicRow[], sustain: null };
    const budget = parseBudget(this.budgetText, this.cap(v));
    const now = this.current(), p = this.proposal;
    const stale = !!p && (!now || !v || applyBlocked(p, now, v.graph, this.choices.budget) === STALE_TEXT || (!this.run || this.run.key !== requestKey(this.request(v, this.run.requestId))));
    const blocked = p && now && v ? (stale ? STALE_TEXT : applyBlocked(p, now, v.graph, this.choices.budget)) : null;
    const names = this.o.sustain ? { some: this.o.sustain.some.name, more: this.o.sustain.more.name } : null;
    const plan = rowPlan(this.choices, m.rows, m.sustain);
    return { choices: this.choices, budgetText: this.budgetText, budgetError: budget.ok ? null : budget.message, rowPlan: plan, mechanics: m.rows,
      sustainAvailable: !!m.sustain && m.sustain.some.problem === null && m.sustain.more.problem === null, sustainNames: names,
      sustainReason: m.sustain ? tr('atlas_optimizer_controller.sustain_target_groups_are_unavailabl') : tr('atlas_optimizer_controller.sustain_targets_are_not_in'),
      status: this.status, error: this.error, proposal: p, stale, blocked, checking: this.status === 'preparing' || this.status === 'running', stopped: this.stopped,
      findDisabled: this.status === 'running' ? null : this.findBlock(), applied: this.applied,
      dataLabel: v ? (v.qualified ? v.record.view.data!.statusText : tr('atlas_optimizer_controller.statustext_tree_data_is_unverified', { statusText: v.record.view.data!.statusText })) : tr('atlas_optimizer_controller.tree_data_is_unavailable'), qualified: !!v?.qualified,
      capText: this.cap(v) === null ? tr('atlas_optimizer_controller.unverified') : String(this.cap(v)), cap: this.cap(v), pinned: this.pinned, ready: !!v };
  }
}
