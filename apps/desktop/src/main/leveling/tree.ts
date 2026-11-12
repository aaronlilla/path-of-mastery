import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LevelingTree } from '../../shared/leveling/treeOrder.js';

const KIND: Record<string, number> = { Normal: 0, Notable: 1, Keystone: 2, Mastery: 3, Socket: 4, ClassStart: 5, AscendClassStart: 6 };
const cache = new Map<string, Promise<RawTree>>();

interface RawNode {
  id: number;
  type?: string;
  dn?: string;
  name?: string;
  out?: unknown;
  ascendancyName?: string;
  classStartIndex?: number;
}
interface RawTree {
  nodes: Record<string, RawNode>;
}

/** The engine's passive tree for `version` ("3_29") as the graph the planner walks, for the class with this class id. */
export async function loadLevelingTree(engineDir: string, version: string, classId: number): Promise<LevelingTree | null> {
  if (!/^[0-9]+_[0-9]+(?:_[a-z_]+)?$/.test(version)) return null;
  let p = cache.get(version);
  if (!p) {
    p = readFile(join(engineDir, `tree_${version}.json`), 'utf8').then((t) => JSON.parse(t) as RawTree);
    cache.set(version, p);
    p.catch(() => cache.delete(version));
  }
  let raw: RawTree;
  try {
    raw = await p;
  } catch {
    return null;
  }
  const all = Object.values(raw.nodes);
  const nodes = all.map((n) => ({
    id: n.id,
    t: KIND[n.type ?? 'Normal'] ?? 0,
    out: (Array.isArray(n.out) ? (n.out as unknown[]) : []).map(Number),
    ...(n.ascendancyName ? { a: n.ascendancyName } : {}),
  }));
  const start = all.find((n) => n.type === 'ClassStart' && n.classStartIndex === classId);
  const names = new Map(all.map((n) => [n.id, n.dn ?? n.name ?? String(n.id)]));
  return { nodes, classStart: start?.id ?? 0, name: (id) => names.get(id) ?? String(id) };
}
