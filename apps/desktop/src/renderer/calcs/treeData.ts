import { bundledTreeVersions } from '../treeVersions';
import { useEffect, useState } from 'react';

/** What a passive node's tooltip needs, from the bundled tree of its version. */
export interface TreeNodeText {
  id: number;
  /** 0 Normal, 1 Notable, 2 Keystone, 3 Mastery, 4 Jewel socket. */
  t: number;
  n: string;
  s: string[];
  a?: string;
}

export const NODE_KIND: Record<number, string> = { 0: 'Passive', 1: 'Notable Passive', 2: 'Keystone', 3: 'Mastery', 4: 'Jewel Socket' };

const cache = new Map<string, Promise<Map<number, TreeNodeText> | null>>();

/** Every node of a tree version with its stat lines (`game/tree/<version>/tree.json`), loaded once. */
export function loadTreeText(version: string): Promise<Map<number, TreeNodeText> | null> {
  let p = cache.get(version);
  if (!p) {
    p = bundledTreeVersions()
      .then((s) => (s.has(version) ? fetch(`game/tree/${version}/tree.json`) : null))
      .then((r) => (r?.ok ? r.json() : null))
      .then((j: { nodes?: Array<{ id: number; t: number; n?: string; s?: string[]; a?: string }> } | null) => (j?.nodes ? new Map(j.nodes.map((x) => [x.id, { id: x.id, t: x.t, n: x.n ?? '', s: x.s ?? [], a: x.a }])) : null))
      .catch(() => null);
    cache.set(version, p);
  }
  return p;
}

/** The node texts of a tree version (null while loading, or when the version is not bundled). */
export function useTreeText(version: string): Map<number, TreeNodeText> | null {
  const [m, setM] = useState<Map<number, TreeNodeText> | null>(null);
  useEffect(() => {
    let live = true;
    if (version) void loadTreeText(version).then((r) => live && setM(r));
    return () => {
      live = false;
    };
  }, [version]);
  return m;
}
