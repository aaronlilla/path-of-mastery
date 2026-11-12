/**
 * Data the Configuration and Skills tabs read from the engine, and the extra edits they make.
 * Everything here is produced by crates/pipeline (`tabdata`) and crates/napi; the renderer never derives these values.
 * Text fields keep upstream colour codes (`^7`, `^xE05030`) exactly as upstream has them; the renderer turns them into
 * coloured spans.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Configuration

export type ConfigOptionType = 'check' | 'count' | 'countAllowZero' | 'integer' | 'float' | 'list' | 'text' | 'label';

export interface ConfigListItem {
  val: string | number;
  label: string;
  /** Extra words the dropdown search matches (map affix lists carry the affix text here). */
  search?: string;
  /** What upstream's tooltip shows for this entry (pantheon souls, map affix tiers, ...). Lines joined by `\n`. */
  tooltip?: string;
}

export interface ConfigOptionDef {
  /** Index of the option in `ConfigOptions.lua` (its order). */
  index: number;
  /** The section it belongs to (a `ConfigSectionDef.title`). */
  section: string;
  /** Absent for the bare sub-labels upstream puts between options (type 'label'). */
  var?: string;
  type: ConfigOptionType;
  /** Label with colour codes; for a 'label' row, the sub-label text. */
  label: string;
  /** Upstream's static tooltip text. */
  tooltip?: string;
  /** Tooltips upstream builds from the build's own numbers: the engine fills `ConfigState.dynamicTooltips[var]`. */
  dynamicTooltip?: boolean;
  list?: ConfigListItem[];
  /** 1-based, as in upstream. */
  defaultIndex?: number;
  defaultState?: boolean | number | string;
  defaultPlaceholderState?: number | string;
  resizable?: boolean;
  hideIfInvalid?: boolean;
  doNotHighlight?: boolean;
  legacy?: boolean;
  /** The `ifX` visibility conditions the option carries, by name (ifCond, ifFlag, ifSkill, ifOption, ...). */
  conditions: Record<string, string | string[]>;
  /** For `ifNode`: the node names ("This option is specific to '<name>'." in the tooltip). */
  ifNodeNames?: string[];
  /** `ConfigVisibility.isShowAllExcluded`: stays hidden even when Show All Configurations is on. */
  showAllExcluded: boolean;
}

export interface ConfigSectionDef {
  /** The section's title as upstream shows it. */
  title: string;
  /** Upstream's column hint (1..3). */
  col: number;
}

export interface ConfigCatalog {
  sections: ConfigSectionDef[];
  options: ConfigOptionDef[];
}

export interface ConfigSetInfo {
  id: number;
  title: string;
  /** Inputs that differ from their default, plus enabled custom mod groups with text. */
  changed: number;
}

export interface CustomModBlock {
  title: string;
  enabled: boolean;
  text: string;
  /** One entry per line of `text`: whether the engine's mod parser understands the line (true = a real mod). */
  lineOk: boolean[];
}

export interface ConfigState {
  sets: ConfigSetInfo[];
  /** The active config set's id. */
  activeSet: number;
  /** The active set's inputs by var (every var the set stores; defaults omitted). */
  values: Record<string, boolean | number | string>;
  /** The active set's placeholder numbers by var (what a number box shows greyed when empty). */
  placeholders: Record<string, number | string>;
  /** Every var's default value as `ConfigTab:GetDefaultState` gives it. */
  defaults: Record<string, boolean | number | string>;
  /**
   * Per var: whether upstream would show the option for this build (all its `ifX` conditions pass). Vars with no
   * condition are true. `ifOption` follows the active set's inputs. Sub-label rows (no var) are keyed `#<index>`
   * (their `ConfigOptionDef.index`), so a skill's heading hides with its options.
   */
  shown: Record<string, boolean>;
  /** Per var: text of the tooltip lines upstream computes from the build (LowLife, FullLife). */
  dynamicTooltips: Record<string, string>;
  /** The active set's custom modifier groups, in order. */
  customMods: CustomModBlock[];
}

/**
 * One line of the Add Mod browser (`Modules/ConfigModBrowser.lua`): a modifier the mod parser accepts, as an item or
 * node would carry it (ranges at their midpoint), with where it comes from ("Normal Node", "Notable Node",
 * "Ascendancy Notable Node", "Mastery Node", "Item mod", "Crafted mod", "Veiled mod", ...). The list is already in the
 * original's order; search and ranking (`fuzzyScore`) are the client's.
 */
