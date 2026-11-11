import type { BuildEdit, ItemInfo, StatDelta } from '@pom/protocol';
import { addShared, type SharedItems } from '../../shared/sharedItems.js';
import { formatDelta, formatStat, statMeta, statPriority } from '../../shared/assistant/statLabels.js';
import type { StashRow } from '../../shared/wealth.js';
import { primarySlot } from '../items/slots.js';
import { tr } from '../i18n';

/** What a stash item can be taken into a build as. The text is the item text the build file and the clipboard use. */
export interface CatalogUnique {
  name: string;
  base: string;
  text: string;
}

export interface StashItemText {
  text: string;
  /** True when the text is a complete item the engine can equip (a unique found in the item database). */
  gear: boolean;
}

/** The item database leaves the rarity line off a unique, as upstream does. */
const withRarity = (text: string): string => (/^\s*Rarity:/.test(text) ? text : tr('wealth_stashItem.rarity_unique_text', { text }));

/** Item text for a stash row: a unique's full text from the item database; anything else as plain lines (name, base, stack). */
export function stashItemText(row: Pick<StashRow, 'name' | 'base' | 'cat' | 'qty' | 'maxStack'>, uniques: CatalogUnique[]): StashItemText {
  if (row.cat === 'uniq') {
    const hit = uniques.find((u) => u.name.toLowerCase() === row.name.toLowerCase());
    if (hit) return { text: withRarity(hit.text), gear: true };
  }
  const lines = [`Rarity: ${row.cat === 'uniq' ? 'UNIQUE' : row.cat === 'cur' || row.cat === 'frag' || row.cat === 'scar' ? 'CURRENCY' : 'NORMAL'}`, row.name];
  if (row.base && row.base !== row.name) lines.push(row.base);
  if (row.maxStack > 1) lines.push(tr('wealth_stashItem.stack_size_tolocalestring_tolocalest', { qty: row.qty.toLocaleString('en-US'), maxStack: row.maxStack.toLocaleString('en-US') }));
  return { text: lines.join('\n'), gear: false };
}

/** The shared items list with this item added; the same text twice is not added again. */
export function addStashItemShared(list: SharedItems, text: string): { list: SharedItems; added: boolean } {
  const key = text.trim();
  if (list.items.some((t) => t.trim() === key)) return { list, added: false };
  return { list: addShared(list, text), added: true };
}

export interface StatRow {
  statId: string;
  label: string;
  before: string;
  after: string;
  change: string;
}

/** The stats a card shows: numbers that moved, the sidebar's stats first, at most `limit`. */
export function topDeltas(changed: StatDelta[], limit = 6): StatRow[] {
  return changed
    .filter((d): d is StatDelta & { before: number; after: number } => typeof d.before === 'number' && typeof d.after === 'number' && d.before !== d.after && !/^Gear:|String$|Display$/.test(d.statId))
    .sort((a, b) => statPriority(a.statId) - statPriority(b.statId))
    .slice(0, limit)
    .map((d) => ({ statId: d.statId, label: statMeta(d.statId).label, before: formatStat(d.statId, d.before), after: formatStat(d.statId, d.after), change: formatDelta(d.statId, d.before, d.after) }));
}

export interface TryResult {
  slot: string;
  edit: BuildEdit;
  rows: StatRow[];
}

type Send = (command: 'itemInfo' | 'previewEdit', params: Record<string, unknown>) => Promise<{ ok: true; result: unknown } | { ok: false; error: { message: string } }>;

/**
 * Puts the item in its slot on a scratch copy of the open build through the engine (the same `previewEdit` the Items tab and the
 * assistant's equip card use) and returns the before/after stats. The build is not changed; the edit comes back for the Equip button.
 */
export async function tryStashItem(send: Send, buildId: string, itemText: string): Promise<TryResult | { error: string }> {
  const info = await send('itemInfo', { buildId, itemText });
  if (!info.ok) return { error: info.error.message };
  const slot = primarySlot((info.result as { item: ItemInfo }).item);
  if (!slot) return { error: tr('wealth_stashItem.this_item_does_not_go') };
  const edit: BuildEdit = { kind: 'setItem', slot, itemText };
  const r = await send('previewEdit', { buildId, edit, full: true });
  if (!r.ok) return { error: r.error.message };
  const res = r.result as { statDiff: { changed: StatDelta[] }; blocked?: string };
  if (res.blocked) return { error: res.blocked };
  return { slot, edit, rows: topDeltas(res.statDiff.changed) };
}
