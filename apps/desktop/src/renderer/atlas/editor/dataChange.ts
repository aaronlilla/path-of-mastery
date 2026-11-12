import type { AtlasPlan, DatasetRef } from '@pom/mastery-contracts';
import { inspectAllocation, type AtlasGraph } from '../../../shared/atlas/graph.js';
import { validatePlan } from '../../../shared/atlas/plan.js';
import type { ValidationLimits } from '@pom/mastery-contracts';
import { tr } from '../../i18n';

export function dataChangePreview(plan: AtlasPlan, source: AtlasGraph | undefined, target: AtlasGraph) {
  const ids = [...new Set(Object.values(plan.stepsById).flatMap(step => step.allocatedIds))];
  return ids.map(id => {
    const a = source?.nodes.get(id), b = target.nodes.get(id);
    const known = !!a && !!b && a.stats.every(stat => stat.provenance.length > 0) && b.stats.every(stat => stat.provenance.length > 0) && source?.costs.status === 'known' && target.costs.status === 'known';
    const identical = known && JSON.stringify(a.stats.map(s => [s.statId, s.effectSchemaHash, s.value, s.unit]).sort()) === JSON.stringify(b.stats.map(s => [s.statId, s.effectSchemaHash, s.value, s.unit]).sort()) && source!.costs.status === 'known' && target.costs.status === 'known' && source!.costs.value.nodeCosts[id] === target.costs.value.nodeCosts[id];
    return { id, name: b?.name ?? a?.name ?? tr('atlas_editor_dataChange.node_is_unavailable_in_this_dataset', { id: id }), asset: b?.asset ?? a?.asset ?? null,
      status: !b ? 'Missing in target data' as const : !known ? 'Effect comparison unavailable' as const : identical ? 'Exact ID match' as const : 'Effect changed' as const };
  });
}
export function changeTreeData(plan: AtlasPlan, dataset: DatasetRef, graph: AtlasGraph, removed: readonly string[], limits: ValidationLimits): AtlasPlan {
  const next = structuredClone(plan);
  next.dataset = structuredClone(dataset);
  next.stamp.datasetVersion = structuredClone(dataset.stamp.datasetVersion); next.stamp.patchVersion = structuredClone(dataset.stamp.patchVersion);
  for (const step of Object.values(next.stepsById)) {
    step.allocatedIds = step.allocatedIds.filter(id => !removed.includes(id));
    step.repair = inspectAllocation(graph, step.allocatedIds);
    if (step.repair.missingIds.length || step.repair.disconnectedIds.length) throw new Error(tr('atlas_editor_dataChange.resolve_missing_ids_and_disconnected_paths'));
  }
  return validatePlan(next, limits);
}
