/**
 * Types shared by the main process, the preload bridge and the renderer for the build library,
 * build codes and app settings. Plain data only, so every side can import it.
 */

export interface BuildInfo {
  /** Class (Witch, Shadow, ...). Empty when the XML has none. */
  className: string;
  /** Ascendancy, or '' when the build has none yet. */
  ascendClassName: string;
  level: number;
  /** Name of the main skill gem, or '' when the build has no skills. */
  mainSkill: string;
  /** Passive tree version of the active spec, like "3_29", or ''. */
  treeVersion: string;
  /** False when the file isn't a build file. */
  valid: boolean;
  /** Headline DPS saved in the build file (PlayerStat FullDPS, else CombinedDPS); absent when the file has none. */
  dps?: number;
  /** Maximum life saved in the build file (PlayerStat Life); absent when the file has none. */
  life?: number;
  /** The league and game patch a followed league starter was made for (its first notes line), when it has one. */
  stamp?: { league: string; patch: string };
}

export interface BuildEntry {
  /** Path under the builds folder with forward slashes, like "League Starters/Cyclone.xml". */
  id: string;
  /** File name without .xml. */
  name: string;
  /** Folder path under the builds folder, '' for the top level. */
  folder: string;
  mtimeMs: number;
  size: number;
  info: BuildInfo;
}

export interface FolderEntry {
  path: string;
  name: string;
  /** Builds in this folder and everything under it. */
  count: number;
}

export interface LibraryListing {
  /** Absolute path of the builds folder. */
  root: string;
  folders: FolderEntry[];
  builds: BuildEntry[];
  /** Number of builds in Recently deleted. */
  trashCount: number;
}

export interface TrashEntry {
  token: string;
  name: string;
  folder: string;
  deletedAtMs: number;
  info: BuildInfo;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; code?: string };

export interface OpenedBuild {
  id: string;
  name: string;
  folder: string;
  xml: string;
  info: BuildInfo;
}

export type ImportSource = 'code' | 'pobb.in' | 'pob.codes' | 'poe.ninja' | 'pastebin' | 'pastebinp' | 'rentry' | 'maxroll' | 'poedb' | 'mobalytics' | 'file';

export interface DecodedImport {
  xml: string;
  source: ImportSource;
  /** Suggested build name. */
  name: string;
  info: BuildInfo;
}

export type NumberStyle = 'comma' | 'dot' | 'space' | 'none';
export type ThemeId = 'obsidian' | 'midnight' | 'verdigris' | 'nocturne' | 'saffron' | 'umber';
export type ModePref = 'light' | 'dark' | 'system';
/** App languages: English plus these; game names (items, skills, mods) stay English. */
export const LANGUAGE_CODES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'th'] as const;
export type LanguageCode = (typeof LANGUAGE_CODES)[number];
export type LanguageSetting = 'system' | LanguageCode;

