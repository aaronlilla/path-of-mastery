import type { AssetRef, Hash, Known } from '@pom/mastery-contracts';
import { dataLabel as englishDataLabel, readableLines } from '../../../shared/atlas/statText.js';
import { fromMain, tr } from '../../i18n.js';
import { inspectAllocation, ordered, type AtlasGraph } from '../../../shared/atlas/graph.js';
import { previewAllocation, previewRemoval } from '../../../shared/atlas/allocation.js';

export type Point = { x: number; y: number };
export type View = Point & { scale: number };
export type CanvasSource = {
  datasetHash: Hash;
  graph: AtlasGraph;
  geometry: Record<string, { position: Known<Point>; group?: string; orbit?: number }>;
  nodeMetadata?: Record<string, Record<string, unknown>>;
  /** The export's group centres and orbit radii: same-orbit links in one group are drawn as arcs around the centre. */
  layout?: { groups?: Record<string, unknown>; constants?: Record<string, unknown>; bounds?: Record<string, unknown> };
};
/** An edge drawn as the short arc of the orbit circle (centre cx, cy, radius r) instead of a straight chord. */
export type EdgeArc = { cx: number; cy: number; r: number; orbit: number } | null;
/** icon: the export's sprite name (data.json `icon`), looked up in the official sheets; null when the export has none. */
export type CanvasNode = { nodeId: string; denseId: number; name: string; type: string; isRoot: boolean; position: Point | null; lines: string[]; asset: AssetRef | null; icon?: string | null };
/** A group's section background art (data.json `groups[].background`), drawn behind its nodes. */
export type GroupArt = { x: number; y: number; image: string; offsetX: number; offsetY: number };
export type CanvasModel = {
  scope: { datasetHash: Hash; graphHash: Hash };
  graph: AtlasGraph;
  ids: readonly string[];
  denseById: ReadonlyMap<string, number>;
  nodes: readonly CanvasNode[];
  edges: readonly (readonly [number, number])[];
  /** Parallel to edges. */
  arcs: readonly EdgeArc[];
  groups: readonly GroupArt[];
  /** Centre of the atlas background art (GGG's placement from the tree bounds); null without bounds. */
  backdrop: Point | null;
  geometryWarnings: string[];
};
export type Overlay = { added: ReadonlySet<string>; removed: ReadonlySet<string>; unchanged: ReadonlySet<string>; kind?: 'diff' | 'ghost' };
export type NodeFilter = 'all' | 'allocated' | 'matches';
export type NodeRow = CanvasNode & { allocated: boolean; repair: boolean; cost: Known<number>; delta: 'added' | 'removed' | 'unchanged' | null };
export type NodeInspection =
  | { kind: 'root' }
  | { kind: 'allocate'; preview: ReturnType<typeof previewAllocation> }
  | { kind: 'remove'; preview: ReturnType<typeof previewRemoval> }
  | { kind: 'unavailable'; reason: string };

