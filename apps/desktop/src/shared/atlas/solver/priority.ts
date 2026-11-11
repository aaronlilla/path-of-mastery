import type { Hash, SolverProof, TargetDecision } from '@pom/mastery-contracts';
import { known, ordered, unknown, type AtlasGraph } from '../graph.js';
import { solveExact, type ExactSolution } from './exact.js';
import { compareCandidates, solveHeuristic, type HeuristicSolution } from './heuristic.js';
import { digest, ExactSolverError, type ExactLimits, type ExactRequest } from './metric.js';
import { rowRequest, solverIdentity, solverInputHash, type SolverIdentity, type SolverInput } from './protocol.js';
import { validateCandidate, validateExactSolution } from './validate.js';

export type RowSolution = ExactSolution | HeuristicSolution;
export type PriorityDecision = {
  decision: TargetDecision; basisHash: Hash; request: ExactRequest; proof: SolverProof;
  provisional: boolean; label: string; detail: string; extraPointsUpperBound?: number;
  solution?: RowSolution;
};
export type PriorityResult = {
  identity: SolverIdentity; pass: number; complete: boolean; allocatedIds: string[]; cost: number;
  withinBudget: boolean; acceptedTargetIds: string[]; decisions: PriorityDecision[]; proof: SolverProof;
  label: 'Shortest' | 'Best found so far'; incidentalAvoidedIds: string[];
};
export type PriorityControl = {
  pass?: number; exact?: boolean; shouldCancel?: () => boolean; elapsedMs?: number;
  cache?: Map<Hash, RowSolution>;
};

function priorityCertificate(identity: SolverIdentity, baseProof: SolverProof, decisions: PriorityDecision[], allocatedIds: string[], cost: number): Hash {
  return digest({ identity, base: baseProof,
    decisions: decisions.map(row => ({ basisHash: row.basisHash, proof: row.proof, decision: row.decision })), allocatedIds, cost });
}

export function validateInput(graph: AtlasGraph, input: SolverInput, limits: ExactLimits): void {
  const inputSize = input.rows.reduce((sum, row) => sum + row.targetIds.length + 1, 0) + input.avoidedTargetIds.length +
    input.sourceAllocatedIds.length + input.preferredNodeGroups.reduce((sum, group) => sum + group.length + 1, 0);
  if (inputSize > limits.maxInputIds) throw new ExactSolverError('RESOURCE_LIMIT', 'Priority input exceeds the solver limit.');
  if (new Set(input.rows.map(row => row.targetId)).size !== input.rows.length || input.rows.some(row => !row.targetId || !row.targetIds.length ||
    row.targetIds.some(id => typeof id !== 'string' || !id) || !row.taxonomy ||
    (row.taxonomy.status === 'known' ? row.taxonomy.value !== 'verified' || !row.taxonomy.evidenceId : row.taxonomy.status !== 'unknown' || !row.taxonomy.reason))) {
    throw new ExactSolverError('INVALID', 'Priority rows need distinct IDs, targets and taxonomy evidence.');
  }
  if (input.rows.some(row => row.targetIds.some(id => input.avoidedTargetIds.includes(id)))) {
    throw new ExactSolverError('INVALID', 'Selected targets include an avoided target.');
  }
  if (solverInputHash(graph, input) !== input.inputHash) throw new ExactSolverError('INVALID', 'Priority input identity changed.');
  // Check the legal model and retained base even if every selected row is missing.
  solveExact(graph, rowRequest(graph, input, [], []), limits);
}

