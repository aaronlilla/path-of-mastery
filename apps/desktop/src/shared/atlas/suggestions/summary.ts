import { allocationCost, type AtlasGraph } from '../graph.js';
import { changed, type Proposal, type ResultRow } from './proposal.js';

/** What Apply will do to the tree, in points, and why any budget is left unspent. Shown before and after Apply. */
export type ApplySummary = {
  addedNodes: number; removedNodes: number;
  /** Point totals; null when the tree data has no verified point costs. `left` is negative when over budget. */
  addedPoints: number | null; removedPoints: number | null; total: number | null; left: number | null; budget: number;
  /** One plain sentence; null when every point is used or nothing can be said. */
  unspent: string | null;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (rows: readonly ResultRow[]) => rows.map(r => `${r.name} (${r.label})`).join(', ');
/** Only a proven shortage "does not fit"; an unproven fit is not called a failure, and an unreachable target is named as such. */
function reasons(missed: readonly ResultRow[]): string {
  const short = missed.filter(r => r.tone === 'short'), unsure = missed.filter(r => r.tone === 'tentative'), gone = missed.filter(r => r.tone === 'unavailable');
  return [short.length ? `${list(short)} ${short.length === 1 ? 'does' : 'do'} not fit in what is left` : '',
    unsure.length ? `${list(unsure)} ${unsure.length === 1 ? 'is' : 'are'} not proven to fit yet` : '',
    gone.length ? `${list(gone)} cannot be reached in this tree data` : ''].filter(Boolean).join('; ');
}

export function applySummary(graph: AtlasGraph, p: Proposal, budget: number): ApplySummary {
  const { added, removed } = changed(p.baseAllocatedIds, p.afterIds);
  const costs = graph.costs.status === 'known' ? graph.costs.value.nodeCosts : null;
  const sum = (ids: readonly string[]) => costs && ids.every(id => Number.isFinite(costs[id])) ? ids.reduce((s, id) => s + costs[id]!, 0) : null;
  const after = allocationCost(graph, p.afterIds), total = after.status === 'known' ? after.value : null;
  const left = total === null ? null : budget - total; // negative: over budget
  const base = { addedNodes: added.length, removedNodes: removed.length, addedPoints: sum(added), removedPoints: sum(removed), total, left, budget };
  if (left === null || left <= 0) return { ...base, unspent: null };
  const missed = p.results.filter(r => r.tone !== 'reached');
  const reached = p.results.filter(r => r.tone === 'reached');
  const unspent = !p.results.length ? null
    : p.certainty === 'Rule path' ? `Why points are left: this suggestion is one path, to ${p.results[0]!.name}. Apply more suggestions or optimize mechanics to use them.`
    : !missed.length ? `Why points are left: ${reached.length === 1 ? `${reached[0]!.name} is` : `all ${reached.length} chosen mechanics are`} reached, and the optimizer only spends the points a path needs. Choose more mechanics to use them.`
      : `Why points are left: ${reasons(missed)}.`;
  return { ...base, unspent };
}

/** "Adds 12 points (9 nodes), removes 3 points (2 nodes). 40 / 138 points, 98 left." */
export function summaryText(s: ApplySummary): string {
  const part = (verb: string, points: number | null, nodes: number) => points === null ? `${verb} ${plural(nodes, 'node')}` : `${verb} ${plural(points, 'point')} (${plural(nodes, 'node')})`;
  const changes = [s.addedNodes ? part('adds', s.addedPoints, s.addedNodes) : '', s.removedNodes ? part('removes', s.removedPoints, s.removedNodes) : ''].filter(Boolean).join(', ') || 'no changes';
  const totals = s.total === null ? 'point cost unverified' : `${s.total} / ${s.budget} points, ${s.left! < 0 ? `${-s.left!} over budget` : `${s.left} left`}`;
  return `${changes[0]!.toUpperCase()}${changes.slice(1)}. ${totals}.`;
}
