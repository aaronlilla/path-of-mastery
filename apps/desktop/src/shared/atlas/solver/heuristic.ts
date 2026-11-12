import type { SolverProof } from '@pom/mastery-contracts';
import { ordered, type AtlasGraph } from '../graph.js';
import { exactInputHash, ExactSolverError, prepareMetric, type ExactBinding, type ExactLimits, type ExactRequest } from './metric.js';
import { validateCandidate } from './validate.js';

export const HEURISTIC_SOLVER_VERSION = 'atlas-attachment-reroute/1';
export type HeuristicSolution = {
  status: 'best_found'; allocatedIds: string[]; cost: number; withinBudget: boolean; shortfall: number;
  binding: ExactBinding; proof: Extract<SolverProof, { kind: 'best_found' }>;
};
export type HeuristicControl = { pass?: number; seed?: readonly string[]; shouldCancel?: () => boolean; elapsedMs?: number };
type Entry = { at: number; cost: number; tie: bigint };
const less = (a: Entry, b: Entry) => a.cost < b.cost || a.cost === b.cost && (a.tie < b.tie || a.tie === b.tie && a.at < b.at);
class Heap {
  private entries: Entry[] = [];
  push(entry: Entry): void {
    let i = this.entries.length; this.entries.push(entry);
    while (i) { const p = (i - 1) >>> 1; if (!less(entry, this.entries[p]!)) break; this.entries[i] = this.entries[p]!; i = p; }
    this.entries[i] = entry;
  }
  pop(): Entry | undefined {
    const first = this.entries[0], last = this.entries.pop();
    if (!first || !this.entries.length) return first;
    let i = 0;
    while (i * 2 + 1 < this.entries.length) {
      let c = i * 2 + 1;
      if (c + 1 < this.entries.length && less(this.entries[c + 1]!, this.entries[c]!)) c++;
      if (!less(this.entries[c]!, last!)) break;
      this.entries[i] = this.entries[c]!; i = c;
    }
    this.entries[i] = last!; return first;
  }
}

// Explicit objective: points, Keep additions or priority-group counts, travel,
// canonical IDs. Secondary choices never outweigh a point of primary cost.
export function compareCandidates(graph: AtlasGraph, request: ExactRequest, a: readonly string[], b: readonly string[]): number {
  const groups = request.preferredNodeGroups.map(group => new Set(group));
  const tuple = (ids: readonly string[]) => request.retainCurrent
    ? [validateCandidate(graph, request, ids), ids.filter(id => !request.sourceAllocatedIds.includes(id)).length]
    : [validateCandidate(graph, request, ids), ...groups.map(group => -ids.filter(id => group.has(id)).length),
      ids.filter(id => !groups.some(group => group.has(id))).length];
  const at = tuple(a), bt = tuple(b);
  for (let i = 0; i < at.length; i++) if (at[i] !== bt[i]) return at[i]! < bt[i]! ? -1 : 1;
  const ai = ordered(a), bi = ordered(b);
  for (let i = 0; i < Math.min(ai.length, bi.length); i++) if (ai[i] !== bi[i]) return ai[i]! < bi[i]! ? -1 : 1;
  return ai.length - bi.length;
}

