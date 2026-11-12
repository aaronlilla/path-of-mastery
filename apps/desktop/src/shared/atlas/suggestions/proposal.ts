import type { AtlasPlan, AtlasProposal, AtlasStep, Hash, RevisionRef, StepId, ValidationLimits } from '@pom/mastery-contracts';
import { allocationCost, inspectAllocation, ordered, type AtlasGraph } from '../graph.js';
import type { PriorityDecision, PriorityResult } from '../solver/priority.js';
import type { MechanicRow } from './mechanics.js';

// Type-only imports above keep this module free of node:crypto, so the renderer can run it.
export type Origin = AtlasProposal['provenance'];
/** The immutable thing the result preview shows. `contract` is the solver's proposal; the rest is what the screen needs. */
export type Proposal = {
  contract: AtlasProposal;
  stepId: StepId; datasetHash: string;
  baseAllocatedIds: string[]; afterIds: string[];
  /** Plain label for how sure we are; never `Shortest` without proof and qualified data. */
  certainty: 'Shortest' | 'Best found so far' | 'Rule path';
  qualified: boolean;
  results: ResultRow[];
  incidental: { targetId: string; name: string; nodeIds: string[] }[];
  note?: string;
};
export type ResultRow = {
  targetId: string; name: string; priority: number; tone: 'reached' | 'short' | 'tentative' | 'unavailable';
  label: string; detail: string; tooltip: string; basisIds: string[]; targetNodeIds: string[];
};
export const changed = (base: readonly string[], after: readonly string[]) => ({
  added: ordered(after.filter(id => !base.includes(id))), removed: ordered(base.filter(id => !after.includes(id))) });

/** `Shortest` needs an exact proof AND qualified data; otherwise a proven result is still called `Best found`. */
export function certaintyOf(result: Pick<PriorityResult, 'proof' | 'label'>, qualified: boolean): 'Shortest' | 'Best found so far' {
  return result.proof.kind === 'exact' && result.label === 'Shortest' && qualified ? 'Shortest' : 'Best found so far';
}
export function rowLabel(d: PriorityDecision, qualified: boolean): Pick<ResultRow, 'tone' | 'label' | 'tooltip'> {
  const basis = `Counted after ${d.decision.acceptedBasisIds.length} accepted nodes at the moment this row was checked.`;
  switch (d.decision.status) {
    case 'accepted': return { tone: 'reached', label: 'Reached', tooltip: d.detail || basis };
    case 'skipped_proven':
      return qualified ? { tone: 'short', label: d.label, tooltip: basis }
        : { tone: 'tentative', label: `About ${d.decision.shortfall.status === 'known' ? d.decision.shortfall.value : '?'} points short`, tooltip: `${basis} Tree data is unverified, so this is not a proven shortage.` };
    case 'fit_not_proven': return { tone: 'tentative', label: d.label, tooltip: `${basis} Fit not proven.` };
    default: return { tone: 'unavailable', label: d.label || 'Unavailable in this tree data', tooltip: d.detail || d.label };
  }
}
export function summaryLine(rows: readonly ResultRow[]): string | null {
  if (!rows.length) return null;
  if (rows.some(r => r.tone === 'reached')) return null;
  return rows.every(r => r.tone === 'short' || r.tone === 'unavailable') ? 'No selected mechanic fits this budget.' : 'No fitting path found yet.';
}

type Ctx = { step: AtlasStep; baseRevision: RevisionRef; datasetHash: string; qualified: boolean; mechanics: readonly MechanicRow[];
  rowNames: Readonly<Record<string, string>>; rowNodes: Readonly<Record<string, readonly string[]>>; avoidedNames: Readonly<Record<string, readonly string[]>>; unavailable?: ResultRow[] };

export function proposalFromResult(result: PriorityResult, ctx: Ctx): Proposal {
  const { step } = ctx, { added, removed } = changed(step.allocatedIds, result.allocatedIds);
  const certainty = certaintyOf(result, ctx.qualified);
  const results: ResultRow[] = result.decisions.map(d => ({ targetId: d.decision.targetId, name: ctx.rowNames[d.decision.targetId] ?? d.decision.targetId, priority: d.decision.priority,
    ...rowLabel(d, ctx.qualified), detail: d.provisional && d.decision.status === 'accepted' ? 'Earlier fit is not proven. This mechanic is provisional.' : d.detail,
    basisIds: [...d.decision.acceptedBasisIds], targetNodeIds: [...(ctx.rowNodes[d.decision.targetId] ?? [])] }));
  const incidental = Object.entries(ctx.avoidedNames).map(([name, nodeIds]) => ({ targetId: name, name, nodeIds: nodeIds.filter(id => result.incidentalAvoidedIds.includes(id)) })).filter(row => row.nodeIds.length);
  const contract: AtlasProposal = { schemaVersion: 1, baseRevision: structuredClone(ctx.baseRevision), sourceHash: result.identity.sourceHash, graphHash: result.identity.graphHash,
    costModelHash: result.identity.costModelHash, taxonomyHash: result.identity.taxonomyHash, inputHash: result.identity.inputHash, solverVersion: result.identity.solverVersion,
    variant: result.identity.variant, candidate: { ...structuredClone(step), allocatedIds: [...result.allocatedIds], repair: { missingIds: [], disconnectedIds: [] } },
    addedIds: added, removedIds: removed, cost: result.cost, targetDecisions: result.decisions.map(d => structuredClone(d.decision)), provenance: 'Optimizer', proof: structuredClone(result.proof) };
  return { contract, stepId: step.stepId, datasetHash: ctx.datasetHash, baseAllocatedIds: ordered(step.allocatedIds), afterIds: [...result.allocatedIds], certainty, qualified: ctx.qualified, results, incidental,
    ...(ctx.unavailable?.length ? { note: ctx.unavailable.map(r => `${r.name}: ${r.label}`).join(' ') } : {}) };
}

