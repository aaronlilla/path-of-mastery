// Player-facing text for atlas stats and tree data. Some export stats carry only their internal id as source text
// (e.g. "map_map_item_drop_chance_+%"); the node's game text is normally another line, so raw ids are hidden when a
// readable line exists and humanized only when they are all there is.

/** True for an internal stat id such as `map_additional_shrine_chance_%` or `map_X_additional_random_unallocated_notables`
 * (one word of letters, digits and _ % + . -, with an underscore; game text always has spaces). */
export function isRawStatId(text: string): boolean {
  return /^[A-Za-z0-9_%+.\-]+$/.test(text.trim()) && text.includes('_');
}

/** A readable fallback for a raw id: `map_map_item_drop_chance_+%` -> `Map item drop chance (%)`. */
export function humanizeStatId(id: string): string {
  const percent = /%/.test(id);
  const words = id.replace(/[+%]/g, ' ').split(/[_\s]+/).filter(Boolean)
    .filter((word, index, all) => index === 0 || word !== all[index - 1]); // map_map_ -> map
  const text = words.join(' ').replace(/\s+/g, ' ').trim();
  return (text.charAt(0).toUpperCase() + text.slice(1)) + (percent ? ' (%)' : '');
}

/** The game's link markup as the game shows it: `[ContainsAbyss|Abyss]` -> `Abyss`, `[Strength]` -> `Strength`. */
export function gameText(line: string): string {
  return line.replace(/\[([^\]|]*)\|([^\]]*)\]/g, '$2').replace(/\[([^\]|]+)\]/g, '$1');
}

/** Stat lines for display: game text only; humanized ids when no game text exists. */
export function readableLines(lines: readonly string[]): string[] {
  const text = lines.filter(line => !isRawStatId(line)).map(gameText);
  return text.length ? text : lines.map(humanizeStatId);
}

/** One label for a stat that may carry several source texts. */
export function statLabel(texts: readonly string[], fallbackId?: string): string {
  const text = texts.find(t => !isRawStatId(t));
  return text !== undefined ? gameText(text) : humanizeStatId(texts[0] ?? fallbackId ?? 'Unknown stat');
}

/** `atlas:<hash>:3.29.3.3` -> `Atlas tree 3.29.3.3` (with the variant when given). */
export function dataLabel(datasetId: string, variant?: string): string {
  const version = datasetId.split(':').at(-1) ?? datasetId;
  const name = /^\d+(\.\d+)+$/.test(version) ? `Atlas tree ${version}` : datasetId;
  return variant && variant !== 'base' ? `${name} (${variant})` : name;
}
