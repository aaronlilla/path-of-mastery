/**
 * The experience multiplier by area level for a character level (Build.lua's tooltip on the Level box, Data.lua's
 * `monsterExperienceLevelMap`): standing in an area far above or below your level costs experience.
 */
const MAX_ENEMY_LEVEL = 85;
const PENALTY_FREE_AREA_LEVEL = 70;
const PENALTY_MULTIPLIER = 0.06;

const triangular = (n: number) => (n * (n + 1)) / 2;

/** The monster level an area level counts as for the experience penalty (areas above level 70 count for less). */
function effectiveMonsterLevel(areaLevel: number): number {
  if (areaLevel <= PENALTY_FREE_AREA_LEVEL) return areaLevel;
  return areaLevel - triangular(areaLevel - PENALTY_FREE_AREA_LEVEL) * PENALTY_MULTIPLIER;
}

export interface ExperienceLine {
  /** "68 (Tier 1)" for map tiers, the area level for the rest. */
  area: string;
  /** Percent, one decimal. */
  percent: string;
}

/** Every area level the character still earns more than 1% from, with the share it earns. */
export function experienceMultipliers(playerLevel: number): ExperienceLine[] {
  const out: ExperienceLine[] = [];
  const safeZone = 3 + Math.floor(playerLevel / 16);
  for (let level = 1; level <= MAX_ENEMY_LEVEL + 2; level++) {
    const expLevel = effectiveMonsterLevel(level);
    const diff = Math.abs(playerLevel - expLevel) - safeZone;
    let mult = diff <= 0 ? 1 : ((playerLevel + 5) / (playerLevel + 5 + diff ** 2.5)) ** 1.5;
    if (playerLevel >= 95) {
      const penalty = [0.935, 0.885, 0.813, 0.7175, 0.6][playerLevel - 95] ?? 0;
      mult = mult * (1 / (1 + 0.1 * (playerLevel - 94))) * penalty;
    }
    if (mult > 0.01) out.push({ area: level >= 68 ? `${level} (Tier ${level - 67})` : String(level), percent: (mult * 100).toFixed(1) });
  }
  return out;
}
