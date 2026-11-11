// Journey contract.
import type { Realm } from '../characterImport.js';
import type { GuideStep } from '../leveling/types.js';
import type { BuildStageId } from '../lootfilter/types.js';
import type { KbTableName } from './kb.js';

export type CheckpointId = string; // 'start' | 'a2'..'a10' | 'swap' | 'lab1'..'lab3' | 'maps' | 'red' | 'final'
export type Policy = 'damage' | 'balanced' | 'survive';

export interface CheckpointSpec {
  id: CheckpointId;
  name: string;
  /** The character level the checkpoint is planned for. */
  level: number;
  /** The area level of the zone the checkpoint sits in; the loot filter stage is read from it. */
  areaLevel: number;
  act: number | 'maps';
  /** Passive points the tree has at this checkpoint (levels plus quest points). */
  passives: number;
  /** Ascendancy points at this checkpoint. */
  ascendancy: number;
  stage: BuildStageId;
  /** Resistance penalty from the KB resist-penalties table, as a negative number or 0. */
  penalty: number;
  policy: Policy;
  /** The checkpoint plays the build's main skill (after the swap); false plays the leveling skill. Additive field. */
  usesMain?: boolean;
}

export interface DecisionOption {
  label: string;
  nodes: number[];
  pathLen: number;
  dpsPct: number;
  ehpPct: number;
  towardPct: number;
  /** What Jev saw: the option in words, no numbers to compare. */
  words: string[];
  hardFail?: string;
}

export interface Decision {
  id: string;
  checkpoint: CheckpointId;
  options: DecisionOption[];
  picked: number;
  decidedBy: 'engine' | 'jev' | 'fallback' | 'player';
  confidence?: number;
  needsReview: boolean;
  jevKey?: string;
}

/** What a gear slot should have at a checkpoint. */
export interface SlotTarget {
  slot: string; // 'Body Armour', 'Ring 1', ...
  /** Build archetype bases with drop level <= area level. */
  bases: string[];
  links?: { size: number; colours: string };
  must: { stat: 'life' | 'res-fire' | 'res-cold' | 'res-light' | 'res-chaos' | 'ms' | 'es' | 'attr-str' | 'attr-dex' | 'attr-int'; min: number; why: string }[];
  nice: { stat: string; why: string }[];
  uniques: { name: string; reqLevel: number; why: string }[];
  crafts: { kind: 'vendor' | 'essence' | 'bench' | 'currency'; text: string; source: 'kb'; kbRow: string }[];
  /** Mode 'trade' only. */
  trade?: { query: object; priceCap: string };
}

export interface GemGroupPlan {
  slot: string;
  colours: string;
  /** gemIds, active gem first. */
  gems: string[];
  /** "Take: Nessa a1q3" or "Buy: Yeena" chips from the guide. */
  sources?: string[];
}

export interface CheckpointPlan {
  spec: CheckpointSpec;
  /** The whole passive tree at this checkpoint (node ids, masteries left out). */
  tree: number[];
  ascend: number[];
  /** The nodes added since the previous checkpoint, in the order to take them. */
  order: number[];
  detours: number[];
  refunds: number[];
  gems: GemGroupPlan[];
  gear: SlotTarget[];
  numbers: Record<string, number>;
  decisions: Decision[];
}

export interface JourneyPlan {
  version: 1;
  buildKey: string;
  planKey: string;
  createdAt: number;
  /** The patch of every KB table the plan used. */
  dataPatch: Partial<Record<KbTableName, string>>;
  stale: boolean;
  mode: 'ssf' | 'trade';
  detourCap: 0 | 8 | 16;
  checkpoints: CheckpointPlan[];
  jevAnswers: Record<string, unknown>;
  /** Why the planner called this build odd (Claude triage input). */
  odd?: string[];
}

export interface CharacterLink {
  buildKey: string;
  realm: Realm;
  account: string;
  character: string;
  autoLink: boolean;
}

export interface TownAdvice {
  reasons: { kind: string; text: string; weight: number }[];
  level: 'hard' | 'suggested';
  decidedBy: 'code' | 'jev' | 'fallback';
}

export interface DefenceCheck {
  deaths: number;
  worst: string;
  lines: string[];
}

export interface LiveState {
  link: CharacterLink | null;
  mode: 'live' | 'log-only' | 'no-log';
  char?: { name: string; cls: string; level: number };
  zone?: { id: string; name: string; areaLevel: number; act: number };
  next: GuideStep[];
  treeDiff: { toTake: number[]; offPlan: number[]; unspent: number } | null;
  gaps: { slot: string; stat: string; have: number; need: number }[] | null;
  town: TownAdvice | null;
  defence: DefenceCheck | null;
  sync: { at: number | null; nextAllowedAt: number | null; budget: { used: number; max: number; window: number }[]; error?: string };
  dataPatch: { patch: string; behind: boolean; livePatch: string | null };
}

// ---- Jev ----

export type JevTaskQuestion = { kind: 'choice'; instructions: string; options: { key: string; criteria: string }[] } | { kind: 'noul'; instructions: string };

export interface JevTask {
  id: string;
  /** At most 2k tokens of words. */
  state: string;
  question: JevTaskQuestion;
  /** Accept the answer when confidence (choice) or p (noul) reaches this. */
  threshold: number;
}

export interface JevVerdict {
  /** The key of the picked option (choice), or null for a noul question. */
  choice?: string;
  p?: number;
  confidence: number;
  accepted: boolean;
  decidedBy: 'jev' | 'fallback';
}

// ---- progress and budget ----

export interface PlanProgress {
  buildKey: string;
  checkpoint: CheckpointId;
  done: number;
  total: number;
  phase: string;
}

export interface BudgetInfo {
  ggg: { used: number; max: number; window: number }[];
  jev: { mode: 'proxy' | 'own-key' | 'env' | 'off'; tokensToday: number };
  claude: { tokens: number; budget: number } | null;
  data: { patch: string; behind: boolean; livePatch: string | null };
}
