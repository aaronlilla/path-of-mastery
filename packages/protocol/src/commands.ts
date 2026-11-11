import type { GemTip, ItemCatalog, ItemInfo, ModPool, TooltipLine } from './items.js';
import type { BreakdownEntry, StatDiff, StatValue, Tooltip } from './stats.js';
import type { ConfigCatalog, ConfigModEntry, ConfigState, GemInfo, SkillsState, StatMetaEntry, TabBuildEdit } from './tabs.js';

/**
 * Every command the renderer (via main) can send to the engine host, and the
 * result it gets back. `Mutating` commands additionally cause the engine host
 * to push a `statDiff` event (see events.ts) once the recalculation settles.
 */
export interface CommandMap {
  loadBuild: {
    /**
     * `keep`: 'open' for the player's open build (one at a time: a newer one frees the last), 'shown' for a build a
     * window shows until it is closed. Kept builds are never closed to make room; drafts and scratch copies are.
     */
    params: { buildXml: string; keep?: 'open' | 'shown' };
    result: { buildId: string };
    mutating: true;
  };
  importCode: {
    params: { code: string };
    result: { buildId: string; buildXml: string };
    mutating: true;
  };
  exportCode: {
    params: { buildId: string };
    result: { code: string };
    mutating: false;
  };
  allocNodes: {
    params: { buildId: string; nodeIds: number[] };
    result: { statDiff: StatDiff };
    mutating: true;
  };
  /**
   * A tree click: allocates the node if it isn't, deallocates it if it is. The result has every changed stat
   * except the FullDPS ones (SkillDPS, FullDPS, FullDotDPS), which follow in a `statDiff` event when the build
   * has FullDPS skills.
   */
  toggleNode: {
    params: { buildId: string; nodeId: number };
    result: { statDiff: StatDiff };
    mutating: true;
  };
  /** The stats clicking the node would change, without changing the build (hover tooltip). A click on the same
   * node right after returns this precomputed result. */
  previewNode: {
    params: { buildId: string; nodeId: number };
    result: { statDiff: StatDiff };
    mutating: false;
  };
  setItem: {
    params: { buildId: string; slot: string; itemText: string | null };
    result: { statDiff: StatDiff };
    mutating: true;
  };
  setSkill: {
    params: { buildId: string; slot: string; skillId: string | null };
    result: { statDiff: StatDiff };
    mutating: true;
  };
  setConfig: {
    params: { buildId: string; key: string; value: string | number | boolean | null };
    result: { statDiff: StatDiff };
    mutating: true;
  };
  getStats: {
    params: { buildId: string };
    result: { stats: StatValue[] };
    mutating: false;
  };
  getBreakdown: {
    params: { buildId: string; statId: string };
    result: { breakdown: BreakdownEntry[] };
    mutating: false;
  };
  getNodeTooltip: {
    params: { buildId: string; nodeId: number };
    result: { tooltip: Tooltip };
    mutating: false;
  };
  getItemTooltip: {
    params: { buildId: string; slot: string };
    result: { tooltip: Tooltip };
    mutating: false;
  };
  compare: {
    params: { buildIdA: string; buildIdB: string };
    result: { statDiff: StatDiff };
    mutating: false;
  };
  /**
   * Any change to the open build (see `BuildEdit`). The result has every changed stat except the FullDPS ones,
   * which follow in a `statDiff` event; `blocked` says why a tree click didn't apply. Undoable.
   */
  edit: {
    params: { buildId: string; edit: BuildEdit };
    /** `fullDpsPending`: the FullDPS rows follow as a `statDiff` event; without it none will come for this edit. */
    result: { statDiff: StatDiff; blocked?: ClickBlocked; blockedClass?: number; fullDpsPending?: boolean };
    mutating: true;
  };
  /** The stats an edit would change, without changing the build (hover tooltips, what-if). The same edit applied
   * next returns this precomputed result. */
  previewEdit: {

    /** `full` also runs the FullDPS rows the preview would otherwise leave out. */
    params: { buildId: string; edit: BuildEdit; full?: boolean };
    result: { statDiff: StatDiff; blocked?: ClickBlocked; blockedClass?: number };
    mutating: false;
  };
  /** `previewEdit` for many edits in one call, each on the build as it is (one engine round trip for a ranking). */
  previewEdits: {
    params: { buildId: string; edits: BuildEdit[]; full?: boolean };
    result: { results: Array<{ statDiff: StatDiff; blocked?: ClickBlocked; blockedClass?: number } | { error: string }> };
    mutating: false;
  };
  /** Steps back through committed edits; `statDiff` is null when there is nothing to undo. */
  undo: {
    params: { buildId: string };
    result: { statDiff: StatDiff | null };
    mutating: true;
  };
  redo: {
    params: { buildId: string };
    result: { statDiff: StatDiff | null };
    mutating: true;
  };
  history: {
    params: { buildId: string };
    result: { undo: number; redo: number };
    mutating: false;
  };
  /** The build's tree for the tree view, beyond the static tree data (see `TreeState`). */
  treeState: {
    params: { buildId: string };
    result: { tree: TreeState };
    mutating: false;
  };
  /** The Calcs tab's sections for the build as it now is: `[{id, enabled, subSections: [{label, extra, rows: [{label, cells}]}]}]`.
   * Calculated again on demand, so ask only when the tab is shown. `buffMode` is the Calcs tab's calculation mode
   * (`misc_buffMode`); without it the build's saved mode is used. */
  calcs: {
    params: { buildId: string; buffMode?: CalcsBuffMode };
    result: { sections: CalcSectionOut[] };
    mutating: false;
  };
  getBuildXml: {
    params: { buildId: string };
    result: { buildXml: string };
    mutating: false;
  };
  /** The `<ExportedBuffs>` blocks of the build file while its Export Support switch is on, as `[name, text]` pairs in the
   * order upstream writes them (empty with the switch off). The engine's `exported_buffs` export. */
  exportedBuffs: {
    params: { buildId: string };
    result: { blocks: [string, string][] };
    mutating: false;
  };
  /** The main skill the sidebar's display stats are conditioned on: its name, the `skillFlags` after the calculation
   * (every flag that is true) and its skill types. The engine's `main_skill` export. */
  mainSkill: {
    params: { buildId: string };
    result: MainSkillInfo;
    mutating: false;
  };
  /**
   * Node Power (upstream's `CalcsTab:PowerBuilder`), in steps so clicks stay responsive in between: `nodePowerStart`
   * begins a run over the unallocated nodes within `maxDepth` path steps (null: all), `nodePowerStep` works for about
   * `budgetMs` and returns the nodes finished so far. A run ends when any edit changes the build (`superseded`).
   * `stat` is a power stat id (null: upstream's combined offence/defence), see `POWER_STATS`.
   */
  nodePowerStart: {
    params: { buildId: string; maxDepth: number | null; stat: string | null };
    result: { total: number };
    mutating: false;
  };
  nodePowerStep: {
    params: { buildId: string; budgetMs: number };
    result: NodePowerStep;
    mutating: false;
  };
  /**
   * Optimize pathing, in steps like Node Power. `objective` 'points' looks for a connected tree with fewer points that
   * keeps every allocated notable, keystone, mastery, jewel socket and ascendancy node; a stat id ('Life',
   * 'FullDPS', ...) looks for a better value of that stat with the same or fewer points under the same rules.
   * `nodeIds` of a result applies through `edit` `setNodes`.
   */
  optimizeStart: {
    params: { buildId: string; objective: string };
    result: { candidates: number };
    mutating: false;
  };
  optimizeStep: {
    params: { buildId: string; budgetMs: number };
    result: OptimizeStep;
    mutating: false;
  };
  optimizeCancel: {
    params: { buildId: string };
    result: Record<string, never>;
    mutating: false;
  };
  /**
   * Smart pathing: the fewest-point tree that reaches every `wanted` node and never enters an `avoided` one. `nodeIds`
   * applies through `edit` `setNodes`; `unreachable` lists the wanted nodes no route reaches without an avoided node.
   */
  pathSolve: {
    params: { buildId: string; wanted: number[]; avoided: number[] };
    result: { nodeIds: number[] } | { unreachable: number[] };
    mutating: false;
  };
  /**
   * The build solver (ticket #46): searches class/ascendancy, gems and tree for a goal in the engine, on worker threads
   * (every core but two by default). `solveStep` returns the best-so-far, waiting up to `budgetMs` for a newer one (0:
   * at once). `solveResult` gives one result as the whole build text, applied with `edit` `setXml` (one undo step).
   * `solveCancel` stops the search; results stay readable until the build's next solve.
   */
  solveStart: {
    params: { buildId: string; goal: SolveGoal; options?: SolveOptions };
    result: { solveId: string };
    mutating: false;
  };
  solveStep: {
    params: { solveId: string; budgetMs: number };
    result: SolveSnapshot;
    mutating: false;
  };
  solveCancel: {
    params: { solveId: string };
    result: Record<string, never>;
    mutating: false;
  };
  /** Sends the AI's new or replacement leads into a running plan solve; they join its lead loop. `running` false: the solve already ended. */
  solveAddLeads: {
    params: { solveId: string; leads: SolvePlanLead[] };
    result: { queued: number; running: boolean };
    mutating: false;
  };
  solveResult: {
    /** `id`: the record id on a result row (the sha256 of its build text), stable however the list is re-sorted; `index` is display order only. */
    params: { solveId: string; index?: number; id?: string };
    result: { xml: string };
    mutating: false;
  };
  /**
   * Find Timeless Jewel. `timelessStatus` says whether the seed tables are installed; `timelessSetDataDir` points the
   * engine at another folder (the app's user-data copy). `timelessInfo` lists the build's jewel sockets and
   * `timelessMods` the nodes a jewel type can be searched for. A search runs in steps like Node Power: `timelessStart`
   * begins it, `timelessStep` works for about `budgetMs`, `timelessRows` pages the ranked results once it is done, and
   * `timelessCancel` drops it.
   */
  timelessStatus: {
    params: Record<string, never>;
    result: TimelessDataStatus;
    mutating: false;
  };
  timelessSetDataDir: {
    params: { dir: string | null };
    result: Record<string, never>;
    mutating: false;
  };
  timelessInfo: {
    params: { buildId: string };
    result: TimelessInfo;
    mutating: false;
  };
  timelessMods: {
    params: { buildId: string; jewelType: number };
    result: { mods: TimelessMod[] };
    mutating: false;
  };
  timelessStart: {
    params: { buildId: string; search: TimelessSearch };
    result: { started: true };
    mutating: false;
  };
  timelessStep: {
    params: { buildId: string; budgetMs: number };
    result: TimelessStep;
    mutating: false;
  };
  timelessRows: {
    params: { buildId: string; from: number; count: number };
    result: TimelessRows;
    mutating: false;
  };
  timelessCancel: {
    params: { buildId: string };
    result: Record<string, never>;
    mutating: false;
  };
  /** The "Generate" button: weights for every node of the jewel type from how much the power stat `stat` (see
   * `POWER_STATS`) gains with that node's mods added, as the fallback list text. */
  timelessFallback: {
    params: { buildId: string; jewelType: number; stat: string };
    result: { list: string };
    mutating: false;
  };
  /** Calculates the open build again from its text (after data it was missing arrived, e.g. the timeless jewel tables).
   * Changes no text and adds no undo step; the result has the stats that differ now. */
  recalc: {
    params: { buildId: string };
    result: { statDiff: StatDiff };
    mutating: false;
  };
  /** An item parsed by the engine: the tooltip lines upstream draws and what the editor needs. `buildId` colours
   * requirements against that build's attributes and level. */
  itemInfo: {
    params: { buildId?: string | null; itemText: string; dbMode?: boolean; slotNum?: number; sanitise?: boolean };
    result: { item: ItemInfo };
    mutating: false;
  };
  /** Several items at once (the build's item list), in the order given. */
  itemsInfo: {
    params: { buildId?: string | null; texts: string[] };
    result: { items: ItemInfo[] };
    mutating: false;
  };
  /** Base lists, uniques and rare templates for the item browser and the craft dialog. */
  itemCatalog: {
    params: Record<string, never>;
    result: { catalog: ItemCatalog };
    mutating: false;
  };
  /** The modifier lists the item editor's dialogs pick from: `mods` (Add Modifier), `corrupt`, `enchant` or `anoint`. */
  itemPool: {
    params: { itemText: string; kind: 'mods' | 'corrupt' | 'enchant' | 'anoint' | 'crucible' | 'affixes' | 'implicits' | 'cluster' | 'foulborn' };
    result: { pool: unknown };
    mutating: false;
  };
  /**
   * The modifiers that can roll on a base at an item level (crates/item/src/modpool.rs): prefixes and suffixes with
   * tier (1 = best), item level, spawn weight, numeric ranges and source (normal, influence, elevated, essence, bench,
   * veiled, delve), Searing Exarch / Eater of Worlds implicits, anoints and cluster jewel skills. Cached per base.
   */
  modPool: {
    params: { base: string; itemLevel: number; influences?: string[]; extraTags?: string[] };
    result: { pool: ModPool };
    mutating: false;
  };
  /** Text copied from the game rebuilt as the build file keeps items (the `Implicits:` count and the flags). */
  itemNormalise: {
    params: { itemText: string };
    result: { text: string };
    mutating: false;
  };
  /**
   * Character import: the cluster jewel passives of an imported character that the build text should allocate, matched
   * the way upstream does (`ImportTab` sets `extended_hashes` / `jewel_data`, `BuildSubgraph` allocates what they
   * name). `allocated` is the node ids the build text's own node list lacks (cluster subgraph nodes and the sockets
   * inside a cluster jewel); `unmatched` the extended hashes that matched nothing. The text is only read.
   */
  resolveImportedClusters: {
    params: { xml: string; hashesEx: number[]; jewelData: Record<string, unknown> };
    result: { allocated: number[]; unmatched: number[] };
    mutating: false;
  };
  /** The text of a new item of a base, as the craft dialog makes it. */
  itemCraft: {
    params: { base: string; rarity: string; title?: string };
    result: { text: string };
    mutating: false;
  };
  /** The item text with the prefix and suffix rows of a crafted item written into it. */
  itemAffix: {
    params: { itemText: string; choice: { prefix: Array<{ id: string | null; range: number; fractured?: boolean }>; suffix: Array<{ id: string | null; range: number; fractured?: boolean }> } };
    result: { text: string };
    mutating: false;
  };
  /** The stats item lists and modifier pickers can sort by, in upstream's order. */
  powerStats: {
    params: Record<string, never>;
    result: { stats: Array<{ stat: string; label: string; negate: boolean; items: boolean }> };
    mutating: false;
  };
  /** What `stat` comes to with each candidate put in its slots in the open build (the best over its slots; null when it could not be calculated). The build does not change. */
  itemRank: {
    params: { buildId: string; stat: string; candidates: Array<{ text: string; slots: string[]; flask?: boolean; base?: boolean }> };
    result: { values: Array<number | null> };
    mutating: false;
  };
  /** The "Effective flask stats" lines of a flask or tincture with the open build's modifiers (recovery, duration, charges). */
  itemFlask: {
    params: { buildId: string; itemText: string };
    result: { lines: TooltipLine[] };
    mutating: false;
  };
  /** Whether the open build's modifiers carry each named flag (a third ring slot is `AdditionalRingSlot`). */
  buildFlags: {
    params: { buildId: string; names: string[] };
    result: { flags: Record<string, boolean> };
    mutating: false;
  };
  /** A skill's tooltip as the gem tooltip draws it, for the skills an item grants. */
  gemTip: {
    params: { buildId?: string | null; skillId: string; level: number };
    result: { tip: GemTip };
    mutating: false;
  };
  /**
   * The Calcs tab's breakdown tables of the open build, as upstream fills them while it calculates: `player`
   * and `minion` map a stat name to its table (a list of lines, or an object with `rowList` / `colList` / `slots`).
   * Computed on demand in a separate calculation, never as part of an edit. `buffMode` as for `calcs`.
   */
  getBreakdowns: {
    params: { buildId: string; buffMode?: CalcsBuffMode };
    result: { breakdowns: { player: Record<string, unknown>; minion: Record<string, unknown> | null } };
    mutating: false;
  };
  /**
   * The Calcs tab with what its popups and controls need: the sections (each cell with the entries a hover on it shows,
   * each sub-section with its collapse state), the skill controls' state and the Calcs skill. `collapsed` maps
   * `"<section id>:<sub-section index>"` to a collapse state that replaces the build's saved one. Calculated again on
   * demand (one Calcs-mode run), never as part of an edit.
   */
  calcsView: {
    params: { buildId: string; collapsed?: Record<string, boolean> };
    result: CalcsViewOut;
    mutating: false;
  };
  /** Every minion the Spectre Library can hold, sorted by name then id (static). */
  spectreCatalog: {
    params: Record<string, never>;
    result: { spectres: Array<{ id: string; name: string }> };
    mutating: false;
  };
  /** The modifier table of one popup entry (the stat's modifiers by source), or null when it has none. */
  calcsMods: {
    params: { buildId: string; detail: CalcDetail };
    result: { table: CalcModTable | null };
    mutating: false;
  };
  /**
   * One boss fight of the open build (crates/sim). `options`: `boss` "Pinnacle" | "Uber", `life`, `maxTime` (cap, seconds),
   * `runs` > 0 rolls that many fights (dice mode). The open build is not changed.
   */
  fightSim: {
    params: { buildId: string; options: Record<string, unknown> };
    result: FightResult;
    mutating: false;
  };
  closeBuild: {
    params: { buildId: string };
    result: Record<string, never>;
    mutating: false;
  };
  /** Every Configuration option upstream has (static). */
  configCatalog: {
    params: Record<string, never>;
    result: { catalog: ConfigCatalog };
    mutating: false;
  };
  /** The open build's config sets, inputs, option visibility and custom modifiers. */
  configState: {
    params: { buildId: string };
    result: { state: ConfigState };
    mutating: false;
  };
  /** The mod browser's lines (Add Mod): what the build's passive tree version and the item mod tables offer. */
  configMods: {
    params: { buildId: string };
    result: { mods: ConfigModEntry[] };
    mutating: false;
  };
  /** Every gem in the game data (static). */
  gemCatalog: {
    params: Record<string, never>;
    result: { gems: GemInfo[] };
    mutating: false;
  };
  /** Upstream's display stats (labels and formats) for naming stats in tooltips (static). */
  statMeta: {
    params: Record<string, never>;
    result: { stats: StatMetaEntry[] };
    mutating: false;
  };
  /** The open build's skill sets, socket groups and gems. */
  skillsState: {
    params: { buildId: string };
    result: { state: SkillsState };
    mutating: false;
  };
  /**
   * The gem picker's DPS figure (`GemSelectControl` sort cache): for each candidate gem, the percent change of `field`
   * when that gem is added to `group` (or put in place of gem `gem`). Null where upstream shows no figure: only
   * supports that can support the group's active skills, and active gems with a global effect, are evaluated.
   * `field` is a `SkillsOptions.sortGemsByDPSField` value. Ask in chunks of about 20 ids so results can show as they come.
   */
  gemPower: {
    params: { buildId: string; group: number; field: string; gemIds: string[]; gem?: number };
    result: { power: Record<string, number | null>; base: number };
    mutating: false;
  };
}

