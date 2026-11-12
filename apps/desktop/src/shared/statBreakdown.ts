/**
 * Which breakdown upstream shows when you hover a sidebar stat (`Build.lua`: BuildBreakdownIndex,
 * GetStatBreakdownKey, GetSidebarBreakdown). The Calcs tab's own cells are the index: the first cell that carries a
 * breakdown key gives the popup entries for that key, and the cells that list a modifier name give the modifier
 * tables to add when the display stat names modifiers.
 */
import type { CalcDetail, CalcViewSection } from '@pom/protocol';
import { lookupBreakdown } from './calcsLogic.js';

export interface BreakdownIndex {
  /** Breakdown key to the entries of the Calcs cell that carries it. */
  byKey: Map<string, CalcDetail[]>;
  /** Modifier name to the entries (with their section labels) of the cells that list it. */
  byMod: Map<string, CalcDetail[]>;
}

export function buildBreakdownIndex(sections: CalcViewSection[]): BreakdownIndex {
  const byKey = new Map<string, CalcDetail[]>();
  const byMod = new Map<string, CalcDetail[]>();
  for (const sec of sections) {
    for (const sub of sec.subSections) {
      const seen = new Set<string>();
      for (const row of sub.rows) {
        for (const cell of row.cellDetails) {
          for (const d of cell) {
            if (d.breakdown && !byKey.has(d.breakdown) && !seen.has(d.breakdown)) byKey.set(d.breakdown, cell);
          }
          for (const d of cell) {
            for (const name of d.modName ?? []) {
              const l = byMod.get(name) ?? [];
              // The first sub-section that lists a name wins, as in upstream's per-sub-section lookup order.
              if (!l.includes(d)) l.push(d);
              byMod.set(name, l);
            }
          }
        }
      }
    }
  }
  return { byKey, byMod };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

/** True when a breakdown table has something to show (upstream's `GetStatBreakdownKey` test). */
export function hasBreakdown(tbl: unknown): boolean {
  if (nonEmpty(tbl)) return true;
  if (!isObj(tbl)) return false;
  if (Object.keys(tbl).some((k) => /^\d+$/.test(k))) return true;
  return !!tbl.radius || nonEmpty(tbl.rowList) || nonEmpty(tbl.reservations) || nonEmpty(tbl.damageTypes) || nonEmpty(tbl.slots) || nonEmpty(tbl.modList);
}

export interface StatRef {
  stat: string;
  childStat?: string;
  breakdown?: string;
  modNames?: string[];
  ignoredSections?: string[];
}

/** The breakdown key of a display stat, or null when the stat has no breakdown (`GetStatBreakdownKey`). */
export function statBreakdownKey(r: StatRef, tables: Record<string, unknown> | null | undefined): string | null {
  if (!tables) return null;
  let key: string | null = null;
  if (r.breakdown !== undefined) key = r.breakdown;
  else if (r.childStat) {
    const parent = tables[r.stat];
    if (isObj(parent) && parent[r.childStat]) key = `${r.stat}.${r.childStat}`;
  } else if (tables[r.stat]) key = r.stat;
  if (key === null) return null;
  if (r.modNames) return key;
  return hasBreakdown(lookupBreakdown(tables, key)) ? key : null;
}

/** The popup entries upstream shows for a display stat (`GetSidebarBreakdown`). */
export function statDetails(r: StatRef, key: string, index: BreakdownIndex): CalcDetail[] {
  const entry = index.byKey.get(key);
  const fallback = (): CalcDetail[] => [{ breakdown: key }, ...(r.modNames ? [{ modName: r.modNames }] : [])];
  if (!entry) return fallback();
  const out: CalcDetail[] = entry.map((d) => ({ ...d }));
  for (const name of r.modNames ?? []) for (const d of index.byMod.get(name) ?? []) out.push({ ...d });
  const visited = new Set<string>();
  const skip = new Set(r.ignoredSections ?? []);
  for (let i = out.length - 1; i >= 0; i--) {
    const label = out[i]!.label;
    if (!label) continue;
    if (visited.has(label) || skip.has(label)) out.splice(i, 1);
    visited.add(label);
  }
  return out.length ? out : fallback();
}