export interface ConfigModEntry {
  text: string;
  sources: string[];
}

/** One of upstream's display stats (`Modules/BuildDisplayStats.lua`): what a stat id is called and how it is shown. */
export interface StatMetaEntry {
  stat: string;
  childStat?: string;
  label: string;
  /** C-style format: "d", ".1f", ".2f%%", "+d%%" (see BuildDisplayStats.lua). */
  fmt?: string;
  /** Colour code for the label. */
  color?: string;
  flag?: string;
  notFlag?: string;
  compactValue?: boolean;
  compPercent?: boolean;
  lowerIsBetter?: boolean;
  pc?: boolean;
  mod?: boolean;
  hideStat?: boolean;
  chaosInoc?: boolean;
  pool?: string;
  /** Upstream also gates the row with a condition function the data cannot carry. */
  hasCond: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Skills

export type GemColour = 'str' | 'dex' | 'int' | 'w';

/** One gem the game data knows, as the gem picker lists it. */
export interface GemInfo {
  /** The `data.gems` key (the variant's own id); what `addGem` and `setGemSkill` take. */
  id: string;
  gameId: string;
  variantId?: string;
  name: string;
  colour: GemColour;
  support: boolean;
  /** Awakened, Greater, Exceptional supports (the picker's "Exceptional" filter). */
  exceptional: boolean;
  legacy: boolean;
  vaal: boolean;
  /** Transfigured ("Alt") variants name their base gem here. */
  transfiguredOf?: string;
  tags: string[];
  naturalMaxLevel: number;
  /** Highest level the gem has data for (corrupted maximum). */
  maxLevel: number;
  /** Level requirement per gem level, index 0 = level 1 (for "Match Character Level"). */
  levelReq: number[];
  reqStr: number;
  reqDex: number;
  reqInt: number;
  /** `grantedEffect.plusVersionOf` is set: corrupted maximum stays at the natural maximum. */
  plusVersion: boolean;
  /** Allowed as the group's imbued support. */
  imbuedOk: boolean;
  /** Names of the gem's primary and secondary granted effects (the secondary is a Vaal gem's). */
  effectName: string;
  secondaryEffectName?: string;
  /** The gem's quality types (default and the Alt qualities) are not part of the XML; omitted. */
}

export interface SkillSetInfo {
  id: number;
  title: string;
  groups: number;
}

export interface SkillsOptions {
  /** 'normalMaximum' | 'corruptedMaximum' | 'awakenedMaximum' | 'characterLevel' | 'levelOne' */
  defaultGemLevel: string;
  defaultGemQuality: number;
  sortGemsByDPS: boolean;
  /** 'FullDPS' | 'CombinedDPS' | 'TotalDPS' | 'AverageDamage' | 'TotalDot' | 'BleedDPS' | 'IgniteDPS' | 'TotalPoisonDPS' | 'TotalEHP' */
  sortGemsByDPSField: string;
  /** 'ALL' | 'NORMAL' | 'EXCEPTIONAL' */
  showSupportGemTypes: string;
  showLegacyGems: boolean;
}

export interface SkillGem {
  /** 1-based within the group. */
  index: number;
  /** The name as saved/shown (the gem's name when known). */
  nameSpec: string;
  /** `GemInfo.id` when the gem is in the game data. */
  gemId?: string;
  /** The skill id of the granted effect when known (item-granted skills have no gem). */
  skillId?: string;
  known: boolean;
  /** Upstream's message for an unrecognised or unsupported gem. */
  errMsg?: string;
  colour: GemColour;
  support: boolean;
  /** The gem's own level and quality fields as saved (upstream validates level into range). */
  level: number;
  quality: number;
  enabled: boolean;
  enableGlobal1: boolean;
  enableGlobal2: boolean;
  count: number;
  /** The gem sits in a socket of its own colour: +10% quality (`MatchingSocketQualityBonus`). */
  matchesSocket: boolean;
  /** Level and quality the calculation actually uses (item and tree bonuses, socket match included). */
  effectiveLevel: number;
  effectiveQuality: number;
  naturalMaxLevel: number;
  maxLevel: number;
  /** Vaal gem with its own secondary effect toggles (`enableGlobal1/2` checkboxes). */
  vaal: boolean;
  effectName: string;
  secondaryEffectName?: string;
  /** The count box is shown (the gem has an active skill). */
  hasCount: boolean;
  /** Why the gem does nothing right now, as the group tooltip says ("(Disabled)", "(Superseded)", ...). */
  inactiveReason?: string;
}

export interface SkillActive {
  /** 1-based index among the group's active skills (`mainActiveSkill`). */
  index: number;
  name: string;
  /** Gem index (1-based) the active skill comes from. */
  gem: number;
}

export interface SkillGroup {
  /** 1-based position in the active skill set. */
  index: number;
  label: string;
  /** The label the list shows: the label, or the active skill names, as `displayLabel` builds it. */
  displayLabel: string;
  slot?: string;
  /** Set on groups an item or node grants ("item:123:Name", ...). Such groups cannot be edited or deleted. */
  source?: string;
  /** The calculation added this group (an item or node grants a skill) and the build text does not have it yet; an edit saves it first. */
  synthetic?: boolean;
  /** Plain name of the granting item or node. */
  sourceName?: string;
  enabled: boolean;
  /** Disabled because it is socketed in the inactive weapon set. */
  slotInactive: boolean;
  includeInFullDPS: boolean;
  groupCount?: number;
  mainActiveSkill: number;
  imbuedSupport?: string;
  gems: SkillGem[];
  activeSkills: SkillActive[];
}

export interface SkillSlotInfo {
  /** The slot name groups store ("Weapon 1", "Body Armour", ...). */
  slot: string;
  /** What the "Socketed in" menu shows. */
  label: string;
  /** The equipped item, when there is one. */
  item?: { id: number; name: string; rarity: string; base: string; sockets: string[]; linkGroups: number[]; socketLimit?: number; canHaveSockets: boolean };
}

export interface SkillsState {
  sets: SkillSetInfo[];
  activeSet: number;
  /** `<Build mainSocketGroup>`: 1-based group index. */
  mainGroup: number;
  options: SkillsOptions;
  groups: SkillGroup[];
  slots: SkillSlotInfo[];
}

/** A gem to put into a group. Unset fields take the gem's defaults for the build's Gem Options. */
export interface GemSpec {
  /** `GemInfo.id`. */
  gemId: string;
  level?: number;
  quality?: number;
  enabled?: boolean;
  count?: number;
}

export interface GroupSpec {
  label?: string;
  slot?: string;
  enabled?: boolean;
  includeInFullDPS?: boolean;
  gems?: GemSpec[];
  imbuedSupport?: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Edits

/** What to do to the config sets, skill sets (the same verbs). `id` is a set id; `to` a 1-based position. */
export type SetOp =
  | { op: 'activate'; id: number }
  | { op: 'new'; title?: string }
  | { op: 'copy'; id: number; title?: string }
  | { op: 'delete'; id: number }
  | { op: 'rename'; id: number; title: string }
  | { op: 'move'; id: number; to: number };

export type TabBuildEdit =
  | ({ kind: 'configSet' } & SetOp)
  | { kind: 'setCustomMods'; blocks: Array<{ title: string; enabled: boolean; text: string }> }
  | ({ kind: 'skillSet' } & SetOp)
  | { kind: 'addGroup'; at?: number; group?: GroupSpec }
  | { kind: 'removeGroup'; group: number }
  | { kind: 'removeAllGroups' }
  | { kind: 'moveGroup'; from: number; to: number }
  | { kind: 'addGem'; group: number; gem: GemSpec; at?: number }
  | { kind: 'removeGem'; group: number; gem: number }
  | { kind: 'moveGem'; group: number; from: number; to: number }
  /** Reorders a group's gems: `order[i]` is the old 1-based index of the gem that goes to position i+1. */
  | { kind: 'orderGems'; group: number; order: number[] }
  /** Swaps a gem for another gem (level, quality and flags are kept, level clamped to the new gem's range). */
  | { kind: 'setGemSkill'; group: number; gem: number; gemId: string }
  | { kind: 'setMainGroup'; group: number }
  | { kind: 'setMainActiveSkill'; group: number; skill: number }
  /** An attribute of `<Skills>`: defaultGemLevel, defaultGemQuality, sortGemsByDPS, sortGemsByDPSField, showSupportGemTypes, showLegacyGems. */
  | { kind: 'setSkillsOption'; attr: string; value: string | number | boolean };
