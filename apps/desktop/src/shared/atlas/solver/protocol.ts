import type { AtlasDataset, Hash, Known, RevisionRef } from '@pom/mastery-contracts';
import { ordered, type AtlasGraph } from '../graph.js';
import { digest, exactInputHash, ExactSolverError, type ExactLimits, type ExactRequest } from './metric.js';
import type { PriorityResult } from './priority.js';

export const SOLVER_VERSION = 'atlas-priority-worker/1';
export const MAX_RUN_MS = 10_000;
export const PREFERENCE_DEBOUNCE_MS = 250;
export type PriorityRow = { targetId: string; targetIds: readonly string[]; taxonomy: Known<'verified'> };
export type SolverInput = Omit<ExactRequest, 'inputHash' | 'targetIds' | 'acceptedTargetIds'> & {
  inputHash: Hash; rows: readonly PriorityRow[]; avoidedTargetIds: readonly string[];
};
export type SolverIdentity = {
  requestId: string; baseRevision: RevisionRef; sourceHash: Hash; graphHash: Hash; costModelHash: Hash;
  taxonomyHash: Hash; inputHash: Hash; variant: string; solverVersion: string;
};
// Only topology and sourced costs cross the worker boundary; no renderer state.
export type CompactGraph = {
  graphHash: Hash; rootId: string; ids: string[]; offsets: Uint32Array; adjacent: Uint32Array;
  costs: AtlasGraph['costs'];
};
export type SearchPolicy = { runMs: number; maxPasses: number };
export type HostMessage = ({ identity: SolverIdentity; cycle: number } & (
  | { type: 'start'; graph: CompactGraph; input: SolverInput; limits: ExactLimits; policy: SearchPolicy;
      deadline: number; resume?: PriorityResult }
  | { type: 'cancel' }
));
export type WorkerMessage = { identity: SolverIdentity; cycle: number } & (
  | { type: 'candidate' | 'decision' | 'proof'; result: PriorityResult }
  | { type: 'stopped'; reason: 'complete' | 'time_limit' | 'work_limit' | 'cancelled'; elapsedMs: number;
      actions: readonly ('Continue solving' | 'Reduce targets' | 'Cancel')[]; label: string }
  | { type: 'error'; code: string; message: string }
);

export function rowRequest(graph: AtlasGraph, input: SolverInput, acceptedTargetIds: readonly string[], targetIds: readonly string[]): ExactRequest {
  const request: ExactRequest = { requestId: input.requestId, baseRevision: input.baseRevision, sourceHash: input.sourceHash,
    taxonomyHash: input.taxonomyHash, variant: input.variant, inputHash: input.inputHash,
    sourceAllocatedIds: input.sourceAllocatedIds, retainCurrent: input.retainCurrent, budget: input.budget,
    legalCostModel: input.legalCostModel, preferredNodeGroups: input.preferredNodeGroups,
    acceptedTargetIds: ordered(acceptedTargetIds), targetIds: ordered(targetIds) };
  request.inputHash = exactInputHash(graph, request);
  return request;
}
export function solverInputHash(graph: AtlasGraph, input: Omit<SolverInput, 'inputHash'> | SolverInput): Hash {
  const base = { ...input, acceptedTargetIds: [], targetIds: input.rows.flatMap(row => [...row.targetIds]) };
  return digest({ solverVersion: SOLVER_VERSION, core: exactInputHash(graph, base),
    rows: input.rows.map(row => ({ ...row, targetIds: ordered(row.targetIds) })), avoidedTargetIds: ordered(input.avoidedTargetIds) });
}
export function solverIdentity(graph: AtlasGraph, input: SolverInput): SolverIdentity {
  if (graph.costs.status !== 'known') throw new ExactSolverError('UNVERIFIED', 'The point cost model is unverified.');
  return { requestId: input.requestId, baseRevision: structuredClone(input.baseRevision), sourceHash: input.sourceHash,
    graphHash: graph.graphHash, costModelHash: graph.costs.value.contentHash, taxonomyHash: input.taxonomyHash,
    inputHash: input.inputHash, variant: input.variant, solverVersion: SOLVER_VERSION };
}
export function sameIdentity(a: SolverIdentity, b: SolverIdentity): boolean { return digest(a) === digest(b); }
export function validatePolicy(policy: SearchPolicy): void {
  if (!Number.isSafeInteger(policy.runMs) || policy.runMs <= 0 || policy.runMs > MAX_RUN_MS ||
    !Number.isSafeInteger(policy.maxPasses) || policy.maxPasses < 2 || policy.maxPasses > 10_000) {
    throw new ExactSolverError('INVALID', 'Search limits are invalid.');
  }
}
export function packGraph(graph: AtlasGraph): CompactGraph {
  const ids = ordered(graph.nodes.keys()), index = new Map(ids.map((id, i) => [id, i]));
  const offsets = new Uint32Array(ids.length + 1), adjacent: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    offsets[i] = adjacent.length;
    for (const next of ordered(graph.adjacent.get(ids[i]!) ?? [])) {
      const at = index.get(next); if (at === undefined) throw new ExactSolverError('INVALID', 'Tree adjacency contains an unavailable node.');
      adjacent.push(at);
    }
  }
  offsets[ids.length] = adjacent.length;
  return { graphHash: graph.graphHash, rootId: graph.rootId, ids, offsets, adjacent: new Uint32Array(adjacent), costs: structuredClone(graph.costs) };
}
export function unpackGraph(wire: CompactGraph, limits: ExactLimits): AtlasGraph {
  if (wire.ids.length > limits.maxNodes || wire.adjacent.length > limits.maxEdges * 2) throw new ExactSolverError('RESOURCE_LIMIT', 'Tree exceeds the worker limit.');
  if (new Set(wire.ids).size !== wire.ids.length || wire.offsets.length !== wire.ids.length + 1 || wire.offsets[0] !== 0 ||
    wire.offsets[wire.ids.length] !== wire.adjacent.length) throw new ExactSolverError('INVALID', 'Compact tree offsets are invalid.');
  const nodes = new Map<string, AtlasDataset['graph']['nodes'][number]>(), adjacent = new Map<string, string[]>();
  for (let i = 0; i < wire.ids.length; i++) {
    if (!wire.ids[i] || wire.offsets[i]! > wire.offsets[i + 1]!) throw new ExactSolverError('INVALID', 'Compact tree is invalid.');
    const links = [...wire.adjacent.subarray(wire.offsets[i], wire.offsets[i + 1])].map(at => {
      const id = wire.ids[at]; if (id === undefined) throw new ExactSolverError('INVALID', 'Compact tree edge is invalid.'); return id;
    });
    const nodeId = wire.ids[i]!;
    nodes.set(nodeId, { nodeId, name: nodeId, adjacentIds: links, stats: [], asset: null }); adjacent.set(nodeId, links);
  }
  return { graphHash: wire.graphHash, rootId: wire.rootId, nodes, adjacent, costs: wire.costs };
}
