/**
 * Changing class with points spent (Build.lua's class dropdown): when the tree already touches the new class's start, the
 * class just changes; otherwise the player picks Continue (the tree resets) or Connect Path, which allocates the shortest
 * route from the new class's start to the tree first (PassiveSpec.lua `IsClassConnected`, `ConnectToClass`).
 */

export interface ClassGraph {
  /** Undirected neighbours of a node. */
  links(id: number): readonly number[];
  /** Type (0 normal .. 4 socket, 5 class start, 6 ascendancy start), ascendancy name, hidden proxy node. */
  kind(id: number): { t: number; a?: string; px?: boolean } | undefined;
}

const isStart = (t: number | undefined): boolean => t === 5 || t === 6;

/** Is the tree (the allocated nodes) joined to the given class's start node, through the route of the current class? */
export function isClassConnected(g: ClassGraph, targetStart: number, alloc: ReadonlySet<number>, currentStart: number): boolean {
  for (const other of g.links(targetStart)) {
    if (!alloc.has(other)) continue;
    const seen = new Set<number>([other]);
    const stack = [other];
    while (stack.length) {
      const cur = stack.pop()!;
      const ck = g.kind(cur);
      for (const nb of g.links(cur)) {
        if (nb === currentStart) return true;
        if (seen.has(nb) || !alloc.has(nb) || ck?.t === 3) continue;
        const nk = g.kind(nb);
        if (isStart(nk?.t)) continue;
        seen.add(nb);
        stack.push(nb);
      }
    }
  }
  return false;
}

/**
 * The nodes to allocate so the tree reaches the target class's start by the shortest route, or null when there is none. The
 * search runs outward from the start over passive nodes (no ascendancy, start or hidden nodes) until it meets an allocated one.
 */
export function classConnectPath(g: ClassGraph, targetStart: number, alloc: ReadonlySet<number>): number[] | null {
  const prev = new Map<number, number>();
  const queue = [targetStart];
  const seen = new Set<number>([targetStart]);
  let found: number | null = null;
  for (let head = 0; head < queue.length && found === null; head++) {
    const node = queue[head]!;
    if (node !== targetStart && alloc.has(node) && !isStart(g.kind(node)?.t)) {
      found = node;
      break;
    }
    for (const nb of g.links(node)) {
      const k = g.kind(nb);
      if (!k || k.px || k.a || isStart(k.t) || seen.has(nb)) continue;
      seen.add(nb);
      prev.set(nb, node);
      queue.push(nb);
    }
  }
  if (found === null) return null;
  const path: number[] = [];
  for (let cur = prev.get(found); cur !== undefined && cur !== targetStart; cur = prev.get(cur)) path.push(cur);
  return path.filter((id) => !alloc.has(id)).reverse();
}
