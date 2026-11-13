import type { KeptLadder } from './types.js';

/**
 * Where the ask sits against real characters of a kept build's gem: one entry per target (EHP, DPS) whose ask is above the best
 * character of the sample, so the kept row can say plainly that nobody in the sample got there. Nothing for a target the sample reaches
 * or has no numbers for (no number is made up).
 */
export function keptGaps(e: KeptLadder | undefined, targets: ReadonlyArray<{ name: string; metric: string; target: number | null }>) {
  if (!e) return [];
  return targets.flatMap((t) => {
    const m = t.metric === 'ehp' ? e.ehp : t.metric === 'dps' || t.metric === 'bossdps' ? e.dps : undefined;
    return m && t.target !== null && t.target > m.best ? [{ name: t.name, asked: t.target, count: e.count, median: m.median, best: m.best }] : [];
  });
}
