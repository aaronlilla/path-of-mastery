import type { AtlasDataset } from '@pom/mastery-contracts';
import { ordered, rootComponent, type AtlasGraph } from './graph.js';

export type ResolvedTarget = { targetId: string; nodeIds: string[]; status: 'verified' | 'unverified' | 'unknown_target' | 'unknown_node' | 'unreachable'; affectedIds: string[] };
export function resolveTargets(graph: AtlasGraph, taxonomy: AtlasDataset['taxonomy'], targetIds: readonly string[]): ResolvedTarget[] {
  const reachable = rootComponent(graph);
  return [...new Set(targetIds)].map(targetId => {
    const candidates = taxonomy.targets.filter(target => target.targetId === targetId);
    const target = candidates[0];
    if (!target) return { targetId, nodeIds: [], status: 'unknown_target', affectedIds: [] };
    const nodeIds = ordered(target.nodeIds);
    const missing = nodeIds.filter(id => !graph.nodes.has(id));
    const detached = nodeIds.filter(id => graph.nodes.has(id) && !reachable.has(id));
    const status = missing.length ? 'unknown_node' : detached.length ? 'unreachable' : candidates.length !== 1 || !nodeIds.length ||
      target.verified.status !== 'known' || !target.verified.value ? 'unverified' : 'verified';
    return { targetId, nodeIds, status, affectedIds: missing.length ? missing : detached };
  });
}
