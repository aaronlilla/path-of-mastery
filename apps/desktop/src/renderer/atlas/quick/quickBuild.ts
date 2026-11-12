import type { AtlasStep, ObjectId } from '@pom/mastery-contracts';
import { fillBlocked, fillPoints, quickTiers, spendLine, spentPoints, treeLayout, type MapSupport } from '../../../shared/atlas/quickPlan.js';
import type { ResultRow } from '../../../shared/atlas/suggestions/proposal.js';
import type { OptimizerController } from '../optimizer/controller.js';
import type { AtlasEditorSession } from '../editor/session.js';
import { tr } from '../../i18n';

// Quick plan's one button, after the plan exists and is open: the existing solver reaches the chosen mechanics'
// notables, then the pure fill step spends what is left, and the tree is written as ONE undoable edit.

export type QuickRequest = { name: string; mechanicIds: string[]; mechanicNames: string[]; support: MapSupport; points: number; fill: boolean };
export type QuickRow = { name: string; reached: boolean; label: string };
/**
 * `undo`: the history entry the build created and the exact plan object the session held right after it was saved.
 * The summary offers Undo only while nothing has changed since (no later entry, no pending text, same plan object), so
 * its Undo can never undo something else. Null when the build changed nothing or another edit landed in between.
 */
export type QuickSummary = { objectId: ObjectId; undo: { cursor: string; plan: unknown } | null; rows: QuickRow[]; spent: string[]; cost: number; budget: number; left: number; error: string | null; stale?: boolean };
export const QUICK_STALE = tr('atlas_quick_quickBuild.you_changed_the_tree_its');
export const QUICK_TAKEN = tr('atlas_quick_quickBuild.the_optimizer_was_stopped_while');
export const QUICK_NOT_SAVED = tr('atlas_quick_quickBuild.the_built_tree_could_not');
/** True only while the session is exactly as the Quick plan build left it. */
export function buildUntouched(s: AtlasEditorSession['state'], summary: QuickSummary): boolean {
  return !!summary.undo && s.save === 'saved' && !s.preview && s.record?.source.objectId === summary.objectId
    && s.plan === summary.undo.plan && s.record.history.cursor === summary.undo.cursor;
}

const SOLVE_MS = 30_000;

function waitFor<T>(subscribe: (fn: () => void) => () => void, read: () => T | null | undefined, ms: number): Promise<T | null> {
  return new Promise(resolve => {
    const now = read(); if (now) { resolve(now); return; }
    let done = false;
    const finish = (value: T | null) => { if (done) return; done = true; off(); clearTimeout(timer); resolve(value); };
    const off = subscribe(() => { const v = read(); if (v) finish(v); });
    const timer = setTimeout(() => finish(read() ?? null), ms);
  });
}

