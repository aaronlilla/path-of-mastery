/**
 * Turns a build's text into what Live follows: the leveling guide (the same generator as the Leveling tab), the passive
 * tree graph for name matching, and the checkpoint trees. Checkpoint trees come from the guide's tree steps until the
 * Journey planner hands over its own.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activeSpecOf, readFacts } from '../../shared/buildFacts.js';
import type { Guide, LevelingData } from '../../shared/leveling/types.js';
import { PassiveResolver, type TreeNodeInfo } from '../../shared/journey/treeTrack.js';
import { LATEST_TREE_VERSION } from '../../shared/treeSets.js';
import { generateGuide, type GuideKit } from '../leveling/guideFor.js';
import type { LiveBuild, LiveCheckpoint } from './live.js';

interface RawNode {
  id: number;
  type?: string;
  dn?: string;
  name?: string;
  out?: unknown;
  ascendancyName?: string;
}

const KIND: Record<string, TreeNodeInfo['kind']> = { Normal: 'normal', Notable: 'notable', Keystone: 'keystone', Mastery: 'mastery', Socket: 'socket', ClassStart: 'start', AscendClassStart: 'start' };
const cache = new Map<string, Promise<{ nodes: TreeNodeInfo[] } | null>>();

/** Every node of the engine's tree with its name and neighbours. */
export function loadTreeNodes(engineDir: string, version: string): Promise<{ nodes: TreeNodeInfo[] } | null> {
  if (!/^[0-9]+_[0-9]+(?:_[a-z_]+)?$/.test(version)) return Promise.resolve(null);
  const key = `${engineDir}|${version}`;
  let p = cache.get(key);
  if (!p) {
    p = readFile(join(engineDir, `tree_${version}.json`), 'utf8')
      .then((t) => {
        const raw = JSON.parse(t) as { nodes: Record<string, RawNode> };
        const all = Object.values(raw.nodes);
        const links = new Map<number, Set<number>>();
        const link = (a: number, b: number): void => {
          let s = links.get(a);
          if (!s) links.set(a, (s = new Set()));
          s.add(b);
        };
        for (const n of all) for (const o of (Array.isArray(n.out) ? n.out : []).map(Number)) if (raw.nodes[String(o)]) (link(n.id, o), link(o, n.id));
        const nodes: TreeNodeInfo[] = all.map((n) => ({
          id: n.id,
          name: n.dn ?? n.name ?? String(n.id),
          links: [...(links.get(n.id) ?? [])],
          ...(n.ascendancyName ? { ascendancy: n.ascendancyName } : {}),
          kind: KIND[n.type ?? 'Normal'] ?? 'normal',
        }));
        return { nodes };
      })
      .catch(() => null);
    cache.set(key, p);
  }
  return p;
}

/** The guide's tree steps as cumulative trees: ascendancy nodes join once the lab step has passed. */
export function guideCheckpoints(guide: Guide): LiveCheckpoint[] {
  const out: LiveCheckpoint[] = [];
  const tree: number[] = [];
  const asc: number[] = [];
  for (const a of guide.acts) {
    for (const s of a.steps) {
      if (s.kind === 'lab') asc.push(...s.ascend);
      if (s.kind === 'tree') {
        for (const n of s.add) if (!tree.includes(n)) tree.push(n);
        out.push({ id: s.id, name: s.specTitle, level: s.level, tree: [...tree, ...asc], detours: [] });
      }
    }
  }
  return out;
}

export interface GuideSourceDeps {
  kit: () => Promise<GuideKit>;
  engineDir: string;
  leagueStart: (buildKey: string) => boolean;
  /** A Journey plan's checkpoint trees for the build, when the planner has one cached. */
  planned?: (buildKey: string) => LiveCheckpoint[] | null;
}

export function makeBuildSource(d: GuideSourceDeps): (buildKey: string, name: string, xml: string) => Promise<LiveBuild> {
  return async (buildKey, name, xml) => {
    const kit = await d.kit();
    const g = await generateGuide(kit, xml, undefined, d.leagueStart(buildKey));
    const spec = activeSpecOf(readFacts(xml));
    const version = spec?.treeVersion || LATEST_TREE_VERSION;
    const treeData = await loadTreeNodes(d.engineDir, version);
    const nodeNames: Record<number, string> = {};
    for (const a of g.guide.acts) {
      for (const s of a.steps) {
        if (s.kind === 'tree') for (const id of s.add) nodeNames[id] = g.tree?.name(id) ?? String(id);
        if (s.kind === 'lab') s.ascend.forEach((id, i) => (nodeNames[id] = s.ascendNames[i] ?? String(id)));
      }
    }
    const byId = new Map((treeData?.nodes ?? []).map((n) => [n.id, n]));
    const planned = d.planned?.(buildKey);
    const checkpoints = planned && planned.length ? planned : guideCheckpoints(g.guide);
    for (const c of checkpoints) for (const id of [...c.tree, ...c.detours]) if (!nodeNames[id] && byId.get(id)) nodeNames[id] = byId.get(id)!.name;
    const data: LevelingData = g.data;
    return {
      buildKey,
      name,
      className: g.build.className,
      ascendancy: g.build.ascendancy,
      mainSkill: data.gems[g.build.mainSkillId]?.name ?? '',
      level: g.build.level,
      guide: g.guide,
      plan: g.plan,
      data,
      checkpoints,
      resolver: treeData ? new PassiveResolver(treeData.nodes) : null,
      notCounted: (id) => {
        const n = byId.get(id);
        return !n || n.kind === 'start' || !!n.ascendancy;
      },
      nodeNames,
    };
  };
}
