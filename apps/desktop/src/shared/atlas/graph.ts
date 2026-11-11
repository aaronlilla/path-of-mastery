import { parseId, type AtlasDataset, type AtlasNode, type Known, type Provenance } from '@pom/mastery-contracts';

export class AtlasDomainError extends Error {
  constructor(readonly code: 'INVALID' | 'UNKNOWN_NODE' | 'UNREACHABLE' | 'UNVERIFIED' | 'NOT_FOUND', message: string) { super(message); }
}
export const unknown = <T>(reason: string): Known<T> => ({ status: 'unknown', reason });
export const known = <T>(value: T, evidenceId: string): Known<T> => ({ status: 'known', value, evidenceId });
export const ordered = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();
export type AtlasGraph = {
  graphHash: AtlasDataset['graph']['graphHash'];
  rootId: string;
  nodes: ReadonlyMap<string, AtlasNode>;
  adjacent: ReadonlyMap<string, readonly string[]>;
  costs: Known<AtlasDataset['costModel']>;
};
function validKnown<T>(value: Known<T>, predicate: (input: T) => boolean): boolean {
  return !!value && (value.status === 'known' ? typeof value.evidenceId === 'string' && !!value.evidenceId && predicate(value.value)
    : value.status === 'unknown' && typeof value.reason === 'string' && !!value.reason);
}
function validProvenance(rows: Provenance[]): boolean {
  return Array.isArray(rows) && rows.every(row => row && typeof row.sourceId === 'string' && !!row.sourceId &&
    /^[a-f0-9]{64}$/.test(row.sourceHash) && typeof row.field === 'string' && !!row.field &&
    typeof row.fetchedAt === 'string' && Number.isFinite(Date.parse(row.fetchedAt)));
}

export function createGraph(source: AtlasDataset['graph'], costs: AtlasGraph['costs']): AtlasGraph {
  parseId('hash', source.graphHash);
  if (!Array.isArray(source.nodes) || typeof source.rootId !== 'string' || !source.rootId) throw new AtlasDomainError('INVALID', 'Tree graph is invalid.');
  const nodes = new Map<string, AtlasNode>();
  for (const node of source.nodes) {
    if (!node || typeof node.nodeId !== 'string' || !node.nodeId || nodes.has(node.nodeId)) throw new AtlasDomainError('INVALID', 'Tree contains a duplicate or empty node ID.');
    if (typeof node.name !== 'string' || !node.name || !Array.isArray(node.adjacentIds) || node.adjacentIds.some(id => typeof id !== 'string' || !id) || !Array.isArray(node.stats) ||
      node.stats.some(stat => !stat || typeof stat.statId !== 'string' || !stat.statId || typeof stat.sourceText !== 'string' || !stat.sourceText ||
        !['additive', 'conditional', 'nonadditive'].includes(stat.aggregation) || !/^[a-f0-9]{64}$/.test(stat.effectSchemaHash) ||
        !validKnown(stat.value, value => typeof value === 'number' && Number.isFinite(value)) ||
        !validKnown(stat.unit, value => typeof value === 'string' && !!value) || !validProvenance(stat.provenance)) ||
      (node.asset !== null && (!node.asset || typeof node.asset.assetId !== 'string' || !node.asset.assetId ||
        !/^[a-f0-9]{64}$/.test(node.asset.contentHash) || !['image/png', 'image/webp', 'image/jpeg'].includes(node.asset.mediaType)))) {
      throw new AtlasDomainError('INVALID', 'Tree node data is invalid.');
    }
    nodes.set(node.nodeId, structuredClone(node));
  }
  if (!nodes.has(source.rootId)) throw new AtlasDomainError('INVALID', 'Tree root is missing.');
  const adjacent = new Map([...nodes.keys()].map(id => [id, new Set<string>()]));
  for (const node of nodes.values()) for (const id of node.adjacentIds) {
    if (!nodes.has(id)) throw new AtlasDomainError('INVALID', `Node ${id} is unavailable in this dataset.`);
    if (id === node.nodeId) throw new AtlasDomainError('INVALID', 'Tree contains a self-link.');
    adjacent.get(node.nodeId)!.add(id);
    adjacent.get(id)!.add(node.nodeId);
  }
  if (!validKnown(costs, model => !!model && typeof model.revision === 'string' && !!model.revision &&
    /^[a-f0-9]{64}$/.test(model.contentHash) && validProvenance(model.provenance) &&
    validKnown(model.maximumPoints, value => Number.isSafeInteger(value) && value >= 0) &&
    validKnown(model.grantedPoints, value => Number.isSafeInteger(value) && value >= 0))) throw new AtlasDomainError('INVALID', 'Cost metadata is invalid.');
  if (costs.status === 'known') {
    const model = costs.value;
    if (!costs.evidenceId || !model.provenance.length || nodes.size !== Object.keys(model.nodeCosts).length ||
      [...nodes.keys()].some(id => !Object.hasOwn(model.nodeCosts, id) || !Number.isFinite(model.nodeCosts[id]) || model.nodeCosts[id]! < 0)) {
      throw new AtlasDomainError('INVALID', 'Every node, including the root, needs a sourced nonnegative cost.');
    }
  }
  return { graphHash: source.graphHash, rootId: source.rootId, nodes,
    adjacent: new Map([...adjacent].map(([id, links]) => [id, ordered(links)])), costs: structuredClone(costs) };
}

export function rootComponent(graph: AtlasGraph, allowed: ReadonlySet<string> = new Set(graph.nodes.keys())): Set<string> {
  const visited = new Set<string>([graph.rootId]);
  const pending = [graph.rootId];
  for (let i = 0; i < pending.length; i++) for (const next of graph.adjacent.get(pending[i]!)!) {
    if (allowed.has(next) && !visited.has(next)) { visited.add(next); pending.push(next); }
  }
  return visited;
}

export function inspectAllocation(graph: AtlasGraph, ids: readonly string[]): { missingIds: string[]; disconnectedIds: string[] } {
  const connected = rootComponent(graph, new Set(ids));
  return { missingIds: ordered(ids.filter(id => !graph.nodes.has(id))),
    disconnectedIds: ordered(ids.filter(id => graph.nodes.has(id) && !connected.has(id))) };
}

export function allocationCost(graph: AtlasGraph, ids: readonly string[]): Known<number> {
  if (ids.some(id => !graph.nodes.has(id))) return unknown('Allocation contains unavailable node IDs.');
  if (graph.costs.status === 'unknown') return unknown(graph.costs.reason);
  const costs = graph.costs.value.nodeCosts;
  const total = ordered([graph.rootId, ...ids]).reduce((sum, id) => sum + costs[id]!, 0);
  return Number.isFinite(total) && total <= Number.MAX_SAFE_INTEGER ? known(total, graph.costs.evidenceId) : unknown('Allocation cost exceeds the supported numeric range.');
}