/** One entry of a Calcs cell's popup (`CalcSections.lua`): a breakdown table by key, or the modifiers of a stat. */
export interface CalcDetail {
  label?: string;
  breakdown?: string;
  modName?: string[];
  modType?: string;
  cfg?: string;
  enemy?: boolean;
  actor?: string;
  modSource?: string;
  gearOnly?: boolean;
  /** `SkillBuffs` of the minion instead of the player. */
  minion?: boolean;
}

export interface CalcViewRow {
  label: string | null;
  cells: string[];
  /** The popup entries of each cell, in the same order as `cells`. `cellIdx` is each cell's column among the row's `cols` (cells with no text leave their column empty). */
  cellIdx: number[];
  cols: number;
  cellDetails: CalcDetail[][];
  /** Colour codes (`^xRRGGBB`) and text size upstream gives the row. */
  bgCol: string | null;
  color: string | null;
  textSize: number | null;
}

export interface CalcViewSection {
  id: string;
  enabled: boolean;
  /** 1 or 3 columns wide, and upstream's layout group. */
  width: number;
  group: number;
  /** The section's colour code. */
  colour: string | null;
  /** The section's flags pass and at least one row passes its own (`CalcSectionControl:UpdateSize`): upstream draws only these. */
  shown: boolean;
  subSections: Array<{ label: string; extra: string | null; collapsed: boolean; rows: CalcViewRow[]; /** Column titles of the table, shown when the rows have none of their own. */ columns: string[] | null }>;
}

