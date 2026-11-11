import type { Hash } from '@pom/mastery-contracts';
import { ordered } from '../../../shared/atlas/graph.js';
import { AiScheduler, realTimers, type Timers } from '../../../shared/atlas/suggestions/aiScheduler.js';
import { buildAiSummary, compileAiReply, parseAiReply, type AiAvailability, type AiSummary, type AtlasAiPort } from '../../../shared/atlas/suggestions/ai.js';
import { sha256Hex } from '../../../shared/atlas/suggestions/hash.js';
import { SuppressionLedger, type LedgerStorage } from '../../../shared/atlas/suggestions/ledger.js';
import { proposalFromPath, STALE_TEXT, type Proposal } from '../../../shared/atlas/suggestions/proposal.js';
import { evaluateRules, pathForTargets, stableOrder, structuralWarnings, visibleRows, RULES_VERSION, type Suggestion, type Warning } from '../../../shared/atlas/suggestions/rules.js';
import type { OptimizerController } from './controller.js';

export type RailState = {
  rows: Suggestion[]; shown: Suggestion[]; more: Suggestion[]; warnings: Warning[]; ruleWarning: string | null; open: boolean; count: number;
  aiOn: boolean; aiStatus: 'idle' | 'checking' | 'working' | 'unavailable' | 'denied' | 'offline'; aiCode: string | null; aiNote: string | null;
  active: Proposal | null; activeKey: string | null; pinned: boolean; dismissedCount: number;
};
/** Deterministic rule rows, optional AI rows, a suppression ledger and the AI pacing. */
export class RailController {
  private listeners = new Set<() => void>();
  private state!: RailState;
  private ledger: SuppressionLedger | null = null;
  private ledgerFor = '';
  private order: string[] = [];
  private ai: Suggestion[] = [];
  private aiSig = '';
  private aiStatus: RailState['aiStatus'] = 'idle';
  private aiCode: string | null = null;
  private scheduler: AiScheduler<AiSummary>;
  // Starts closed: the tree gets the room; the toolbar's Suggestions button (with its count) opens it.
  private open = false;
  private hold = false;
  private active: { key: string; proposal: Proposal } | null = null;
  private pinned = false;
  private lastSig = '';
  private requestedSummary: AiSummary | null = null;
  private unsub: (() => void)[] = [];
  constructor(private readonly o: { controller: OptimizerController; ai: AtlasAiPort | null; storage: LedgerStorage | null; online: () => boolean; timers?: Timers }) {
    const t = o.timers ?? realTimers;
    this.scheduler = new AiScheduler<AiSummary>((summary, signal) => this.askAi(summary, signal), t);
    this.unsub.push(o.controller.o.session.subscribe(() => this.refresh()));
    if (o.ai) this.unsub.push(o.ai.onAccess(() => this.emit()));
    this.refresh();
  }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.state;
  dispose(): void { this.closeWorkspace(); this.scheduler.cancel(); this.unsub.forEach(f => f()); this.listeners.clear(); }
  private emit(): void { this.state = this.build(); this.listeners.forEach(fn => fn()); }
  setOpen(open: boolean): void { this.open = open; this.emit(); }
  setHold(on: boolean): void { this.hold = on; }
  setDragging(on: boolean): void { this.scheduler.setDragging(on); }
  get scheduledAi(): AiScheduler<AiSummary> { return this.scheduler; }

