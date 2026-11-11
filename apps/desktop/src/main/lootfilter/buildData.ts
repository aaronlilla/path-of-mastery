import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rankCandidates } from '../../shared/leveling/plan.js';
import type { LevelingData, LevelingPlan, LevelingProfileLite } from '../../shared/leveling/types.js';
import type { LevelingCandidateRow } from '../../shared/lootfilter/ipcTypes.js';
import { reduceGameData, type GameData } from '../../shared/lootfilter/profile.js';
import { LEVELING_GUIDE } from '../../shared/leagueContent.js';

let memo: { dir: string; data: GameData } | null = null;

/** The engine tables the Build Filter reads (item bases, gems, gem names), reduced. Read once per run. */
export async function loadGameData(engineDataDir: string): Promise<GameData> {
  if (memo && memo.dir === engineDataDir) return memo.data;
  const j = async (n: string): Promise<never> => JSON.parse(await readFile(join(engineDataDir, n), 'utf8')) as never;
  const [itemBases, gems, gemForBaseName, vaalForBase] = await Promise.all([j('data_itemBases.json'), j('data_gems.json'), j('data_gemForBaseName.json'), j('data_gemVaalGemIdForBaseGemId.json').catch(() => undefined)]);
  const data = reduceGameData({ itemBases, gems, gemForBaseName, ...(vaalForBase ? { vaalForBase } : {}) });
  memo = { dir: engineDataDir, data };
  return data;
}

/** The picker's list: the leveling skills the class can have by area level 4, best fit first, each with why. */
export function candidateRows(lite: LevelingProfileLite, data: LevelingData): LevelingCandidateRow[] {
  return rankCandidates(lite, data).map((r) => ({ gemId: r.candidate.gemId, name: data.gems[r.candidate.gemId]?.name ?? r.candidate.gemId, availLevel: r.availLevel, score: Math.round(r.score * 100) / 100, reason: r.reason }));
}

export interface PlanReply {
  plan: LevelingPlan | null;
  /** Why there is no plan, in words for the player. */
  note?: string;
}

type PlanProvider = (lite: LevelingProfileLite, override?: string) => Promise<PlanReply>;
let provider: PlanProvider | null = null;

/** The leveling planner registers itself here (main/leveling). Until it does, the Build Filter runs without a leveling stage. */
export function setPlanProvider(p: PlanProvider): void {
  provider = p;
}

export async function planFor(lite: LevelingProfileLite, override?: string): Promise<PlanReply> {
  // Parked leveling guide (shared/leagueContent.ts): no stage and no note about it.
  if (!provider) return LEVELING_GUIDE ? { plan: null, note: 'Leveling data is not available, so the filter has no leveling stage.' } : { plan: null };
  try {
    return await provider(lite, override);
  } catch (e) {
    return { plan: null, note: `The leveling plan failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
