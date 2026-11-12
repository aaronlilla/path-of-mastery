import type { Action, EmbeddedDependency, Trigger } from './timeline.js';
import type { ActionId, BundleId, ClipId, Hash, Known, LeagueStamp, OptionId, PublishedRevisionRef, RevisionRef, RunId } from './stamp.js';

export type RunSettingsSnapshot = {
  schemaVersion: 1;
  stamp: LeagueStamp;
  characterChunks: { kind: 'auto' } | { kind: 'fixed'; size: 4 | 6 | 8 | 10 };
  atlasSplitPoints: 10;
  countRuns: boolean;
  globalNextBackEnabled: boolean;
};
export type ScheduledBundle = { bundleId: BundleId; trigger: Trigger; actionIds: ActionId[]; fingerprint: Hash };
export type RunSnapshot = {
  schemaVersion: 1;
  runId: RunId;
  stamp: LeagueStamp;
  timelineRevision: RevisionRef;
  publishedOrigin: PublishedRevisionRef | null;
  choices: { clipId: ClipId; optionId: OptionId }[];
  omittedClipIds: ClipId[];
  actions: Action[];
  bundles: ScheduledBundle[];
  dependencies: EmbeddedDependency[];
  schedulerVersion: string;
  settings: RunSettingsSnapshot;
};
export type AtlasCoverage = 'unknown' | 'manual_baseline_and_deltas' | 'complete_snapshot' | 'gap';
export type ObservedProgress = {
  characterLevel: Known<number>;
  zoneId: Known<string>;
  areaLevel: Known<number>;
  firstMap: Known<{ anchorId: string; observedAt: string; method: 'zone_evidence' | 'manual_declaration' }>;
  atlas: { allocatedCount: Known<number>; nodeIds: Known<string[]>; coverage: AtlasCoverage; available: Known<number>; unspent: Known<number>; earned: Known<number> };
  observedAt: string | null;
};
export type RunState = {
  schemaVersion: 1;
  runId: RunId;
  stamp: LeagueStamp;
  snapshotHash: Hash;
  guideCursor: { bundleId: BundleId | null; level: number };
  observedProgress: ObservedProgress;
  mode: 'manual' | 'auto' | 'paused';
  presentedBundleIds: BundleId[];
  reviewed: { actionId: ActionId; contentHash: Hash }[];
  skippedActionIds: ActionId[];
  outstandingActionIds: ActionId[];
  commandCursor: number;
  eventCursor: { generationId: string; byteOffset: number; eventId: string } | null;
  startedAt: string;
  endedAt: string | null;
  characterBinding?: string;
  logPath?: string;
};
export type FinishMethod = 'final_trigger_observed' | 'player_confirmed';
export type LocalFinishRecord = {
  schemaVersion: 1;
  runId: RunId;
  stamp: LeagueStamp;
  reviewedCount: number;
  skippedCount: number;
  outstandingCount: number;
  finishMethod: FinishMethod | null;
  endedAt: string;
};
export type CompletionReceipt = {
  schemaVersion: 1;
  stamp: LeagueStamp;
  publishedRevision: PublishedRevisionRef;
  method: FinishMethod;
  finalTrigger: Trigger;
  finalActionFingerprint: Hash;
  evidenceSummary: { kind: 'log_trigger_match' | 'player_confirmation'; observedAt: string };
  idempotencyKey: string;
};
