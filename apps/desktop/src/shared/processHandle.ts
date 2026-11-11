/**
 * Minimal process-control surface the engine connection and the update
 * system's hot-swap logic depend on. Electron's `utilityProcess` and Node's
 * `child_process.fork` both satisfy this after a thin adapter (see
 * main/engineProcessAdapter.ts), which is what lets the hot-swap state
 * machine be unit-tested with plain `child_process.fork`-ed fixtures
 * instead of a real Electron utility process.
 */
export interface ProcessHandle {
  postMessage(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  onExit(handler: (code: number | null) => void): void;
  kill(): void;
}

export type ProcessFactory = (options: { modulePath: string; env?: Record<string, string> }) => ProcessHandle;