/** The state of the Calcs tab's skill controls (`CalcsTab` "View Skill Details"). */
export interface CalcSkillView {
  showMinion: boolean;
  buffMode: string;
  skillName: string;
  /** `skillFlags` of the shown actor and of the player's Calcs skill. */
  flags: string[];
  playerFlags: string[];
  haveMinion: boolean;
  parts: string[];
  part: number;
  partHasStages: boolean;
  stageCount: number | null;
  stageDefault: number;
  mineCount: number | null;
  minions: Array<{ id: string; label: string }>;
  minion: string | null;
  spectre: boolean;
  /** The skill's minion uses an item set (Animate Guardian, Animate Weapon) and the chosen set id. */
  minionHasItemSet: boolean;
  minionItemSet: number | null;
  /** `output.BuffList`, `CombatList` and `CurseList` of the player and (with a minion) of the minion. */
  lists: { buff: string; combat: string; curse: string };
  minionLists: { buff: string; combat: string; curse: string } | null;
  minionSkills: string[];
  minionSkill: number;
}

/** What `fightSim` returns (crates/sim `simulate`): the shown fight (the median one in dice mode) and the spread over the rolled fights. */
export interface FightResult {
  mode: 'average' | 'dice';
  runs: number;
  boss: { preset: string; /** Null when the life was typed in. */ name: string | null; lifeSource: string; /** Pinnacle boss names in the game files. */ pinnacles: string[]; level: number; life: number; lowLifeThreshold: number; cullPercent: number };
  steady: { dps: number; stat: string; combinedDPS: number | null; fullDPS: number | null };
  killed: boolean;
  killedRuns: number;
  ttk: { seconds: number | null; median: number | null; p10: number | null; p90: number | null; min: number | null; max: number | null };
  /** Dice mode: every killed fight's time to kill, sorted (seconds). */
  ttks?: number[];
  avgDps: number;
  endDps: number;
  /** Damage per second, one entry per second of the shown fight (the last one is the partial second). */
  dpsSeries: number[];
  events: Array<{ t: number; condition: string; label: string; value: boolean | number; configured: boolean | number | null }>;
  assumptions: string[];
  ms: number;
}

