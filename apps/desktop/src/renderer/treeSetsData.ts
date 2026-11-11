// The tree sets of the open build as the dialogs and menus show them: title, game version, class and ascendancy, and the
// allocated passive points (upstream's `CountAllocNodes`, not the number of nodes in the file).
import { useEffect, useMemo, useState } from 'react';
import { CLASSES } from '../shared/buildXml';
import { countPoints, LATEST_TREE_VERSION as LATEST, readSpecSummaries, type PointCounts, type SpecSummary } from '../shared/treeSets';
import { loadVersionEntries, useTreeFacts, type TreeFacts, type VersionEntry } from './treeKinds';
import { tr } from './i18n';

export interface SpecRow extends SpecSummary {
  /** Title as upstream lists it: `[3.24] Title` when the tree is not on the latest version. */
  label: string;
  /** The tree select's wording (the design's): `Title (3.24)` when the tree is not on the latest version. */
  short: string;
  versionDisplay: string;
  className: string;
  ascName: string;
  /** Allocated passive points; null until the tree data of its version has loaded. */
  counts: PointCounts | null;
  active: boolean;
}

export interface SpecData {
  rows: SpecRow[];
  active: number;
  versions: VersionEntry[];
  facts: Map<string, TreeFacts>;
  display: (v: string) => string;
}

export function useVersionEntries(): VersionEntry[] {
  const [v, setV] = useState<VersionEntry[]>([]);
  useEffect(() => {
    let live = true;
    void loadVersionEntries().then((l) => live && setV(l));
    return () => {
      live = false;
    };
  }, []);
  return v;
}

export function useSpecData(xml: string): SpecData {
  const versions = useVersionEntries();
  const parsed = useMemo(() => readSpecSummaries(xml), [xml]);
  const facts = useTreeFacts(parsed.specs.map((s) => s.treeVersion));
  return useMemo(() => {
    const display = (v: string) => versions.find((x) => x.value === v)?.display ?? v.replace(/_/g, '.');
    const rows: SpecRow[] = parsed.specs.map((s) => {
      const f = facts.get(s.treeVersion);
      const cls = f?.classes[s.classId];
      const className = cls?.name ?? CLASSES.find((c) => c.classId === s.classId)?.name ?? '';
      const ascName = s.ascendClassId ? cls?.asc.find((a) => a[0] === s.ascendClassId)?.[1] ?? CLASSES.find((c) => c.classId === s.classId)?.ascendancies[s.ascendClassId - 1] ?? '' : '';
      return {
        ...s,
        label: (s.treeVersion !== LATEST ? `[${display(s.treeVersion)}] ` : '') + (s.title || tr('treeSetsData.default')),
        short: (s.title || tr('treeSetsData.default')) + (s.treeVersion !== LATEST ? ` (${display(s.treeVersion)})` : ''),
        versionDisplay: display(s.treeVersion),
        className,
        ascName,
        counts: f ? countPoints(s.nodes, f) : null,
        active: s.index === parsed.active,
      };
    });
    return { rows, active: parsed.active, versions, facts, display };
  }, [parsed, facts, versions]);
}
