/**
 * The order to take the build's passive nodes while leveling: from the class start, repeatedly take the allocated notable or
 * keystone that is cheapest to reach (travel nodes included), life and defence first on a tie. Only the final tree is used.
 * Ascendancy nodes are ordered separately, outward from the ascendancy start.
 */
import { pathDistances, type TreeGraphNode } from '../treePath.js';

export interface LevelingTree {
  nodes: TreeGraphNode[];
  /** Node id of the build's class start. */
  classStart: number;
  name(id: number): string;
  /** Life, resistance or armour nodes: these win ties. */
  defensive?(id: number): boolean;
}

export interface TreeOrder {
  /** Regular passives in the order to allocate, travel nodes included. Masteries are not points and are left out. */
  order: number[];
  /** Ascendancy nodes in the order to allocate. */
  ascend: number[];
}

export function orderPassives(tree: LevelingTree, finalNodes: readonly number[]): TreeOrder {
  const finalSet = new Set(finalNodes);
  const regular = tree.nodes.filter((n) => (finalSet.has(n.id) || n.id === tree.classStart) && !n.a && n.t !== 3 && n.t !== 6);
  const byId = new Map(regular.map((n) => [n.id, n]));
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number) => (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
  for (const n of regular) for (const o of n.out ?? []) if (byId.has(o)) (link(n.id, o), link(o, n.id));

  const have = new Set<number>([tree.classStart]);
  const order: number[] = [];
  const targets = regular.filter((n) => n.id !== tree.classStart);
  const remaining = new Set(targets.map((n) => n.id));
  const rank = (n: TreeGraphNode) => (n.t === 2 || n.t === 1 ? 0 : n.t === 4 ? 1 : 2);

  while (remaining.size) {
    const dist = pathDistances(regular, have);
    let best: TreeGraphNode | undefined;
    let bestKey: [number, number, number, number] | undefined;
    for (const id of remaining) {
      const n = byId.get(id)!;
      const d = dist.get(id);
      if (d === undefined) continue;
      const key: [number, number, number, number] = [rank(n), d, tree.defensive?.(id) ? 0 : 1, id];
      if (!bestKey || cmp(key, bestKey) < 0) {
        bestKey = key;
        best = n;
      }
    }
    if (!best) {
      // nodes the final tree cannot reach (a cluster jewel's nodes, say): take them last in id order
      const rest = [...remaining].sort((a, b) => a - b);
      for (const id of rest) {
        order.push(id);
        have.add(id);
      }
      break;
    }
    // walk back from the target along strictly smaller distances to the allocated set
    const path: number[] = [best.id];
    let cur = best.id;
    for (let d = dist.get(best.id)!; d > 1; d--) {
      const step = (adj.get(cur) ?? []).filter((o) => dist.get(o) === d - 1).sort((a, b) => a - b)[0];
      if (step === undefined) break;
      path.push(step);
      cur = step;
    }
    for (const id of path.reverse()) {
      if (have.has(id)) continue;
      have.add(id);
      remaining.delete(id);
      order.push(id);
    }
  }

  // ascendancy: outward from its start
  const asc = tree.nodes.filter((n) => n.a && (finalSet.has(n.id) || n.t === 6));
  const ascById = new Map(asc.map((n) => [n.id, n]));
  const aAdj = new Map<number, number[]>();
  for (const n of asc) {
    for (const o of n.out ?? []) {
      if (!ascById.has(o)) continue;
      (aAdj.get(n.id) ?? aAdj.set(n.id, []).get(n.id)!).push(o);
      (aAdj.get(o) ?? aAdj.set(o, []).get(o)!).push(n.id);
    }
  }
  const ascend: number[] = [];
  const seen = new Set<number>();
  let frontier = asc.filter((n) => n.t === 6).map((n) => n.id);
  frontier.forEach((id) => seen.add(id));
  while (frontier.length) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const o of (aAdj.get(id) ?? []).slice().sort((a, b) => a - b)) {
        if (seen.has(o)) continue;
        seen.add(o);
        next.push(o);
        if (finalSet.has(o)) ascend.push(o);
      }
    }
    frontier = next;
  }
  for (const n of asc) if (finalSet.has(n.id) && !seen.has(n.id)) ascend.push(n.id);
  return { order, ascend };
}

function cmp(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}