function solveRow(graph: AtlasGraph, input: ExactRequest, limits: ExactLimits, control: PriorityControl): RowSolution {
  const cached = control.cache?.get(input.inputHash);
  if (cached) {
    if (cached.status === 'exact') validateExactSolution(graph, input, cached, limits);
    else if (cached.binding.inputHash !== input.inputHash || cached.cost !== validateCandidate(graph, input, cached.allocatedIds)) {
      throw new ExactSolverError('INVALID', 'Cached path does not match this row.');
    }
    if (cached.status === 'exact') return cached;
  }
  let result: RowSolution;
  if (control.exact !== false) {
    try { result = solveExact(graph, input, limits, { shouldCancel: control.shouldCancel }); }
    catch (error) {
      if (!(error instanceof ExactSolverError) || !['TOO_MANY_TARGETS', 'RESOURCE_LIMIT'].includes(error.code)) throw error;
      result = solveHeuristic(graph, input, limits, { pass: control.pass, seed: cached?.allocatedIds,
        shouldCancel: control.shouldCancel, elapsedMs: control.elapsedMs });
    }
  } else result = solveHeuristic(graph, input, limits, { pass: control.pass, seed: cached?.allocatedIds,
    shouldCancel: control.shouldCancel, elapsedMs: control.elapsedMs });
  if (cached && result.status !== 'exact' && compareCandidates(graph, input, cached.allocatedIds, result.allocatedIds) < 0) result = cached;
  control.cache?.set(input.inputHash, result);
  return result;
}

// Each pass starts at the original root/retained basis. A changed earlier fit
// recomputes every later row; a cached row is reusable only for the same basis.
export function* priorityEvaluation(graph: AtlasGraph, input: SolverInput, limits: ExactLimits, control: PriorityControl = {}): Generator<PriorityResult> {
  validateInput(graph, input, limits);
  const identity = solverIdentity(graph, input), pass = control.pass ?? 0;
  const base = solveExact(graph, rowRequest(graph, input, [], []), limits, { shouldCancel: control.shouldCancel });
  let accepted: string[] = [], allocatedIds = base.allocatedIds, cost = base.cost, tentative = false;
  const decisions: PriorityDecision[] = [];
  const snapshot = (complete: boolean): PriorityResult => {
    const exact = complete && decisions.every(row => row.proof.kind === 'exact');
    const proof: SolverProof = exact
      ? { kind: 'exact', inputHash: input.inputHash, graphHash: identity.graphHash, costModelHash: identity.costModelHash,
        variant: input.variant, minimumCost: cost, certificateHash: priorityCertificate(identity, base.proof, decisions, allocatedIds, cost) }
      : { kind: 'best_found', inputHash: input.inputHash, upperBound: cost, elapsedMs: control.elapsedMs ?? 0 };
    return { identity, pass, complete, allocatedIds: [...allocatedIds], cost, withinBudget: cost <= input.budget,
      acceptedTargetIds: [...accepted], decisions: structuredClone(decisions), proof, label: exact ? 'Shortest' : 'Best found so far',
      incidentalAvoidedIds: allocatedIds.filter(id => input.avoidedTargetIds.includes(id)) };
  };
  if (!input.rows.length) { yield snapshot(true); return; }
  for (let i = 0; i < input.rows.length; i++) {
    if (control.shouldCancel?.()) throw new ExactSolverError('CANCELLED', 'Priority evaluation was stopped.');
    const row = input.rows[i]!, request = rowRequest(graph, input, accepted, row.targetIds);
    const acceptedBasisIds = ordered([graph.rootId, ...accepted, ...(input.retainCurrent ? input.sourceAllocatedIds : [])]);
    const basisHash = digest({ identity, acceptedBasisIds, budget: input.budget });
    let record: PriorityDecision;
    try {
      if (row.taxonomy.status !== 'known') {
        record = { decision: { targetId: row.targetId, priority: i + 1, status: 'unavailable', acceptedBasisIds,
          cost: unknown('Targets unverified'), shortfall: unknown('Targets unverified') }, basisHash, request,
          proof: { kind: 'unavailable', reason: 'unverified_taxonomy' }, provisional: tentative, label: 'Targets unverified', detail: row.taxonomy.reason };
      } else {
        const result = solveRow(graph, request, limits, control);
        const proven = result.proof.kind === 'exact';
        const evidence = result.proof.kind === 'exact' ? result.proof.certificateHash : result.binding.inputHash;
        const fits = result.cost <= input.budget;
        record = { decision: { targetId: row.targetId, priority: i + 1,
          status: fits ? 'accepted' : proven ? 'skipped_proven' : 'fit_not_proven', acceptedBasisIds,
          cost: known(result.cost, evidence), shortfall: proven || fits ? known(result.shortfall, evidence) : unknown('Fit not proven') },
          basisHash, request, proof: result.proof, solution: result, provisional: tentative,
          label: fits ? 'Reached' : proven ? `${result.shortfall} points short` : `Needs up to ${result.shortfall} more points`,
          detail: fits ? (tentative ? 'Earlier fit is not proven. This mechanic is provisional.' : '')
            : proven ? `Priority ${i + 1} did not fit. Later mechanics were checked in order.`
              : `Fit not proven. Priority ${i + 1} fit is not proven. Later mechanics are provisional.`,
          ...(!fits && !proven ? { extraPointsUpperBound: result.shortfall } : {}) };
        if (fits) { accepted = ordered([...accepted, ...row.targetIds]); allocatedIds = result.allocatedIds; cost = result.cost; }
        else if (!proven) tentative = true;
      }
    } catch (error) {
      if (!(error instanceof ExactSolverError) || !['UNKNOWN_TARGET', 'UNREACHABLE_TARGET'].includes(error.code)) throw error;
      const label = error.code === 'UNKNOWN_TARGET' ? 'Unavailable in this tree data' : 'No connected path';
      record = { decision: { targetId: row.targetId, priority: i + 1, status: 'unavailable', acceptedBasisIds,
        cost: unknown(label), shortfall: unknown(label) }, basisHash, request,
        proof: { kind: 'unavailable', reason: error.code === 'UNKNOWN_TARGET' ? 'unknown_target' : 'unreachable_target' },
        provisional: tentative, label, detail: '' };
    }
    decisions.push(record);
    // Unknown taxonomy also leaves later rows provisional.
    if (record.proof.kind === 'unavailable' && record.proof.reason === 'unverified_taxonomy') tentative = true;
    if (solverInputHash(graph, input) !== input.inputHash) throw new ExactSolverError('INVALID', 'Priority input changed during solving.');
    yield snapshot(i === input.rows.length - 1);
  }
  if (solverInputHash(graph, input) !== input.inputHash) throw new ExactSolverError('INVALID', 'Priority input changed during solving.');
}