/** A rule or AI path that the app computed itself from the pinned graph. `hash` is supplied by the caller (async digest). */
export function proposalFromPath(args: { provenance: 'Rule' | 'AI'; step: AtlasStep; baseRevision: RevisionRef; datasetHash: string; graphHash: Hash; costModelHash: Hash; taxonomyHash: Hash;
  inputHash: Hash; variant: string; afterIds: string[]; cost: number; qualified: boolean; targetId: string; name: string; note?: string }): Proposal {
  const { added, removed } = changed(args.step.allocatedIds, args.afterIds);
  const contract: AtlasProposal = { schemaVersion: 1, baseRevision: structuredClone(args.baseRevision), sourceHash: args.inputHash, graphHash: args.graphHash, costModelHash: args.costModelHash,
    taxonomyHash: args.taxonomyHash, inputHash: args.inputHash, solverVersion: 'atlas-rules/1', variant: args.variant,
    candidate: { ...structuredClone(args.step), allocatedIds: [...args.afterIds], repair: { missingIds: [], disconnectedIds: [] } }, addedIds: added, removedIds: removed, cost: args.cost, targetDecisions: [],
    provenance: args.provenance, proof: { kind: 'best_found', inputHash: args.inputHash, upperBound: args.cost, elapsedMs: 0 } };
  return { contract, stepId: args.step.stepId, datasetHash: args.datasetHash, baseAllocatedIds: ordered(args.step.allocatedIds), afterIds: [...args.afterIds], certainty: 'Rule path', qualified: args.qualified,
    results: [{ targetId: args.targetId, name: args.name, priority: 1, tone: 'reached', label: 'Reached', detail: '', tooltip: 'Cheapest connected path from your current tree.', basisIds: ordered(args.step.allocatedIds), targetNodeIds: [] }],
    incidental: [], ...(args.note ? { note: args.note } : {}) };
}

export type Current = { revisionId: string; stepId: string; allocatedIds: readonly string[]; datasetHash: string; budget: number; ownership: 'owned' | 'saved'; preview: boolean };
export const STALE_TEXT = 'The plan changed. Recalculate this preview.';
/** Cheap synchronous freshness check. Apply re-validates the hashes in main as well. */
export function staleReason(p: Proposal, now: Current): string | null {
  if (now.revisionId !== p.contract.baseRevision.revisionId || now.stepId !== p.stepId || now.datasetHash !== p.datasetHash) return STALE_TEXT;
  if (JSON.stringify(ordered(now.allocatedIds)) !== JSON.stringify(p.baseAllocatedIds)) return STALE_TEXT;
  return null;
}
export function applyBlocked(p: Proposal, now: Current, graph: AtlasGraph | undefined, budget: number, requireWithinBudget = true): string | null {
  const stale = staleReason(p, now); if (stale) return stale;
  if (now.ownership !== 'owned' || now.preview) return 'Read-only preview. Edit a copy to change this plan.';
  if (!graph) return 'Tree data is unavailable. The plan snapshot is preserved.';
  if (inspectAllocation(graph, p.afterIds).missingIds.length || inspectAllocation(graph, p.afterIds).disconnectedIds.length) return 'Allocated nodes need a connected path.';
  const cost = allocationCost(graph, p.afterIds);
  if (requireWithinBudget && cost.status === 'known' && cost.value > budget) return 'This preview exceeds the point budget.';
  if (!p.afterIds.length && !p.baseAllocatedIds.length) return 'Your tree already matches these paths.';
  if (JSON.stringify(p.afterIds.slice().sort()) === JSON.stringify(p.baseAllocatedIds)) return 'Your tree already matches these paths.';
  return null;
}
/** The one tree-only edit Apply commits. The editor's `allocation` edit rechecks the base and writes a single transaction. */
export function applyEdit(p: Proposal) {
  return { kind: 'allocation' as const, stepId: p.stepId, beforeIds: [...p.baseAllocatedIds], afterIds: [...p.afterIds], datasetHash: p.datasetHash };
}

/** Destination for `Add as alternative` / `Add next step`: a new step carrying the proposal, in one saved edit. */
export function destinationPlan(plan: AtlasPlan, p: Proposal, kind: 'alternative' | 'next', newId: StepId, groupId: string, limits: ValidationLimits,
  edit: (plan: AtlasPlan, e: unknown, limits: ValidationLimits, graph?: AtlasGraph) => AtlasPlan, graph: AtlasGraph): AtlasPlan {
  const source = plan.stepsById[p.stepId];
  if (!source) throw new Error('Step is unavailable.');
  let next = kind === 'alternative' ? edit(plan, { kind: 'alternative', sourceId: p.stepId, newId, groupId }, limits, graph)
    : edit(plan, { kind: 'add', sourceId: p.stepId, newId }, limits, graph);
  next = edit(next, { kind: 'allocation', stepId: newId, beforeIds: [...source.allocatedIds], afterIds: [...p.afterIds], datasetHash: p.datasetHash }, limits, graph);
  return next;
}
