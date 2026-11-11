import { tr as trTyped } from '../../../i18n';

const tr = trTyped as unknown as (key: string, vars: Record<string, string>) => string;

const UNIT: Record<string, string> = {
  change: 'change', rule: 'rule', 'gem rule': 'gem_rule', item: 'item', suggestion: 'suggestion',
  section: 'section', 'item type': 'item_type', 'reviewed change': 'reviewed_change',
};

/** "3 rules" in the player's language; unit is an English key into h_lootB_Plural. */
export const plural = (n: number, unit: string): string =>
  tr(`h_lootB_Plural.${UNIT[unit]}_${n === 1 ? 'one' : 'other'}`, { n: n.toLocaleString() });
