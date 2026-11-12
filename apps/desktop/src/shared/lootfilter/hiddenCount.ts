import type { Block } from './types.js';
import type { BaseInfo } from './bases.js';
import { parseBlocks } from './blocks.js';
import { buildCatalog } from './catalog.js';
import { evaluateItem, type ItemProps } from './evaluate.js';
import type { HiddenCounts } from './ipcTypes.js';

/**
 * How much each strictness file really hides. An item type counts as hidden when the file hides a single drop of it
 * (a stackable alone, so stack-size rules count), and a gear base when it hides a Normal, a Magic and a Rare drop at item
 * level 75, all in a map at area level 83. So a rule that hides by stack size, rarity, class or item level counts, not only a list of base names.
 * Gear comes from the engine's base table, because NeverSink's tier lists name only a few hundred bases.
 */

const GEAR_ITEM_LEVEL = 75;
const AREA_LEVEL = 83;

const props = (o: Partial<ItemProps> & { name: string }): ItemProps => ({ itemLevel: 80, areaLevel: AREA_LEVEL, stackSize: 1, quality: 0, identified: true, corrupted: false, mirrored: false, linkedSockets: 0, sockets: '', ...o });

export async function hiddenInFile(blocks: Block[], bases: BaseInfo[], tick: () => Promise<void> = async () => undefined): Promise<{ hiddenNames: Set<string>; names: string[] }> {
  const cat = buildCatalog(blocks);
  const hiddenNames = new Set<string>();
  const all: string[] = [];
  let n = 0;
  for (const it of cat.items) {
    if (++n % 120 === 0) await tick();
    all.push(it.name);
    const base = { name: it.name, ...(it.class ? { class: it.class } : {}), ...(it.rarity ? { rarity: it.rarity } : {}) };
    if (!evaluateItem(blocks, props({ ...base, stackSize: 1 })).visible) hiddenNames.add(it.name);
  }
  const have = new Set(all);
  for (const b of bases) {
    if (++n % 120 === 0) await tick();
    if (have.has(b.name)) continue;
    have.add(b.name);
    all.push(b.name);
    const hid = (['Normal', 'Magic', 'Rare'] as const).every((rarity) => !evaluateItem(blocks, props({ name: b.name, class: b.class, rarity, itemLevel: GEAR_ITEM_LEVEL })).visible);
    if (hid) hiddenNames.add(b.name);
  }
  return { hiddenNames, names: all };
}

/** Counts for the seven files, given their text in strictness order. `tick` lets the caller give other work a turn between files. */
export async function countHidden(version: string, texts: string[], bases: BaseInfo[], tick: () => Promise<void> = async () => undefined): Promise<HiddenCounts> {
  const mask: Record<string, number> = {};
  const hidden: number[] = [];
  const universe = new Set<string>();
  for (let i = 0; i < texts.length; i++) {
    const { hiddenNames, names } = await hiddenInFile(parseBlocks(texts[i]!).blocks, bases, tick);
    for (const n of names) {
      universe.add(n);
      mask[n] = (mask[n] ?? 0) | (hiddenNames.has(n) ? 1 << i : 0);
    }
    hidden.push(hiddenNames.size);
    await tick();
  }
  return { version, total: universe.size, hidden, mask };
}
