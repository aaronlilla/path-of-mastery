// Smart pathing: the fewest-points connected tree from the start node that reaches every wanted node and never uses an avoided one.
// Steiner-tree heuristic: grow the tree by the shortest path (unit cost per node) to the nearest wanted node, then prune.
export type SmartMark = 'want' | 'avoid';
export type SmartPathResult = { ids: string[]; unreachableId: string | null };

export function smartPath(adjacent: ReadonlyMap<string, readonly string[]>, rootId: string, wanted: Iterable<string>, avoided: ReadonlySet<string>): SmartPathResult {
  const want = new Set([...wanted].filter(id => id !== rootId));
  const tree = new Set([rootId]);
  const open = new Set(want);
  while (open.size) {
    // Multi-source BFS from the whole tree to the nearest wanted node not in it yet.
    const previous = new Map<string, string>(), queue = [...tree];
    let hit: string | null = null;
    for (let i = 0; i < queue.length && !hit; i++) for (const next of adjacent.get(queue[i]!) ?? []) {
      if (tree.has(next) || previous.has(next) || avoided.has(next)) continue;
      previous.set(next, queue[i]!);
      if (open.has(next)) { hit = next; break; }
      queue.push(next);
    }
    if (!hit) return { ids: [], unreachableId: [...open][0]! };
    for (let at: string | undefined = hit; at !== undefined && !tree.has(at); at = previous.get(at)) { tree.add(at); open.delete(at); }
  }
  // Re-span the node set from the start (drops any loop the paths made), then trim leaves nobody wanted.
  const parent = new Map<string, string>(), order = [rootId], seen = new Set(order);
  for (let i = 0; i < order.length; i++) for (const next of adjacent.get(order[i]!) ?? []) {
    if (tree.has(next) && !seen.has(next)) { seen.add(next); parent.set(next, order[i]!); order.push(next); }
  }
  const children = new Map<string, number>();
  for (const p of parent.values()) children.set(p, (children.get(p) ?? 0) + 1);
  const keep = new Set(order);
  for (let i = order.length - 1; i > 0; i--) {
    const id = order[i]!;
    if (!want.has(id) && !children.get(id)) { keep.delete(id); const p = parent.get(id)!; children.set(p, children.get(p)! - 1); }
  }
  keep.delete(rootId);
  return { ids: [...keep].sort(), unreachableId: null };
}

// A click re-solves the whole route, so anything allocated that is not a plain travel node stays wanted.
export function smartRoute(adjacent: ReadonlyMap<string, readonly string[]>, rootId: string, wanted: Iterable<string>, avoided: ReadonlySet<string>, allocated: readonly string[], isPlain: (id: string) => boolean): SmartPathResult {
  return smartPath(adjacent, rootId, [...wanted, ...allocated.filter(id => !isPlain(id) && !avoided.has(id))], avoided);
}
