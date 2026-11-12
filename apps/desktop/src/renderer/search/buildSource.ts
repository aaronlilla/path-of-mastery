// What the search palette can find inside the open build. The workspace publishes it (stats from the engine, items and
// gems and configuration from the build text, passives from the tree data); the palette reads it. Plain data only.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { configRows, gemRows, itemRows, type CfgOpt, type SearchRow } from '../../shared/searchRows.js';
import schema from '../../shared/configSchema.json';
import { buildSidebar, type NumberFormat } from '../displayStats';
import type { BuildHeader } from '../buildSkills';
import { bundledTreeVersions } from '../treeVersions';
import type { EngineBuild } from '../engineBuild';

export type { SearchRow };

export interface BuildSearchData {
  buildId: string;
  stats: SearchRow[];
  config: SearchRow[];
  items: SearchRow[];
  gems: SearchRow[];
  passives: SearchRow[];
}

let current: BuildSearchData | null = null;
const listeners = new Set<() => void>();

export function publishBuildSearch(d: BuildSearchData | null): void {
  current = d;
  for (const l of listeners) l();
}

export function useBuildSearch(): BuildSearchData | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

// ---- passives, from the tree data ---------------------------------------------------------------------------------

interface TreeNameRow {
  id: number;
  name: string;
  kind: string;
}
const KINDS = ['', 'Notable', 'Keystone', 'Mastery'];
const names = new Map<string, Promise<TreeNameRow[]>>();

function loadNames(version: string): Promise<TreeNameRow[]> {
  let p = names.get(version);
  if (!p) {
    p = fetch(`game/tree/${version}/tree.json`)
      .then((r) => (r.ok ? (r.json() as Promise<{ nodes: Array<{ id: number; t?: number; n?: string }> }>) : { nodes: [] }))
      .then((d) => d.nodes.filter((n) => n.n && (n.t === 1 || n.t === 2 || n.t === 3)).map((n) => ({ id: n.id, name: n.n!, kind: KINDS[n.t!]! })))
      .catch(() => []);
    names.set(version, p);
  }
  return p;
}

/** Keeps the palette's view of the open build current. Call once from the workspace. */
export function usePublishBuildSearch(buildId: string, xml: string, eng: EngineBuild, header: BuildHeader | null, fmt: NumberFormat): void {
  const fromText = useMemo(() => ({ items: itemRows(xml), gems: gemRows(xml), config: configRows(xml, (schema as unknown as { options: CfgOpt[] }).options) }), [xml]);
  const stats = useMemo<SearchRow[]>(() => {
    if (!eng.ready) return [];
    const seen = new Set<string>();
    const out: SearchRow[] = [];
    for (const r of buildSidebar(eng.stats, eng.flags, fmt).rows) {
      if (seen.has(r.label)) continue;
      seen.add(r.label);
      out.push({ title: r.label, meta: r.suffix ? `${r.text} (${r.suffix})` : r.text, target: { tab: 'calcs', stat: r.stat } });
    }
    return out;
  }, [eng.ready, eng.stats, eng.flags, fmt]);
  const spec = header?.specs[(header?.activeSpec ?? 1) - 1];
  const version = spec?.treeVersion ?? '';
  const [tree, setTree] = useState<TreeNameRow[]>([]);
  useEffect(() => {
    let alive = true;
    // A version the app has no data for has no tree file to read.
    if (version) void bundledTreeVersions().then((known) => (known.has(version) ? loadNames(version) : [])).then((r) => alive && setTree(r));
    return () => {
      alive = false;
    };
  }, [version]);
  const allocated = spec?.nodes;
  const passives = useMemo<SearchRow[]>(() => {
    const on = new Set(allocated ?? []);
    return tree.map((n) => ({ title: n.name, meta: `${n.kind} · ${on.has(n.id) ? 'allocated' : 'not allocated'}`, target: { tab: 'tree', nodeIds: [n.id] } }));
  }, [tree, allocated]);
  useEffect(() => {
    publishBuildSearch({ buildId, stats, passives, ...fromText });
  }, [buildId, stats, passives, fromText]);
  useEffect(() => () => publishBuildSearch(null), []);
}