export interface CalcsViewOut {
  sections: CalcViewSection[];
  view: CalcSkillView | null;
  mainSkill: { name: string; flags: string[]; skillTypes: number[] };
}

export interface CalcModRow {
  value: string;
  name?: string;
  flags?: string;
  tags?: string;
  source: string;
  sourceName?: string;
  itemId?: number;
  nodeId?: number;
  skillId?: string;
}

export interface CalcModTable {
  label: string | null;
  rows: CalcModRow[];
  /** Several stat names: each row says which. */
  named: boolean;
  /** Per source type, the lines of the "Total from ..." tooltip. */
  totals: Record<string, string[]> | null;
}

/** One section of the Calcs tab as the engine renders it. Colour codes (^7, ^xRRGGBB) are left in the text. */
/** The Calcs tab's calculation mode (`misc_buffMode`): which buffs, combat conditions and enemy effects the Calcs tab's own
 * calculation includes. The sidebar's stats are always EFFECTIVE. */
export type CalcsBuffMode = 'UNBUFFED' | 'BUFFED' | 'COMBAT' | 'EFFECTIVE';

export interface CalcSectionOut {
  id: string;
  enabled: boolean;
  subSections: Array<{ label: string; extra: string | null; rows: Array<{ label: string | null; cells: string[] }> }>;
}

