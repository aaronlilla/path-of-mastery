import type { ActionId, RunId, RunSettingsSnapshot } from '@pom/mastery-contracts';
import type { RunCommand, RunView } from './types.js';
import type { WindowPreferences } from './window.js';
import type { RunLogCall, RunLogState } from './log.js';
import type { Monitor } from './window.js';
import type { RunServiceCall, RunServiceResult } from './services.js';

export type RunReply<T> = { ok: true; value: T } | { ok: false; code: 'FORBIDDEN' | 'INVALID' | 'UNAVAILABLE' | 'SAVE_FAILED' | 'RUN_REQUEST_FAILED' };
export type RunWindowMessage = RunView | null | { kind: 'windowPreferences'; preferences: WindowPreferences; rehomed: boolean };
export type RunBridge = {
  view(): Promise<RunReply<RunView | null>>;
  runAgain(runId: RunId): Promise<RunReply<RunView>>;
  command(command: RunCommand): Promise<RunReply<RunView>>;
  close(): Promise<RunReply<null>>;
  retry(): Promise<RunReply<RunView | null>>;
  exportRecovery(): Promise<RunReply<{ exported: boolean }>>;
  setCounting(enabled: boolean): Promise<RunReply<RunView | null>>;
  setChunks(characterChunks: RunSettingsSnapshot['characterChunks']): Promise<RunReply<RunView>>;
  windowSettings(): Promise<RunReply<WindowPreferences | null>>;
  saveWindowSettings(preferences: WindowPreferences): Promise<RunReply<WindowPreferences | null>>;
  configureHotkeys(next: string, back: string): Promise<RunReply<null>>;
  disableHotkeys(): Promise<RunReply<null>>;
  logState(): Promise<RunReply<RunLogState | null>>;
  logControl(control: RunLogCall): Promise<RunReply<RunLogState>>;
  openTimeline(): Promise<RunReply<null>>;
  openSource(actionId: ActionId): Promise<RunReply<null>>;
  /** Connected screens, for the Settings monitor list. */
  monitors(): Promise<RunReply<Monitor[]>>;
  /** Votes, private feedback, publish and the detected Client.txt, answered by the main process. */
  services(call: RunServiceCall): Promise<RunReply<RunServiceResult>>;
  subscribe(listener: (message: RunWindowMessage) => void): () => void;
};
