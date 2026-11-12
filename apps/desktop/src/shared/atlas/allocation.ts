import type { Known } from '@pom/mastery-contracts';
import { allocationCost, AtlasDomainError, inspectAllocation, known, ordered, rootComponent, unknown, type AtlasGraph } from './graph.js';

export type AllocationPreview = {
  allocatedIds: string[]; addedIds: string[]; pathIds: string[];
  incrementalCost: Known<number>; totalCost: Known<number>; overBudget: Known<number>;
  pathBasis: 'weighted_points' | 'topology_only'; repair: ReturnType<typeof inspectAllocation>;
};

export function previewAllocation(graph: AtlasGraph, allocated: readonly string[], targetId: string, budget: number): AllocationPreview {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new AtlasDomainError('INVALID', 'Point budget must be a nonnegative whole number.');
  if (!graph.nodes.has(targetId)) throw new AtlasDomainError('UNKNOWN_NODE', `Node ${targetId} is unavailable in this dataset.`);
  const anchors = rootComponent(graph, new Set(allocated));
  const distances = new Map<string, number>();
  const previous = new Map<string, string>();
  const settled = new Set<string>();
  for (const id of ordered(anchors)) distances.set(id, 0);
  while (true) {
    let at: string | undefined;
    for (const id of distances.keys()) if (!settled.has(id) && (at === undefined || distances.get(id)! < distances.get(at)! ||
      (distances.get(id) === distances.get(at) && id < at))) at = id;
    if (at === undefined) throw new AtlasDomainError('UNREACHABLE', 'No connected path.');
    if (at === targetId) break;
    settled.add(at);
    for (const next of graph.adjacent.get(at)!) {
      if (settled.has(next) || anchors.has(next)) continue;
      const cost = allocated.includes(next) ? 0 : graph.costs.status === 'known' ? graph.costs.value.nodeCosts[next]! : 1;
      const distance = distances.get(at)! + cost;
      if (!Number.isFinite(distance) || distance > Number.MAX_SAFE_INTEGER) throw new AtlasDomainError('INVALID', 'Path cost exceeds the supported numeric range.');
      if (!distances.has(next) || distance < distances.get(next)!) { distances.set(next, distance); previous.set(next, at); }
    }
  }
  const pathIds = [targetId];
  while (!anchors.has(pathIds[0]!)) pathIds.unshift(previous.get(pathIds[0]!)!);
  const addedIds = ordered(pathIds.filter(id => id !== graph.rootId && !allocated.includes(id)));
  const allocatedIds = ordered([...allocated, ...addedIds]);
  const totalCost = allocationCost(graph, allocatedIds);
  const costs = graph.costs;
  const incrementalCost: Known<number> = costs.status === 'known'
    ? known(addedIds.reduce((sum, id) => sum + costs.value.nodeCosts[id]!, 0), costs.evidenceId)
    : unknown(costs.reason);
  return { allocatedIds, addedIds, pathIds, incrementalCost, totalCost,
    overBudget: totalCost.status === 'known' ? known(Math.max(0, totalCost.value - budget), totalCost.evidenceId) : unknown(totalCost.reason),
    pathBasis: graph.costs.status === 'known' ? 'weighted_points' : 'topology_only', repair: inspectAllocation(graph, allocatedIds) };
}

export function previewRemoval(graph: AtlasGraph, allocated: readonly string[], nodeId: string): {
  removedIds: string[]; cascadeIds: string[]; allocatedIds: string[]; repair: ReturnType<typeof inspectAllocation>;
} {
  if (nodeId === graph.rootId) throw new AtlasDomainError('INVALID', 'The tree root cannot be removed.');
  if (!allocated.includes(nodeId)) throw new AtlasDomainError('NOT_FOUND', 'Node is not allocated.');
  const before = rootComponent(graph, new Set(allocated));
  const remaining = allocated.filter(id => id !== nodeId);
  const after = rootComponent(graph, new Set(remaining));
  const cascadeIds = ordered(remaining.filter(id => before.has(id) && !after.has(id)));
  const removedIds = ordered([nodeId, ...cascadeIds]);
  const allocatedIds = ordered(remaining.filter(id => !removedIds.includes(id)));
  return { removedIds, cascadeIds, allocatedIds, repair: inspectAllocation(graph, allocatedIds) };
}
