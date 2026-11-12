/**
 * The leveling plan: when the build's main skill (and its first two supports) can be had, which skill carries the
 * character until then, and with which supports. Pure; everything is joined by gemId.
 */
import { avail } from './offers.js';
import type { GemOffer, LevelingData, LevelingPlan, LevelingPlanSkill, LevelingProfileLite, LevelingSkillCandidate } from './types.js';

/** Engine weapon type to the loot filter class names. */
export const FILTER_CLASS: Record<string, string[]> = {
  Bow: ['Bows'],
  Claw: ['Claws'],
  Dagger: ['Daggers', 'Rune Daggers'],
  'One Handed Axe': ['One Hand Axes'],
  'One Handed Mace': ['One Hand Maces'],
  'One Handed Sword': ['One Hand Swords'],
  'Thrusting One Handed Sword': ['Thrusting One Hand Swords'],
  Sceptre: ['Sceptres'],
  Staff: ['Staves', 'Warstaves'],
  'Two Handed Axe': ['Two Hand Axes'],
  'Two Handed Mace': ['Two Hand Maces'],
  'Two Handed Sword': ['Two Hand Swords'],
  Wand: ['Wands'],
};

export function filterClassesOf(weaponTypes: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of weaponTypes) for (const c of FILTER_CLASS[t] ?? []) if (!out.includes(c)) out.push(c);
  return out;
}

/** The weapon classes each class starts the game with (the free starter weapon decides what an early skill can use). */
export const STARTER_WEAPONS: Record<string, string[]> = {
  Marauder: ['One Handed Mace', 'Two Handed Mace', 'One Handed Axe', 'Two Handed Axe', 'Sceptre'],
  Duelist: ['One Handed Sword', 'Two Handed Sword', 'Thrusting One Handed Sword', 'One Handed Axe'],
  Ranger: ['Bow'],
  Shadow: ['Dagger', 'Claw'],
  Witch: [],
  Templar: ['One Handed Mace', 'Sceptre', 'Staff'],
  Scion: ['One Handed Sword', 'Two Handed Sword', 'One Handed Axe', 'One Handed Mace', 'Bow', 'Dagger', 'Claw', 'Wand'],
};

const lower = (xs: readonly string[] | undefined) => (xs ?? []).map((x) => x.toLowerCase());

function kindOf(tags: string[]): LevelingSkillCandidate['kind'] {
  if (tags.includes('minion')) return 'minion';
  if (tags.includes('attack')) return 'attack';
  return 'spell';
}

/** The weapon types a skill needs; [] and "None" both mean it needs no particular weapon. */
function needsNoWeapon(weaponTypes: readonly string[]): boolean {
  return weaponTypes.length === 0 || weaponTypes.includes('None');
}

export interface CandidateScore {
  candidate: LevelingSkillCandidate;
  availLevel: number;
  score: number;
  reason: string;
}

/**
 * Score a leveling candidate against the main skill (DESIGN 2.3 step 4):
 * +3 same kind, +2 per shared damage tag, +2 when it needs no weapon or the class starts with one it can use,
 * -3 when it needs a weapon the class has no starter for, +1 per main-group support it can use, minus rank/100.
 */
export function scoreCandidate(c: LevelingSkillCandidate, main: { tags: string[]; weaponTypes: string[]; supportIds: string[] }, className: string): { score: number; reason: string } {
  const mainTags = lower(main.tags);
  let score = 0;
  const why: string[] = [];
  if (c.kind === kindOf(mainTags)) {
    score += 3;
    why.push('same kind');
  }
  const shared = lower(c.damage).filter((t) => mainTags.includes(t));
  if (shared.length) {
    score += 2 * shared.length;
    why.push('shares ' + shared.join(', '));
  }
  const starters = STARTER_WEAPONS[className] ?? [];
  if (needsNoWeapon(c.weaponTypes)) {
    score += 2;
    why.push('needs no weapon');
  } else if (c.weaponTypes.some((w) => main.weaponTypes.includes(w))) {
    score += 2;
    why.push('weapon fits your main skill');
  } else if (c.weaponTypes.some((w) => starters.includes(w))) {
    score += 2;
    why.push('uses a starter weapon');
  } else {
    score -= 3;
    why.push('needs a weapon you must find');
  }
  const shareSupports = c.supports.filter((s) => main.supportIds.includes(s)).length;
  if (shareSupports) {
    score += shareSupports;
    why.push(`${shareSupports} shared support${shareSupports > 1 ? 's' : ''}`);
  }
  score -= c.rank / 100;
  return { score, reason: why.join(', ') };
}

/** Socket colours as the filter's SocketGroup wants them: most frequent first ("GGGGGB"), ties in R G B W order. */
export function colourString(colours: readonly string[]): string {
  const order = 'RGBW';
  const n = new Map<string, number>();
  for (const c of colours) n.set(c, (n.get(c) ?? 0) + 1);
  return [...n.entries()]
    .sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([c, k]) => c.repeat(k))
    .join('');
}

function coloursOf(data: LevelingData, gemIds: string[]): string {
  return colourString(gemIds.map((g) => data.gems[g]?.colour ?? 'W'));
}

