import type { PriceTable } from '../../shared/lootfilter/ipcTypes.js';
import { tr } from '../i18n';

/**
 * Price in the unit the player picked: "178c", "1.2 div", "<0.1c". One rule everywhere: from one Divine Orb up
 * a price reads in div (the prototype's 1.0, 6.7, 19, 169, 888 div), below it in chaos. A price within half a
 * percent of one Divine counts as one, so the Divine Orb itself never reads "368c" in one place and "1.0 div" in another.
 */
export function formatPrice(chaos: number | undefined, divine: number, unit: 'Chaos' | 'Divine' = 'Chaos'): string {
  if (chaos === undefined || chaos === null) return '';
  const d = divine > 1 ? divine : 0;
  if (d && (chaos >= d * 0.995 || unit === 'Divine') && chaos >= d * 0.1) {
    const v = chaos / d;
    return (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(v >= 10 ? 0 : 1)) + ' div';
  }
  if (chaos >= 1) return Math.round(chaos).toLocaleString() + 'c';
  if (chaos >= 0.1) return chaos.toFixed(1) + 'c';
  return '<0.1c';
}

/** The price an item chip stands for. A base type with no price of its own (a plain Amethyst Ring) takes the dearest unique on it; `via` names that unique. */
export function itemPrice(p: PriceTable | null | undefined, name: string): { chaos: number; via?: string } | undefined {
  if (!p) return undefined;
  const own = p.byName[name]?.chaos;
  if (own !== undefined) return { chaos: own };
  const base = p.uniqueByBase[name];
  if (base === undefined) return undefined;
  return { chaos: base, via: p.uniqueByBaseName?.[name] ?? tr('lootfilter_format.a_unique') };
}

/** The price text for a chip: "178c", or "up to 820 div · Original Sin" when the number is the dearest unique on this base. */
export function itemPriceText(p: PriceTable | null | undefined, name: string, unit: 'Chaos' | 'Divine' = 'Chaos'): string | undefined {
  const ip = itemPrice(p, name);
  if (!ip) return undefined;
  const t = formatPrice(ip.chaos, p?.divine ?? 0, unit);
  return ip.via ? tr('lootfilter_format.up_to', { t: t, via: ip.via }) : t;
}
