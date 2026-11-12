import type { ActionId, BundleId, CompletionReceipt, FinishMethod, Hash, LocalFinishRecord, RunId, RunSnapshot, RunState, ScheduledBundle, TimelineBundle } from '@pom/mastery-contracts';
import type { ConfirmationLedger, Schedule } from '../timelines/scheduler/index.js';

export type RunCommand = { commandId: string } & (
  | { kind: 'next'; bundleId: BundleId; presentationVersion: number; repeat?: boolean }
  | { kind: 'back' | 'manual' | 'follow' | 'pause' | 'resumePresentation' | 'openDetails' | 'closeDetails' | 'finish' | 'confirmFinished' }
  | { kind: 'jump'; bundleId: BundleId }
  | { kind: 'catchUp'; choice: 'review' | 'keep' | 'catch_up' }
  | { kind: 'review'; actionIds: ActionId[] }
  | { kind: 'skip'; actionIds: ActionId[] }
  | { kind: 'pointerDown'; gestureId: string; x: number; y: number; button: 'next' | 'back'; surface: 'instruction' | 'chrome' }
  | { kind: 'pointerUp'; gestureId: string; x: number; y: number; dragged: boolean }
  | { kind: 'cancelPointer' }
);
export type Gesture = { gestureId: string; x: number; y: number; button: 'next' | 'back'; bundleId: BundleId; presentationVersion: number };
export type CatchUp = { target: ScheduledBundle; passedChunkIds: string[]; missedActionIds: ActionId[] };
export type RunSession = {
  snapshot: RunSnapshot;
  schedule: Schedule;
  state: RunState;
  displayed: ScheduledBundle;
  presentationVersion: number;
  history: ScheduledBundle[];
  historyIndex: number;
  ledger: ConfirmationLedger;
  commands: { commandId: string; hash: Hash }[];
  lastNextAt: number | null;
  modeBeforePause?: 'auto' | 'manual';
  gesture: Gesture | null;
  detailsOpen: boolean;
  catchUp: CatchUp | null;
  finish: LocalFinishRecord | null;
  retainedHashes: Hash[];
  sourceBundle: TimelineBundle;
  autoReceiptConsumed: boolean;
  receiptMethod: FinishMethod | null;
};
/** The only observation data that leaves this PC with an automatic receipt: the final trigger and when it was seen. */
export type ReceiptEvidence = { origin: 'live'; context: 'continuous'; observations: { trigger: CompletionReceipt['finalTrigger']; observedAt: string }[] };
export type ReceiptEntry = { accountId: string; receipt: CompletionReceipt; evidence?: ReceiptEvidence };
export type RunCheckpoint = {
  schemaVersion: 1;
  activeRunId: RunId | null;
  sessions: RunSession[];
  countRuns: boolean;
  outbox: ReceiptEntry[];
  sent: { accountId: string; idempotencyKey: string }[];
};
export type RunView = Pick<RunSession, 'snapshot' | 'state' | 'displayed' | 'presentationVersion' | 'detailsOpen' | 'catchUp' | 'finish' | 'receiptMethod'> & {
  pendingCriticalActionIds: ActionId[];
  countRuns: boolean;
  /** Timeline title (from the frozen bundle). */
  title: string;
  /** One row per scheduled chunk, in order; `label` is the first instruction of the chunk. */
  chunks: { bundleId: string; label: string }[];
};