  private ledgerNow(planId: string): SuppressionLedger {
    if (!this.ledger || this.ledgerFor !== planId) { this.ledger?.workspaceClosed(); this.ledger = new SuppressionLedger(planId, this.o.storage, () => (this.o.timers ?? realTimers).now()); this.ledgerFor = planId; this.ai = []; }
    return this.ledger;
  }
  /** Rule rows recomputed from the session; AI rows kept until their basis changes. */
  private compute(): { rows: Suggestion[]; warnings: Warning[]; ruleWarning: string | null } {
    const v = this.o.controller.view(); if (!v) return { rows: [], warnings: [], ruleWarning: null };
    const s = this.o.controller.snapshot(), c = s.choices;
    const { suggestions, warning } = evaluateRules({ step: v.step, graph: v.graph, budget: c.budget, mechanics: s.mechanics, priority: c.priority, sustainAvailable: s.sustainAvailable,
      sustainChosen: c.sustain !== 'none', dataQualified: v.qualified, dataLabel: s.dataLabel });
    return { rows: [...suggestions, ...this.ai], warnings: structuralWarnings(v.step, v.graph, v.step.pointBudget), ruleWarning: warning };
  }
  /** Called on every session change: an unrelated committed edit may count as an ignore, then the rail refreshes. */
  private refresh(): void {
    const v = this.o.controller.view();
    if (!v) { this.emit(); return; }
    const ledger = this.ledgerNow(v.record.source.objectId);
    const sig = `${v.record.source.revisionId}:${v.step.stepId}`;
    if (this.lastSig && sig !== this.lastSig && this.o.controller.snapshot().status !== 'running' && !this.suppressNext) ledger.unrelatedEdit(this.relatedKey);
    this.suppressNext = false; this.relatedKey = null; this.lastSig = sig;
    if (this.aiSig && this.aiSig !== `${v.step.allocatedIds.join()}` ) { /* AI rows are tied to the allocation they were computed for */ }
    this.emit();
    if (this.scheduler.on) this.scheduler.notify(this.summary()!);
  }
  private suppressNext = false;
  private relatedKey: string | null = null;
  private summary(): AiSummary | null {
    const v = this.o.controller.view(); if (!v) return null; const s = this.o.controller.snapshot();
    return buildAiSummary({ dataset: v.plan.dataset, step: v.step, graph: v.graph, budget: s.choices.budget, mechanics: s.mechanics, priority: s.choices.priority, avoided: s.choices.avoided });
  }
  private build(): RailState {
    const { rows, warnings, ruleWarning } = this.compute(), ledger = this.ledger;
    const live = rows.filter(r => !ledger?.suppressed(r.key));
    // Rule rows first, then AI; positions already on screen are kept so nothing jumps under the pointer.
    const ranked = visibleRows(live, 99), kept = this.hold || true ? stableOrder(this.order, [...ranked.shown]) : ranked.shown;
    const firstSeen = this.order.length === 0 ? ranked.shown : kept;
    const ordered2 = this.order.length ? kept : firstSeen;
    this.order = ordered2.map(r => r.id);
    const { shown, more } = { shown: ordered2.slice(0, 3), more: ordered2.slice(3) };
    ledger?.shown(shown.map(r => r.key));
    return { rows: live, shown, more, warnings, ruleWarning, open: this.open, count: live.length, aiOn: this.scheduler.on, aiStatus: this.aiStatus, aiCode: this.aiCode, aiNote: null,
      active: this.active?.proposal ?? null, activeKey: this.active?.key ?? null, pinned: this.pinned, dismissedCount: ledger?.snapshot().dismissed.length ?? 0 };
  }