export function solveHeuristic(graph: AtlasGraph, request: ExactRequest, limits: ExactLimits, control: HeuristicControl = {}): HeuristicSolution {
  let work = 0;
  const check = (force = false) => {
    if ((force || (++work & 127) === 0) && control.shouldCancel?.()) throw new ExactSolverError('CANCELLED', 'Path search was stopped.');
  };
  check(true);
  if (exactInputHash(graph, request) !== request.inputHash) throw new ExactSolverError('INVALID', 'Solver input identity changed.');
  // Reuse the solver's graph/model/retained validation and contraction without allocating
  // a terminal-mask table. The full terminal union is validated separately below.
  const base = { ...request, acceptedTargetIds: [], targetIds: [] };
  base.inputHash = exactInputHash(graph, base);
  const metric = prepareMetric(graph, base, limits);
  const required = ordered([...request.acceptedTargetIds, ...request.targetIds]);
  if (required.length + request.sourceAllocatedIds.length + request.preferredNodeGroups.flat().length > limits.maxInputIds) {
    throw new ExactSolverError('RESOURCE_LIMIT', 'Targets exceed the solver limit.');
  }
  const index = new Map(metric.ids.map((id, i) => [id, i]));
  const retained = new Set(metric.retainedIds);
  if (required.some(id => !graph.nodes.has(id))) throw new ExactSolverError('UNKNOWN_TARGET', 'A target is unavailable in this tree data.');
  if (required.some(id => !retained.has(id) && !index.has(id))) throw new ExactSolverError('UNREACHABLE_TARGET', 'No connected path to a target.');
  const terminals = required.filter(id => !retained.has(id)).map(id => index.get(id)!);
  const mandatory = new Set([0, ...terminals]);
  const pass = control.pass ?? 0;
  if (!Number.isSafeInteger(pass) || pass < 0) throw new ExactSolverError('INVALID', 'Search pass must be a nonnegative whole number.');
  const seed = control.seed && ordered(control.seed);
  if (seed) validateCandidate(graph, request, seed);
  const optional = seed?.filter(id => !retained.has(id) && !required.includes(id)) ?? [];
  // Deterministic rip-up: avoid one optional seed vertex, then reconnect all
  // terminals on the full graph. Keep the seed if the reroute is worse.
  const blocked = pass >= 3 && optional.length ? index.get(optional[(pass - 3) % optional.length]!) : undefined;
  const build = (ban: number | undefined): string[] | undefined => {
    const selected = new Set([0]);
    let remaining = [...terminals];
    if (pass % 3 === 1) remaining.reverse();
    if (pass % 3 === 2 && remaining.length) {
      const offset = Math.floor(pass / 3) % remaining.length;
      remaining = [...remaining.slice(offset), ...remaining.slice(0, offset)];
    }
    while (remaining.length) {
      check(true);
      remaining = remaining.filter(at => !selected.has(at));
      if (!remaining.length) break;
      const distances = new Float64Array(metric.ids.length).fill(Infinity);
      const ties: (bigint | undefined)[] = new Array(metric.ids.length);
      const previous = new Int32Array(metric.ids.length).fill(-1);
      const queue = new Heap();
      for (const at of selected) { distances[at] = 0; ties[at] = 0n; queue.push({ at, cost: 0, tie: 0n }); }
      const wanted = new Set(pass % 3 === 0 ? remaining : [remaining[0]!]);
      let found: number | undefined;
      let entry: Entry | undefined;
      while ((entry = queue.pop())) {
        check();
        if (distances[entry.at] !== entry.cost || ties[entry.at] !== entry.tie) continue;
        if (wanted.has(entry.at)) { found = entry.at; break; }
        for (const next of metric.adjacent[entry.at]!) {
          check();
          if (next === ban || selected.has(next)) continue;
          if (entry.cost > metric.totalCost - metric.costs[next]!) continue;
          const cost = entry.cost + metric.costs[next]!, tie = entry.tie + metric.ties[next]!;
          if (cost < distances[next]! || cost === distances[next] && (ties[next] === undefined || tie < ties[next]!)) {
            distances[next] = cost; ties[next] = tie; previous[next] = entry.at;
            queue.push({ at: next, cost, tie });
          }
        }
      }
      if (found === undefined) return undefined;
      let at = found;
      while (!selected.has(at)) { check(); selected.add(at); at = previous[at]!; }
    }
    // Delete redundant travel and cycle vertices only when all required vertices
    // remain root-connected. This also prunes dangling attachment branches.
    const removable = [...selected].filter(at => !mandatory.has(at)).sort((a, b) => metric.costs[b]! - metric.costs[a]! || b - a);
    for (const at of removable) {
      check(true); selected.delete(at);
      const visited = new Set([0]), pending = [0];
      for (let i = 0; i < pending.length; i++) for (const next of metric.adjacent[pending[i]!]!) {
        check(); if (selected.has(next) && !visited.has(next)) { visited.add(next); pending.push(next); }
      }
      if ([...selected].some(node => !visited.has(node))) selected.add(at);
    }
    return ordered([...metric.retainedIds, ...[...selected].map(at => metric.ids[at]!)].filter(id => id !== graph.rootId));
  };
  let allocatedIds = build(blocked) ?? seed ?? build(undefined);
  if (!allocatedIds) throw new ExactSolverError('UNREACHABLE_TARGET', 'No connected path to a target.');
  if (seed && compareCandidates(graph, request, seed, allocatedIds) < 0) allocatedIds = seed;
  const cost = validateCandidate(graph, request, allocatedIds);
  check(true);
  if (exactInputHash(graph, request) !== request.inputHash) throw new ExactSolverError('INVALID', 'Solver input changed during path search.');
  const binding: ExactBinding = { ...metric.binding, inputHash: request.inputHash, requiredTargetIds: required, solverVersion: HEURISTIC_SOLVER_VERSION };
  return { status: 'best_found', allocatedIds, cost, withinBudget: cost <= request.budget, shortfall: Math.max(0, cost - request.budget), binding,
    proof: { kind: 'best_found', inputHash: request.inputHash, upperBound: cost, elapsedMs: control.elapsedMs ?? 0 } };
}
