import type { AtlasPlan, AtlasStep, DatasetRef, RevisionRef } from '@pom/mastery-contracts';
import { ordered } from '../graph.js';
import type { MechanicRow, SustainGroups } from './mechanics.js';

// Same values as protocol.ts (PREFERENCE_DEBOUNCE_MS); a test pins them together.
export const PREFERENCE_IDLE_MS = 250;
export type Sustain = 'none' | 'some' | 'more';
export type Mark = 'want' | 'avoid' | 'neutral';
/** Everything the player chose. `priority` is user order and may hold one generated sustain group. */
export type Choices = { priority: string[]; avoided: string[]; custom: Record<string, string[]>; sustain: Sustain; budget: number; retainCurrent: boolean };
export type SolverRow = { targetId: string; targetIds: string[]; taxonomy: MechanicRow['taxonomy'] };
/** What the main-side solver service needs to bind one run to one exact source. No hashes live in the renderer. */
export type PrepareRequest = {
  requestId: string; dataset: DatasetRef; baseRevision: RevisionRef; stepId: string; sourceAllocatedIds: string[];
  budget: number; retainCurrent: boolean; rows: SolverRow[]; avoidedTargetIds: string[];
};
export type RowPlan = {
  rows: SolverRow[];
  /** Rows the solver cannot take (no node IDs at all) are listed with their reason instead. */
  unavailable: { targetId: string; name: string; label: string }[];
  /** Selected targets that share a notable with an avoided mechanic. The shared notable stays selected. */
  overlaps: { targetId: string; withName: string }[];
  unverified: string[];
  avoidedTargetIds: string[];
};

/** "Keep current allocations" starts ON: the optimizer adds to the player's tree instead of replacing it. */
export const emptyChoices = (budget: number): Choices => ({ priority: [], avoided: [], custom: {}, sustain: 'none', budget, retainCurrent: true });

export function sustainLevel(priority: readonly string[], groups: SustainGroups | null): Sustain {
  return groups && priority.includes(groups.more.targetId) ? 'more' : groups && priority.includes(groups.some.targetId) ? 'some' : 'none';
}
/** Choices saved with the plan win. With nothing saved yet, "Keep current allocations" is ON, unless the step's tree
 * cannot be kept as it is (`canRetain` false: unavailable or disconnected nodes the solver must not be asked to keep). */
export function choicesFromPlan(plan: AtlasPlan, step: AtlasStep, mechanics: readonly MechanicRow[], groups: SustainGroups | null, canRetain = true): Choices {
  const saved = plan.optimizerPreferences, avoidSet = new Set(saved.avoidNodeIds);
  const keep = saved.targetIds.length > 0 || saved.avoidNodeIds.length > 0;
  const avoided = mechanics.filter(m => m.nodeIds.length && m.nodeIds.every(id => avoidSet.has(id)) && !saved.targetIds.includes(m.targetId)).map(m => m.targetId);
  return { priority: [...new Set(saved.targetIds)], avoided, custom: {}, sustain: sustainLevel(saved.targetIds, groups),
    budget: keep ? saved.budget : step.pointBudget, retainCurrent: keep ? saved.retainCurrent : canRetain };
}
export function toPreferences(choices: Choices, mechanics: readonly MechanicRow[]): AtlasPlan['optimizerPreferences'] {
  const avoid = mechanics.filter(m => choices.avoided.includes(m.targetId)).flatMap(m => m.nodeIds);
  return { targetIds: [...choices.priority], avoidNodeIds: ordered(avoid), retainCurrent: choices.retainCurrent, budget: choices.budget };
}

