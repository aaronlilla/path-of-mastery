/**
 * Small shared types for the assistant panel. The panel draws only what the design's assistant panel shows: prose,
 * the "Used N tools" line, the change card with its numbered steps and stat table, and the applied receipt. The
 * old structured answer layouts (overview, compare, upgrades, craft, formula, boss, timeline, choices) are gone:
 * the model no longer writes them, and a thread saved with one shows its text without the fence.
 */

export type Rarity = 'normal' | 'magic' | 'rare' | 'unique' | 'gem' | 'currency';
export type StatKind = 'dps' | 'ehp' | 'life' | 'mana' | 'es' | 'armour' | 'evasion' | 'res' | 'chaos' | 'neutral';
export type TabName = 'tree' | 'skills' | 'items' | 'calcs' | 'config' | 'compare' | 'party' | 'notes';

export type BlockAction = { label: string; do: 'tab'; tab: TabName };

/** Replies saved by an older version may hold a ```pom layout fence; it is dropped, the prose around it stays. */
export function plainText(text: string): string {
  return text
    .replace(/```pom[\s\S]*?(?:```|$)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
