import { createHash } from 'node:crypto';
import { parseId } from '@pom/mastery-contracts';
import type { AtlasGraph } from '../graph.js';
import { checkedAdd, exactInputHash, ExactSolverError, prepareMetric, type ExactLimits, type ExactRequest } from './metric.js';
import { reconstruct, type ExactRow } from './reconstruct.js';
import { certificateHash, validateCandidate, type ExactSolution } from './validate.js';

export { EXACT_SOLVER_VERSION, ExactSolverError, exactInputHash } from './metric.js';
export type { ExactLimits, ExactRequest, ExactBinding } from './metric.js';
export type { ExactSolution } from './validate.js';
export type ExactControl = { shouldCancel?: () => boolean };
type Entry = { at: number; cost: number; tie: bigint };
function less(a: Entry, b: Entry): boolean { return a.cost < b.cost || a.cost === b.cost && (a.tie < b.tie || a.tie === b.tie && a.at < b.at); }
class Heap {
  private entries: Entry[] = [];
  push(entry: Entry): void {
    let i = this.entries.length; this.entries.push(entry);
    while (i) { const parent = (i - 1) >>> 1; if (!less(entry, this.entries[parent]!)) break; this.entries[i] = this.entries[parent]!; i = parent; }
    this.entries[i] = entry;
  }
  pop(): Entry | undefined {
    const first = this.entries[0], last = this.entries.pop();
    if (!first || !this.entries.length) return first;
    let i = 0;
    while (i * 2 + 1 < this.entries.length) {
      let child = i * 2 + 1;
      if (child + 1 < this.entries.length && less(this.entries[child + 1]!, this.entries[child]!)) child++;
      if (!less(this.entries[child]!, last!)) break;
      this.entries[i] = this.entries[child]!; i = child;
    }
    this.entries[i] = last!; return first;
  }
}

// Rooted node-weighted port of atlas-research/steiner.js. The research singleton
// BFS and unit buckets become weighted Dijkstra; merge subtracts the shared vertex.
export function solveExact(graph: AtlasGraph, request: ExactRequest, limits: ExactLimits, control: ExactControl = {}): ExactSolution {
  let work = 0;
  const check = (force = false) => {
    if ((force || (++work & 2047) === 0) && control.shouldCancel?.()) throw new ExactSolverError('CANCELLED', 'Exact solving was cancelled.');
  };
  check(true);
  const metric = prepareMetric(graph, request, limits);
  const full = (1 << metric.terminals.length) - 1, n = metric.ids.length;
  const rows: (ExactRow | undefined)[] = new Array(full + 1);
  const transcript = createHash('sha256');
  for (let mask = 1; mask <= full; mask++) {
    check(true);
    const row: ExactRow = { cost: new Float64Array(n).fill(Infinity), tie: new Array(n), previous: new Int32Array(n).fill(-1), split: new Uint16Array(n) };
    rows[mask] = row;
    if ((mask & (mask - 1)) === 0) {
      const terminal = metric.terminals[Math.log2(mask)]!;
      row.cost[terminal] = metric.costs[terminal]!; row.tie[terminal] = metric.ties[terminal]!;
    } else {
      for (let sub = (mask - 1) & mask; sub; sub = (sub - 1) & mask) {
        const rest = mask ^ sub;
        if (sub > rest) continue;
        const a = rows[sub]!, b = rows[rest]!;
        for (let at = 0; at < n; at++) {
          check();
          if (!Number.isFinite(a.cost[at]) || !Number.isFinite(b.cost[at])) continue;
          // Subtract before adding; bound states by the whole graph upper bound.
          const remaining = a.cost[at]! - metric.costs[at]!;
          if (remaining > metric.totalCost - b.cost[at]!) continue;
          const cost = remaining + b.cost[at]!;
          if (cost > row.cost[at]!) continue;
          const tie = a.tie[at]! + b.tie[at]! - metric.ties[at]!;
          if (cost < row.cost[at]! || row.tie[at] === undefined || tie < row.tie[at]!) {
            row.cost[at] = cost; row.tie[at] = tie; row.split[at] = sub;
          }
        }
      }
    }
    const queue = new Heap();
    for (let at = 0; at < n; at++) if (Number.isFinite(row.cost[at])) queue.push({ at, cost: row.cost[at]!, tie: row.tie[at]! });
    let entry: Entry | undefined;
    while ((entry = queue.pop())) {
      check();
      if (entry.cost !== row.cost[entry.at] || entry.tie !== row.tie[entry.at]) continue;
      for (const next of metric.adjacent[entry.at]!) {
        check();
        if (entry.cost > metric.totalCost - metric.costs[next]!) continue;
        const cost = entry.cost + metric.costs[next]!;
        if (cost > row.cost[next]!) continue;
        const tie = entry.tie + metric.ties[next]!;
        if (cost < row.cost[next]! || row.tie[next] === undefined || tie < row.tie[next]!) {
          row.cost[next] = cost; row.tie[next] = tie; row.previous[next] = entry.at; row.split[next] = 0;
          queue.push({ at: next, cost, tie });
        }
      }
    }
    transcript.update(Buffer.from(row.cost.buffer));
    transcript.update(Buffer.from(row.previous.buffer));
    transcript.update(Buffer.from(row.split.buffer));
  }
  check(true);
  const allocatedIds = reconstruct(metric, rows, full);
  const cost = validateCandidate(graph, request, allocatedIds);
  const minimum = checkedAdd(metric.baseCost, full ? rows[full]!.cost[metric.root]! : 0);
  if (cost !== minimum) throw new ExactSolverError('INVALID', 'Reconstructed allocation differs from the exact minimum.');
  const body: Omit<ExactSolution, 'proof'> = { status: 'exact', allocatedIds, cost, withinBudget: cost <= request.budget,
    shortfall: Math.max(0, cost - request.budget), binding: metric.binding, completedMasks: full,
    dpHash: parseId('hash', transcript.digest('hex')) };
  check(true);
  if (request.inputHash !== metric.binding.inputHash || exactInputHash(graph, request) !== metric.binding.inputHash) {
    throw new ExactSolverError('INVALID', 'Solver input changed during exact solving.');
  }
  return { ...body, proof: { kind: 'exact', inputHash: request.inputHash, graphHash: graph.graphHash,
    costModelHash: metric.binding.costModelHash, variant: request.variant, minimumCost: cost, certificateHash: certificateHash(body) } };
}