const without = (list: readonly string[], id: string) => list.filter(x => x !== id);
/** Checkbox, island click, menu and A/N keys all land here: one state per mechanic. */
export function mark(choices: Choices, targetId: string, to: Mark): Choices {
  const priority = without(choices.priority, targetId), avoided = without(choices.avoided, targetId);
  if (to === 'want') priority.push(targetId); else if (to === 'avoid') avoided.push(targetId);
  return { ...choices, priority, avoided };
}
export function markOf(choices: Choices, targetId: string): Mark {
  return choices.priority.includes(targetId) ? 'want' : choices.avoided.includes(targetId) ? 'avoid' : 'neutral';
}
export function move(choices: Choices, targetId: string, delta: number): Choices {
  const from = choices.priority.indexOf(targetId), to = from + delta;
  if (from < 0 || to < 0 || to >= choices.priority.length) return choices;
  const priority = [...choices.priority]; priority.splice(to, 0, ...priority.splice(from, 1));
  return { ...choices, priority };
}
export function moveTo(choices: Choices, targetId: string, index: number): Choices {
  const from = choices.priority.indexOf(targetId);
  if (from < 0) return choices;
  const priority = [...choices.priority]; priority.splice(from, 1);
  priority.splice(Math.max(0, Math.min(index, priority.length)), 0, targetId);
  return { ...choices, priority };
}
/** None adds nothing. Some/More add their group once at the end; a changed level keeps the row's place. */
export function setSustain(choices: Choices, level: Sustain, groups: SustainGroups | null): Choices {
  if (!groups) return choices;
  const ids = [groups.some.targetId, groups.more.targetId], at = choices.priority.findIndex(id => ids.includes(id));
  const priority = choices.priority.filter(id => !ids.includes(id));
  if (level !== 'none') priority.splice(at < 0 ? priority.length : Math.min(at, priority.length), 0, groups[level].targetId);
  return { ...choices, priority, sustain: level };
}
export function setCustom(choices: Choices, targetId: string, nodeIds: readonly string[] | null): Choices {
  const custom = { ...choices.custom };
  if (nodeIds) custom[targetId] = [...nodeIds]; else delete custom[targetId];
  return { ...choices, custom };
}
export function parseBudget(text: string, cap: number | null): { ok: true; value: number } | { ok: false; message: string } {
  const value = Number(text.trim());
  const fail = { ok: false as const, message: cap === null ? 'Enter a whole number from 0.' : `Enter a whole number from 0 to ${cap}.` };
  if (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(value) || (cap !== null && value > cap)) return fail;
  return { ok: true, value };
}

/** Turn choices into solver rows. The sustain group, if chosen, is just another row in the player's order. */
export function rowPlan(choices: Choices, mechanics: readonly MechanicRow[], sustain: { some: MechanicRow; more: MechanicRow } | null): RowPlan {
  const byId = new Map(mechanics.map(m => [m.targetId, m] as const));
  if (sustain) { byId.set(sustain.some.targetId, sustain.some); byId.set(sustain.more.targetId, sustain.more); }
  const rows: SolverRow[] = [], unavailable: RowPlan['unavailable'] = [], unverified: string[] = [], overlaps: RowPlan['overlaps'] = [];
  const selected = new Set<string>();
  for (const targetId of choices.priority) {
    const m = byId.get(targetId);
    if (!m) { unavailable.push({ targetId, name: targetId, label: 'Unavailable in this tree data' }); continue; }
    const custom = choices.custom[targetId]?.filter(id => m.nodeIds.includes(id)), nodeIds = custom?.length ? ordered(custom) : m.nodeIds;
    if (!nodeIds.length) { unavailable.push({ targetId, name: m.name, label: m.problem ?? 'Unavailable in this tree data' }); continue; }
    if (m.taxonomy.status !== 'known') unverified.push(m.name);
    rows.push({ targetId, targetIds: nodeIds, taxonomy: m.taxonomy }); nodeIds.forEach(id => selected.add(id));
  }
  const avoidedNodes = new Set<string>();
  for (const id of choices.avoided) {
    const m = byId.get(id); if (!m) continue;
    for (const nodeId of m.nodeIds) if (selected.has(nodeId)) {
      const owner = rows.find(r => r.targetIds.includes(nodeId));
      if (owner && !overlaps.some(o => o.targetId === owner.targetId && o.withName === m.name)) overlaps.push({ targetId: owner.targetId, withName: m.name });
    } else avoidedNodes.add(nodeId);
  }
  return { rows, unavailable, overlaps, unverified, avoidedTargetIds: ordered(avoidedNodes) };
}
export function prepareRequest(args: { requestId: string; dataset: DatasetRef; baseRevision: RevisionRef; step: AtlasStep; choices: Choices; plan: RowPlan }): PrepareRequest {
  return { requestId: args.requestId, dataset: args.dataset, baseRevision: args.baseRevision, stepId: args.step.stepId,
    sourceAllocatedIds: ordered(args.step.allocatedIds), budget: args.choices.budget, retainCurrent: args.choices.retainCurrent,
    rows: args.plan.rows, avoidedTargetIds: args.plan.avoidedTargetIds };
}
/** Two requests describe the same run when everything but the request ID matches. */
export const requestKey = (r: PrepareRequest): string => JSON.stringify({ ...r, requestId: '' });
