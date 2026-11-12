import type { Hash, SolverProof } from '@pom/mastery-contracts';
import { allocationCost, inspectAllocation, ordered, type AtlasGraph } from '../graph.js';
import { digest, ExactSolverError, prepareMetric, type ExactBinding, type ExactLimits, type ExactRequest } from './metric.js';

export type ExactSolution = {
  status: 'exact'; allocatedIds: string[]; cost: number; withinBudget: boolean; shortfall: number;
  binding: ExactBinding; proof: Extract<SolverProof, { kind: 'exact' }>;
  completedMasks: number; dpHash: Hash;
};
export function validateCandidate(graph: AtlasGraph, request: ExactRequest, ids: readonly string[]): number {
  if (ids.length !== new Set(ids).size) throw new ExactSolverError('INVALID', 'Candidate contains duplicate node IDs.');
  const repair = inspectAllocation(graph, ids);
  if (repair.missingIds.length || repair.disconnectedIds.length) throw new ExactSolverError('INVALID', 'Candidate is not connected to the tree root.');
  const present = new Set([graph.rootId, ...ids]);
  const required = [...request.acceptedTargetIds, ...request.targetIds, ...(request.retainCurrent ? request.sourceAllocatedIds : [])];
  if (required.some(id => !present.has(id))) throw new ExactSolverError('INVALID', 'Candidate does not cover every required node.');
  const cost = allocationCost(graph, ids);
  if (cost.status !== 'known' || !Number.isSafeInteger(cost.value)) throw new ExactSolverError('UNVERIFIED', 'Candidate point cost is unavailable.');
  return cost.value;
}
export function certificateHash(solution: Omit<ExactSolution, 'proof'>): Hash {
  return digest({ binding: solution.binding, allocatedIds: ordered(solution.allocatedIds), minimumCost: solution.cost,
    completedMasks: solution.completedMasks, dpHash: solution.dpHash });
}
// This verifies a trusted solver result's binding and candidate, not an untrusted
// caller's claim that its DP was executed. Main must retain the worker certificate.
export function validateExactSolution(graph: AtlasGraph, request: ExactRequest, solution: ExactSolution, limits: ExactLimits): void {
  const metric = prepareMetric(graph, request, limits);
  const cost = validateCandidate(graph, request, solution.allocatedIds);
  const proof = solution.proof;
  if (solution.status !== 'exact' || digest(solution.binding) !== digest(metric.binding) ||
    solution.completedMasks !== (1 << metric.terminals.length) - 1 || solution.cost !== cost ||
    solution.withinBudget !== (cost <= request.budget) || solution.shortfall !== Math.max(0, cost - request.budget) ||
    proof.kind !== 'exact' || proof.minimumCost !== cost || proof.inputHash !== request.inputHash ||
    proof.graphHash !== graph.graphHash || proof.costModelHash !== metric.binding.costModelHash || proof.variant !== request.variant ||
    proof.certificateHash !== certificateHash(solution)) throw new ExactSolverError('INVALID', 'Exact certificate does not match this request and candidate.');
}