/** What Quick plan needs from the optimizer: view and subscribe always; the rest only when mechanics are requested. */
export type QuickController = Pick<OptimizerController, 'view' | 'subscribe' | 'snapshot' | 'change' | 'discard' | 'find'>;
export async function runQuickBuild(session: AtlasEditorSession, controller: QuickController, req: QuickRequest): Promise<QuickSummary | null> {
  const view = await waitFor(controller.subscribe, () => controller.view(), 10_000);
  if (!view) return null;
  const objectId = view.record.source.objectId, stepId = view.step.stepId, budget = req.points;
  // The build is computed from the step as it was when the button was pressed: its allocation, point budget and target,
  // the tree data, and that step being the selected one (the optimizer solves the selected step and drops its result
  // when the selection moves). If the player changes any of these at any moment while it builds, even and back again,
  // the result is stale: it is dropped and their changes are kept, never overwritten.
  const key = (step: AtlasStep, dataset: string) => JSON.stringify([[...step.allocatedIds].sort(), step.pointBudget, step.pointTarget, dataset]);
  const original = key(view.step, view.plan.dataset.contentHash), ownIds: readonly string[] = view.step.allocatedIds;
  const sameNow = () => {
    const s = session.state, step = s.plan?.stepsById[stepId];
    return s.record?.source.objectId === objectId && !s.preview && s.selected === stepId && !!step && key(step, s.plan!.dataset.contentHash) === original;
  };
  let touched = false, taken = false, wanted: string | null = null;
  // The optimizer is shared with its panel: if its choices (mechanics, budget, ...) change while this build waits, its
  // next result answers a different request, so the build is stale too.
  const sameChoices = () => wanted === null || JSON.stringify(controller.snapshot().choices) === wanted;
  const stopSession = session.subscribe(() => { if (!sameNow()) touched = true; });
  const stopController = controller.subscribe(() => { if (!sameChoices()) touched = true; });
  const stopWatching = () => { stopSession(); stopController(); };
  try { return await build(); } finally { stopWatching(); }

  async function build(): Promise<QuickSummary | null> {
  const unchanged = () => !touched && sameNow() && sameChoices();
  let start: string[] = [...ownIds], rows: QuickRow[] = [], error: string | null = null;
  const stale = (): QuickSummary => ({ objectId, undo: null, rows: [], spent: [], cost: 0, budget, left: budget, stale: true, error: taken ? QUICK_TAKEN : QUICK_STALE });
  if (req.mechanicIds.length) {
    // retainCurrent is left as the plan has it ("Keep current allocations", on by default): a new plan has nothing to
    // keep, and Find saves these choices with the plan, so overriding it would change the player's default.
    controller.change(c => ({ ...c, priority: [...req.mechanicIds], avoided: [], custom: {}, budget: req.points }));
    wanted = JSON.stringify(controller.snapshot().choices);
    const block = controller.snapshot().findDisabled;
    if (block) { error = tr('atlas_quick_quickBuild_2.the_tree_was_filled_without_them', { block: block }); controller.discard(); }
    else {
    await controller.find();
    // Wakes on the solver and on the session: a change that makes the build stale ends the wait at once.
    const either = (fn: () => void) => { const a = controller.subscribe(fn), b = session.subscribe(fn); return () => { a(); b(); }; };
    const done = await waitFor(either, () => {
      if (!unchanged()) return 'stale' as const;
      const s = controller.snapshot();
      // Back to idle with no result: something else cancelled this run (the optimizer panel shares it). Stop now and say
      // so instead of waiting out the time limit and filling without the mechanics.
      if (s.status === 'idle' && !s.proposal) { taken = true; return 'stale' as const; }
      return s.status === 'error' ? s : s.proposal && (s.status === 'complete' || s.status === 'stopped' || s.status === 'idle') ? s : null;
    }, SOLVE_MS);
    if (done === 'stale') { controller.discard(); return stale(); }
    const proposal = done?.proposal ?? controller.snapshot().proposal;
    if (!unchanged()) { controller.discard(); return stale(); }
    const solvedGraph = controller.view()?.graph;
    if (proposal && solvedGraph && spentPoints(solvedGraph, proposal.afterIds) > budget) {
      // Never take a result that does not fit the requested points, whatever produced it.
      error = tr('atlas_quick_quickBuild_2.the_mechanics_did_not_fit_in', { budget: budget });
    } else if (proposal) {
      start = [...proposal.afterIds];
      rows = proposal.results.filter((r: ResultRow) => r.tone !== 'unavailable' || req.mechanicIds.includes(r.targetId))
        .map(r => ({ name: r.name, reached: r.tone === 'reached', label: r.label }));
    } else error = done?.error ?? tr('atlas_quick_quickBuild_2.could_not_reach_these_mechanics_in');
    controller.discard();
    }
  }
  const now = controller.view();
  if (!now || now.record.source.objectId !== objectId) return null;
  if (!unchanged()) return stale();
  const graph = now.graph, data = now.record.view.data;
  const layout = data?.nodeMetadata && Object.keys(data.nodeMetadata).length ? treeLayout(data.nodeMetadata, data.geometry as Record<string, { group?: unknown }>) : undefined;
  const targets = req.mechanicIds.map((id, i) => ({ name: req.mechanicNames[i] ?? id, nodeIds: data?.taxonomy.targets.find(t => t.targetId === id)?.nodeIds ?? [] }));
  const tiers = quickTiers(graph, req.support, targets, req.fill, layout);
  const filled = fillPoints(graph, start, budget, tiers, fillBlocked(layout, start));
  // The build's own step as it was when the button was pressed (unchanged() just proved it still is), not whichever
  // step is selected now: the player may have added or switched steps while the solver ran.
  const before = ownIds;
  // Same convention as the allocation it extends: the start node is listed only when the solver listed it.
  const after = start.includes(graph.rootId) ? filled.allocatedIds : filled.allocatedIds.filter(id => id !== graph.rootId);
  let undo: QuickSummary['undo'] = null;
  // Last guard: a tree above the requested points is never written.
  if (spentPoints(graph, after) > budget) return { objectId, undo: null, rows: [], spent: [], cost: 0, budget, left: budget, stale: true, error: QUICK_NOT_SAVED };
  if (after.join() !== [...before].sort().join() && after.some(id => id !== graph.rootId)) {
    // Anything typed while the solver ran is saved first, so the build is its own history entry.
    await session.flush();
    // Checked again right before writing: nothing awaits between this check and the edit.
    if (!unchanged()) return stale();
    const parent = session.state.record?.source.objectId === objectId ? session.state.record.history.cursor : null;
    stopWatching(); // our own edit below changes the allocation on purpose
    session.edit({ kind: 'allocation', stepId, beforeIds: [...before], afterIds: after, datasetHash: now.plan.dataset.contentHash });
    // edit() reports a refused change through the session's error, not by throwing: success is only claimed when the
    // step now holds exactly the built tree.
    const written = session.state.plan?.stepsById[stepId];
    if (!written || [...written.allocatedIds].sort().join() !== [...after].sort().join())
      return { objectId, undo: null, rows: [], spent: [], cost: 0, budget, left: budget, stale: true, error: QUICK_NOT_SAVED };
    await session.flush();
    if (session.state.save === 'failed') error = tr('atlas_quick_quickBuild_2.your_tree_was_built_but_is');
    const s = session.state, cursor = s.record?.history.cursor ?? null, entry = s.record?.history.events.find(e => e.transactionId === cursor);
    if (s.save === 'saved' && s.record?.source.objectId === objectId && entry && entry.parentTransactionId === parent) undo = { cursor: cursor!, plan: s.plan };
  }
  const spent: string[] = [];
  const solverCost = spentPoints(graph, start);
  if (req.mechanicIds.length && start.length) spent.push(tr('atlas_quick_quickBuild.mechanic_notables_and_paths_solverco', { solverCost }));
  for (const row of filled.spent) spent.push(spendLine(graph, row));
  return { objectId, undo, rows, spent, cost: filled.cost, budget, left: filled.left, error };
  }
}