  // ---- row actions ----
  async proposalFor(row: Suggestion): Promise<Proposal | null> {
    const v = this.o.controller.view(); if (!v || !row.afterIds || row.cost === undefined || !row.target) return null;
    const data = v.record.view.data!, hash = (await sha256Hex({ rule: row.rule, key: row.key, base: ordered(v.step.allocatedIds), after: row.afterIds, v: RULES_VERSION })) as Hash;
    return proposalFromPath({ provenance: row.origin, step: v.step, baseRevision: v.record.source, datasetHash: v.plan.dataset.contentHash, graphHash: v.graph.graphHash,
      costModelHash: (v.graph.costs.status === 'known' ? v.graph.costs.value.contentHash : hash) as Hash, taxonomyHash: data.taxonomy.contentHash, inputHash: hash, variant: v.plan.dataset.variant,
      afterIds: row.afterIds, cost: row.cost, qualified: v.qualified, targetId: row.target.targetId, name: row.target.name, note: row.reason });
  }
  /** Hover or focus: ghost only. Details pins it. Building the proposal is async, so every call takes a number and a
   * hover answer that comes back after a newer call (the pointer already left, another chip, Close) is dropped: a ghost
   * never sticks to the tree after the pointer has gone. A pending Details pin survives the pointer leaving the chip. */
  async preview(row: Suggestion | null, pin = false): Promise<void> {
    const n = ++this.seq;
    if (!row) { if (!this.pinned && !this.pinning) { this.active = null; this.emit(); } return; }
    if (pin) this.pinning = n;
    const p = await this.proposalFor(row);
    if (pin ? this.pinning !== n : n !== this.seq) return;
    if (pin) this.pinning = 0;
    if (!p) return;
    if (this.pinned && !pin && this.active?.key !== row.key) return;
    this.active = { key: row.key, proposal: p }; if (pin) this.pinned = true; this.emit();
  }
  private seq = 0;
  private pinning = 0;
  closePreview(): void { this.seq++; this.pinning = 0; this.active = null; this.pinned = false; this.emit(); }
  /** Chip body: one click, one tree-only edit. Rechecks the path against the plan as it is now. */
  async apply(row: Suggestion): Promise<string | null> {
    const v = this.o.controller.view(); if (!v || !row.target) return STALE_TEXT;
    const fresh = row.origin === 'Rule' || row.origin === 'AI' ? pathForTargets(v.graph, v.step.allocatedIds, row.target.nodeIds.filter(id => !v.step.allocatedIds.includes(id))) : null;
    if (!fresh || JSON.stringify(fresh.afterIds) !== JSON.stringify(ordered(row.afterIds ?? []))) return STALE_TEXT;
    const p = await this.proposalFor(row); if (!p) return STALE_TEXT;
    const err = await this.o.controller.applyProposal(p);
    if (!err) { this.ledger?.applied(row.key); this.seq++; this.pinning = 0; this.active = null; this.pinned = false; this.emit(); }
    return err;
  }
  dismiss(row: Suggestion): void { this.ledger?.dismiss(row.key); if (this.active?.key === row.key) this.closePreview(); else this.emit(); }
  // An explicit Reset re-ranks from scratch, so the suggestions shown again take their rule places (not the end of the list).
  reset(): void { this.ledger?.reset(); this.order = []; this.emit(); }
  closeWorkspace(): void { this.ledger?.workspaceClosed(); }
  noteRelated(key: string): void { this.relatedKey = key; }

  // ---- AI ----
  async setAi(on: boolean): Promise<AiAvailability | null> {
    const ai = this.o.ai; if (!ai) return null;
    if (!on) { this.scheduler.setEnabled(false); this.ai = []; this.aiStatus = 'idle'; this.emit(); return null; }
    if (!this.o.online()) { this.aiStatus = 'offline'; this.emit(); return ai.access(); }
    this.aiStatus = 'checking'; this.aiCode = null; this.emit();
    try { await ai.verify(); } catch (e) {
      this.aiStatus = 'denied'; this.aiCode = typeof e === 'string' ? e : (e as { code?: string })?.code ?? 'ENTITLEMENT_UNAVAILABLE'; this.emit(); return ai.access();
    }
    this.scheduler.setEnabled(true); this.aiStatus = 'working'; this.emit();
    const s = this.summary(); if (s) this.scheduler.notify(s, true);
    return ai.access();
  }
  private async askAi(summary: AiSummary, signal: AbortSignal): Promise<void> {
    const ai = this.o.ai, v = this.o.controller.view(); if (!ai || !v) return;
    this.aiStatus = 'working'; this.emit(); this.requestedSummary = summary;
    try {
      const raw = await ai.suggest(summary, signal), reply = parseAiReply(raw);
      if (signal.aborted) return;
      if (!reply) throw new Error('bad');
      const now = this.o.controller.view()!, s = this.o.controller.snapshot();
      this.ai = compileAiReply(reply, { step: now.step, graph: now.graph, budget: s.choices.budget, mechanics: s.mechanics, summary, dataLabel: s.dataLabel });
      this.aiStatus = 'idle'; this.aiCode = null;
    } catch (e) {
      if (signal.aborted) return;
      this.aiStatus = 'unavailable'; this.aiCode = (e as { code?: string })?.code ?? null;
      if (this.aiCode && ['AI_ACCESS_REQUIRED', 'SIGN_IN_REQUIRED', 'HUMAN_CHECK_REQUIRED'].includes(this.aiCode)) { this.aiStatus = 'denied'; this.scheduler.setEnabled(false); }
    }
    this.emit();
  }
}
