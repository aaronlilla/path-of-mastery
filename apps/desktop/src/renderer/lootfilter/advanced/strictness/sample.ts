import type { Catalog, CatalogItem } from '../../../../shared/lootfilter/catalog.js';

/**
 * A readable sample of real item types for the "Compare levels" grid. The mask says at which of the seven
 * strictness levels each item is hidden (bit 0 is Soft). Items are grouped by the first level that hides them, and
 * each group gives items from different types, the most valuable first when prices are known, so the grid shows
 * the whole range from "never hidden" to "hidden from Soft".
 */
export function sampleItems(catalog: Catalog, mask: Record<string, number>, price: (name: string) => number, perLevel = 1, limit = 10): CatalogItem[] {
  const buckets: CatalogItem[][] = [[], [], [], [], [], [], [], []];
  // Currency and cards, like the design: they are the loot every player knows by name, and what strictness cuts first.
  const known = catalog.items.filter((it) => it.type === 'currency' || it.type === 'divination' || it.type.startsWith('currency->'));
  for (const it of known.length >= limit ? known : catalog.items) {
    const m = mask[it.name];
    if (m === undefined) continue;
    let first = 7;
    for (let l = 0; l < 7; l++) {
      if ((m >> l) & 1) {
        first = l;
        break;
      }
    }
    buckets[first]!.push(it);
  }
  const out: CatalogItem[] = [];
  // Never hidden first, then hidden from the strictest level down to Soft.
  const order = [7, 6, 5, 4, 3, 2, 1, 0];
  for (const b of order) {
    const list = buckets[b]!.slice().sort((x, y) => price(y.name) - price(x.name) || x.name.localeCompare(y.name));
    const seen = new Set<string>();
    let n = 0;
    // Never hidden, and hidden from Regular on, get two rows: they show what stays and where the first cuts fall.
    const take = b === 7 || b === 1 ? perLevel + 1 : perLevel;
    for (const it of list) {
      if (seen.has(it.type)) continue;
      seen.add(it.type);
      out.push(it);
      if (++n >= take) break;
    }
  }
  return out.slice(0, limit);
}
