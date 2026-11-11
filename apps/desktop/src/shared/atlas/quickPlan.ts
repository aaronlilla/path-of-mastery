import { ordered, type AtlasGraph } from './graph.js';
import { isRawStatId } from './statText.js';

// Quick plan: after the solver has reached the chosen mechanics' notables, spend the points that are left.
// Everything here reads the pinned tree data only (node costs, adjacency, each node's stat text, node kinds and
// clusters). Renderer-safe.

export type MapSupport = 'none' | 'some' | 'max';
/** Points the "Some" level may spend on map drop chance nodes. "Max" has no cap. */
export const SOME_MAP_POINTS = 8;
export const MAP_SUPPORT_TEXT: Record<MapSupport, string> = {
  none: 'No map nodes. Every point goes to your mechanics and loot.',
  some: `Up to ${SOME_MAP_POINTS} points of map drop chance nodes near your path.`,
  max: 'Every map drop chance and higher map tier node your points can reach.',
};

export type FillTier = { id: string; label: string; nodeIds: readonly string[]; maxPoints?: number };
export type FillSpend = { id: string; label: string; points: number; nodeIds: string[] };
export type FillResult = { allocatedIds: string[]; cost: number; budget: number; left: number; spent: FillSpend[] };

const MAP_DROP = /increased Maps found in your Maps/i;
const MAP_TIER = /Maps found have \d+% chance to become \d+ tiers? higher/i;
const LOOT = [/^\d+% increased Quantity of Items found in your Maps$/i, /^\d+% increased Rarity of Items found in your Maps$/i, /^\d+% increased Pack Size in your Maps$/i];

const costOf = (graph: AtlasGraph, id: string): number => graph.costs.status === 'known' ? graph.costs.value.nodeCosts[id] ?? 1 : 1;
// Game text only: each node also carries its raw dat stat ids (e.g. map_item_drop_quantity_+%), which are not text.
const textOf = (graph: AtlasGraph, id: string): string[] => graph.nodes.get(id)?.stats.map(s => s.sourceText).filter(t => !isRawStatId(t)) ?? [];
/** Point cost of an allocation, the root included (it costs 0). */
export function spentPoints(graph: AtlasGraph, ids: Iterable<string>): number {
  let total = 0; for (const id of new Set([graph.rootId, ...ids])) total += costOf(graph, id); return total;
}

/** Nodes by role, from their stat text in the pinned data. */
export function nodeRoles(graph: AtlasGraph): { mapDrop: string[]; mapTier: string[]; loot: string[] } {
  const mapDrop: string[] = [], mapTier: string[] = [], loot: string[] = [];
  for (const id of graph.nodes.keys()) {
    const lines = textOf(graph, id);
    if (lines.some(l => MAP_DROP.test(l))) mapDrop.push(id);
    else if (lines.some(l => MAP_TIER.test(l))) mapTier.push(id);
    else if (lines.length && lines.every(l => LOOT.some(r => r.test(l.trim())))) loot.push(id);
  }
  return { mapDrop: ordered(mapDrop), mapTier: ordered(mapTier), loot: ordered(loot) };
}

/** What the fill needs to know about node kinds and clusters, from the pack's node metadata and geometry. */
export type TreeLayout = { small: ReadonlySet<string>; keystones: ReadonlySet<string>; masteries: ReadonlySet<string>; groupOf: ReadonlyMap<string, string> };
export function treeLayout(metadata: Record<string, Record<string, unknown>> = {}, geometry: Record<string, { group?: unknown }> = {}): TreeLayout {
  const small = new Set<string>(), keystones = new Set<string>(), masteries = new Set<string>(), groupOf = new Map<string, string>();
  for (const [id, m] of Object.entries(metadata)) {
    if (m.isKeystone) keystones.add(id); else if (m.isMastery) masteries.add(id); else if (!m.isNotable && !m.isWormhole) small.add(id);
  }
  for (const [id, g] of Object.entries(geometry)) if (typeof g?.group === 'string' || typeof g?.group === 'number') groupOf.set(id, String(g.group));
  return { small, keystones, masteries, groupOf };
}
/** Keystones change how a mechanic plays (Unending Nightmare, Extreme Archaeology): the fill never enters one the plan does not already have. */
export function fillBlocked(layout: TreeLayout | undefined, startIds: readonly string[]): Set<string> {
  const have = new Set(startIds);
  return new Set([...(layout?.keystones ?? [])].filter(id => !have.has(id)));
}

export type QuickTarget = { name: string; nodeIds: readonly string[] };
/**
 * A mechanic's own nodes: its target notables, every node in the same tree clusters as those notables (its small
 * nodes, e.g. Strongbox Additional Pack Chance), and nodes named after it ("Harvest Chance"). Never a keystone,
 * mastery or the start.
 */
