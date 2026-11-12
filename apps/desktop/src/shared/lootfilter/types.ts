/**
 * Loot filter data model. Shared by the main process (files, store, network), the renderer (Guided and
 * Advanced) and the tests, so it is plain data and pure functions only: no node or DOM imports.
 *
 * The source of truth is the player's rules (`Rule[]`) plus a few settings. The generated
 * `Path of Mastery.filter` is only ever an output of `generateFilter`.
 */

/** [r, g, b] or [r, g, b, a], each 0 to 255. A missing alpha means 255. */
export type Color = number[];

export type SoundSpec =
  | { kind: 'builtin'; id: number; vol: number; positional?: boolean }
  | { kind: 'custom'; file: string; vol: number; optional?: boolean };

export interface IconSpec {
  /** 0 large, 1 medium, 2 small. */
  size: 0 | 1 | 2;
  colour: string;
  shape: string;
}

export interface BeamSpec {
  colour: string;
  temp?: boolean;
}

/**
 * How a label looks. A field that is `undefined` is left as the base filter has it.
 * `null` on sound, icon and beam switches that effect off (`PlayAlertSound None`, `MinimapIcon -1`, `PlayEffect None`).
 */
export interface LabelStyle {
  fg?: Color;
  bd?: Color;
  bg?: Color;
  fs?: number;
  sound?: SoundSpec | null;
  icon?: IconSpec | null;
  beam?: BeamSpec | null;
  /** false writes DisableDropSound, true writes EnableDropSound. */
  dropSound?: boolean;
}

/** A condition line, like `ItemLevel >= 84` or `BaseType == "Chaos Orb" "Divine Orb"`. */
export interface Condition {
  key: string;
  /** '' when the line has no operator. */
  op: string;
  values: string[];
}

/** A base-filter tier, written in NeverSink's blocks as `$type->currency $tier->t4chaos`. */
export interface TagRef {
  type: string;
  tier: string;
}

export interface Target {
  /** Restyle every base block carrying this tag (in place, no new block). */
  tag?: TagRef;
  /** Emit a new block with these conditions above the base. */
  conditions?: Condition[];
}

export type Visibility = 'show' | 'hide';
export type RuleSource = 'guided' | 'advanced' | 'build' | 'price';

/** The plain-words model a Guided change was made from, kept so Edit can reopen it. */
export type Clause =
  | { t: 'item'; name: string }
  | { t: 'tier'; type: string; tier: string; label?: string }
  | { t: 'sec'; type: string; label?: string }
  | { t: 'gear'; rar: Record<string, 1>; cls: Record<string, 1>; il: number; lk: number; q?: number; sk?: number; cor?: 'yes' | 'no'; idn?: 'yes' | 'no'; inf?: boolean };

export type GuidedAction = 'hide' | 'quiet' | 'standout' | 'loud' | 'reset' | 'custom' | 'match';

export interface GuidedMeta {
  sel: Clause[];
  exc: Clause[];
  act: GuidedAction;
  /** For act 'match': the tier whose look to copy. */
  match?: TagRef;
  /** For act 'custom': the look the player chose. */
  look?: LabelStyle;
}

export interface Rule {
  id: string;
  name?: string;
  source: RuleSource;
  enabled: boolean;
  /** Higher wins. Guided shows rules in ascending priority, so a later change wins. */
  priority: number;
  targets: Target[];
  /** Each entry is a set of conditions that must all hold; items matching any of them are left out of this rule. */
  except?: Condition[][];
  /** Undefined keeps what the base block does. */
  visibility?: Visibility;
  style?: LabelStyle;
  /** Copy the look of another base tier (resolved when the file is written). */
  styleFrom?: TagRef;
  /** Put the matching items back to the base filter: cancels lower rules on the same items. */
  reset?: boolean;
  continue?: boolean;
  /** A block kept word for word (from an imported file) because it does not map onto a rule kind. Written as is. */
  raw?: string[];
  guided?: GuidedMeta;
  /** This rule is a tier the player added in Customize. Its BaseType names are the items in it; `type` is the NeverSink section type it was added to. */
  customTier?: { type: string };
  /** Rules made by one action (a Re-tier or Adapt apply) share a batch, so Your changes shows them as one entry. */
  batch?: { id: string; name: string };
  /** Why the rule exists, shown in the UI (for example "Your boots are 12% under cap"). */
  why?: string;
  createdAt?: number;
  /** Set on rules the Build Filter wrote: which stage of the leveling gradient they belong to and why they exist. */
  build?: BuildMeta;
}