export function createCanvasModel(source: CanvasSource): CanvasModel {
  const ids = ordered(source.graph.nodes.keys());
  const denseById = new Map(ids.map((id, index) => [id, index]));
  const nodes = ids.map((nodeId, denseId): CanvasNode => {
    const node = source.graph.nodes.get(nodeId)!;
    const p = source.geometry[nodeId]?.position;
    const metadata = source.nodeMetadata?.[nodeId];
    const type = typeof metadata?.type === 'string' ? metadata.type : metadata?.isKeystone === true ? 'Keystone'
      : metadata?.isNotable === true ? 'Notable' : metadata?.isMastery === true ? 'Mastery' : metadata?.isWormhole === true ? 'Wormhole' : 'Type unverified';
    // A node without a real name (the export gives its id) is the start node beside the root, or a plain passive.
    const isRoot = nodeId === source.graph.rootId, nameless = !node.name?.trim() || node.name.trim() === nodeId || /^\d+$/.test(node.name.trim());
    const name = !nameless ? node.name : isRoot || source.graph.adjacent.get(nodeId)?.includes(source.graph.rootId) ? tr('atlas_canvas_model_2.start') : tr('atlas_canvas_model_2.atlas_passive');
    return { nodeId, denseId, name, type, isRoot,
      position: p?.status === 'known' && Number.isFinite(p.value.x) && Number.isFinite(p.value.y) ? { ...p.value } : null,
      lines: readableLines(node.stats.map(stat => stat.sourceText)), asset: node.asset, icon: typeof metadata?.icon === 'string' && metadata.icon ? metadata.icon : null };
  });
  const edges: [number, number][] = [], arcs: EdgeArc[] = [];
  const radii = Array.isArray(source.layout?.constants?.orbitRadii) ? source.layout!.constants!.orbitRadii as unknown[] : [];
  const arcFor = (a: string, b: string): EdgeArc => {
    const ga = source.geometry[a], gb = source.geometry[b];
    if (!ga || !gb || ga.group === undefined || ga.group !== gb.group || !ga.orbit || ga.orbit !== gb.orbit) return null;
    const group = source.layout?.groups?.[ga.group] as { x?: unknown; y?: unknown } | undefined, r = radii[ga.orbit];
    if (!group || typeof group.x !== 'number' || typeof group.y !== 'number' || typeof r !== 'number' || !(r > 0)) return null;
    return { cx: group.x, cy: group.y, r, orbit: ga.orbit };
  };
  // Drawn connectors only, as GGG's renderer draws them: never between two gateways (allocating one gateway opens its
  // partner on the other side of the tree, with no line between them) and never to a mastery. The graph keeps every link.
  const flag = (id: string, key: string) => source.nodeMetadata?.[id]?.[key] === true;
  for (const id of ids) for (const next of source.graph.adjacent.get(id)!) {
    const a = denseById.get(id)!, b = denseById.get(next)!;
    if (a >= b || (flag(id, 'isWormhole') && flag(next, 'isWormhole')) || flag(id, 'isMastery') || flag(next, 'isMastery')) continue;
    edges.push([a, b]); arcs.push(arcFor(id, next));
  }
  const groups: GroupArt[] = [];
  for (const raw of Object.values(source.layout?.groups ?? {})) {
    const g = raw as { x?: unknown; y?: unknown; background?: { image?: unknown; offsetX?: unknown; offsetY?: unknown } } | null;
    if (!g || typeof g.x !== 'number' || typeof g.y !== 'number' || typeof g.background?.image !== 'string') continue;
    groups.push({ x: g.x, y: g.y, image: g.background.image, offsetX: Number(g.background.offsetX) || 0, offsetY: Number(g.background.offsetY) || 0 });
  }
  // GGG: centre (-60, round((extent.tl.y - extent.br.y) / 2.95)), the extent being the bounds grown by 2 * orbitRadii[4] + 900.
  const b = source.layout?.bounds, grow = 2 * (typeof radii[4] === 'number' ? radii[4] : 0) + 900;
  const backdrop = b && typeof b.min_y === 'number' && typeof b.max_y === 'number' ? { x: -60, y: Math.round((b.min_y - grow - (b.max_y + grow)) / 2.95) } : null;
  return { scope: { datasetHash: source.datasetHash, graphHash: source.graph.graphHash }, graph: source.graph, ids, denseById, nodes, edges, arcs, groups, backdrop,
    geometryWarnings: nodes.filter(n => !n.position).map(n => n.nodeId) };
}

export function overlayFor(before: readonly string[], after: readonly string[], kind: Overlay['kind'] = 'diff'): Overlay {
  const a = new Set(before), b = new Set(after);
  return { kind, added: new Set(ordered(after.filter(id => !a.has(id)))), removed: new Set(ordered(before.filter(id => !b.has(id)))),
    unchanged: new Set(ordered(before.filter(id => b.has(id)))) };
}

/** The tree data name ("Atlas tree 3.29.3.3") in the player's language. */
export const dataLabel = (datasetId: string, variant?: string): string => fromMain('ml_atlas_status', englishDataLabel(datasetId, variant));

export function canvasRows(model: CanvasModel, allocated: readonly string[], query: string, filter: NodeFilter, overlay?: Overlay | null): NodeRow[] {
  const allocation = new Set(allocated), repair = inspectAllocation(model.graph, allocated);
  const broken = new Set([...repair.missingIds, ...repair.disconnectedIds]);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (n: CanvasNode) => words.every(word => [n.name, n.nodeId, ...n.lines].some(text => text.toLowerCase().includes(word)));
  const missingIds = ordered([...repair.missingIds, ...overlay?.added ?? [], ...overlay?.removed ?? []].filter(nodeId => !model.graph.nodes.has(nodeId)));
  const missing: CanvasNode[] = missingIds.map(nodeId => ({ nodeId, denseId: -1, name: tr('atlas_canvas_model_2.node_is_unavailable_in_this_dataset', { nodeId }), type: 'Unavailable',
    isRoot: false, position: null, lines: [], asset: null }));
  return [...model.nodes, ...missing].filter(n => (filter !== 'allocated' || allocation.has(n.nodeId)) && (filter !== 'matches' || !!words.length) && matches(n))
    .map(n => ({ ...n, allocated: allocation.has(n.nodeId), repair: broken.has(n.nodeId) || !model.graph.nodes.has(n.nodeId),
      cost: model.graph.costs.status === 'known' && model.graph.nodes.has(n.nodeId)
        ? { status: 'known', value: model.graph.costs.value.nodeCosts[n.nodeId]!, evidenceId: model.graph.costs.evidenceId }
        : { status: 'unknown', reason: model.graph.costs.status === 'unknown' ? model.graph.costs.reason : tr('atlas_canvas_model_2.node_is_unavailable') },
      delta: overlay?.added.has(n.nodeId) ? 'added' : overlay?.removed.has(n.nodeId) ? 'removed' : overlay?.unchanged.has(n.nodeId) ? 'unchanged' : null }));
}