export function evaluatePriority(graph: AtlasGraph, input: SolverInput, limits: ExactLimits, control: PriorityControl = {}): PriorityResult {
  let result: PriorityResult | undefined;
  for (const candidate of priorityEvaluation(graph, input, limits, control)) result = candidate;
  return result!;
}

export function validatePriorityResult(graph: AtlasGraph, input: SolverInput, result: PriorityResult, limits: ExactLimits): void {
  if (solverInputHash(graph, input) !== input.inputHash || digest(result.identity) !== digest(solverIdentity(graph, input))) {
    throw new ExactSolverError('INVALID', 'The plan changed. Recalculate this preview.');
  }
  const accepted: string[] = [];
  let provisional = false;
  for (let i = 0; i < result.decisions.length; i++) {
    const row = result.decisions[i]!, expected = input.rows[i];
    if (!expected || row.decision.targetId !== expected.targetId || row.decision.priority !== i + 1 ||
      digest(row.request) !== digest(rowRequest(graph, input, accepted, expected.targetIds)) ||
      digest(row.decision.acceptedBasisIds) !== digest(ordered([graph.rootId, ...accepted, ...(input.retainCurrent ? input.sourceAllocatedIds : [])])) ||
      row.basisHash !== digest({ identity: result.identity, acceptedBasisIds: row.decision.acceptedBasisIds, budget: input.budget }) ||
      row.provisional !== provisional) {
      throw new ExactSolverError('INVALID', 'Priority basis does not match this preview.');
    }
    const solution = row.solution;
    if (solution) {
      const cost = validateCandidate(graph, row.request, solution.allocatedIds);
      if (solution.status === 'exact') validateExactSolution(graph, row.request, solution, limits);
      else if (solution.proof.kind !== 'best_found' || solution.proof.inputHash !== row.request.inputHash ||
        solution.binding.inputHash !== row.request.inputHash || solution.proof.upperBound !== cost) {
        throw new ExactSolverError('INVALID', 'Heuristic bound does not match this row.');
      }
      const fits = cost <= input.budget;
      const status = fits ? 'accepted' : solution.status === 'exact' ? 'skipped_proven' : 'fit_not_proven';
      if (expected.taxonomy.status !== 'known' || cost !== solution.cost || solution.withinBudget !== fits ||
        solution.shortfall !== Math.max(0, cost - input.budget) || row.decision.status !== status ||
        row.decision.cost.status !== 'known' || row.decision.cost.value !== cost || digest(row.proof) !== digest(solution.proof)) {
        throw new ExactSolverError('INVALID', 'Priority decision does not match its validated path.');
      }
      if (status === 'fit_not_proven') {
        if (row.decision.shortfall.status !== 'unknown' || row.extraPointsUpperBound !== solution.shortfall) throw new ExactSolverError('INVALID', 'Unproven fit needs an upper-bound label.');
        provisional = true;
      } else if (row.decision.shortfall.status !== 'known' || row.decision.shortfall.value !== solution.shortfall) {
        throw new ExactSolverError('INVALID', 'Proven shortfall does not match this row.');
      }
    } else if (row.decision.status !== 'unavailable' || row.proof.kind !== 'unavailable') {
      throw new ExactSolverError('INVALID', 'Priority decision has no validated path.');
    } else if (row.proof.reason === 'unverified_taxonomy') provisional = true;
    if (row.decision.status === 'accepted') accepted.push(...expected.targetIds);
  }
  const cost = validateCandidate(graph, rowRequest(graph, input, accepted, []), result.allocatedIds);
  if (digest(ordered(accepted)) !== digest(result.acceptedTargetIds) || cost !== result.cost || result.withinBudget !== (cost <= input.budget) ||
    result.complete && result.decisions.length !== input.rows.length || result.proof.kind !== 'unavailable' && result.proof.inputHash !== input.inputHash) {
    throw new ExactSolverError('INVALID', 'Candidate does not match the priority result.');
  }
  if (result.proof.kind === 'exact') {
    if (!result.complete || result.decisions.some(row => row.proof.kind !== 'exact') || result.label !== 'Shortest' ||
      result.proof.minimumCost !== cost || result.proof.graphHash !== result.identity.graphHash ||
      result.proof.costModelHash !== result.identity.costModelHash || result.proof.variant !== input.variant) {
      throw new ExactSolverError('INVALID', 'Shortest requires proof for every priority decision.');
    }
    const base = solveExact(graph, rowRequest(graph, input, [], []), limits);
    if (result.proof.certificateHash !== priorityCertificate(result.identity, base.proof, result.decisions, result.allocatedIds, cost)) {
      throw new ExactSolverError('INVALID', 'Priority certificate does not match this preview.');
    }
  } else if (result.proof.kind !== 'best_found' || result.label !== 'Best found so far' || result.proof.upperBound !== cost) {
    throw new ExactSolverError('INVALID', 'Best-found bound does not match this preview.');
  }
  if (digest(result.incidentalAvoidedIds) !== digest(result.allocatedIds.filter(id => input.avoidedTargetIds.includes(id)))) {
    throw new ExactSolverError('INVALID', 'Avoided travel does not match this preview.');
  }
}
