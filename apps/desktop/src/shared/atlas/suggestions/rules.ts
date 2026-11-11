import type { AtlasStep } from '@pom/mastery-contracts';
import { allocationCost, ordered, rootComponent, type AtlasGraph } from '../graph.js';
import type { MechanicRow } from './mechanics.js';

export const RULES_VERSION = 'atlas-rules/1';
export const CLUSTER_FINISH_MAX = 3;
export type Origin = 'Rule' | 'AI';
export type Suggestion = {
  id: string;
  /** Suppression key: rule ID + target + intent. */
  key: string;
  rule: string; origin: Origin; kind: 'path' | 'info';
  text: string; detail: string;
  target?: { targetId: string; name: string; nodeIds: string[] };
  afterIds?: string[]; cost?: number;
  action?: 'choose-sustain';
  /** AI reasons are shown as quoted text. They never feed a number or a path. */
  reason?: string;
};
/** Problems with the plan itself. They are shown outside the rail and ignore the suppression ledger. */
export type Warning = { id: string; text: string; tone: 'error' | 'warn' };
export type RuleContext = {
  step: AtlasStep; graph: AtlasGraph; budget: number; mechanics: readonly MechanicRow[];
  priority: readonly string[]; sustainAvailable: boolean; sustainChosen: boolean; dataQualified: boolean; dataLabel: string;
};
export const suggestionKey = (rule: string, target: string, intent: string) => `${rule}|${target}|${intent}`;

type Reach = { cost: Map<string, number>; previous: Map<string, string> };
/** One multi-source shortest-path pass from the connected allocation. Allocated nodes cost 0, others their sourced cost. */
export function reachFrom(graph: AtlasGraph, allocated: readonly string[]): Reach | null {
  if (graph.costs.status !== 'known') return null;
  const costs = graph.costs.value.nodeCosts, have = new Set(allocated), anchors = rootComponent(graph, have);
  const cost = new Map<string, number>(), previous = new Map<string, string>(), settled = new Set<string>();
  const heap: [number, string][] = [];
  const push = (item: [number, string]) => { heap.push(item); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (less(heap[p]!, heap[i]!)) break; [heap[p], heap[i]] = [heap[i]!, heap[p]!]; i = p; } };
  const less = (a: [number, string], b: [number, string]) => a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);
  const pop = () => { const top = heap[0]!, last = heap.pop()!; if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && !less(heap[m]!, heap[l]!)) m = l; if (r < heap.length && !less(heap[m]!, heap[r]!)) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i]!, heap[m]!]; i = m; } } return top; };
  for (const id of ordered(anchors)) { cost.set(id, 0); push([0, id]); }
  while (heap.length) {
    const [d, at] = pop();
    if (settled.has(at)) continue;
    settled.add(at);
    for (const next of graph.adjacent.get(at) ?? []) {
      if (settled.has(next) || anchors.has(next)) continue;
      const nd = d + (have.has(next) ? 0 : costs[next]!);
      if (!cost.has(next) || nd < cost.get(next)!) { cost.set(next, nd); previous.set(next, at); push([nd, next]); }
    }
  }
  return { cost, previous };
}
export function pathTo(reach: Reach, anchors: ReadonlySet<string>, target: string): string[] | null {
  if (!reach.cost.has(target)) return null;
  const ids = [target];
  while (!anchors.has(ids[0]!)) { const p = reach.previous.get(ids[0]!); if (p === undefined) return null; ids.unshift(p); }
  return ids;
}

/** Add targets one at a time, each by its cheapest path from what is already allocated. Cost is the real added points. */
export function pathForTargets(graph: AtlasGraph, allocated: readonly string[], nodeIds: readonly string[]): { afterIds: string[]; cost: number } | null {
  if (graph.costs.status !== 'known') return null;
  const costs = graph.costs.value.nodeCosts;
  let after = ordered(allocated), total = 0;
  for (const target of nodeIds) {
    const reach = reachFrom(graph, after)!, path = pathTo(reach, rootComponent(graph, new Set(after)), target);
    if (!path) return null;
    const add = path.filter(id => !after.includes(id) && id !== graph.rootId);
    total += add.reduce((sum, id) => sum + costs[id]!, 0); after = ordered([...after, ...add]);
  }
  return { afterIds: after, cost: total };
}

export function structuralWarnings(step: AtlasStep, graph: AtlasGraph | undefined, budget = step.pointBudget): Warning[] {
  if (!graph) return [{ id: 'tree-data', text: 'Tree data is unavailable. The plan snapshot is preserved.', tone: 'error' }];
  const out: Warning[] = [];
  const missing = step.allocatedIds.filter(id => !graph.nodes.has(id)), loose = step.repair.disconnectedIds;
  if (missing.length) out.push({ id: 'missing', text: `${missing.length} allocated ${missing.length === 1 ? 'node is' : 'nodes are'} unavailable in this tree data.`, tone: 'error' });
  if (loose.length) out.push({ id: 'disconnected', text: 'Allocated nodes need a connected path.', tone: 'error' });
  const cost = allocationCost(graph, step.allocatedIds);
  if (cost.status === 'known' && cost.value > budget) out.push({ id: 'over-budget', text: `${cost.value - budget} points over your budget.`, tone: 'warn' });
  return out;
}