function candidateFor(data: LevelingData, gemId: string): LevelingSkillCandidate | null {
  const known = data.skills.find((s) => s.gemId === gemId);
  if (known) return known;
  const g = data.gems[gemId];
  if (!g || g.isSupport) return null;
  const tags = lower(g.tags);
  return { gemId, kind: kindOf(tags), damage: tags, weaponTypes: g.weaponTypes ?? [], rank: 50, supports: [] };
}

/** Everything the UI needs to show the picker: candidates the class can use at level 4 or lower, best first. */
export function rankCandidates(profile: LevelingProfileLite, data: LevelingData): CandidateScore[] {
  const main = data.gems[profile.mainSkillId];
  const mainInfo = { tags: main?.tags ?? [], weaponTypes: main?.weaponTypes ?? [], supportIds: profile.mainSupportIds };
  const out: CandidateScore[] = [];
  for (const c of data.skills) {
    const a = avail(data, c.gemId, profile.className, profile.ruthless);
    if (!a || a.level > 4 || c.gemId === profile.mainSkillId) continue;
    const s = scoreCandidate(c, mainInfo, profile.className);
    out.push({ candidate: c, availLevel: a.level, ...s });
  }
  return out.sort((a, b) => b.score - a.score || a.candidate.rank - b.candidate.rank);
}

/** The limiting offer of the swap: the latest of the main skill and the first two supports. */
function swapOffer(profile: LevelingProfileLite, data: LevelingData): GemOffer | null {
  const ids = [profile.mainSkillId, ...profile.mainSupportIds.slice(0, 2)];
  let worst: GemOffer | null = null;
  for (const id of ids) {
    const a = avail(data, id, profile.className, profile.ruthless);
    // a gem no NPC sells (a drop-only support) does not hold the swap back; the main skill itself must be obtainable
    if (!a) {
      if (id === profile.mainSkillId) return null;
      continue;
    }
    if (!worst || a.level > worst.level) worst = a;
  }
  return worst;
}

function supportsFor(c: LevelingSkillCandidate, data: LevelingData, profile: LevelingProfileLite, upTo: number, max: number): string[] {
  return c.supports
    .map((id) => ({ id, a: avail(data, id, profile.className, profile.ruthless) }))
    .filter((x): x is { id: string; a: GemOffer } => !!x.a && x.a.level <= upTo)
    .sort((a, b) => a.a.level - b.a.level)
    .slice(0, max)
    .map((x) => x.id);
}

function skillRow(c: LevelingSkillCandidate, data: LevelingData, profile: LevelingProfileLite, from: number, to: number): LevelingPlanSkill {
  const supports = supportsFor(c, data, profile, Math.max(to, 4), from <= 4 ? 4 : 5);
  return {
    gemId: c.gemId,
    name: data.gems[c.gemId]?.name ?? c.gemId,
    from,
    to,
    supports,
    weaponClasses: needsNoWeapon(c.weaponTypes) ? [] : filterClassesOf(c.weaponTypes),
    colours: coloursOf(data, [c.gemId, ...supports]),
  };
}

export function planLeveling(profile: LevelingProfileLite, data: LevelingData, override?: string): LevelingPlan {
  const limiting = swapOffer(profile, data);
  const mainName = data.gems[profile.mainSkillId]?.name ?? profile.mainSkillId;
  // At level 4 or lower there is no leveling skill: the main skill is there from the start.
  if (!limiting || limiting.level <= 4) return { swap: null, skills: [] };
  const swapLevel = limiting.level;
  const swap = {
    gemId: profile.mainSkillId,
    name: mainName,
    level: swapLevel,
    areaLevel: swapLevel,
    zone: data.questZones[limiting.questId] ?? '',
    questId: limiting.questId,
    source: limiting.kind,
  };

  const ranked = rankCandidates(profile, data);
  let first: LevelingSkillCandidate | undefined;
  if (override) {
    first = candidateFor(data, override) ?? undefined;
  }
  first ??= ranked[0]?.candidate;
  if (!first) return { swap, skills: [] };

  // A bridge skill: a better one that turns up at least 6 levels before the swap and 6 levels after the first one.
  const skills: LevelingPlanSkill[] = [];
  let bridge: LevelingSkillCandidate | undefined;
  if (!override) {
    const main = data.gems[profile.mainSkillId];
    const mainInfo = { tags: main?.tags ?? [], weaponTypes: main?.weaponTypes ?? [], supportIds: profile.mainSupportIds };
    const firstScore = scoreCandidate(first, mainInfo, profile.className).score;
    const firstFrom = Math.max(avail(data, first.gemId, profile.className, profile.ruthless)?.level ?? 1, 1);
    let bestScore = firstScore;
    for (const c of data.skills) {
      if (c.gemId === first.gemId || c.gemId === profile.mainSkillId) continue;
      const a = avail(data, c.gemId, profile.className, profile.ruthless);
      if (!a || a.level <= 4 || a.level > swapLevel - 6 || a.level < firstFrom + 6) continue;
      const sc = scoreCandidate(c, mainInfo, profile.className).score;
      if (sc > bestScore) {
        bestScore = sc;
        bridge = c;
      }
    }
  }
  if (bridge) {
    const bFrom = avail(data, bridge.gemId, profile.className, profile.ruthless)!.level;
    skills.push(skillRow(first, data, profile, 1, bFrom - 1), skillRow(bridge, data, profile, bFrom, swapLevel - 1));
  } else {
    skills.push(skillRow(first, data, profile, 1, swapLevel - 1));
  }
  return { swap, skills };
}
