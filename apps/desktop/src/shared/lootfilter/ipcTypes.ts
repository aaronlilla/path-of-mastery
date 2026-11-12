import type { FilterDoc, FilterSetup, GuidedMeta, Rule } from './types.js';
import type { BaseInfo } from './bases.js';

/** Shapes that cross the IPC boundary for the loot filter. Plain data only. */

export interface LootFilterSettings {
  /** Folder the game reads filters from. Empty means the default under Documents. */
  gameFolder: string;
  /** How many backups of the previous file to keep. */
  backups: number;
  /** Write after every change. */
  autoWrite: boolean;
  league: string;
  /** NeverSink version to build on. Empty means the newest installed. */
  baseVersion: string;
  /** Last NeverSink version the player dismissed in the update banner. */
  dismissedVersion: string;
  priceRefreshMinutes: number;
  currencyUnit: 'Chaos' | 'Divine';
  showPrices: boolean;
  confirmValuable: boolean;
  soundPreview: boolean;
  reduceMotion: boolean;
  quickSetup: boolean;
  startWith: 'Last filter' | 'My Filters';
  checkNeverSink: boolean;
  /** Path to the game's Client.txt, or empty to look in the usual folders. */
  clientLogPath: string;
}

export const DEFAULT_SETTINGS: LootFilterSettings = {
  gameFolder: '',
  backups: 5,
  autoWrite: false,
  league: '',
  baseVersion: '',
  dismissedVersion: '',
  priceRefreshMinutes: 15,
  currencyUnit: 'Chaos',
  showPrices: true,
  confirmValuable: true,
  soundPreview: true,
  reduceMotion: false,
  quickSetup: true,
  startWith: 'Last filter',
  checkNeverSink: true,
  clientLogPath: '',
};

export interface LootFilterState {
  version: 1;
  activeId: string;
  filters: FilterDoc[];
  settings: LootFilterSettings;
  /** Guided state that is not rules: dismissed cards and the like. */
  ui: Record<string, unknown>;
}

export interface BaseVersionInfo {
  version: string;
  source: 'bundled' | 'downloaded';
  /** True when the licence text sits beside the files. */
  licence: boolean;
}

export interface BaseFiles {
  version: string;
  /** Files by strictness id, like `2-SEMI-STRICT`. */
  files: Record<string, string>;
  licence: string;
}

export interface ReleaseInfo {
  tag: string;
  name: string;
  publishedAt: string;
  htmlUrl: string;
  zipUrl: string;
  /** Release notes, trimmed. */
  body: string;
}

export interface UpdateCheck {
  checkedAt: number;
  installed: BaseVersionInfo[];
  /** The latest GitHub release, or null if the check failed. */
  latest: ReleaseInfo | null;
  error?: string;
  /** True when `latest.tag` is not installed. */
  newer: boolean;
}

export type TargetState =
  | { state: 'folder-missing'; folder: string }
  | { state: 'none'; path: string }
  /** Our file, unchanged since we wrote it. */
  | { state: 'ours'; path: string; hash: string; header: string }
  /** Our file, but the text no longer matches what we wrote. */
  | { state: 'changed'; path: string; hash: string }
  /** A file with this name that is not ours. */
  | { state: 'foreign'; path: string; hash: string };

export type WriteOutcome =
  | { kind: 'written'; path: string; bytes: number; hash: string; backupPath?: string; folder: string }
  | { kind: 'needs-confirm'; why: 'foreign' | 'changed'; path: string; folder: string }
  | { kind: 'error'; code: 'folder-missing' | 'permission' | 'disk-full' | 'invalid' | 'unknown'; message: string; path: string; folder: string };

export interface WriteRequest {
  folder: string;
  fileName: string;
  fileText: string;
  /** Hash of the text we last wrote to this path, from the filter's record. */
  lastHash?: string;
  /** Set after the player agreed to overwrite a file that is not ours or was changed. */
  overwrite?: 'foreign' | 'changed';
}

export interface PriceEntry {
  chaos: number;
  category: string;
}

export interface PriceTable {
  league: string;
  fetchedAt: number;
  source: 'poe.ninja';
  /** Chaos per divine. */
  divine: number;
  byName: Record<string, PriceEntry>;
  /** Highest unique price per base type (like Heavy Belt), since filters match uniques by base. */
  uniqueByBase: Record<string, number>;
  /** The unique that sets that price, per base type (older cached tables do not have it). */
  uniqueByBaseName?: Record<string, string>;
  /** Categories that could not be fetched. */
  failed: string[];
}

export interface PriceResult {
  table: PriceTable | null;
  error?: string;
  /** True when the table is older than the refresh interval and a refresh failed. */
  stale?: boolean;
}

export interface HiddenCounts {
  version: string;
  total: number;
  /** Item types hidden at each of the seven strictness levels. */
  hidden: number[];
  /** Item name -> bitmask of strictness levels where it is hidden (bit 0 Soft). */
  mask: Record<string, number>;
}

export interface EngineBases {
  available: boolean;
  bases: BaseInfo[];
  note?: string;
}

export interface AreaVisit {
  /** When the game generated the area (local time, ms). */
  at: number;
  /** The game's area id, like MapWorldsStrand. */
  id: string;
  /** The name shown in game, like Strand. */
  name: string;
  /** Area level. */
  level: number;
}

export interface ClientLogInfo {
  found: boolean;
  path: string;
  /** Oldest first. Only areas the game generated; Client.txt records no drops or pickups. */
  areas: AreaVisit[];
  modifiedAt?: number;
  note?: string;
}

export interface FilePick {
  path: string;
  name: string;
  text: string;
}

export interface LfProposalChange {
  /** The change in plain words. */
  sentence: string;
  /** Item types it touches in NeverSink's lists. */
  itemCount: number;
  sample: string[];
  /** Left out for a change that only moves a setting (the Build Filter's overrides or leveling skill). */
  guided?: GuidedMeta;
  /** The rule it would add (id and priority are set when the player applies it). Left out for a setting change. */
  rule?: Rule;
  /** Settings Apply changes along with the rule. */
  setup?: Partial<FilterSetup>;
  /** The group it belongs to in the review, like "Leveling gear after act 10". Without one the action names the group. */
  section?: string;
  /** Why it is proposed, in one line. */
  reason?: string;
}

/** Rule changes the assistant proposed. They change nothing until the player applies them. */
export interface LfProposal {
  id: string;
  filterId: string;
  title: string;
  summary?: string;
  changes: LfProposalChange[];
  status: 'pending' | 'applied' | 'dismissed';
  createdAt: number;
}


/** One leveling skill the picker offers: what it is, when the class can first get it, how well it fits, and why. */
export interface LevelingCandidateRow {
  gemId: string;
  name: string;
  availLevel: number;
  score: number;
  reason: string;
}
