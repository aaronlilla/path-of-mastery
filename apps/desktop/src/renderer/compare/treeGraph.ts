import type { TreeGraphNode } from '../../shared/treePath.js';

/** What the tab reads from a version's `tree.json`: the links between nodes, their text and each class's start node. */
export interface TreeGraph {
  nodes: Map<number, TreeGraphNode & { n: string; s?: string[] }>;
  classStart: (classId: number) => number | undefined;
}

const cache = new Map<string, Promise<TreeGraph | null>>();

/** The passive tree of a version (`game/tree/<version>/tree.json`), or null when it is not installed. */
export function loadTreeGraph(version: string): Promise<TreeGraph | null> {
  let p = cache.get(version);
  if (!p) {
    p = fetch(`game/tree/${version}/tree.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { nodes: Array<TreeGraphNode & { n: string; s?: string[] }>; classes: Array<{ start: number }> } | null) => {
        if (!j) return null;
        return { nodes: new Map(j.nodes.map((n) => [n.id, n])), classStart: (c: number) => j.classes[c]?.start };
      })
      .catch(() => null);
    cache.set(version, p);
  }
  return p;
}
