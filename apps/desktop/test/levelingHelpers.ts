import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGemIndex, loadLevelingData } from '../src/main/leveling/data.js';
import type { GemIndex } from '../src/shared/leveling/offers.js';
import type { LevelingTree } from '../src/shared/leveling/treeOrder.js';
import type { LevelingData } from '../src/shared/leveling/types.js';

const here = fileURLToPath(new URL('.', import.meta.url));
export const RESOURCES = join(here, '..', '..', 'resources', 'leveling');
export const ENGINE_DATA = process.env.POM_ENGINE_DATA ?? join(here, '..', '..', '..', '..', 'engine-data');
export const FIXTURE_XML = (): string => readFileSync(join(here, '..', '..', 'test', 'fixtures', 'leveling-pconc.xml'), 'utf8');

let cached: Promise<{ data: LevelingData; idx: GemIndex }> | undefined;
export function loadAll(): Promise<{ data: LevelingData; idx: GemIndex }> {
  cached ??= (async () => {
    const { data } = await loadLevelingData(RESOURCES, '3.29');
    return { data, idx: await loadGemIndex(ENGINE_DATA, data) };
  })();
  return cached;
}

/** The engine's 3.29 tree as a LevelingTree for the class with this start node. */
export function loadTree(version: string, classId: number): LevelingTree {
  const raw = JSON.parse(readFileSync(join(ENGINE_DATA, `tree_${version}.json`), 'utf8')) as { nodes: Record<string, { id: number; type?: string; dn?: string; name?: string; out?: string[]; ascendancyName?: string; classStartIndex?: number }> };
  const T: Record<string, number> = { Normal: 0, Notable: 1, Keystone: 2, Mastery: 3, Socket: 4, ClassStart: 5, AscendClassStart: 6 };
  const nodes = Object.values(raw.nodes).map((n) => ({ id: n.id, t: T[n.type ?? 'Normal'] ?? 0, out: (Array.isArray(n.out) ? n.out : []).map(Number), ...(n.ascendancyName ? { a: n.ascendancyName } : {}) }));
  const start = Object.values(raw.nodes).find((n) => n.type === 'ClassStart' && n.classStartIndex === classId);
  const names = new Map(Object.values(raw.nodes).map((n) => [n.id, n.dn ?? n.name ?? String(n.id)]));
  return { nodes, classStart: start?.id ?? 0, name: (id) => names.get(id) ?? String(id) };
}
