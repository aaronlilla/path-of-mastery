import type { LevelingPlan } from '../leveling/types.js';
import type { BuildStageId, Rule } from './types.js';
import { LEVELING_GUIDE } from '../leagueContent.js';

/**
 * The leveling gradient. The game gives a filter no character level but it does give AreaLevel, so every stage is an
 * AreaLevel band and one file covers the whole climb.
 */

export interface Stage {
  id: BuildStageId;
  name: string;
  /** First AreaLevel of the stage. */
  lo: number;
  /** Last AreaLevel of the stage; `OPEN_END` for the last one. */
  hi: number;
  meaning: string;
}

export const OPEN_END = 100;

const NAMES: Record<BuildStageId, { name: string; meaning: string }> = {
  S0: { name: 'Leveling skill', meaning: 'Before your main skill is available.' },
  S1: { name: 'Transition', meaning: 'Main skill on 3 or 4 links, up to Act 5.' },
  S2: { name: 'Late campaign', meaning: 'Resist penalties, the 5 link hunt, Acts 6 to 10.' },
  S3: { name: 'Early maps', meaning: 'White and yellow maps.' },
  S4: { name: 'Endgame', meaning: 'Red maps and up.' },
};

/** Where the stages start by default when the player has not moved them: S2, S3 and S4. */
export const DEFAULT_LATER_BOUNDS = [45, 68, 78];

/**
 * Stages for a plan. `bounds` are the start levels of S1 to S4 when the player moved them; left out, S1 starts where
 * the main skill becomes available (`plan.swap.areaLevel`). S0 is dropped when the main skill is there by area level 4,
 * and a stage with no levels left is dropped.
 */
export function planStages(plan: LevelingPlan | null, bounds?: number[]): Stage[] {
  const aswap = plan?.swap ? plan.swap.areaLevel : 1;
  const swap = aswap <= 4 ? 1 : aswap;
  const starts = bounds && bounds.length >= 4 ? bounds.slice(0, 4) : [swap, ...DEFAULT_LATER_BOUNDS];
  // Leveling guide switched off (shared/leagueContent.ts): S1 starts at area 1, whatever a saved setup says; the saved bounds are kept.
  if (!LEVELING_GUIDE) starts[0] = 1;
  const lo: Record<BuildStageId, number> = { S0: 1, S1: starts[0]!, S2: starts[1]!, S3: starts[2]!, S4: starts[3]! };
  const ids: BuildStageId[] = ['S0', 'S1', 'S2', 'S3', 'S4'];
  const out: Stage[] = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    const next = ids[i + 1];
    const hi = next ? lo[next] - 1 : OPEN_END;
    if (id === 'S0' && lo.S1 <= 1) continue;
    if (lo[id] > hi) continue;
    out.push({ id, ...NAMES[id], lo: lo[id], hi });
  }
  return out;
}

export function stageBanner(s: Stage): string {
  return `${s.id} ${s.name} (area ${s.lo}${s.hi >= OPEN_END ? '+' : `-${s.hi}`})`;
}

export function stageAt(stages: Stage[], areaLevel: number): Stage | undefined {
  return stages.find((s) => areaLevel >= s.lo && areaLevel <= s.hi);
}

/** The AreaLevel range a rule covers, from its conditions. A rule with none covers every level. */
export function bandOf(r: Rule): { lo: number; hi: number } {
  let lo = 1;
  let hi = OPEN_END;
  for (const c of r.targets.flatMap((t) => t.conditions ?? [])) {
    if (c.key !== 'AreaLevel') continue;
    const n = Number(c.values[0]);
    if (c.op === '>=') lo = Math.max(lo, n);
    else if (c.op === '<=') hi = Math.min(hi, n);
  }
  return { lo, hi };
}

export const coversStage = (r: Rule, s: Stage): boolean => {
  const b = bandOf(r);
  return b.lo <= s.hi && b.hi >= s.lo;
};