export interface AppSettings {
  buildNameInTitle: boolean;
  betaBuilds: boolean;
  communityBuilds: boolean;
  language: LanguageSetting;
  density: 'comfortable' | 'compact';
  uiScale: 'system' | '90' | '100' | '110' | '125' | '150';
  animations: boolean;
  /** Backdrop stars: Full, Calm (game focus) or Off. Reduced motion and Animations off always show the static layer. */
  starfield: 'Full' | 'Calm' | 'Off';
  styledTooltips: boolean;
  nodePowerColours: 'red-blue' | 'red-green' | 'green-blue';
  positiveColour: string;
  negativeColour: string;
  highlightColour: string;
  offscreenMarkers: boolean;
  defaultLevel: number;
  defaultGemQuality: number;
  defaultAffixQuality: number;
  buildWarnings: boolean;
  thousandsSeparators: boolean;
  compactNumbers: boolean;
  thousandsSeparator: string;
  decimalSeparator: string;
  connectionProtocol: 'auto' | 'ipv4' | 'ipv6';
  proxyKind: 'http' | 'socks5';
  proxyHost: string;
  allAffixSliders: boolean;
  tooltipsAffectedSlotsOnly: boolean;
  copyEldritchImplicits: boolean;
  tooltipsUnsupportedMods: boolean;
  ignoreWheelOnControls: boolean;
  invertSliderScroll: boolean;
  /** UI preferences kept with the rest of the settings. */
  theme: ThemeId;
  mode: ModePref;
  glass: 'liquid' | 'clear' | 'frosted';
  texture: 'off' | 'subtle' | 'stone';
  libraryView: 'grid' | 'list';
  librarySort: 'edited' | 'name' | 'class' | 'level';
  /** The sidebar's stat sections in the order the player dragged them (empty = the default order). */
  statOrder: string[];
  /** The two headline stats pinned in the sidebar tiles ('' = the tile's default). */
  pinnedStats: string[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  buildNameInTitle: true,
  betaBuilds: false,
  communityBuilds: false,
  language: 'system',
  density: 'comfortable',
  uiScale: 'system',
  animations: true,
  starfield: 'Calm',
  styledTooltips: true,
  nodePowerColours: 'red-blue',
  positiveColour: '#33ff77',
  negativeColour: '#dd0022',
  highlightColour: '#3de2e2',
  offscreenMarkers: true,
  defaultLevel: 1,
  defaultGemQuality: 20,
  defaultAffixQuality: 50,
  buildWarnings: true,
  thousandsSeparators: true,
  compactNumbers: false,
  thousandsSeparator: ',',
  decimalSeparator: '.',
  connectionProtocol: 'auto',
  proxyKind: 'http',
  proxyHost: '',
  allAffixSliders: true,
  tooltipsAffectedSlotsOnly: false,
  copyEldritchImplicits: false,
  tooltipsUnsupportedMods: true,
  ignoreWheelOnControls: false,
  invertSliderScroll: false,
  theme: 'obsidian',
  mode: 'dark',
  glass: 'liquid',
  texture: 'subtle',
  libraryView: 'grid',
  librarySort: 'edited',
  statOrder: [],
  pinnedStats: [],
};

export interface EngineSummary {
  state: 'ready' | 'unavailable' | 'error' | 'starting';
  detail: string;
}

/** What "Check for updates" found: the layers whose version differs from the installed one (empty = up to date). */
export interface UpdateOffer {
  channel: 'stable' | 'beta';
  layers: { layer: 'app' | 'engine' | 'interface'; current: string; next: string; notes: string[] }[];
}

/** The builds folder the player chose cannot be used, so this run saves in the default folder. */
export interface BuildsDirProblem {
  path: string;
  reason: string;
}

export interface AppInfo {
  version: string;
  /** The engine and interface layers now running; a signed update changes them without a restart. Absent means unknown (About then shows "unknown", never another layer's number). */
  engineVersion?: string;
  interfaceVersion?: string;
  platform: string;
  userDataDir: string;
  buildsDir: string;
  /** The folder builds will be saved in after the next start (differs from buildsDir once the player picked another). */
  nextBuildsDir: string;
  /** Set when the chosen builds folder is unreadable or missing (the Change Settings Path dialog shows at startup). */
  buildsDirProblem?: BuildsDirProblem;
  engine: EngineSummary;
  maximized: boolean;
}

/** The stats the sidebar shows, with their labels. */
export const HEADLINE_STATS: { id: string; label: string }[] = [
  { id: 'FullDPS', label: 'Full DPS' },
  { id: 'TotalDPS', label: 'Hit DPS' },
  { id: 'Life', label: 'Life' },
  { id: 'EnergyShield', label: 'Energy Shield' },
  { id: 'TotalEHP', label: 'Effective HP' },
];

/** Stats the engine host returns after loading a build. Only what the shell shows today. */
export interface EngineBuildSummary {
  buildId: string;
  statCount: number;
  headline: { id: string; label: string; value: number }[];
}

/** Game data looked up by name (see main/gameData.ts). */
/** One spectre-capable minion as the Spectre Library's tooltip shows it (`MinionListControl:AddValueTooltip`). */
export interface SpectreInfo {
  name: string;
  life: number;
  energyShield?: number;
  armour?: number;
  evasion?: number;
  resist: { fire: number; cold: number; lightning: number; chaos: number };
  damage: number;
  attackTime: number;
  /** The names of its skills. */
  skills: string[];
}

export interface GameInfo {
  /** Gem name to its attribute colour ('' for a white gem) and whether it is a support. */
  gems: Record<string, { attr: 'str' | 'dex' | 'int' | ''; support: boolean }>;
}

/** One passive node: its name, type (Normal, Notable, Keystone, Mastery, ...) and ascendancy, if any. */
export interface TreeNodeInfo {
  n: string;
  t: string;
  a?: string;
  /** A hash of the node's mods, 0 when it has none: nodes with the same hash do the same thing. */
  k?: number;
  /** A jewel socket. */
  j?: 1;
  /** Its icon in the tree's skill sheet: x, y and size in pixels. */
  sp?: [number, number, number];
}
