// What the build header and the tree sets need to know about a tree version: what each passive node is (for counting a
// tree's allocated points), how the nodes link (for connecting a path to another class), the classes with their
// ascendancies and the secondary (bloodline) ascendancies. Read from the same tree.json the tree view draws, so the
// browser has the file already; nothing here is calculated by the app, it only reads game data.
import { useEffect, useState } from 'react';
import { specTreeVersion, withSpecClassNames } from './buildSkills';
import type { ClassGraph } from '../shared/classConnect';
import type { NodeKinds } from '../shared/treeSets';

interface RawKindNode {
  id: number;
  t: number;
  a?: string;
  mc?: 1;
  px?: 1;
  out?: number[];
}

interface RawTree {
  nodes: RawKindNode[];
  classes?: Record<string, { name: string; start: number; asc: Record<string, { id: string; name: string; start?: number }> }>;
  alt?: Record<string, { id: string; name?: string }>;
  sheets?: Array<{ file: string; w: number; h: number }>;
  /** [sheet, x, y, w, h] in sheet pixels. */
  sprites?: number[][];
  named?: Record<string, number>;
}

export interface TreeFacts extends NodeKinds, ClassGraph {
  version: string;
  /** Class id to its name, start node and ascendancies as [ascendClassId, name] (0 is "None"). */
  classes: Record<number, { name: string; start: number; asc: Array<[number, string]> }>;
  /** Secondary ascendancies on this version: the id the build file stores, and the name shown. */
  alternates: Array<{ value: number; id: string; name: string }>;
  /** The tree's own art for a class ("center<class>") or ascendancy ("Classes<Name>") as an inline style that crops it from its sheet, `w` px wide. */
  art: (sprite: string, w: number) => { width: number; height: number; backgroundImage: string; backgroundSize: string; backgroundPosition: string } | undefined;
}

export interface VersionEntry {
  value: string;
  display: string;
}
let versionEntries: Promise<VersionEntry[]> | null = null;
/** The tree versions the app has data for (the Version dropdown's list, from GameVersions.lua), fetched once. */
export function loadVersionEntries(): Promise<VersionEntry[]> {
  versionEntries ??= fetch('game/tree/versions.json').then((r) => (r.ok ? (r.json() as Promise<VersionEntry[]>) : [])).catch(() => []);
  return versionEntries;
}

/** The tree version whose sheets carry every class and ascendancy emblem (older versions lack most of them). */
export const ART_VERSION = '3_29';

const cache = new Map<string, Promise<TreeFacts | null>>();

export function loadTreeFacts(version: string): Promise<TreeFacts | null> {
  let p = cache.get(version);
  if (!p) {
    // A version the app has no data for is never fetched (the request would only be a 404 in the console).
    p = loadVersionEntries()
      .then((list) => (list.some((v) => v.value === version) ? fetch(`game/tree/${version}/tree.json`) : null))
      .then((r) => (r && r.ok ? (r.json() as Promise<RawTree>) : null))
      .then((d) => {
        if (!d) return null;
        const byId = new Map<number, RawKindNode>();
        const links = new Map<number, number[]>();
        const add = (a: number, b: number) => {
          const l = links.get(a);
          if (l) {
            if (!l.includes(b)) l.push(b);
          } else links.set(a, [b]);
        };
        for (const n of d.nodes) byId.set(n.id, n);
        for (const n of d.nodes) {
          for (const o of n.out ?? []) {
            if (!byId.has(o)) continue;
            add(n.id, o);
            add(o, n.id);
          }
        }
        const alternates = Object.entries(d.alt ?? {})
          .map(([k, a]) => ({ value: Number(k), id: a.id, name: a.name ?? a.id }))
          .filter((a) => Number.isFinite(a.value))
          .sort((a, b) => a.name.localeCompare(b.name));
        const classes: TreeFacts['classes'] = {};
        for (const [k, c] of Object.entries(d.classes ?? {})) {
          classes[Number(k)] = { name: c.name, start: c.start, asc: Object.entries(c.asc).map(([i, a]) => [Number(i), a.name] as [number, string]).sort((a, b) => a[0] - b[0]) };
        }
        const facts: TreeFacts = {
          version,
          get: (id) => {
            const n = byId.get(id);
            return n ? { t: n.t, a: n.a, mc: !!n.mc } : undefined;
          },
          secondary: new Set(alternates.map((a) => a.id)),
          links: (id) => links.get(id) ?? [],
          kind: (id) => {
            const n = byId.get(id);
            return n ? { t: n.t, a: n.a, px: !!n.px } : undefined;
          },
          classes,
          alternates,
          art: (sprite, w) => {
            const sp = d.sprites?.[d.named?.[sprite] ?? -1];
            const sh = sp && d.sheets?.[sp[0]!];
            if (!sp || !sh) return undefined;
            const k = w / sp[3]!;
            const url = new URL(`game/tree/${version}/${sh.file}`, document.baseURI).href;
            return { width: w, height: Math.round(sp[4]! * k), backgroundImage: `url(${url})`, backgroundSize: `${sh.w * k}px ${sh.h * k}px`, backgroundPosition: `${-sp[1]! * k}px ${-sp[2]! * k}px` };
          },
        };
        return facts;
      })
      .catch(() => null);
    cache.set(version, p);
  }
  return p;
}

/** Tree facts for each of the versions (loaded once each); a version still loading is simply missing for now. */
export function useTreeFacts(versions: string[]): Map<string, TreeFacts> {
  const key = [...new Set(versions.filter(Boolean))].sort().join('|');
  const [map, setMap] = useState<Map<string, TreeFacts>>(new Map());
  useEffect(() => {
    let live = true;
    const want = key ? key.split('|') : [];
    void Promise.all(want.map(async (v) => [v, await loadTreeFacts(v)] as const)).then((rows) => {
      if (!live) return;
      const m = new Map<string, TreeFacts>();
      for (const [v, k] of rows) if (k) m.set(v, k);
      setMap(m);
    });
    return () => {
      live = false;
    };
  }, [key]);
  return map;
}

/** The text a save, a build code, a share link or a file carries: `<Build className ascendClassName>` taken from the active spec, as upstream does. */
export async function fileText(xml: string): Promise<string> {
  const facts = await loadTreeFacts(specTreeVersion(xml)).catch(() => null);
  return facts ? withSpecClassNames(xml, facts.classes) : xml;
}