export function inspectNode(model: CanvasModel, allocated: readonly string[], nodeId: string, budget: number): NodeInspection {
  if (nodeId === model.graph.rootId) return { kind: 'root' };
  try {
    return allocated.includes(nodeId) ? { kind: 'remove', preview: previewRemoval(model.graph, allocated, nodeId) }
      : { kind: 'allocate', preview: previewAllocation(model.graph, allocated, nodeId, budget) };
  } catch (error) { return { kind: 'unavailable', reason: error instanceof Error ? error.message : tr('atlas_canvas_model_2.node_preview_is_unavailable') }; }
}

/** Whether a list row's Allocate/Unallocate button can act. One walk from the start (`reachable`) instead of a path search per row. */
export function rowActionAvailable(model: CanvasModel, reachable: ReadonlySet<string>, allocated: readonly string[], nodeId: string): boolean {
  return allocated.includes(nodeId) || (model.graph.nodes.has(nodeId) && reachable.has(nodeId));
}

export function fitView(model: CanvasModel, ids: readonly string[], width: number, height: number): View | null {
  if (!(width > 0 && height > 0)) return null;
  // An empty plan fits the start with its first ring of nodes, so the first choices are on screen, not only edges running off it.
  // The root only links to the start node, which sits at the same spot, so the ring is two hops out.
  // An empty plan fits the whole tree, so every mechanic is on screen at once (like the in-game atlas). Without a known
  // root anchor an empty Fit stays put rather than guess where the tree starts.
  if (!ids.length && !model.nodes[model.denseById.get(model.graph.rootId) ?? -1]?.position) return null;
  const points = (ids.length ? ordered([model.graph.rootId, ...ids]).map(id => model.nodes[model.denseById.get(id) ?? -1]?.position) : model.nodes.map(n => n.position))
    .filter((p): p is Point => !!p);
  if (!points.length) return null;
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  return { x: (left + right) / 2, y: (top + bottom) / 2,
    scale: Math.min(Math.max(32, width - 80) / Math.max(400, right - left + 120), Math.max(32, height - 80) / Math.max(400, bottom - top + 120), 1.2) };
}
export const screenPoint = (p: Point, v: View, w: number, h: number): Point => ({ x: (p.x - v.x) * v.scale + w / 2, y: (p.y - v.y) * v.scale + h / 2 });
export const worldPoint = (p: Point, v: View, w: number, h: number): Point => ({ x: (p.x - w / 2) / v.scale + v.x, y: (p.y - h / 2) / v.scale + v.y });
/** Node radius in world units by type: GGG's getNodeRadius (the click area of the in-game frames). */
export function nodeRadius(n: Pick<CanvasNode, 'type' | 'isRoot'>): number {
  return n.isRoot ? 48 : n.type === 'Keystone' || n.type === 'Wormhole' ? 109 : n.type === 'Notable' ? 70 : n.type === 'Mastery' ? 90 : 51;
}
export function hitNode(model: CanvasModel, p: Point, view: View, width: number, height: number): string | null {
  let nearest: string | null = null, best = Infinity;
  for (const n of model.nodes) {
    if (!n.position) continue;
    const s = screenPoint(n.position, view, width, height), d = (s.x - p.x) ** 2 + (s.y - p.y) ** 2;
    // A click must land on (or within a few px of) a node disc: at the zoomed-out view a 10 px floor turned clicks on empty
    // space between the tiny discs into path allocations.
    const reach = Math.max(6, nodeRadius(n) * view.scale + 3) ** 2;
    if (d <= reach && d < best) { best = d; nearest = n.nodeId; }
  }
  return nearest;
}
