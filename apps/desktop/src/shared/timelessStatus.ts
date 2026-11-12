// What the timeless jewel installer (src/main/timelessData.ts) tells the window.
export type TimelessInstallState = 'ready' | 'idle' | 'inflating' | 'error';

export interface TimelessInstallStatus {
  state: TimelessInstallState;
  /** Tables of the package inflated so far, and in all. */
  done: number;
  total: number;
  /** The table being inflated, and the share of all the bytes that are done (0 to 100). */
  current: string | null;
  percent: number;
  error?: string;
  /** Where the engine reads the tables from. */
  dir: string;
  /** Tables the package does not hold (they come as a download). */
  notBundled: string[];
}
