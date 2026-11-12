// The lines a build has to be over (accuracy above life for Precise Technique, an attribute requirement), read from the engine's
// raw stats. No imports: both thresholdRoute (which finds the nodes) and tools.ts (which reports the margin of the final build) use it.
export type Raw = Array<{ id: string; value: unknown }>;

export interface Threshold {
  /** Tree search words and the stat line a node must carry to count. */
  search: string;
  lines: RegExp;
  /** How far the stat is under the line in these raw engine stats; 0 or less when it is met. */
  short: (raw: Raw) => number;
  /** One line on how far over the line the result is and what undoes it, from the raw stats of the build as it will be. */
  margin?: (raw: Raw, before?: Raw) => string;
  /** A margin under this is thin: the route takes one more cheap node when it can. */
  cushion?: (raw: Raw) => number;
}

const val = (raw: Raw, id: string) => raw.find((s) => s.id === id)?.value;
const n = (v: unknown) => (typeof v === 'number' ? v : 0);
// the lower hand decides: Precise Technique needs accuracy over life in each hand a dual wielder swings with
const accuracyOf = (raw: Raw) => {
  const hand = (id: string) => (val(raw, id) as { Accuracy?: number } | null | undefined)?.Accuracy;
  const hands = [hand('MainHand'), hand('OffHand')].filter((a): a is number => typeof a === 'number');
  return Math.round(hands.length ? Math.min(...hands) : n(val(raw, 'Accuracy')));
};

/** Precise Technique and similar: Accuracy Rating (per hand, as the sidebar warns) above maximum Life. */
export const ACCURACY_OVER_LIFE: Threshold = {
  search: 'accuracy',
  lines: /accuracy rating/i,
  short: (raw) => Math.floor(n(val(raw, 'Life'))) + 1 - accuracyOf(raw),
  margin: (raw, before) => {
    const acc = accuracyOf(raw);
    const life = Math.floor(n(val(raw, 'Life')));
    return `Accuracy ${before ? `${accuracyOf(before).toLocaleString('en-US')} -> ` : ''}${acc.toLocaleString('en-US')} against life ${life.toLocaleString('en-US')}: gaining more than ~${Math.max(0, acc - life).toLocaleString('en-US')} life turns Precise Technique off`;
  },
  cushion: (raw) => Math.round(n(val(raw, 'Life')) * 0.1),
};

/** A gem or item needing more of one attribute (Str, Dex or Int) than the character has: the engine's own Req and attribute stats. */
export const attributeThreshold = (attr: 'Str' | 'Dex' | 'Int'): Threshold => {
  const word = { Str: 'strength', Dex: 'dexterity', Int: 'intelligence' }[attr];
  return {
    search: word,
    lines: new RegExp(`\\+\\d+ to (${word}|all attributes)`, 'i'),
    short: (raw) => n(val(raw, `Req${attr}`)) - n(val(raw, attr)),
    margin: (raw) => `${attr} ${n(val(raw, attr))} against the ${n(val(raw, `Req${attr}`))} needed`,
  };
};
