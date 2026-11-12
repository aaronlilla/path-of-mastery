/** The arithmetic of a crafted item's affix rows: which tier a group's slider position stands for, and where a tier's roll sits on the track. */

/** `pickModifierFromList`: the middle tier of a group, at the default roll of 0.5. */
export function middleTier(n: number): number {
  return n <= 1 ? 0 : Math.floor((n - 1) * 0.5 + 0.5);
}

/** Where the slider sits for a tiered group: the tier is a segment of the track and the roll the position inside it. */
export function sliderPosition(index: number, count: number, range: number): number {
  return (index + Math.max(0, Math.min(1, range))) / count;
}

/** The tier and the roll the slider's position stands for. */
export function sliderTier(v: number, count: number): { index: number; range: number } {
  const at = Math.max(0, Math.min(1, v)) * count;
  const index = Math.min(count - 1, Math.floor(at));
  return { index, range: Math.max(0, Math.min(1, at - index)) };
}

/**
 * The rolled text of each chosen affix: the item shows its prefix (or suffix) lines in row order and a hybrid affix
 * takes several lines, so `counts[i]` lines (0 for an empty row) belong to row i. Rows with no lines get ''.
 */
export function rolledByRow(texts: string[], counts: number[]): string[] {
  let at = 0;
  return counts.map((n) => {
    const out = texts.slice(at, at + n).join(' / ');
    at += n;
    return out;
  });
}

/** Whether every modifier gets its own roll slider: the setting is on and the item is a Unique (upstream stacks them for no other rarity). */
export function stacksSliders(setting: boolean, rarity: string | undefined): boolean {
  return setting && rarity === 'UNIQUE';
}
