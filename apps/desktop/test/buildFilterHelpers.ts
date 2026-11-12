import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LevelingPlan } from '../src/shared/leveling/types.js';
import { reduceGameData, type GameData } from '../src/shared/lootfilter/profile.js';
import { NEVERSINK_DIR } from './lootfilterHelpers.js';
import type { TestContext } from 'node:test';
import { LEVELING_GUIDE, setLevelingGuideForTests } from '../src/shared/leagueContent.js';

/** Runs the rest of this test with the leveling guide switch set (src/shared/leagueContent.ts); it goes back after the test. */
export function levelingGuide(t: TestContext, on: boolean): void {
  const was = LEVELING_GUIDE;
  setLevelingGuideForTests(on);
  t.after(() => setLevelingGuideForTests(was));
}

const here = dirname(fileURLToPath(import.meta.url));
/** dist-test/test -> repo engine-data */
export const ENGINE_DATA = resolve(here, '..', '..', '..', '..', 'engine-data');

let game: GameData | null = null;
export function loadGame(): GameData {
  if (game) return game;
  const j = (n: string): never => JSON.parse(readFileSync(join(ENGINE_DATA, n), 'utf8')) as never;
  game = reduceGameData({ itemBases: j('data_itemBases.json'), gems: j('data_gems.json'), gemForBaseName: j('data_gemForBaseName.json'), vaalForBase: j('data_gemVaalGemIdForBaseGemId.json') });
  return game;
}

export const fixture = (name: string): string => readFileSync(resolve(here, '..', '..', 'test', 'fixtures', name), 'utf8');
export const neverSink = (file = '2-SEMI-STRICT.filter'): string => readFileSync(join(NEVERSINK_DIR, file), 'utf8');

/** The plan the real planner returns for a Ranger with Poisonous Concoction (DESIGN-ADDENDUM: swap at 12, Caustic Arrow on a bow before it). */
export const RANGER_PLAN: LevelingPlan = {
  swap: { gemId: 'Metadata/Items/Gems/SkillGemPoisonousConcoction', name: 'Poisonous Concoction', level: 12, areaLevel: 12, zone: 'The Southern Forest', questId: 'a1q3', source: 'quest' },
  skills: [{ gemId: 'Metadata/Items/Gems/SkillGemPoisonArrow', name: 'Caustic Arrow', from: 1, to: 11, supports: [], weaponClasses: ['Bows'], colours: 'GGG' }],
};
/** Witch with Poisonous Concoction: swap at 31. */
export const WITCH_PLAN: LevelingPlan = {
  swap: { gemId: 'Metadata/Items/Gems/SkillGemPoisonousConcoction', name: 'Poisonous Concoction', level: 31, areaLevel: 31, zone: 'The Lunaris Temple Level 1', questId: 'a3q12', source: 'siosa' },
  skills: [{ gemId: 'Metadata/Items/Gems/SkillGemPoisonArrow', name: 'Caustic Arrow', from: 1, to: 30, supports: [], weaponClasses: ['Bows'], colours: 'GGG' }],
};
