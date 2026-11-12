import type { SyncState } from '../../shared/accounts.js';

/**
 * The sync's state, as a pure function of events. The engine feeds it what happened; the title bar's pill, the
 * Library's badges and the retry timer all read from it.
 *
 *   idle  -> running  a pass started
 *   running -> idle   it finished (conflicts and waiting changes are counted, not blocking)
 *   running -> offline the cloud could not be reached; retry after a growing delay
 *   running -> error  something else went wrong (the message is kept); retried like offline
 *   any -> signedOut  the account ended
 */
export type Phase = 'signedOut' | 'idle' | 'running' | 'offline' | 'error';

export interface MachineState {
  phase: Phase;
  /** Builds whose cloud and local copies both changed. */
  conflicts: number;
  /** Local changes not yet in the cloud. */
  pending: number;
  /** Failed passes in a row. */
  failures: number;
  lastOkAt: number | null;
  error: string | null;
  /** When the next retry runs, or null. */
  retryAt: number | null;
}

export type SyncEvent =
  | { t: 'signedIn' }
  | { t: 'signedOut' }
  | { t: 'start' }
  | { t: 'ok'; at: number; pending: number; conflicts: number }
  | { t: 'network'; at: number; pending: number }
  | { t: 'fail'; at: number; pending: number; error: string }
  /** The scan found a different number of waiting changes or conflicts without a full pass. */
  | { t: 'scanned'; pending: number; conflicts: number };

export const INITIAL: MachineState = { phase: 'signedOut', conflicts: 0, pending: 0, failures: 0, lastOkAt: null, error: null, retryAt: null };

/** Seconds between retries: 5, 15, 30, 60, 120, then every 5 minutes. */
const BACKOFF_S = [5, 15, 30, 60, 120, 300];
export function backoffMs(failures: number): number {
  return BACKOFF_S[Math.min(Math.max(failures, 1), BACKOFF_S.length) - 1]! * 1000;
}

export function reduce(s: MachineState, e: SyncEvent): MachineState {
  switch (e.t) {
    case 'signedIn':
      return { ...INITIAL, phase: 'idle' };
    case 'signedOut':
      return { ...INITIAL };
    case 'start':
      return s.phase === 'signedOut' ? s : { ...s, phase: 'running', retryAt: null };
    case 'ok':
      return { ...s, phase: 'idle', pending: e.pending, conflicts: e.conflicts, failures: 0, lastOkAt: e.at, error: null, retryAt: null };
    case 'network': {
      const failures = s.failures + 1;
      return { ...s, phase: 'offline', pending: e.pending, failures, error: null, retryAt: e.at + backoffMs(failures) };
    }
    case 'fail': {
      const failures = s.failures + 1;
      return { ...s, phase: 'error', pending: e.pending, failures, error: e.error, retryAt: e.at + backoffMs(failures) };
    }
    case 'scanned':
      return s.phase === 'signedOut' ? s : { ...s, pending: e.pending, conflicts: e.conflicts };
  }
}

/** What the pill shows. A conflict outranks the rest because it needs the player. */
export function displayState(s: MachineState): SyncState {
  if (s.phase === 'signedOut') return 'local';
  if (s.phase === 'offline') return 'offline';
  if (s.phase === 'error') return 'error';
  if (s.conflicts > 0 && s.phase !== 'running') return 'conflict';
  if (s.phase === 'running' || s.pending > 0) return 'syncing';
  return 'synced';
}
