import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SolveGoal } from '@pom/protocol';
import type { KeptLadder } from '../../shared/assistant/types.js';

/**
 * Kept builds (PLAN.md slice 3): a whole, proven build per exact gem, ascendancy and budget tier, shipped in resources/skeletons.
 * The Solve starts from one when the goal matches, so the first row is a complete build, not a blank start.
 * shortcut: each tier is its own file at one level (no cut of the tree to another level), when a second skill ships make the fit a procedure.
 */

export interface KeptBuild {
  id: string;
  skill: string;
  className: string;
  ascendancy: string;
  tier: string;
  level: number;
  file: string;
  gearDivines: number;
  dps: number;
  ehp: number;
  /** How far real characters of this build get, in one line with its source (the ask's number often sits above what the ladder reaches). */
  ladderNote?: string;
  /** The numbers behind `ladderNote`: how far real characters of this gem got (a ladder sample, our engine). The row says where the ask sits when it is above the best of them. */
  ladder?: KeptLadder;
}

interface Index { skeletons: KeptBuild[]; versions?: Record<string, number> }

let cached: { dir: string; index: Index } | null | undefined;

function load() {
  if (cached !== undefined) return cached;
  const rel = 'skeletons';
  const res = (process as unknown as { resourcesPath?: string }).resourcesPath;
  let dir = res && existsSync(join(res, rel, 'index.json')) ? join(res, rel) : undefined;
  for (let d = dirname(fileURLToPath(import.meta.url)), i = 0; !dir && i < 7; i++, d = dirname(d)) if (existsSync(join(d, 'resources', rel, 'index.json'))) dir = join(d, 'resources', rel);
  try {
    cached = dir ? { dir, index: JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as Index } : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** The kept build for a goal: same gem, the goal's ascendancy (or none named), the budget tier, and a level from the kept one up to 5 above (a skill's level box may hold the tier's usual level). */
export function keptFor(goal: SolveGoal): (KeptBuild & { xml: string }) | null {
  const k = load();
  if (!k || !goal.skill) return null;
  const hit = k.index.skeletons.find(
    (s) =>
      s.skill.toLowerCase() === goal.skill.trim().toLowerCase() &&
      s.tier === goal.wealth &&
      (!goal.ascendancy || goal.ascendancy === s.ascendancy) &&
      (!goal.className || goal.className === s.className) &&
      (!goal.level || (goal.level >= s.level && goal.level <= s.level + 5)),
  );
  if (!hit) return null;
  try {
    return { ...hit, xml: readFileSync(join(k.dir, hit.file), 'utf8') };
  } catch {
    return null;
  }
}

/** The goal as the kept build plays it: its class and ascendancy, and its level unless the player asked for one (the solver sets the asked level on the start build). */
export const withKept = (goal: SolveGoal, k: KeptBuild): SolveGoal => ({ ...goal, className: k.className, ascendancy: k.ascendancy, level: goal.level ?? k.level });

/** The evidence group the pack's `bySkill` holds: how many real characters play this gem version and which ascendancies (shares of that group). */
export interface KeptEvidence { builds: number; ascendancies?: Array<{ name: string; count: number; share: number }> }

/**
 * Real-character counts per gem version, so the wizard's ascendancy and gem-version questions have evidence for the skills the kept builds cover.
 * From `census.json` beside the kept builds (poe.ninja search totals per skill, gem version, stage and ascendancy: the knowledge lane's `census.mjs` writes it; the stage with most characters is used)
 * and the index's own `versions` for a gem the census does not list.
 */
export function keptEvidence(): Record<string, KeptEvidence> {
  const k = load();
  const out: Record<string, KeptEvidence> = Object.fromEntries(Object.entries(k?.index.versions ?? {}).map(([name, builds]) => [name, { builds }]));
  try {
    const census = k && existsSync(join(k.dir, 'census.json')) ? (JSON.parse(readFileSync(join(k.dir, 'census.json'), 'utf8')) as { skills?: Record<string, Record<string, Record<string, { total: number; byAscendancy?: Record<string, number> }>>> }) : null;
    for (const versions of Object.values(census?.skills ?? {})) {
      for (const [name, stages] of Object.entries(versions)) {
        const best = Object.values(stages).sort((a, b) => b.total - a.total)[0];
        if (!best || !(best.total > 0)) continue;
        const asc = Object.entries(best.byAscendancy ?? {}).filter(([n]) => !n.startsWith('class#')).sort((a, b) => b[1] - a[1]).slice(0, 8);
        out[name] = { builds: best.total, ...(asc.length ? { ascendancies: asc.map(([n, count]) => ({ name: n, count, share: Math.round((count / best.total) * 100) / 100 })) } : {}) };
      }
    }
  } catch { /* an unreadable census leaves the index's counts */ }
  return out;
}

/** Every kept build, cheapest tier first. */
export const keptAll = (): KeptBuild[] => load()?.index.skeletons ?? [];
