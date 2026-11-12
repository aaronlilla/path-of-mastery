/** Shared value/stat shapes returned by the engine host. */

export type StatScalar = number | string | boolean | null;

export interface StatValue {
  id: string;
  label: string;
  value: StatScalar;
  unit?: string;
}

/** One line of a stat's "why is this value what it is" breakdown. */
export interface BreakdownEntry {
  label: string;
  value: StatScalar;
  source?: string;
}

/** A single stat's before/after when a mutating command changes the build. */
export interface StatDelta {
  statId: string;
  label: string;
  before: StatScalar;
  after: StatScalar;
}

/** Emitted after every mutating command: the full set of stats that moved. */
export interface StatDiff {
  buildId: string;
  changed: StatDelta[];
}

export interface Tooltip {
  title: string;
  lines: string[];
}
