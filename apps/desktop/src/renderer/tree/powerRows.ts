// The rows of the Node Power report, as upstream's TreeTab:BuildPowerReport builds them. Kept free of the tree view and
// of React so the rules can be tested.
import type { NodePower } from '@pom/protocol';
import { tr } from '../i18n';

/** The distance upstream gives a node no allocated path reaches (PassiveSpec: `pathDist = 1000`). */
export const UNREACHABLE_DIST = 1000;

export interface ReportRow {
  /** Unique within the report (a mastery has one row per effect). */
  key: string;
  id: number;
  type: number;
  name: string;
  power: number;
  points: number;
  perPoint: number;
}

export interface ReportNode {
  t: number;
  name: string;
  asc?: unknown;
  /** A mastery's effects and their stat lines. */
  mastery?: { effects: Array<{ e: number; s: string[] }> };
}

/** What the POINTS cell says: the distance, or 'Anoint' for a node no path reaches (upstream shows the same). */
export function pointsLabel(points: number): string {
  return points >= UNREACHABLE_DIST ? tr('tree_powerRows.anoint') : String(points);
}

/**
 * The report's rows. Unallocated (default): nodes whose change in `stat` is positive (upstream lists only those).
 * `allocated` ("Show Allocated"): the allocated nodes, with what taking each away changes (negative when it helps), however small.
 */
export function reportRows(nodes: NodePower[], tree: { nodeById(id: number): ReportNode | undefined }, opts: { masteries: boolean; allocated?: boolean }): ReportRow[] {
  const out: ReportRow[] = [];
  const wantAlloc = !!opts.allocated;
  for (const n of nodes) {
    if (!!n.allocated !== wantAlloc) continue;
    const node = tree.nodeById(n.id);
    if (!node || node.asc) continue;
    if (node.t === 3 && n.effects) {
      // A mastery: one row per effect that adds to the stat, named `Mastery: effect lines` (TreeTab:BuildPowerReportList).
      if (!opts.masteries) continue;
      const lines = new Map((node.mastery?.effects ?? []).map((e) => [e.e, e.s]));
      const points = Math.max(1, n.dist);
      for (const ef of n.effects) {
        if (!wantAlloc && !(ef.single > 0)) continue;
        out.push({ key: `${n.id}:${ef.e}`, id: n.id, type: 3, name: `${node.name}: ${(lines.get(ef.e) ?? []).join(' / ')}`, power: ef.single, points, perPoint: (ef.pathPower ?? ef.single) / points });
      }
      continue;
    }
    if (!wantAlloc && !(n.single > 0)) continue;
    if (node.t === 3 && !opts.masteries) continue;
    if (node.t > 3) continue;
    const points = Math.max(1, n.dist);
    // Per point is the path's change over the points it costs. A node without a path (nothing reaches it) has no path
    // change: upstream shows 0 there. Only a mastery falls back on its own change.
    const pathPower = node.t === 3 ? n.pathPower ?? n.single : n.pathPower ?? 0;
    out.push({ key: String(n.id), id: n.id, type: node.t, name: node.name, power: n.single, points, perPoint: pathPower / points });
  }
  return out;
}
