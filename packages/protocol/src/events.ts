import type { StatDiff } from './stats.js';

export type EngineStatus =
  | { state: 'starting' }
  | { state: 'ready'; engineVersion: string }
  | { state: 'unavailable'; reason: string }
  | { state: 'error'; message: string };

/**
 * Unsolicited messages the engine host (or the main-process update
 * machinery standing in for it) can push at any time, independent of the
 * request/response pairs in commands.ts.
 */
export type EngineEvent =
  | { type: 'statDiff'; statDiff: StatDiff }
  | { type: 'status'; status: EngineStatus }
  | { type: 'updateFailed'; layer: 'engine' | 'interface' | 'app'; message: string; stillOnVersion: string };
