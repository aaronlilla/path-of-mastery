import type { AssetRef, AtlasPlan, Instructions } from './atlas.js';
import type { ActionId, BundleId, ClipId, Hash, Known, LaneId, LeagueStamp, OptionId, RevisionRef, SourceCredit, StepId } from './stamp.js';

export type Trigger =
  | { kind: 'level'; level: number }
  | { kind: 'areaLevel'; areaId?: string; level: number }
  | { kind: 'zone'; zoneId: string }
  | { kind: 'quest'; questId: string; evidenceRequired: string }
  | { kind: 'firstMap'; anchorId: string }
  | { kind: 'atlasAllocated'; stepId: StepId; points: number }
  | { kind: 'manual'; sequenceId: string; ordinal: number };
export type Requirement =
  | { kind: 'level'; minimum: number; provenance: string }
  | { kind: 'quest'; questId: string; evidenceRequired: string }
  | { kind: 'areaLevel'; minimum: number; provenance: string }
  | { kind: 'atlasAllocated'; minimum: number; provenance: string };
export type LaneType = 'build' | 'atlas' | 'filter' | 'notes' | 'checklist';
export type Action = {
  schemaVersion: 1;
  actionId: ActionId;
  contentHash: Hash;
  sourceRevision: RevisionRef;
  laneId: LaneId;
  clipId: ClipId;
  optionId: OptionId;
  trigger: Trigger;
  requirements: Requirement[];
  critical: boolean;
  instruction: Instructions;
  stamp: LeagueStamp;
};
export type BuildSnapshot = {
  schemaVersion: 1;
  title: string;
  stamp: LeagueStamp;
  treeNodes: string[];
  skills: { skillId: string; name: string; level: Known<number>; asset: AssetRef | null }[];
  gear: { slotId: string; itemId: string; name: string; modifiers: string[]; asset: AssetRef | null }[];
  configuration: { settingId: string; value: string | number | boolean }[];
  guide: { actionId: ActionId; contentHash: Hash; trigger: Trigger; requirements: Requirement[]; instruction: Instructions }[];
  calculatedStats: Known<{ engineVersion: string; sourceHash: Hash; assumptions: string[]; values: { statId: string; value: number; unit: string }[] }>;
  notes?: string;
  /** The upstream export code of the build (zlib-deflated XML, URL-safe base64), so a copy is the exact build. */
  buildCode?: string;
  /** Class and ascendancy read from the build itself (never typed by the creator). */
  className?: string;
  ascendancy?: string;
};
export type LocalBuildSource = {
  schemaVersion: 1;
  stamp: LeagueStamp;
  buildXml: string;
  guide: BuildSnapshot['guide'];
  settings: { stamp: LeagueStamp; configuration: BuildSnapshot['configuration'] };
  dataReferences: RevisionRef[];
  publicSnapshot: BuildSnapshot;
};
export type FilterSnapshot = {
  schemaVersion: 1;
  title: string;
  stamp: LeagueStamp;
  stages: { stageId: string; areaLevel: { start: number; endExclusive: number }; rules: string[]; instruction: Instructions }[];
  capabilities: { exportFile: boolean; installFile: boolean; automaticSelection: boolean };
  notes?: string;
};
export type TextSnapshot = { schemaVersion: 1; title: string; stamp: LeagueStamp; instructions: Instructions[]; notes?: string };
export type SourceSnapshot =
  | { kind: 'build'; payload: BuildSnapshot }
  | { kind: 'atlas'; payload: AtlasPlan }
  | { kind: 'filter'; payload: FilterSnapshot }
  | { kind: 'notes'; payload: TextSnapshot }
  | { kind: 'checklist'; payload: TextSnapshot };
export type FrozenSource = { ref: RevisionRef; fallbackSnapshot: SourceSnapshot };
export type ChunkOverride = { kind: 'auto' } | { kind: 'levels'; size: 4 | 6 | 8 | 10 }
  | { kind: 'atlas'; mode: 'per_step'; splitAtAllocatedPoints: 10 };
export type ClipOption = { optionId: OptionId; title: string; source: FrozenSource; actions: Action[] };
export type Clip = {
  clipId: ClipId;
  laneId: LaneId;
  range: { start: number; endExclusive: number };
  options: ClipOption[];
  selectedOptionId: OptionId | null;
  instructionOverrides: { actionId: ActionId; instruction: Instructions }[];
  timingMode: 'keep_instruction_timing' | 'scale_timing';
  chunkOverride: ChunkOverride;
  excludedActionIds: ActionId[];
  /** Optional Atlas point sub-range, half-open `[start, endExclusive)` in allocated Atlas points (not character levels).
   * Only valid on a clip in an `atlas` lane. Absent = the whole pinned source span. Added in contracts 0.2.0. */
  atlasPointRange?: { start: number; endExclusive: number };
  /** Explicit "Enabled in Run" off: Run schedules nothing from this clip. Absent = enabled. Never inferred from
   * excludedActionIds (which hold only coverage and the author's per-step exclusions). */
  disabled?: boolean;
  /** Actions the author kept ("Keep mine") after the creator removed them. They stay as they are while the creator's source
   * lacks them; a later revision that restores one is a conflict wherever the author's value differs. Absent = none. */
  keptActionIds?: ActionId[];
};
export type Lane = { laneId: LaneId; type: LaneType; title: string; order: number; muted: boolean; clipIds: ClipId[] };
export type Timeline = {
  schemaVersion: 1;
  title: string;
  stamp: LeagueStamp;
  lanes: Lane[];
  clips: Clip[];
  firstMapAnchor: { anchorId: string; evidence: Known<{ kind: 'zone'; zoneId: string } | { kind: 'manual' }> } | null;
  editorMetadata: { previewLevel: number; snap: boolean; showChunks: boolean };
  credits: SourceCredit[];
  notes?: string;
};
export type EmbeddedDependency = { ref: RevisionRef; snapshot: SourceSnapshot; dependsOn: RevisionRef[] };
export type TimelineBundle = {
  schemaVersion: 1;
  bundleId: BundleId;
  timeline: Timeline;
  dependencies: EmbeddedDependency[];
  assets: AssetRef[];
  schedulerVersion: string;
  actionSchemaVersion: 1;
  choices: { clipId: ClipId; optionId: OptionId }[];
  credits: SourceCredit[];
};
