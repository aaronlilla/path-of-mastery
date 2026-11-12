/** The passive and ascendancy point readout: labels, remaining counts and the over-limit state, shared by the build header and the Tree tab. */

/**
 * Passive points the character has: level - 1, 23 from quests, plus extra (the bandit point, Grants N Passive Skill Points).
 * An auto level is worked out from the points spent, so it says nothing about the real level: then the level 100 total, as upstream shows.
 */
export const passiveMax = (extra: number, level: number | null): number => (level ? Math.min(100, Math.max(1, level)) - 1 : 99) + 23 + extra;

/** A tree card's button and receipt text: points taken and refunded together are moved, not counted twice. */
export function treeCardLabel(added: number, removed: number): { apply: string; applied: string; undid: string } {
  const pts = (n: number) => `${n} passive ${n === 1 ? 'point' : 'points'}`;
  if (added && removed && added === removed) return { apply: `Move ${pts(added)}`, applied: `Moved ${pts(added)}`, undid: `Undid moving ${pts(added)}` };
  if (added && removed) return { apply: `Take ${pts(added)}, refund ${removed}`, applied: `Took ${pts(added)}, refunded ${removed}`, undid: `Undid taking ${pts(added)}, refunding ${removed}` };
  if (removed) return { apply: `Refund ${pts(removed)}`, applied: `Refunded ${pts(removed)}`, undid: `Undid refunding ${pts(removed)}` };
  return { apply: `Apply ${pts(added)}`, applied: `Applied ${pts(added)}`, undid: `Undid ${pts(added)}` };
}

export interface PointsCount { used: number; usedMax: number; asc: number; ascMax: number }

export interface PointsReadout {
  passiveLabel: string;
  passiveLeft: string;
  ascLabel: string;
  ascLeft: string;
  passiveOver: boolean;
  ascOver: boolean;
  /** Fill fractions 0..1 for the two bars. */
  passiveFill: number;
  ascFill: number;
}

const frac = (n: number, max: number): number => (max > 0 ? Math.min(1, Math.max(0, n / max)) : 0);
const left = (n: number, max: number): string => (n > max ? `${n - max} over` : `${max - n} left`);

export function pointsReadout(c: PointsCount | null): PointsReadout {
  if (!c) return { passiveLabel: '– / –', passiveLeft: '', ascLabel: '– / –', ascLeft: '', passiveOver: false, ascOver: false, passiveFill: 0, ascFill: 0 };
  return {
    passiveLabel: `${c.used} / ${c.usedMax}`,
    passiveLeft: left(c.used, c.usedMax),
    ascLabel: `${c.asc} / ${c.ascMax}`,
    ascLeft: left(c.asc, c.ascMax),
    passiveOver: c.used > c.usedMax,
    ascOver: c.asc > c.ascMax,
    passiveFill: frac(c.used, c.usedMax),
    ascFill: frac(c.asc, c.ascMax),
  };
}
