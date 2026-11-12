import type { AtlasStep } from '@pom/mastery-contracts';
import { ordered, type AtlasGraph } from './graph.js';
import { summarizeStats, type StatSummary } from './stats.js';

export function diffSteps(before: AtlasStep, after: AtlasStep, beforeGraph: AtlasGraph, afterGraph: AtlasGraph) {
  const a = new Set(before.allocatedIds), b = new Set(after.allocatedIds);
  const shared = ordered([...a].filter(id => b.has(id)));
  const unmatchedIds = ordered([...a, ...b]).filter(id => (a.has(id) && !beforeGraph.nodes.has(id)) || (b.has(id) && !afterGraph.nodes.has(id)));
  const oldStats = summarizeStats(beforeGraph, before.allocatedIds), newStats = summarizeStats(afterGraph, after.allocatedIds);
  const key = (stat: StatSummary) => JSON.stringify([stat.statId, stat.effectSchemaHash, stat.unit.status === 'known' ? stat.unit.value : null]);
  const stats = ordered([...oldStats.additive, ...newStats.additive].map(stat => stat.statId)).map(statId => {
    const oldRows = oldStats.additive.filter(s => s.statId === statId), newRows = newStats.additive.filter(s => s.statId === statId);
    const old = oldRows[0], next = newRows[0];
    const comparable = oldRows.length === 1 && newRows.length === 1 && old && next && key(old) === key(next) && old.value.status === 'known' && next.value.status === 'known';
    return { statId, before: oldRows, after: newRows, delta: comparable && old.value.status === 'known' && next.value.status === 'known' ? next.value.value - old.value.value : null,
      status: comparable ? 'comparable' as const : 'not_comparable' as const };
  });
  const fields = (['effectSelections', 'pointBudget', 'pointTarget', 'maps', 'favouriteMaps', 'scarabs', 'strategy', 'instructions', 'title', 'repair'] as const)
    .filter(field => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .map(field => ({ field, before: structuredClone(before[field]), after: structuredClone(after[field]) }));
  const practical = (['maps', 'favouriteMaps', 'scarabs'] as const).flatMap(kind =>
    ordered([...before[kind], ...after[kind]].map(row => row.catalogId)).flatMap(catalogId => {
      const oldRows = before[kind].filter(row => row.catalogId === catalogId), newRows = after[kind].filter(row => row.catalogId === catalogId);
      return JSON.stringify(oldRows) === JSON.stringify(newRows) ? [] : [{ kind, catalogId, before: structuredClone(oldRows), after: structuredClone(newRows) }];
    }));
  return { addedIds: ordered([...b].filter(id => !a.has(id))), removedIds: ordered([...a].filter(id => !b.has(id))),
    unchangedIds: shared.filter(id => !unmatchedIds.includes(id)), unmatchedIds,
    differentGraph: beforeGraph.graphHash !== afterGraph.graphHash, stats, separateStats: { before: oldStats.separate, after: newStats.separate }, practical, fields };
}