/** One change to a build. Socket groups and gems are 1-based, as in the build XML. */
export type BuildEdit =
  | { kind: 'clickNode'; nodeId: number }
  | { kind: 'setNodes'; nodeIds: number[] }
  | { kind: 'setItem'; slot: string; itemText: string | null }
  | { kind: 'setSlotItem'; slot: string; itemId: number }
  | { kind: 'setConfig'; key: string; value: string | number | boolean | null }
  | { kind: 'setGem'; group: number; gem: number; attr: string; value: string | number | boolean | null }
  | { kind: 'setGroup'; group: number; attr: string; value: string | number | boolean | null }
  /** `amend`: folds into the previous history entry instead of adding one (an automatic follow-up to the user's edit). */
  | { kind: 'setXml'; xml: string; amend?: boolean }
  /** Picks the effect of a mastery: allocates the mastery along its path when it isn't allocated, otherwise changes its effect. */
  | { kind: 'pickMastery'; nodeId: number; effectId: number }
  /** A click on a node of another ascendancy (upstream's `PassiveTreeView` branch): same-class switches the
   * ascendancy, another class switches class too when no points are spent or the tree touches that class, otherwise
   * the reply is `blocked: 'ClassChange'` until `confirm` says what to do ('reset' drops the tree, 'connect' adds the
   * path to the new class first). Allocates the clicked node. */
  | { kind: 'chooseAscendancy'; nodeId: number; confirm?: 'reset' | 'connect' }
  /** The class and ascendancy dropdowns (`PassiveSpec:SelectClass`, `SelectAscendClass`, `SelectSecondaryAscendClass`). */
  | { kind: 'setClass'; classId: number; ascendClassId?: number; secondaryAscendClassId?: number }
  /** Reset Tree: every node and mastery effect off, the class kept (`PassiveSpec:ResetNodes`). */
  | { kind: 'resetTree' }
  /** Replace Modifier of Node: the tattoo (a key of the tree's tattoo table, its display name) replaces the node's
   * modifier; null takes the node's tattoo off (Reset Node). An unknown key or an ascendancy node is an error. */
  | { kind: 'setTattoo'; nodeId: number; tattoo: string | null }
  /** Remove All Tattoos (`TreeTab` "Reset Tree/Tattoos"). */
  | { kind: 'resetTattoos' }
  /** Replaces the Party tab's data (the build's `<Party>` element). The host turns it into a `setXml`. */
  | { kind: 'setParty'; party: PartyState }
  /** Sets several config inputs in the active config set at once (null removes one). The host turns it into a `setXml`. */
  | { kind: 'setConfigs'; values: Record<string, string | number | boolean | null> }
  /** Counts the nodes as allocated wherever they are on the tree, for one calculation (the Compare tab's power report).
   * `previewEdit` only: it changes no build text, so `edit` refuses it. With `xml`, that build text is calculated instead
   * of the open one (a jewel put into a socket that is only counted as allocated). */
  | { kind: 'addNodes'; nodeIds: number[]; xml?: string }
  /** Upstream's `removeNodes` calculator override (the tree tooltip's "Unallocating this node"): the allocated nodes stop
   * counting for one calculation and the rest of the build stays as it is (a timeless jewel's changes to nearby nodes included).
   * `previewEdit` only: it changes no build text, so `edit` refuses it. */
  | { kind: 'removeNodes'; nodeIds: number[] }
  | TabBuildEdit
  | HostBuildEdit;

/**
 * Edits the tabs make by rewriting the build text. The engine host turns each into a `setXml` with the same helpers the
 * tabs use (apps/desktop/src/shared/hostEdits.ts), so one of these is one undo step like any other edit.
 */
export type HostBuildEdit =
  /** Item sets. `id` is the set id (`activate`, `copy`, `delete`, `rename`). `new` and `copy` make the new set the active one. */
  | { kind: 'itemSet'; op: 'activate' | 'new' | 'copy' | 'delete' | 'rename'; id?: number; title?: string }
  /** The active item set's weapon swap (second weapon set) on or off. */
  | { kind: 'setWeaponSwap'; on: boolean }
  /** A flask slot's "active" switch ("Flask 1".."Flask 5"). */
  | { kind: 'setFlaskActive'; slot: string; active: boolean }
  /** Puts an item of the build (`itemId`, 0 empties) or a new item (`itemText`) in a jewel socket of the active tree. */
  | { kind: 'setJewel'; nodeId: number; itemId?: number; itemText?: string }
  | { kind: 'deleteItems'; itemIds: number[] }
  | { kind: 'setItemText'; itemId: number; itemText: string }
  /** Tree sets (specs). `index` is 1-based. `new` is an empty tree of the active class; `importLink` adds a tree from an official tree link. */
  | { kind: 'treeSet'; op: 'activate' | 'new' | 'copy' | 'delete' | 'rename' | 'move' | 'importLink'; index?: number; title?: string; to?: number; link?: string }
  /** Character level, and whether it follows the points spent (`auto`). */
  | { kind: 'setLevel'; level?: number; auto?: boolean }
  | { kind: 'setNotes'; text: string }
  /** Opens the loadout of that name (its tree, item, skill and config sets). */
  | { kind: 'openLoadout'; name: string }
  /** The Spectre Library (ids from `spectreCatalog`): `ids` replaces it, or `add` / `remove` change it. */
  | { kind: 'setSpectres'; ids?: string[]; add?: string[]; remove?: string[] };

/** The Party tab's text fields and switches, as stored in the build file (see apps/desktop/src/shared/partyXml.ts). */
export interface PartyState {
  stats: string;
  auras: string;
  curses: string;
  warcries: string;
  links: string;
  enemyCond: string;
  enemyMods: string;
  destination: string;
  append: boolean;
  showAdvanced: boolean;
  /** Party effects off: the text is kept but the engine no longer applies it. */
  disabled: boolean;
}

/** Why a tree click didn't apply: an unallocated mastery needs an effect picked, a node of another ascendancy needs
 * the class change confirmed, or the click does nothing (no path, a class start). */
export type ClickBlocked = 'PickMastery' | 'OtherAscendancy' | 'ClassChange' | 'Nothing';

/** A node the build generates (cluster-jewel subgraphs) or changes (conquered, tattooed). */
export interface TreeStateNode {
  id: number;
  kind?: string;
  name: string;
  stats: string[];
  group?: number | null;
  orbit?: number;
  orbitIndex?: number;
  linked?: number[];
  ascendancy?: string | null;
  socket?: boolean;
  conquered?: boolean;
  tattoo?: boolean;
  isTattoo?: boolean;
  /** The hash override's icon path (tattoos), when there is one. */
  icon?: string | null;
  activeEffectImage?: string | null;
  /** What conquered the node: an abyss jewel, a timeless jewel, or something else. */
  conqueredBy?: 'abyss' | 'timeless' | 'other' | null;
}

export interface TreeState {
  treeVersion: string;
  classId: number;
  ascendClassId: number;
  secondaryAscendClassId: number;
  /** Allocated jewel sockets in node order; `size` is a cluster jewel socket's size (0 to 2). */
  sockets: Array<{ id: number; name: string; size: number | null; group: number | null }>;
  /** Allocated node ids, in the order they were allocated. */
  allocated: number[];
  /** [mastery node, effect] pairs. */
  masteries: Array<[number, number]>;
  /** [socket node, item id] pairs. */
  jewels: Array<[number, number]>;
  generated: TreeStateNode[];
  changed: TreeStateNode[];
  /** Each socketed jewel's name, base and radius, by socket node id. */
  jewelInfo?: Record<string, JewelInfo>;
}

export interface JewelInfo {
  title: string;
  base: string;
  /** The item's radius label ("Large", "Variable", ...) when it has one. */
  radius?: string;
}

