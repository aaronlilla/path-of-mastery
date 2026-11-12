import type { Rule } from '../../../../shared/lootfilter/types.js';
import { tagOf } from '../../../../shared/lootfilter/catalog.js';
import { formatPrice, type LfValue } from '../../lfStore';
import type { RetierRow } from './useRetier';
import { tr } from '../../../i18n';

/** One price rule per item: show it with the look of the tier its price belongs to. */
export function priceRules(lf: LfValue, rows: RetierRow[], firstPriority: number): Rule[] {
  const divine = lf.prices?.divine ?? 0;
  const unit = lf.settings.currencyUnit;
  const now = Date.now();
  return rows.map((r, i) => ({
    id: lf.newId('p'),
    name: tr('lootfilter_advanced_retier_apply_2.price_to', { name: r.item.name, toName: r.toName }),
    source: 'price' as const,
    enabled: true,
    priority: firstPriority + i,
    targets: [{ conditions: [{ key: 'BaseType', op: '==', values: [r.item.name] }] }],
    visibility: 'show' as const,
    styleFrom: tagOf(r.to),
    why: tr('lootfilter_advanced_retier_apply.unit_fits_typelabel_toname_it', { unit: formatPrice(r.price, divine, unit), typeLabel: r.typeLabel, toName: r.toName, fromName: r.fromName }),
    createdAt: now,
  }));
}

/** Applies the moves as a single undo step. */
export function applyPriceMoves(lf: LfValue, rows: RetierRow[]): number {
  if (!rows.length) return 0;
  const batch = { id: lf.newId('b'), name: tr(rows.length === 1 ? 'h_lootB_Retier.retiered_one' : 'h_lootB_Retier.retiered_other', { n: rows.length }) };
  const made = priceRules(lf, rows, lf.nextPriority()).map((r) => ({ ...r, batch }));
  lf.setRules(tr('lootfilter_advanced_retier_apply.moved_count_items_to_new', { count: made.length }), (rs) => [...rs, ...made]);
  return made.length;
}
