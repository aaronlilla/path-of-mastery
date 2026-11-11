import type { AssetRef, AtlasDataset, Known } from '@pom/mastery-contracts';
import { readableLines } from '../statText.js';
import { known, ordered, unknown, type AtlasGraph } from '../graph.js';
import { resolveTargets, type ResolvedTarget } from '../targets.js';

// Renderer-safe: no hashing and no solver imports. Everything here comes from the pinned dataset.
export const UNVERIFIED_TARGETS = 'Targets unverified';
export type Notable = { nodeId: string; name: string; lines: string[]; asset: AssetRef | null };
export type MechanicRow = {
  targetId: string; name: string; nodeIds: string[]; notables: Notable[];
  taxonomy: Known<'verified'>; status: ResolvedTarget['status']; problem: string | null; asset: AssetRef | null;
};
/** A versioned, data-backed node group for the Map sustain slider. Absent data disables the slider. */
export type SustainGroup = { targetId: string; name: string; nodeIds: string[]; evidenceId: string };
export type SustainGroups = { revision: string; some: SustainGroup; more: SustainGroup };

const problemFor = (status: ResolvedTarget['status']): string | null =>
  status === 'verified' ? null : status === 'unverified' ? UNVERIFIED_TARGETS
    : status === 'unreachable' ? 'No connected path' : 'Unavailable in this tree data';

export function mechanicRows(graph: AtlasGraph, taxonomy: AtlasDataset['taxonomy'], names: Readonly<Record<string, string>> = {}): MechanicRow[] {
  const ids = ordered(taxonomy.targets.map(target => target.targetId));
  const resolved = new Map(resolveTargets(graph, taxonomy, ids).map(row => [row.targetId, row]));
  return ids.map(targetId => {
    const r = resolved.get(targetId)!, target = taxonomy.targets.find(row => row.targetId === targetId)!;
    const notables = r.nodeIds.flatMap(nodeId => {
      const node = graph.nodes.get(nodeId);
      return node ? [{ nodeId, name: node.name, lines: readableLines(node.stats.map(stat => stat.sourceText)), asset: node.asset }] : [];
    });
    const evidence = target.verified.status === 'known' && target.verified.value ? target.verified.evidenceId : null;
    return { targetId, name: names[targetId] ?? targetId, nodeIds: r.nodeIds, notables,
      taxonomy: r.status === 'verified' && evidence ? known('verified' as const, evidence) : unknown<'verified'>(UNVERIFIED_TARGETS),
      status: r.status, problem: problemFor(r.status), asset: notables[0]?.asset ?? null };
  });
}

/** Display name per taxonomy target, from the pinned data only: the shared official mastery label of the notables'
 * export groups (GGG names each mechanic cluster's mastery, e.g. "Breach"), else their shared in-game name, else Unknown. */
export function targetDisplayNames(taxonomy: AtlasDataset['taxonomy'], nodeName: (id: string) => string | undefined,
  geometry: Readonly<Record<string, { group: string } | undefined>>, nodeMetadata: Readonly<Record<string, Record<string, unknown> | undefined>>): Record<string, string> {
  const masteryByGroup = new Map<string, Set<string>>();
  for (const [id, meta] of Object.entries(nodeMetadata)) {
    const group = geometry[id]?.group, name = meta?.name;
    if (meta?.isMastery !== true || group === undefined || typeof name !== 'string' || !name) continue;
    if (!masteryByGroup.has(group)) masteryByGroup.set(group, new Set());
    masteryByGroup.get(group)!.add(name);
  }
  const names: Record<string, string> = {};
  for (const target of taxonomy.targets) {
    const shared = new Set(target.nodeIds.map(nodeName).filter((n): n is string => !!n));
    const labels = new Set(target.nodeIds.flatMap(id => [...masteryByGroup.get(geometry[id]?.group ?? '') ?? []]));
    names[target.targetId] = labels.size === 1 ? [...labels][0]! : shared.size === 1 ? [...shared][0]! : 'Unknown';
  }
  return names;
}

export function sustainRows(graph: AtlasGraph, groups: SustainGroups | null): { some: MechanicRow; more: MechanicRow } | null {
  if (!groups) return null;
  const row = (group: SustainGroup): MechanicRow => {
    const missing = group.nodeIds.filter(id => !graph.nodes.has(id));
    return { targetId: group.targetId, name: group.name, nodeIds: ordered(group.nodeIds),
      notables: group.nodeIds.flatMap(nodeId => { const n = graph.nodes.get(nodeId); return n ? [{ nodeId, name: n.name, lines: readableLines(n.stats.map(s => s.sourceText)), asset: n.asset }] : []; }),
      taxonomy: group.nodeIds.length && !missing.length ? known('verified' as const, group.evidenceId) : unknown<'verified'>(UNVERIFIED_TARGETS),
      status: missing.length ? 'unknown_node' : 'verified', problem: missing.length ? 'Unavailable in this tree data' : null, asset: null };
  };
  return { some: row(groups.some), more: row(groups.more) };
}