export function evaluateRules(ctx: RuleContext): { suggestions: Suggestion[]; warning: string | null } {
  const { step, graph } = ctx, out: Suggestion[] = [];
  const spent = allocationCost(graph, step.allocatedIds);
  let warning: string | null = null;
  if (spent.status !== 'known') warning = 'Suggestions need sourced point costs, which are unverified in this tree data.';
  else {
    const free = ctx.budget - spent.value, have = new Set(step.allocatedIds), anchors = rootComponent(graph, have), reach = reachFrom(graph, step.allocatedIds)!;
    const order = new Map(ctx.priority.map((id, i) => [id, i] as const));
    const rows = [...ctx.mechanics].filter(m => m.taxonomy.status === 'known' && m.notables.length).sort((a, b) =>
      (order.get(a.targetId) ?? 1e9) - (order.get(b.targetId) ?? 1e9) || a.targetId.localeCompare(b.targetId));
    const paths: Suggestion[] = [];
    for (const m of rows) {
      const open = m.notables.filter(n => !have.has(n.nodeId) && reach.cost.has(n.nodeId));
      if (!open.length) continue;
      // Finish a cluster: the mechanic is already started and what is left is small and fits.
      if (open.length < m.notables.length) {
        const got = pathForTargets(graph, step.allocatedIds, open.map(n => n.nodeId)), after = got?.afterIds ?? [], total = got?.cost ?? 0, ok = !!got;
        if (ok && total > 0 && total <= CLUSTER_FINISH_MAX && total <= free) {
          paths.push({ id: `finish:${m.targetId}`, key: suggestionKey('finish-cluster', m.targetId, 'add'), rule: 'finish-cluster', origin: 'Rule', kind: 'path',
            text: `Finish ${m.name}: +${total} ${total === 1 ? 'point' : 'points'}`, detail: `Reaches the remaining ${open.length} ${open.length === 1 ? 'notable' : 'notables'} of ${m.name}. ${ctx.dataLabel}`,
            target: { targetId: m.targetId, name: m.name, nodeIds: open.map(n => n.nodeId) }, afterIds: after, cost: total });
          continue;
        }
      }
      const best = open.map(n => ({ n, c: reach.cost.get(n.nodeId)! })).filter(x => x.c > 0 && x.c <= free)
        .sort((a, b) => a.c - b.c || a.n.name.localeCompare(b.n.name) || a.n.nodeId.localeCompare(b.n.nodeId))[0];
      if (!best) continue;
      const path = pathTo(reach, anchors, best.n.nodeId)!, add = path.filter(id => !have.has(id) && id !== graph.rootId);
      paths.push({ id: `reach:${best.n.nodeId}`, key: suggestionKey('reach-notable', best.n.nodeId, 'add'), rule: 'reach-notable', origin: 'Rule', kind: 'path',
        text: `Reach ${best.n.name}: +${best.c} ${best.c === 1 ? 'point' : 'points'}`, detail: `A notable of ${m.name}. ${best.n.lines[0] ?? ''} ${ctx.dataLabel}`.trim(),
        target: { targetId: m.targetId, name: m.name, nodeIds: [best.n.nodeId] }, afterIds: ordered([...step.allocatedIds, ...add]), cost: best.c });
    }
    out.push(...paths);
    if (free > 0 && step.allocatedIds.length) out.push({ id: 'unused-budget', key: suggestionKey('unused-budget', step.stepId, 'info'), rule: 'unused-budget', origin: 'Rule', kind: 'info',
      text: `${free} ${free === 1 ? 'point is' : 'points are'} unspent.`, detail: 'Your allocation is under the budget for this step.' });
  }
  if (ctx.sustainAvailable && !ctx.sustainChosen) out.push({ id: 'no-sustain', key: suggestionKey('no-sustain', step.stepId, 'info'), rule: 'no-sustain', origin: 'Rule', kind: 'info',
    text: 'No sustain targets set.', detail: 'Map sustain is None in Optimize mechanics.', action: 'choose-sustain' });
  if (!step.maps.length) out.push({ id: 'empty-maps', key: suggestionKey('empty-maps', step.stepId, 'info'), rule: 'empty-maps', origin: 'Rule', kind: 'info', text: 'No maps selected.', detail: 'This step lists no maps.' });
  if (!step.scarabs.length) out.push({ id: 'empty-scarabs', key: suggestionKey('empty-scarabs', step.stepId, 'info'), rule: 'empty-scarabs', origin: 'Rule', kind: 'info', text: 'No scarabs selected.', detail: 'This step lists no scarabs.' });
  return { suggestions: out, warning };
}

/** Keep earlier rows where they were; new ones go to the end. Recommendations never reshuffle under the pointer. */
export function stableOrder<T extends { id: string }>(previous: readonly string[], next: readonly T[]): T[] {
  const byId = new Map(next.map(item => [item.id, item] as const));
  const kept = previous.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  const seen = new Set(kept.map(item => item.id));
  return [...kept, ...next.filter(item => !seen.has(item.id))];
}
/** Rule rows first, then AI; at most `limit` actionable rows show, the rest wait behind a count. */
export function visibleRows<T extends Suggestion>(rows: readonly T[], limit = 3): { shown: T[]; more: T[] } {
  const rank = (s: Suggestion) => (s.origin === 'Rule' ? 0 : 1) * 2 + (s.kind === 'path' ? 0 : 1);
  const sorted = rows.map((row, i) => ({ row, i })).sort((a, b) => rank(a.row) - rank(b.row) || a.i - b.i).map(x => x.row);
  return { shown: sorted.slice(0, limit), more: sorted.slice(limit) };
}
