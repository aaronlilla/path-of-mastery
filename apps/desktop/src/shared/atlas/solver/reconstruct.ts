import { ordered } from '../graph.js';
import { ExactSolverError, type ExactMetric } from './metric.js';

export type ExactRow = { cost: Float64Array; tie: (bigint | undefined)[]; previous: Int32Array; split: Uint16Array };
export function reconstruct(metric: ExactMetric, rows: readonly (ExactRow | undefined)[], fullMask: number): string[] {
  const ids = new Set(metric.retainedIds);
  const visited = new Set<number>();
  const pending: [number, number][] = fullMask ? [[fullMask, metric.root]] : [];
  while (pending.length) {
    const [mask, at] = pending.pop()!;
    const state = mask * metric.ids.length + at;
    if (visited.has(state)) continue;
    visited.add(state);
    ids.add(metric.ids[at]!);
    const row = rows[mask]!;
    if (row.previous[at]! >= 0) pending.push([mask, row.previous[at]!]);
    else if (row.split[at]) pending.push([row.split[at]!, at], [mask ^ row.split[at]!, at]);
    else if ((mask & (mask - 1)) !== 0 || metric.terminals[Math.log2(mask)] !== at) throw new ExactSolverError('INVALID', 'Exact path reconstruction is incomplete.');
  }
  return ordered(ids).filter(id => id !== metric.ids[metric.root]);
}
