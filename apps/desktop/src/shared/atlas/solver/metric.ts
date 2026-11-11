import { createHash } from 'node:crypto';
import { parseId, type Hash, type Known, type RevisionRef } from '@pom/mastery-contracts';
import { inspectAllocation, ordered, rootComponent, type AtlasGraph } from '../graph.js';

export const EXACT_SOLVER_VERSION = 'atlas-dreyfus-wagner/1';
export class ExactSolverError extends Error {
  constructor(readonly code: 'INVALID' | 'UNVERIFIED' | 'UNSUPPORTED' | 'UNKNOWN_TARGET' | 'UNREACHABLE_TARGET' | 'REPAIR_REQUIRED' | 'TOO_MANY_TARGETS' | 'RESOURCE_LIMIT' | 'CANCELLED', message: string) { super(message); }
}
export type ExactRequest = {
  requestId: string;
  baseRevision: RevisionRef;
  sourceHash: Hash;
  taxonomyHash: Hash;
  variant: string;
  inputHash: Hash;
  acceptedTargetIds: readonly string[];
  targetIds: readonly string[];
  sourceAllocatedIds: readonly string[];
  retainCurrent: boolean;
  budget: number;
  legalCostModel: Known<'nonnegative_additive'>;
  // These are sourced mechanic node groups in priority order, not a reward score.
  preferredNodeGroups: readonly (readonly string[])[];
};
export type ExactLimits = { maxNodes: number; maxEdges: number; maxInputIds: number; maxDpBytes: number };
export type ExactBinding = {
  requestId: string; baseRevision: RevisionRef; sourceHash: Hash; graphHash: Hash; costModelHash: Hash;
  taxonomyHash: Hash; variant: string; inputHash: Hash; solverVersion: string; rootId: string;
  requiredTargetIds: string[]; retainedIds: string[]; legalCostEvidenceId: string;
};
export type ExactMetric = {
  ids: string[]; adjacent: number[][]; costs: number[]; ties: bigint[]; root: number;
  terminals: number[]; retainedIds: string[]; baseCost: number; totalCost: number; binding: ExactBinding;
};
export function digest(value: unknown): Hash {
  const canonical = JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
  return parseId('hash', createHash('sha256').update(canonical).digest('hex'));
}
function graphIdentity(graph: AtlasGraph) {
  return ordered(graph.nodes.keys()).map(id => [id, ordered(graph.adjacent.get(id) ?? [])]);
}
export function exactInputHash(graph: AtlasGraph, request: Omit<ExactRequest, 'inputHash'> | ExactRequest): Hash {
  return digest({ solverVersion: EXACT_SOLVER_VERSION, requestId: request.requestId, baseRevision: request.baseRevision,
    sourceHash: request.sourceHash, graphHash: graph.graphHash, graph: graphIdentity(graph), rootId: graph.rootId,
    costs: graph.costs, taxonomyHash: request.taxonomyHash, variant: request.variant,
    requiredTargetIds: ordered([...request.acceptedTargetIds, ...request.targetIds]),
    sourceAllocatedIds: ordered(request.sourceAllocatedIds), retainCurrent: request.retainCurrent,
    budget: request.budget, legalCostModel: request.legalCostModel,
    preferredNodeGroups: request.preferredNodeGroups.map(ordered) });
}
export function checkedAdd(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum) || sum < 0) throw new ExactSolverError('RESOURCE_LIMIT', 'Point cost exceeds the supported numeric range.');
  return sum;
}
export function prepareMetric(graph: AtlasGraph, request: ExactRequest, limits: ExactLimits): ExactMetric {
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new ExactSolverError('INVALID', 'Solver limits must be positive whole numbers.');
  const inputSize = request.acceptedTargetIds.length + request.targetIds.length + request.sourceAllocatedIds.length +
    request.preferredNodeGroups.length + request.preferredNodeGroups.reduce((sum, group) => sum + group.length, 0);
  if (graph.nodes.size > limits.maxNodes || inputSize > limits.maxInputIds) throw new ExactSolverError('RESOURCE_LIMIT', 'Tree or input exceeds the solver limit.');
  if (!graph.nodes.has(graph.rootId) || graph.adjacent.size !== graph.nodes.size) throw new ExactSolverError('INVALID', 'Tree adjacency or root is incomplete.');
  const inputIds = [...request.acceptedTargetIds, ...request.targetIds, ...request.sourceAllocatedIds, ...request.preferredNodeGroups.flat()];
  let edges = 0;
  for (const [id, links] of graph.adjacent) {
    if (!graph.nodes.has(id)) throw new ExactSolverError('INVALID', 'Tree adjacency contains an unavailable node.');
    for (const next of links) {
      if (id === next || !graph.nodes.has(next) || !graph.adjacent.get(next)?.includes(id)) throw new ExactSolverError('INVALID', 'Solver requires an undirected tree graph.');
      if (++edges > limits.maxEdges * 2) throw new ExactSolverError('RESOURCE_LIMIT', 'Tree exceeds the edge limit.');
    }
  }
  if (!request.requestId || !request.variant || !Number.isSafeInteger(request.budget) || request.budget < 0 ||
    inputIds.some(id => typeof id !== 'string' || !id)) throw new ExactSolverError('INVALID', 'Solver input is invalid.');
  for (const hash of [request.sourceHash, request.taxonomyHash, request.inputHash, graph.graphHash]) parseId('hash', hash);
  if (exactInputHash(graph, request) !== request.inputHash) throw new ExactSolverError('INVALID', 'Solver input identity changed.');
  if (graph.costs.status !== 'known' || request.legalCostModel.status !== 'known') throw new ExactSolverError('UNVERIFIED', 'The legal point cost model is unverified.');
  if (request.legalCostModel.value !== 'nonnegative_additive' || !request.legalCostModel.evidenceId || !graph.costs.evidenceId || !graph.costs.value.provenance.length) throw new ExactSolverError('UNVERIFIED', 'An additive point cost model needs source evidence.');
  const nodeCosts = graph.costs.value.nodeCosts;
  let totalCost = 0;
  for (const id of graph.nodes.keys()) {
    if (!Object.hasOwn(nodeCosts, id) || !Number.isSafeInteger(nodeCosts[id]) || nodeCosts[id]! < 0) throw new ExactSolverError('UNSUPPORTED', 'Exact solving requires sourced nonnegative whole-number node costs.');
    totalCost = checkedAdd(totalCost, nodeCosts[id]!);
  }
  const requiredTargetIds = ordered([...request.acceptedTargetIds, ...request.targetIds]);
  if (requiredTargetIds.some(id => !graph.nodes.has(id))) throw new ExactSolverError('UNKNOWN_TARGET', 'A target is unavailable in this tree data.');
  const retainedIds = request.retainCurrent ? ordered([graph.rootId, ...request.sourceAllocatedIds]) : [graph.rootId];
  const repair = inspectAllocation(graph, retainedIds);
  if (repair.missingIds.length || repair.disconnectedIds.length) throw new ExactSolverError('REPAIR_REQUIRED', 'Retained allocations need repair before exact solving.');
  if (request.preferredNodeGroups.some(group => group.some(id => !graph.nodes.has(id)))) throw new ExactSolverError('UNKNOWN_TARGET', 'A preferred node is unavailable in this tree data.');
  const reachable = rootComponent(graph);
  if (requiredTargetIds.some(id => !reachable.has(id))) throw new ExactSolverError('UNREACHABLE_TARGET', 'No connected path to a target.');
  const retained = new Set(retainedIds);
  const variableTargets = requiredTargetIds.filter(id => !retained.has(id));
  if (variableTargets.length > 10) throw new ExactSolverError('TOO_MANY_TARGETS', 'Exact solving supports at most 10 variable targets.');
  const ids = [graph.rootId, ...ordered(reachable).filter(id => !retained.has(id))];
  // Positive cardinality precedes canonical ID order. Negative preference weights
  // are legal only on positive-point nodes, so every lexicographic edge is nonnegative.
  const groups = request.retainCurrent ? [] : request.preferredNodeGroups.map(group => new Set(group));
  if (groups.some(group => [...group].some(id => !retained.has(id) && nodeCosts[id] === 0))) throw new ExactSolverError('UNSUPPORTED', 'Priority preferences on zero-cost optional nodes need a different tie model.');
  const bytesPerCell = 48 + Math.ceil((ids.length + (groups.length + 1) * Math.log2(ids.length + 1)) / 8);
  const bytes = (1 << variableTargets.length) * ids.length * bytesPerCell +
    (edges + ids.length) * (bytesPerCell + 48) + edges * 8;
  if (!Number.isSafeInteger(bytes) || bytes > limits.maxDpBytes) throw new ExactSolverError('RESOURCE_LIMIT', 'Exact search exceeds the memory limit.');
  const index = new Map(ids.map((id, i) => [id, i]));
  const canonicalUnit = 1n << BigInt(ids.length);
  const radix = BigInt(ids.length + 1);
  const ties = ids.map((id, i) => {
    if (i === 0) return 0n;
    let preference = 0n;
    for (const group of groups) preference = preference * radix - BigInt(group.has(id));
    // With Keep on this counts additions; retained IDs cannot be removed.
    const travel = request.retainCurrent || !groups.some(group => group.has(id)) ? 1n : 0n;
    return (preference * radix + travel) * canonicalUnit - (1n << BigInt(ids.length - 1 - i));
  });
  const adjacent = ids.map(id => {
    const boundary = id === graph.rootId ? retainedIds.flatMap(node => [...graph.adjacent.get(node)!]) : [...graph.adjacent.get(id)!];
    return [...new Set(boundary.map(next => retained.has(next) ? 0 : index.get(next)!).filter(next => next !== index.get(id)))].sort((a, b) => a - b);
  });
  const baseCost = retainedIds.reduce((sum, id) => checkedAdd(sum, nodeCosts[id]!), 0);
  const binding: ExactBinding = { requestId: request.requestId, baseRevision: structuredClone(request.baseRevision), sourceHash: request.sourceHash,
    graphHash: graph.graphHash, costModelHash: graph.costs.value.contentHash, taxonomyHash: request.taxonomyHash,
    variant: request.variant, inputHash: request.inputHash, solverVersion: EXACT_SOLVER_VERSION, rootId: graph.rootId,
    requiredTargetIds, retainedIds, legalCostEvidenceId: request.legalCostModel.evidenceId };
  return { ids, adjacent, costs: ids.map((id, i) => i === 0 ? 0 : nodeCosts[id]!), ties, root: 0,
    terminals: variableTargets.map(id => index.get(id)!), retainedIds, baseCost, totalCost, binding };
}
