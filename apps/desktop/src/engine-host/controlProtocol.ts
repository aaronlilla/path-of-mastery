import type { OpenBuildState } from '@pom/protocol';

/**
 * Messages exchanged between main and an engine host process for lifecycle
 * purposes (hot-swap, health checks) - never seen by the renderer,
 * and orthogonal to the EngineRequest/EngineResponse command surface.
 */
export type HostControlMessage =
  | { kind: 'control'; type: 'loadBuildState'; state: OpenBuildState }
  | { kind: 'control'; type: 'recalculate' }
  | { kind: 'control'; type: 'ping' };

export type HostControlResponse =
  | { type: 'loadBuildStateAck'; ok: true }
  | { type: 'loadBuildStateAck'; ok: false; error: string }
  | { type: 'recalculateResult'; ok: true }
  | { type: 'recalculateResult'; ok: false; error: string }
  | { type: 'pong' };
