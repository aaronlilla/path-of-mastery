import type { Catalog } from '../../../shared/lootfilter/catalog.js';
import { sectionOfType } from '../../../shared/lootfilter/sections.js';
import type { Rule } from '../../../shared/lootfilter/types.js';
import { tr } from '../../i18n';

const CURRENCY = new Set(['currency', 'othercur', 'stacked', 'shards', 'fossils', 'essences', 'oils', 'catalysts', 'delirium', 'tattoos', 'omens', 'cards', 'lcur', 'scarabs', 'fragments', 'gold']);
const MAPS = new Set(['maps', 'minf', 'valdo']);
const GEMS = new Set(['gems', 'gq']);

const ofSection = (id: string): 'currency' | 'maps' | 'gems' | 'gear' => (CURRENCY.has(id) ? 'currency' : MAPS.has(id) ? 'maps' : GEMS.has(id) ? 'gems' : 'gear');
const ofClass = (c: string): 'currency' | 'maps' | 'gems' | 'gear' => (/gem/i.test(c) ? 'gems' : /\bmap/i.test(c) ? 'maps' : /currency|fragment|card|scarab|stackable|labyrinth|delve|incubator|pantheon|essence|fossil|oil/i.test(c) ? 'currency' : 'gear');

/**
 * What a rule matches, for the little tag in "Your changes": Currency, Maps, Gems, Gear, Mixed, or "Custom rule" when it
 * names no item class and no base type (for example one that only asks for an item level).
 */
export function ruleKind(rule: Rule, cat: Catalog | null | undefined): string {
  const kinds = new Set<string>();
  for (const t of rule.targets) {
    if (t.tag) kinds.add(ofSection(sectionOfType(t.tag.type).id));
    for (const c of t.conditions ?? []) {
      if (c.op === '!' || c.op === '!=') continue;
      if (c.key === 'BaseType') {
        for (const v of c.values) {
          const it = cat?.byName.get(v);
          kinds.add(it ? ofSection(sectionOfType(it.type).id) : 'gear');
        }
      } else if (c.key === 'Class') {
        for (const v of c.values) kinds.add(ofClass(v));
      }
    }
  }
  if (kinds.size === 0) return tr('lootfilter_guided_ruleKind.custom_rule');
  if (kinds.size > 1) return tr('lootfilter_guided_ruleKind_2.mixed');
  const k = [...kinds][0]!;
  return k[0]!.toUpperCase() + k.slice(1);
}
