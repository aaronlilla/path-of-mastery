import type { Action, ActionId, BundleId, ClipId, Hash, LaneId, RunSettingsSnapshot, ScheduledBundle,
  StepId, Timeline, Trigger, ValidationLimits } from '@pom/mastery-contracts';

export type LevelInterval = {
  fromLevel: number; toLevel: number; elapsedSeconds: number; inactivitySeconds: number[]; reliable: boolean;
};
export type LevelWindow = { start: number; endExclusive: number };
export type AtlasWindow = { stepId: StepId; fromPoints: number; toPoints: number };
export type SchedulerChunk = {
  chunkId: string; laneId: LaneId; clipId: ClipId; actionIds: ActionId[];
} & ({ coordinate: 'level'; window: LevelWindow; coverage: LevelWindow }
  | { coordinate: 'atlasAllocated'; window: AtlasWindow; anchorId: string });
export type ActionGroup = ScheduledBundle & { chunkIds: string[]; laneOrder: number; authoredOrder: number };
export type Schedule = {
  schedulerVersion: string; actions: Action[]; chunks: SchedulerChunk[]; groups: ActionGroup[];
  excludedActionIds: ActionId[];
};
export type CompileOptions = {
  limits: ValidationLimits;
  characterChunks?: RunSettingsSnapshot['characterChunks'];
  pace?: readonly LevelInterval[];
  landmarks?: readonly number[];
  omittedClipIds?: readonly ClipId[];
  atlasChoices?: Readonly<Record<string, Readonly<Record<string, StepId>>>>;
  presentedChunks?: readonly SchedulerChunk[];
};
export type CompileInput = { timeline: Timeline; options: CompileOptions };

// Observations are already normalized and qualified by the telemetry owner.
export type TriggerObservation = {
  eventId: string; sequence: number; transitionId: string; contextEpoch: string; observedAt: string;
  trigger: Trigger; method: 'log' | 'manual' | 'seed'; reliable: boolean; continuous: boolean;
  selectedContext: boolean; sourceEvidenceId?: string;
};
export type ReviewedAction = { actionId: ActionId; contentHash: Hash };
export type Confirmation = {
  groupId: BundleId; sequence: number; transitionId: string; contextEpoch: string; coTrigger: boolean;
};
export type ConfirmationLedger = { seenEventIds: string[]; observations: TriggerObservation[]; confirmations: Confirmation[] };
export type DueBundle = ScheduledBundle & { groupIds: BundleId[]; triggers: Trigger[]; sequence: number; chunkIds: string[] };
