import type { CatalogItem } from '../../shared/lootfilter/catalog.js';
import { LabelChip, type LabelChipProps } from './LabelChip';
import { itemPriceText, useLf } from './lfStore';
import { tr } from '../i18n';
import { strictName } from './names';

/**
 * A catalog item drawn with the look the filter that would be written gives it (your rules above NeverSink),
 * its poe.ninja price and a "changed by you" dot. Shared by Guided and Advanced.
 */
export function ItemChip({ item, hiddenLook = 'fade', ...rest }: { item: CatalogItem } & Partial<LabelChipProps>) {
  const lf = useLf();
  const r = lf.evaluateCatalogItem(item);
  const mine = !!r?.matched.some((b) => b.ruleId);
  const hidden = r ? !r.visible : item.hidden;
  const priceText = hidden || !lf.settings.showPrices ? undefined : itemPriceText(lf.prices, item.name, lf.settings.currencyUnit);
  const hidTag = hidden ? (r?.decided?.ruleId ? tr('lootfilter_ItemChip.hidden_by_your_rule') : tr('h_lootB_Names.hidden_at', { level: strictName(lf.doc.setup.strictness) })) : undefined;
  return (
    <LabelChip
      name={item.name}
      style={r?.style ?? item.style}
      hidden={hidden}
      hiddenLook={hiddenLook}
      changed={mine}
      title={`${item.name}${hidden ? ` (${tr('lootfilter_guided_Home.hidden')})` : ''}${mine ? ` · ${tr('lootfilter_guided_Home.changed_by_you')}` : ''}`}
      {...(priceText ? { price: priceText } : {})}
      {...(hidTag ? { hidTag } : {})}
      {...rest}
    />
  );
}