export interface MainSkillInfo {
  name: string;
  /** The skill flags that are true (`attack`, `spell`, `hit`, `notAverage`, ...). */
  flags: string[];
  skillTypes: string[];
  /** The message lines under the skill (`mainSkill.infoMessage`, split at colons when over 40 characters), and `infoMessage2` below them. */
  info?: string[];
  info2?: string | null;
  /** `mainSkill.disableReason`, given when the skill is disabled (flags then hold just `disable`): "This skill requires a Shield", ... */
  disableReason?: string | null;
  /** The minion's main skill when the main skill is a minion skill (`mainEnv.minion.mainSkill`), same shape. */
  minion?: { name: string; flags: string[]; skillTypes: string[]; info?: string[]; info2?: string | null };
}

/** One node's power. `offence`/`defence` are upstream's combined values; `single` is the chosen stat's change. */
export interface NodePower {
  id: number;
  /** Path steps from the allocated tree (1: next to it). */
  dist: number;
  offence: number;
  defence: number;
  single: number;
  /** The chosen stat's change for allocating the whole path (null when the node has no path). */
  pathPower: number | null;
  /** An allocated node (a chosen stat only): `single` and `pathPower` are the change for removing it (and what depends on it); `dist` is how many nodes go. */
  allocated?: boolean;
  /** A mastery: what each of its effects does, for the report's one row per effect (the fields above hold the best). */
  effects?: Array<{ e: number; offence: number; defence: number; single: number; pathPower: number | null }>;
}

export interface NodePowerStep {
  /** False once a run was replaced by another or an edit changed the build; then `nodes` is empty. */
  active: boolean;
  done: boolean;
  /** 0..100 */
  progress: number;
  nodes: NodePower[];
  /** Set when `done`: the largest values, for normalising (`PowerBuilder`'s `powerMax`). */
  max?: { singleStat: number; offence: number; offencePerPoint: number; defence: number; defencePerPoint: number };
}

export interface OptimizeResult {
  /** The whole new node list (the active spec's, in order), for `edit` `setNodes`. */
  nodeIds: number[];
  added: number[];
  removed: number[];
  pointsBefore: number;
  pointsAfter: number;
  /** Stats that change, [statId, before, after]. */
  stats: Array<[string, number, number]>;
  /** Notables, keystones, masteries and sockets kept. */
  keptNotables: number;
}

export interface TimelessDataStatus {
  installed: boolean;
  dir: string;
  /** Table files that cannot be read (`NodeIndexMapping.lua` when the folder is empty). */
  missing: string[];
}

export interface TimelessSocket {
  /** The tree node id; -1 is "All Sockets". */
  id: number;
  /** "Keystone: id", with "# " in front when the build has the socket allocated. */
  label: string;
  keystone: string;
  allocated: boolean;
  /** Notables in the socket's radius the build has (the "Protect allocated nodes from changing" list). */
  allocatedNotables?: Array<{ label: string; id: number }>;
  /** The nodes of the socket's radius as `[dx, dy, kind, allocated]`: offset from the socket, kind (0 small, 1 notable,
   * 2 keystone, 3 socket) and whether the build has the node. */
  preview?: Array<[number, number, number, number]>;
}

export interface TimelessInfo {
  sockets: TimelessSocket[];
  treeVersion: string;
  data: TimelessDataStatus;
  /** Reclaimed Malevolence: the ascendancy notables the build has (the protect list). */
  ascendancyNotables: Array<{ label: string; id: number }>;
  /** Reclaimed Malevolence: the outcomes a search can be limited to ("Required ascendancy outcome"). */
  ascendancyOutcomes: Array<{ label: string; id: string }>;
}

/** An entry of the "Search for Node" list. */
export interface TimelessMod {
  label: string;
  id?: string;
  descriptions?: string[];
  /** The hybrid "Total Strength / Dexterity / Devotion" entry. */
  totalMod?: boolean;
  statCount?: number;
  /** What the first and second weight slider control. */
  stat1?: string;
  stat2?: string;
}

export interface TimelessSearch {
  jewelType: number;
  /** A tree socket id, or -1 for every socket. */
  socketId: number;
  socketFilter: boolean;
  socketFilterDistance: number;
  totalMinimumWeight: number | null;
  /** One row per line: `id, weight, secondWeight, minimumWeight`. */
  searchList: string;
  searchListFallback: string;
  /** Names of the notables ticked in "Protect allocated nodes from changing". */
  protected: string[];
}

export interface TimelessStep {
  active: boolean;
  done: boolean;
  progress: number;
  results: number;
  seedsDone?: number;
}

export interface TimelessRow {
  seed: number;
  total: number;
  /** The total as upstream prints it (`tostring`). */
  totalText: string;
  /** The row text of upstream's results list. */
  label: string;
  socketId: number | null;
  socketLabel: string | null;
  hits: Array<{ id: string; idx: number; weight: number; names: string[] }>;
}

export interface TimelessRows {
  total: number;
  rows: TimelessRow[];
  /** The weight columns, in order. */
  desired: Array<{ id: string; displayName: string; idx: number; weight: number; weight2: number }>;
}

export interface OptimizeStep {
  active: boolean;
  done: boolean;
  progress: number;
  evaluated: number;
  /** Best result so far; on `done` null means the tree is already optimal for the objective. */
  best: OptimizeResult | null;
}

/**
 * A solve goal (decision #39). Metrics: DPS `combined` (default) | `hit` | `dot` | `boss` | `full` | `minion` (a minion skill's minion DPS); defence `ehp` |
 * `maxhit:<fire|cold|lightning|chaos|physical>` | `pool` | `life` | `es` | `resist:<element>`; any output key as
 * `stat:<key>`. Limits are on unless loosened: resists (null turns them off), attributes, reservation, warnings, cost.
 */