export function mechanicNodes(graph: AtlasGraph, target: QuickTarget, layout?: TreeLayout): string[] {
  const out = new Set<string>(target.nodeIds.filter(id => graph.nodes.has(id)));
  if (layout) {
    const groups = new Set(target.nodeIds.map(id => layout.groupOf.get(id)).filter((g): g is string => !!g));
    for (const [id, g] of layout.groupOf) if (groups.has(g) && graph.nodes.has(id)) out.add(id);
  }
  const base = target.name.replace(/^the\s+/i, '').trim();
  if (base.length >= 4 && !/^unknown$/i.test(base)) {
    const stem = base.replace(/(es|s)$/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${stem}(e?s)?\\b`, 'i');
    for (const n of graph.nodes.values()) if (re.test(n.name)) out.add(n.nodeId);
  }
  return ordered([...out].filter(id => id !== graph.rootId && !layout?.keystones.has(id) && !layout?.masteries.has(id)));
}

/**
 * The fill tiers for a Quick plan, in the order points are spent: map support (capped for Some), the chosen
 * mechanics' own nodes, quantity / rarity / pack size, then (with a layout) the nearest small nodes so every point is
 * used. Keystones are never targets; pass fillBlocked() to fillPoints so no path crosses one either. With map support
 * None, no tier aims at a map node (a path may still cross one).
 */
export function quickTiers(graph: AtlasGraph, support: MapSupport, mechanics: readonly QuickTarget[], fillLeftover: boolean, layout?: TreeLayout): FillTier[] {
  const roles = nodeRoles(graph), tiers: FillTier[] = [], mapIds = new Set([...roles.mapDrop, ...roles.mapTier]);
  const allowed = (id: string) => !layout?.keystones.has(id) && !layout?.masteries.has(id);
  const keep = (ids: readonly string[]) => ids.filter(id => allowed(id) && (support !== 'none' || !mapIds.has(id)));
  if (support === 'some') tiers.push({ id: 'map', label: 'Map support', nodeIds: roles.mapDrop.filter(allowed), maxPoints: SOME_MAP_POINTS });
  if (support === 'max') tiers.push({ id: 'map', label: 'Map support', nodeIds: [...roles.mapDrop, ...roles.mapTier].filter(allowed) });
  if (fillLeftover) {
    const own = ordered(mechanics.flatMap(m => mechanicNodes(graph, m, layout)));
    if (own.length) tiers.push({ id: 'mechanics', label: mechanics.length === 1 ? `More ${mechanics[0]!.name}` : 'More of your mechanics', nodeIds: keep(own) });
    tiers.push({ id: 'loot', label: 'Quantity, rarity and pack size', nodeIds: keep(roles.loot) });
    if (layout) tiers.push({ id: 'other', label: 'Nearest small nodes', nodeIds: keep([...layout.small].filter(id => graph.nodes.has(id) && id !== graph.rootId)) });
  }
  return tiers;
}

/**
 * Greedy, deterministic fill: in each tier, repeatedly take the cheapest reachable node of that tier (path cost from the
 * current allocation, 0-1 weights from the node costs), while the budget and the tier's cap allow it. Blocked nodes are
 * never entered. The start allocation is never changed, only extended, so the result stays connected.
 */
export function fillPoints(graph: AtlasGraph, startIds: readonly string[], budget: number, tiers: readonly FillTier[], blocked: ReadonlySet<string> = new Set()): FillResult {
  const have = new Set<string>([graph.rootId, ...startIds]);
  let cost = spentPoints(graph, have);
  const spent: FillSpend[] = [];
  for (const tier of tiers) {
    const row: FillSpend = { id: tier.id, label: tier.label, points: 0, nodeIds: [] };
    const wanted = new Set(tier.nodeIds.filter(id => graph.nodes.has(id) && !blocked.has(id)));
    for (;;) {
      const room = Math.min(budget - cost, tier.maxPoints === undefined ? Infinity : tier.maxPoints - row.points);
      if (room <= 0 && ![...wanted].some(id => !have.has(id) && costOf(graph, id) === 0)) break;
      const { dist, prev } = distances(graph, have, blocked);
      let pick: string | null = null, best = Infinity;
      for (const id of wanted) {
        if (have.has(id)) continue;
        const d = dist.get(id);
        if (d === undefined || d > room) continue;
        if (d < best || (d === best && pick !== null && id < pick)) { best = d; pick = id; }
      }
      if (pick === null) break;
      const path: string[] = [];
      for (let at: string | undefined = pick; at !== undefined && !have.has(at); at = prev.get(at)) path.push(at);
      for (const id of path) have.add(id);
      cost += best; row.points += best; row.nodeIds.push(...path.reverse());
    }
    if (row.nodeIds.length) spent.push(row);
  }
  return { allocatedIds: ordered(have), cost, budget, left: Math.max(0, budget - cost), spent };
}

/** 0-1 shortest paths from every allocated node: entering a node costs its point cost. */
function distances(graph: AtlasGraph, from: ReadonlySet<string>, blocked: ReadonlySet<string>): { dist: Map<string, number>; prev: Map<string, string> } {
  const dist = new Map<string, number>(), prev = new Map<string, string>();
  const deque: string[] = [];
  for (const id of [...from].sort()) { dist.set(id, 0); deque.push(id); }
  let head = 0;
  const front: string[] = [];
  const next = (): string | undefined => front.length ? front.pop() : head < deque.length ? deque[head++] : undefined;
  for (let at = next(); at !== undefined; at = next()) {
    const base = dist.get(at)!;
    for (const to of graph.adjacent.get(at) ?? []) {
      if (blocked.has(to)) continue;
      const w = costOf(graph, to), d = base + w;
      if (d < (dist.get(to) ?? Infinity)) { dist.set(to, d); prev.set(to, at); if (w === 0) front.push(to); else deque.push(to); }
    }
  }
  return { dist, prev };
}

/** One plain line per spend, e.g. "Map support: 8 points (Map Drop Chance x5, ...)". */
export function spendLine(graph: AtlasGraph, row: FillSpend): string {
  const counts = new Map<string, number>();
  // Nameless connector nodes (their name is their id) are part of the points but not worth naming.
  for (const id of row.nodeIds) { const name = graph.nodes.get(id)?.name?.trim(); if (!name || name === id || /^\d+$/.test(name)) continue; counts.set(name, (counts.get(name) ?? 0) + 1); }
  const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([n, c]) => c > 1 ? `${n} x${c}` : n);
  return `${row.label}: ${row.points} ${row.points === 1 ? 'point' : 'points'} (${top.join(', ')}${counts.size > 3 ? ', ...' : ''})`;
}
