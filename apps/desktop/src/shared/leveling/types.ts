// Contract for the leveling planner and guide.
// Everything is joined by gemId (Metadata/Items/Gems/...), never by display name.

export type OfferKind = 'start' | 'chest' | 'quest' | 'vendor' | 'siosa' | 'lilly';

export interface GemOffer {
  gemId: string;
  class: string;
  kind: OfferKind;
  questId: string;
  act: number;
  npc: string;
  /** max(characterLevelAvailable, gemLevelRequirement): "around level N" */
  level: number;
}

export interface GemMeta {
  name: string;
  isSupport: boolean;
  /** socket colour R, G, B or W */
  colour: string;
  /** engine weaponTypes of the gem's granted effect ("Bow", "None", ...). Empty for spells and supports. */
  weaponTypes?: string[];
  /** engine tags ("Attack", "Chaos", "Projectile", ...). */
  tags?: string[];
}

export interface ZoneInfo {
  order: number;
  id: string;
  name: string;
  act: number;
  monsterLevel: number;
  town: boolean;
  waypoint: boolean;
}

export interface LevelingSkillCandidate {
  gemId: string;
  kind: 'attack' | 'spell' | 'minion';
  damage: string[];
  weaponTypes: string[];
  rank: number;
  supports: string[]; // gemIds
}

/** Loaded and normalised leveling data (main/leveling/data.ts builds it from resources/leveling/<league>/). */
export interface LevelingData {
  league: string;
  /** gemId -> class -> offers */
  offers: Record<string, Record<string, GemOffer[]>>;
  gems: Record<string, GemMeta>;
  zones: ZoneInfo[];
  skills: LevelingSkillCandidate[];
  /** questId -> { passives, note } (approximate, see quest-extras.json) */
  questExtras: Record<string, { passives?: number; note?: string }>;
  /** class -> starting gem and chest-support gem (gemIds) */
  starts: Record<string, { start: string; chest: string }>;
  /** exile-leveling route text per act (1..10) */
  routes: Record<number, string>;
  /** questId -> zone name where it is handed in on the route */
  questZones: Record<string, string>;
}

export interface LevelingPlanSkill {
  gemId: string;
  name: string;
  from: number;
  to: number;
  supports: string[]; // gemIds
  weaponClasses: string[];
  colours: string;
}

export interface LevelingPlan {
  swap: {
    gemId: string;
    name: string;
    level: number;
    areaLevel: number;
    zone: string;
    questId: string;
    source: OfferKind;
  } | null;
  skills: LevelingPlanSkill[];
}

export interface LevelingProfileLite {
  className: string;
  mainSkillId: string;
  mainSupportIds: string[];
  ruthless: boolean;
}

export type PlanLevelingFn = (
  profileLite: LevelingProfileLite,
  data: LevelingData,
  override?: string, // gemId
) => LevelingPlan;

// ---- guide ----

export type StageId = 'S0' | 'S1' | 'S2' | 'S3' | 'S4';
export interface StageRef { id: StageId; name: string; lo: number; hi: number }

export type GuideStep =
  | { id: string; kind: 'arrive'; zone: string; zoneId: string; areaLevel: number; text: string; notes: string[] }
  | { id: string; kind: 'handin'; questIds: string[]; quest: string; zone: string; text: string }
  | { id: string; kind: 'text'; text: string; notes: string[] }
  | { id: string; kind: 'quest-reward'; zone: string; quest: string; questId: string; take: string; gemId: string; alt?: string[]; why: string }
  | { id: string; kind: 'buy'; npc: string; zone: string; questId: string; gems: { gemId: string; name: string; cost: string }[]; why: string }
  | { id: string; kind: 'links'; at: { level: number; zone: string }; groups: { slot: string; gems: string[]; colours: string }[] }
  | { id: string; kind: 'swap'; level: number; from: string; to: string; respec?: number[] }
  | { id: string; kind: 'transfigure'; gem: string; how: string }
  | { id: string; kind: 'tree'; level: number; points: number; add: number[]; notables: string[]; specTitle: string }
  | { id: string; kind: 'lab'; which: 'Normal' | 'Cruel' | 'Merciless' | 'Eternal'; ascend: number[]; ascendNames: string[] }
  | { id: string; kind: 'gear'; stage: StageId; lines: string[] }
  | { id: string; kind: 'flask'; level: number; lines: string[] };

export interface GuideAct { act: number; steps: GuideStep[] }

export interface Guide {
  league: string;
  class: string;
  stages: StageRef[];
  acts: GuideAct[];
}