export interface SolveGoal {
  skill: string;
  /** Restricts the solver to this class's ascendancies ("Templar"). */
  className?: string;
  ascendancy?: string;
  level?: number;
  targets?: Array<{ name: string; metric?: string; value?: number; weight?: number }>;
  limits?: {
    resists?: number | null;
    /** Life plus energy shield at least this (default 3000); null turns it off. */
    pool?: number | null;
    attributes?: boolean;
    reservation?: boolean;
    warnings?: boolean;
    cost?: boolean;
    extra?: Array<{ name?: string; stat: string; min?: number; max?: number }>;
  };
  gems?: { require?: string[]; ban?: string[] };
  /** Item rules, kept for the items layer: allowed rarities, must/never uniques, slot locks. */
  items?: unknown;
  /**
   * `flasks` (default true): a flask counts when the build sustains it; `flasksAlways`: every flask counts as always on.
   * `flaskUptime`: `mapping` (default, kills refill flasks too) or `bossing` (only charges the build generates).
   * `playMode`: `mapping`, `bossing` or `both` (the app asks every time), the enemy and config switches are set for it. `configOn`: config switch keys
   * the player turned on (offers taken); the solver sets them on every candidate.
   */
  assume?: { flasks?: boolean; flasksAlways?: boolean; flaskUptime?: 'mapping' | 'bossing'; ailments?: boolean; charges?: boolean; buffs?: boolean; playMode?: 'mapping' | 'bossing' | 'both'; configOn?: string[] };
  bandit?: 'None' | 'Oak' | 'Kraityn' | 'Alira';
  passivePoints?: number;
  ascendancyPoints?: number;
  /** Optional test order (Jev's shortlist, 0..1 per name; unnamed = 0.5). Orders candidates, never removes one. */
  priority?: SolvePriority;
  /** Crafted rares: `typical` (default, the middle of the top two tiers) or `perfect` (best tier, top roll). */
  rolls?: 'typical' | 'perfect';
  /** How rich the player is: the gear lines and uniques the solver may use (engine-data/wealth_tiers.json). Left out: no limit; the app asks every time. */
  wealth?: SolveWealth;
  /** Live unique prices in divine orbs (the app's poe.ninja feed); the engine falls back to its own snapshot. */
  uniquePrices?: Record<string, number>;
  /**
   * The player's AI's plan: each lead runs first as its own solve (that ascendancy or class only, its
   * uniques must-use when the wealth tier allows them, its supports required, its keystones seeded), then the solver's
   * own leads. A unique above the tier is left out and named in the lead's `notes`. Results: `SolveSnapshot.plan`.
   */
  plan?: { leads: SolvePlanLead[] };
}

export interface SolvePlanLead {
  name: string;
  className?: string;
  ascendancy?: string;
  uniques?: string[];
  supports?: string[];
  keystones?: string[];
  why?: string;
  /** The stalled lead this one replaces (the panel shows it under that lead). */
  replaces?: string;
}

/** How one lead stands (solver_plan.rs). */
export interface SolvePlanLeadResult {
  /** The lead's number in this run (stable; `SolveSnapshot.stalls[].id`). */
  id: number;
  name: string;
  replaces: string | null;
  className: string | null;
  ascendancy: string | null;
  why: string | null;
  status: 'running' | 'met' | 'stalled' | 'error' | 'stopped';
  /** Solves run for this lead; each round doubles the last one's tries. */
  rounds: number;
  evaluations: number;
  /** Index into `results` of the lead's best build (null: none yet). */
  best: number | null;
  targets: Array<{ name: string; value: number; target: number | null; met: boolean }>;
  limitsMet: boolean | null;
  /** What held the best build back, one line: "DPS 2.1M of 3M; tree and gems alone give 900k of it; gear budget used up at league-start (4.8 of 5 divine)". */
  limiting: string | null;
  /** More search time on this lead plausibly closes the gap (false once a doubling of tries gained under 5%). */
  moreTimeHelps: boolean;
  /** What the last doubling of tries gained on the goal, in percent (null until the tries have doubled once). */
  lastGainPct: number | null;
  /** What the plan asked for that was left out and why ("Headhunter left out: about 60.0 divine, above league-start"). */
  notes: string[];
  error: string | null;
}

export type SolveWealth = 'league-start' | 'mid-league' | 'rich' | 'mirror';

/** Supports and uniques by name; modifier families by a phrase of their text ("maximum Life") or their mod group. */
export interface SolvePriority {
  supports?: Record<string, number>;
  uniques?: Record<string, number>;
  modGroups?: Record<string, number>;
}

export interface SolveOptions {
  /** 0 or left out: no clock; the run ends when every target is met or every lead has stalled (`SolveSnapshot.endReason`). */
  timeBudgetMs?: number;
  threads?: number;
}

export interface SolveResultSummary {
  index: number;
  /** The record id (sha256 of the build text): fetch the result with it, not by `index`. */
  id?: string;
  label: string;
  className: string;
  ascendancy: string | null;
  score: number;
  /** `startValue`: the open build's value of the same target (null on the open build's own row). */
  targets: Array<{ name: string; metric: string; stats: string[]; value: number; shown?: number; target: number | null; met: boolean; startValue?: number | null }>;
  limits: Array<{ name: string; value: number; need: number; met: boolean; shortfall: number }>;
  limitsMet: boolean;
  /** The required-basics checklist for the goal's play mode and tier (solver_checklist.rs): every item that applies, met or not, with the plain reason when unmet. `level`: a hard limit, a soft goal, or a warning chip. */
  checks?: Array<{ id: string; label: string; level: 'hard' | 'soft' | 'chip'; status: 'met' | 'unmet'; value: number; need: number; reason: string | null; note?: string | null; shown?: string; missing?: string }>;
  /** The limit (largest shortfall) or, with every limit met, the target furthest from its value that stops the goal. */
  blocking: { kind: 'limit'; name: string; shortfall: number } | { kind: 'target'; name: string; reached: number } | null;
  points: number;
  ascendancyPointsUsed: number;
  gems: { main: string[]; utility: string[] };
  /** Every filled slot (flasks, abyss sockets, "Tree jewel", and "Jewel <node>" for jewels in particular sockets). */
  items: Array<{ slot: string; item: string; locked: boolean }>;
  bandit: string;
  /** The open build as it was, scored on the goal (always listed). */
  start: boolean;
  /** A target is below the open build's (listed for meeting limits the open build misses). */
  belowStart?: boolean;
  /** What this result assumes beyond the solve's list: each config switch it sets (with why), each flask, counted (sustained) or not, with its uptime. */
  assumptions?: string[];
  /** Config switches this result sets, with why ("Fortify support"); `player`: the player turned it on. */
  configOn?: Array<{ key: string; label: string; reason: string; player: boolean }>;
  /** Close calls (and switches that alone moved a target by more than a quarter) left off, with what each adds. */
  offers?: Array<{ key: string; label: string; reason: string; delta: number; text: string }>;
  /** Bossing: the boss skills (the config's preset list) that one-shot this result, "One-shot by Sirus Meteor (needs +18k Physical max hit)". Info only. */
  bossChips?: string[];
  /** Bossing: boss DPS, EHP and the weakest max hit against the boss's hit, in one line. */
  bossBreakdown?: string | null;
  /** The honest re-check: the biggest target move when only the config the build earns is kept; `flagged` over 5%. */
  honest?: { target: string; raw: number; honest: number; delta: number; flagged: boolean; dropped: string[]; text: string } | null;
  /** Estimated gear cost in divine orbs (the open build's own row: 0). */
  costDivines?: number;
  life?: number;
  energyShield?: number;
  /** Which lead (weapon + damage route + ascendancy) this build comes from. Absent on solvers that do not search leads. */
  lead?: SolveLead;
  /** Plan runs: the name of the plan lead (or "Solver's own leads") this build came from. */
  planLead?: string;
}

