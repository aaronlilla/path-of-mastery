// The knowledge-base interface Journey depends on. Every game fact (gems, quests, zones, passive ids,
// recipes, mod tiers, resist penalties, the XP formula) is a KB row, never a constant in Journey code.
// main/journey/kbStub.ts serves the bundled leveling files behind this same interface.

export interface KbTable<T> {
  /** The game patch the rows are for, like "3.29.1". */
  patch: string;
  /** The live game patch, or null when unknown (offline). */
  livePatch: string | null;
  checkedAt: number;
  /** The rows are older than the live game. */
  behind: boolean;
  data: T;
}

export type KbTableName =
  | 'gem-offers'
  | 'zones'
  | 'routes'
  | 'quest-extras'
  | 'leveling-skills'
  | 'passive-ids'
  | 'vendor-recipes'
  | 'leveling-uniques'
  | 'mod-tiers'
  | 'resist-penalties'
  | 'xp-penalty'
  | 'lab-trials'
  | 'card-rewards'
  | 'life-floors'
  | 'gem-requirements';

export interface KnowledgeBase {
  /** Throws KbMissing when the table was never loaded. */
  table<T>(name: KbTableName): Promise<KbTable<T>>;
  /** A refresh landed. Returns the unsubscribe function. */
  onChange(cb: (name: KbTableName) => void): () => void;
}

export class KbMissing extends Error {
  constructor(public readonly name_: KbTableName) {
    super(`The knowledge base has no "${name_}" table.`);
    this.name = 'KbMissing';
  }
}

// ---- row shapes of the tables Journey reads that the leveling files do not already carry ----

/** `resist-penalties`: the penalty applied to every elemental and chaos resistance once the player is past an act. */
export interface ResistPenaltyRow {
  /** The penalty applies from this act on (a character in act `fromAct` or later has it). */
  fromAct: number;
  /** Negative percentage points, like -30. */
  penalty: number;
  source: string;
}

/** `life-floors`: the least life (or energy shield) a character of the checkpoint is expected to have. */
export interface LifeFloorRow {
  checkpoint: string;
  floor: number;
  source: string;
}

/** `xp-penalty`: the safe range of monster levels around the character level. */
export interface XpPenaltyTable {
  /** Monster level difference that is free of a penalty, as a function of character level. */
  safeRange: { fromLevel: number; toLevel: number; below: number; above: number }[];
  source: string;
}

/** `gem-requirements`: when a gem can be used, by character level (the engine's gem data also carries this). */
export interface GemRequirementRow {
  gemId: string;
  level: number;
}
