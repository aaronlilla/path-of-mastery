/**
 * One guide generator for the Leveling tab and the assistant. The filter and the guide must agree on the main skill: a main
 * group that sits in no gear (a calc-only group) cannot be leveled toward, so the build profile picks the slotted group with
 * the most supports (shared/lootfilter/profile.ts `levelingLite`) and the guide takes the same one.
 */
import { activeSpecOf, readFacts } from '../../shared/buildFacts.js';
import { buildGuide, readGuideBuild, type GuideBuild } from '../../shared/leveling/guide.js';
import type { GemIndex } from '../../shared/leveling/offers.js';
import { planLeveling } from '../../shared/leveling/plan.js';
import type { LevelingTree } from '../../shared/leveling/treeOrder.js';
import type { Guide, LevelingData, LevelingPlan, LevelingProfileLite } from '../../shared/leveling/types.js';
import { levelingLite, readBuildProfile, type GameData } from '../../shared/lootfilter/profile.js';
import { LATEST_TREE_VERSION } from '../../shared/treeSets.js';
import { loadLevelingTree } from './tree.js';

export interface GuideKit {
  data: LevelingData;
  idx: GemIndex;
  engineDir: string;
  game: () => Promise<GameData>;
}

export interface GeneratedGuide {
  guide: Guide;
  plan: LevelingPlan;
  data: LevelingData;
  build: GuideBuild;
  lite: LevelingProfileLite;
  tree: LevelingTree | null;
}

/** Points the guide's build at the filter's main skill. */
export function applyFilterMain(build: GuideBuild, lite: LevelingProfileLite): void {
  if (!lite.mainSkillId || lite.mainSkillId === build.mainSkillId) return;
  build.mainSkillId = lite.mainSkillId;
  build.mainSupportIds = lite.mainSupportIds;
  for (const g of build.groups) g.main = g.gemIds.includes(lite.mainSkillId);
}

/**
 * The leveling data only knows gems an NPC offers. A build also holds gems nobody sells (Awakened and Greater supports, drops):
 * without them the guide would print their internal ids and take a support for a skill. Add them from the engine's gem table.
 */
export function withBuildGems(data: LevelingData, build: GuideBuild, game: GameData): LevelingData {
  const extra: LevelingData['gems'] = {};
  for (const id of build.groups.flatMap((g) => g.gemIds)) {
    const g = game.gems[id];
    if (!data.gems[id] && g) extra[id] = { name: g.name, isSupport: g.support, colour: g.colour, ...(g.weaponTypes.length ? { weaponTypes: g.weaponTypes } : {}) };
  }
  return Object.keys(extra).length ? { ...data, gems: { ...data.gems, ...extra } } : data;
}

export async function generateGuide(kit: GuideKit, xml: string, override: string | undefined, leagueStart: boolean): Promise<GeneratedGuide> {
  const game = await kit.game();
  let build = readGuideBuild(xml, kit.idx, kit.data);
  const data = withBuildGems(kit.data, build, game);
  if (data !== kit.data) build = readGuideBuild(xml, kit.idx, data);
  const profile = readBuildProfile(xml, game);
  if (profile?.mainSkill) applyFilterMain(build, levelingLite(profile));
  const lite: LevelingProfileLite = { className: build.className, mainSkillId: build.mainSkillId, mainSupportIds: build.mainSupportIds, ruthless: build.ruthless };
  const plan = planLeveling(lite, data, override || undefined);
  const spec = activeSpecOf(readFacts(xml));
  const tree = spec ? await loadLevelingTree(kit.engineDir, spec.treeVersion || LATEST_TREE_VERSION, spec.classId) : null;
  const guide = buildGuide(build, plan, data, { tree, route: { leagueStart } });
  return { guide, plan, data, build, lite, tree };
}
