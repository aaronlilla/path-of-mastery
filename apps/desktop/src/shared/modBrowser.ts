/**
 * Search for the Add Mod picker: `Modules/ConfigModBrowser.lua`'s `fuzzyScore` and `updateDisplayList`. The engine
 * lists the parser-supported mod lines already sorted (`sortAlphabeticallyIgnoringValues`); this ranks them for a search.
 */

export interface ModEntry {
  text: string;
  /** Where the line comes from ("Passive Node", "Item mod", ...), shown on hover. */
  sources: string[];
}

/** 1 = the whole search is inside the text, 2 = every word is, 3 = one word split across two adjacent words, undefined = no match. */
export function fuzzyScore(modText: string, searchStr: string, words: string[]): number | undefined {
  const lower = modText.toLowerCase();
  if (lower.includes(searchStr)) return 1;
  if (words.length > 1 && words.every((w) => lower.includes(w))) return 2;
  if (words.length === 1 && searchStr.length >= 3) {
    const textWords = lower.match(/[a-z0-9_]+/g) ?? [];
    for (let i = 0; i < textWords.length; i++) {
      const next = textWords[i + 1];
      if (next === undefined) continue;
      for (let len1 = 2; len1 <= searchStr.length - 1; len1++) {
        if (textWords[i]!.startsWith(searchStr.slice(0, len1)) && next.startsWith(searchStr.slice(len1))) return 3;
      }
    }
  }
  return undefined;
}

/** The sort key the engine's order uses: the template with numbers and symbols stripped (only to break ties between equal ranks). */
function sortKey(text: string): string {
  return text
    .replace(/([+-]?)\((-?\d+\.?\d*)-(-?\d+\.?\d*)\)/g, '$1#')
    .replace(/\d+\.?\d*/g, '#')
    .toLowerCase()
    .replace(/#/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

/** The mods a search shows: all of them (in the engine's order) for an empty search, else the ranked matches. */
export function filterMods(mods: ModEntry[], search: string): ModEntry[] {
  const s = search.toLowerCase().replace(/^\s+|\s+$/g, '');
  if (!s) return mods;
  const words = s.split(/\s+/).filter(Boolean);
  const ranked: { m: ModEntry; rank: number; key: string }[] = [];
  for (const m of mods) {
    const rank = fuzzyScore(m.text, s, words);
    if (rank !== undefined) ranked.push({ m, rank, key: sortKey(m.text) });
  }
  ranked.sort((a, b) => a.rank - b.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || (a.m.text < b.m.text ? -1 : a.m.text > b.m.text ? 1 : 0));
  return ranked.map((r) => r.m);
}

/** The group's text with `line` added on its own line (`blockData.text` plus "\n" when it does not end in one). */
export function appendModLine(text: string, line: string): string {
  return (text && !text.endsWith('\n') ? text + '\n' : text) + line;
}
