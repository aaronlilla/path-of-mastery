// Which art-index name stands for an item shown in Compare. A build's item text can carry a title the player typed
// ("Breathstealer +frenzy", "Replica Dragonfang's Flight - faster") or a magic item's affixes in its name line
// ("Perpetual Quicksilver Flask of Variegation"), so the plain name lookup misses and the row had no picture.

export interface ArtPick {
  name: string;
  category: 'uniques' | 'bases';
}

export interface PickItem {
  rarity: string;
  name: string;
  base: string;
}

/** `has(category, name)` says whether the art index holds that name; `baseNames` are all the base names it holds. */
export function pickItemArt(it: PickItem, has: (category: string, name: string) => boolean, baseNames: readonly string[]): ArtPick | undefined {
  const unique = it.rarity === 'UNIQUE' || it.rarity === 'RELIC';
  if (unique) {
    // The title as typed, then with a trailing " - note" or " +note" cut off, then shorter and shorter word prefixes.
    const cuts = [it.name, it.name.split(' - ')[0], it.name.split(' +')[0]];
    const words = it.name.split(' ');
    for (let n = words.length - 1; n >= 2; n--) cuts.push(words.slice(0, n).join(' '));
    for (const c of cuts) if (c && has('uniques', c)) return { name: c, category: 'uniques' };
  }
  if (it.base && has('bases', it.base)) return { name: it.base, category: 'bases' };
  // A magic item's name line is "<prefix> <base> of <suffix>": the longest base name found inside it.
  let best: string | undefined;
  for (const b of baseNames) if (it.name.includes(b) && (!best || b.length > best.length)) best = b;
  if (best) return { name: best, category: 'bases' };
  return undefined;
}
