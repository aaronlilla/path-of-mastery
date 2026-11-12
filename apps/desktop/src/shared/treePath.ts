/**
 * How many points it takes to reach each passive node from a build's tree (upstream's `pathDist`): the fewest
 * unallocated nodes to allocate, the node itself included. Masteries and ascendancy nodes are not part of such a path,
 * and a class start is a starting point, never a step.
 */

export interface TreeGraphNode {
  id: number;
  /** 0 normal, 1 notable, 2 keystone, 3 mastery, 4 jewel socket, 5 class start, 6 ascendancy start. */
  t: number;
  out?: number[];
  /** Ascendancy name; set on ascendancy nodes. */
  a?: string;
}

/** Points to reach each node not in `allocated`, by breadth-first search from the allocated nodes. */
export function pathDistances(nodes: TreeGraphNode[], allocated: Iterable<number>): Map<number, number> {
  const by = new Map<number, TreeGraphNode>();
  const adj = new Map<number, number[]>();
  for (const n of nodes) by.set(n.id, n);
  const link = (a: number, b: number) => {
    const l = adj.get(a);
    if (l) l.push(b);
    else adj.set(a, [b]);
  };
  for (const n of nodes) for (const o of n.out ?? []) if (by.has(o)) (link(n.id, o), link(o, n.id));
  const dist = new Map<number, number>();
  const have = new Set(allocated);
  let frontier: number[] = [...have];
  for (let d = 1; frontier.length; d++) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const o of adj.get(id) ?? []) {
        const n = by.get(o);
        if (!n || have.has(o) || dist.has(o) || n.t === 3 || n.t === 5 || n.t === 6 || n.a) continue;
        dist.set(o, d);
        next.push(o);
      }
    }
    frontier = next;
  }
  return dist;
}