export type BuildStageId = 'S0' | 'S1' | 'S2' | 'S3' | 'S4';
export type BuildGroup = 'custom' | 'safety' | 'weapons' | 'armour' | 'links' | 'boots' | 'jewellery' | 'flasks' | 'resists' | 'gems' | 'jewels' | 'uniques' | 'cards' | 'currency';

export interface BuildMeta {
  stage: BuildStageId | 'all';
  kind: 'safety' | 'show' | 'hide' | 'force';
  reason: string;
  /** The chip in the Build step that switches this rule on and off. */
  group: BuildGroup;
}

/** A change the player (or the assistant, with a card the player accepted) made to one stage: show or hide some classes or bases. */
export interface BuildOverride {
  stage: BuildStageId | 'all';
  action: 'show' | 'hide';
  classes?: string[];
  bases?: string[];
  reason: string;
}

/** The Build Filter's settings. Left out on a filter made before it existed. */
export interface BuildSetup {
  on: boolean;
  mode: 'ssf' | 'trade';
  /** gemId of the leveling skill the player picked instead of the computed one. */
  levelingSkill?: string;
  /** Stage start area levels for S1..S4, when the player moved them. */
  bounds?: number[];
  /** Groups (chips) or rule ids the player switched off. */
  disabled: string[];
  /** False drops the safety net. */
  safetyNet: boolean;
  /** Changes on top of the generated stages. They sit above the stage rules and below the player's own rules, uniques, cards and currency. */
  overrides?: BuildOverride[];
}

export const DEFAULT_BUILD_SETUP: BuildSetup = { on: false, mode: 'ssf', disabled: [], safetyNet: true };

export type LootFilterGame = 'poe1';

export interface FilterSetup {
  /** Index into STRICTNESS (0 Soft to 6 Uber plus strict). */
  strictness: number;
  /** Index into STYLES. */
  style: number;
  /** A different STYLES index for currency-like sections only. Left out, the whole-filter style applies. */
  styleCurrency?: number;
  /** A different STYLES index for gear sections only. Left out, the whole-filter style applies. */
  styleGear?: number;
  /**
   * NeverSink's stacked-currency tiers (stacks of cheap currency get the look of a higher tier). Left out means on, as NeverSink ships it.
   * Off writes those blocks commented out, so stacks fall to the single item's own tier.
   */
  stackedTiering?: boolean;
  followBuild: boolean;
  /** Gear kinds picked when no build is open ("What do you use?"). */
  use: string[];
  /** Build Filter: a generated layer above NeverSink for one build. */
  build?: BuildSetup;
}

export interface FilterDoc {
  id: string;
  name: string;
  game: LootFilterGame;
  setup: FilterSetup;
  rules: Rule[];
  /** File name written into the game folder. */
  fileName: string;
  createdAt: number;
  editedAt: number;
  /** The league the filter was made for. Set the first time the app knows the current league; a copy to the current league gets the current one and the original keeps its own. */
  league?: string;
  /** The build this filter follows, if any (library id). */
  buildId?: string;
  buildName?: string;
  /** Header lines and stage banners for the Build Filter's rules, written into the file by `generateFilter`. */
  buildFilter?: { header: string[]; banners: Record<string, string> };
  /** The last write: when, the hash of the exact text, the setup and rule signature that produced it. */
  /** The copy of this filter on the player's pathofexile.com account: its id there, the hash of the text sent, and when. */
  account?: { id: string; name: string; fileHash: string; at: number; valid: boolean | null; gameVersion: string };
  written?: { at: number; fileHash: string; rulesHash: string; folder: string; path: string; snapshot?: { rules: Rule[]; setup: FilterSetup }; baseVersion?: string };
}

export interface BlockLine {
  /** Condition or action keyword, as written. */
  key: string;
  /** Everything after the keyword, trimmed. */
  rest: string;
  raw: string;
}

export type BlockKind = 'Show' | 'Hide' | 'Minimal';

export interface Block {
  kind: BlockKind;
  /** The text after `Show` or `Hide` on the first line, like `# %D8 $type->6l $tier->hightier`. */
  headerComment: string;
  tag?: TagRef;
  /** NeverSink's own marker such as `%D8`, when present. */
  code?: string;
  /** Present when one of our rules wrote this block (`pom:rule=<id>`). */
  ruleId?: string;
  conditions: Condition[];
  /** Action lines, parsed lazily into a style by `blockStyle`. */
  lines: BlockLine[];
  continue: boolean;
  /** 1-based line of the header in the text this was parsed from. */
  line: number;
  endLine: number;
  /** NeverSink table-of-contents section this block sits in, like `4000 Currency - Regular Currency Tiering`. */
  section?: string;
}