export interface SolveLead {
  id: number;
  /** In player words: "Poison claws · Hierophant". */
  label: string;
  weapon: { name: string; itemType: string; unique: boolean };
  damage: 'physical' | 'fire' | 'cold' | 'lightning' | 'chaos' | 'poison' | 'bleed' | 'ignite' | 'minion';
  crit: boolean;
  keystones: string[];
  /** What makes it different from pick 1 ("Claw, not Axe"). Empty on pick 1. */
  differs: string[];
  /** A relaxed pick (too close to the others): the panel says "Close to #1". */
  similar?: boolean;
}

export interface SolveSnapshot {
  solveId?: string;
  active: boolean;
  done: boolean;
  /** gems | tree | ascendancy | trade-off: <target> | bandit | done */
  layer: string;
  /** The class/ascendancy being worked on. */
  candidate?: string;
  evaluations: number;
  elapsedMs: number;
  evalsPerSec?: number;
  threads?: number;
  budgetMs?: number;
  level?: number;
  passivePoints?: number;
  ascendancyPoints?: number;
  assumptions?: string[];
  /** Set when some result moves over 5% under the honest re-check. */
  honestSummary?: string | null;
  itemRules?: unknown;
  /** Up to 8 builds along the trade-off between the targets, best score first. */
  results: SolveResultSummary[];
  /** Indexes into `results` of the best 3 leads that differ, best first; empty or absent until the solver has picked them. */
  picks?: number[];
  /** Every lead and where it stands, for the progress line. */
  leads?: Array<{ id: number; label: string; status: 'live' | 'reserve' | 'dropped' | 'stalled' | 'final'; dps: number; ehp: number }>;
  /** Plan runs (a goal `plan`, or no time budget): every lead's standing, plan leads first, the solver's own leads last. */
  plan?: { leads: SolvePlanLeadResult[] };
  /** Set when a plan run ends: `met` (a result meets every target and limit), `stalled` (every lead stopped gaining), `stopped` (Stop), `budget` (the time budget ran out), `error`. */
  endReason?: 'met' | 'stalled' | 'stopped' | 'budget' | 'error';
  /** Set when a plan run ends by itself (every target met, or every lead stalled): what the AI re-plans from. */
  end?: SolveEnd;
  /** Plan runs: each lead that stalled (or could not run) while the run goes on, by lead id, for the AI's swap. */
  stalls?: SolveStall[];
  /** Plan runs: every lead has stalled and the run waits (no work) for new leads (`solveAddLeads`) or Stop. */
  idle?: boolean;
  error?: string;
}

/**
 * How a plan run ended by itself. `leads[].name`: the plan lead's name (the solver's own leads last); `values`: each target
 * with a value and each limit, the lead's best build against the need; `limiting`: what held it back, in a plain phrase.
 */
export interface SolveEnd {
  reason: 'met' | 'stalled';
  leads?: Array<{ name: string; values: Array<{ name: string; value: number; need: number }>; limiting?: string; moreTimeHelps?: boolean }>;
}

/** One stalled lead's record: its best against every target value and limit, what held it back, whether time helps. */
export interface SolveStall {
  id: number;
  name: string;
  values: Array<{ name: string; value: number; need: number }>;
  limiting?: string;
  moreTimeHelps?: boolean;
}

export type CommandName = keyof CommandMap;

export type CommandParams<K extends CommandName> = CommandMap[K]['params'];
export type CommandResult<K extends CommandName> = CommandMap[K]['result'];

const MUTATING_FLAGS: Record<CommandName, boolean> = {
  loadBuild: true,
  importCode: true,
  exportCode: false,
  allocNodes: true,
  toggleNode: true,
  previewNode: false,
  setItem: true,
  setSkill: true,
  setConfig: true,
  getStats: false,
  getBreakdown: false,
  getNodeTooltip: false,
  getItemTooltip: false,
  compare: false,
  edit: true,
  previewEdit: false,
  previewEdits: false,
  undo: true,
  redo: true,
  history: false,
  treeState: false,
  calcs: false,
  getBuildXml: false,
  mainSkill: false,
  exportedBuffs: false,
  nodePowerStart: false,
  nodePowerStep: false,
  optimizeStart: false,
  optimizeStep: false,
  optimizeCancel: false,
  pathSolve: false,
  solveStart: false,
  solveStep: false,
  solveCancel: false,
  solveAddLeads: false,
  solveResult: false,
  timelessStatus: false,
  timelessSetDataDir: false,
  timelessInfo: false,
  timelessMods: false,
  timelessStart: false,
  timelessStep: false,
  timelessRows: false,
  timelessCancel: false,
  timelessFallback: false,
  recalc: false,
  itemInfo: false,
  itemsInfo: false,
  itemCatalog: false,
  itemCraft: false,
  itemPool: false,
  modPool: false,
  itemNormalise: false,
  resolveImportedClusters: false,
  itemAffix: false,
  powerStats: false,
  itemRank: false,
  itemFlask: false,
  gemTip: false,
  buildFlags: false,
  getBreakdowns: false,
  calcsView: false,
  calcsMods: false,
  fightSim: false,
  spectreCatalog: false,
  closeBuild: false,
  configCatalog: false,
  configState: false,
  gemCatalog: false,
  statMeta: false,
  configMods: false,
  skillsState: false,
  gemPower: false,
};

export const MUTATING_COMMANDS: ReadonlySet<CommandName> = new Set(
  (Object.keys(MUTATING_FLAGS) as CommandName[]).filter((name) => MUTATING_FLAGS[name]),
);

/** Request envelope sent over the main <-> engine-host message channel. */
export interface EngineRequest<K extends CommandName = CommandName> {
  id: string;
  command: K;
  params: CommandParams<K>;
}

export interface EngineErrorPayload {
  message: string;
  code?: string;
}

export type EngineResponse<K extends CommandName = CommandName> =
  | { id: string; command: K; ok: true; result: CommandResult<K> }
  | { id: string; command: K; ok: false; error: EngineErrorPayload };
