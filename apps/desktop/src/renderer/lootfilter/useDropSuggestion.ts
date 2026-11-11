import { useMemo } from 'react';
import { tagOf } from '../../shared/lootfilter/catalog.js';
import { hiddenValuableDrops, nearestTier, recentDrops, type Drop, type DropSuggestion } from '../../shared/lootfilter/drops.js';
import type { Rule } from '../../shared/lootfilter/types.js';
import { useDrops } from './useDrops';
import { useLf } from './lfStore';
import { tr } from '../i18n';

export interface DropAdvice {
  /** The last 50 loot stacks from the player's sessions, newest first. */
  drops: Drop[];
  /** null until the sessions have been read. */
  loaded: boolean;
  suggestion: DropSuggestion | null;
  /** Show rules for the suggested items, each with the look of the tier its price fits. */
  rules(firstPriority: number): Rule[];
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Filter suggestions from what actually dropped: items the current filter hides that are worth picking up. */
export function useDropSuggestion(): DropAdvice {
  const lf = useLf();
  const sessions = useDrops();
  const drops = useMemo(() => recentDrops(sessions ?? []), [sessions]);
  const price = (n: string): number | null => lf.prices?.byName[n]?.chaos ?? null;
  const suggestion = useMemo(
    () =>
      lf.catalog && lf.prices
        ? hiddenValuableDrops(drops, (n) => {
            const it = lf.catalog!.byName.get(n);
            const r = it ? lf.evaluateCatalogItem(it) : null;
            return r ? { visible: r.visible, price: price(n) } : null;
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drops, lf.catalog, lf.prices, lf.evaluateCatalogItem],
  );
  const rules = (first: number): Rule[] => {
    const now = Date.now();
    return (suggestion?.names ?? []).map((n, i) => {
      const it = lf.catalog?.byName.get(n);
      const ty = lf.catalog?.types.find((t) => t.type === it?.type);
      const bands = (ty?.tiers ?? [])
        .filter((t) => t.kind !== 'Hide' && !t.conditional)
        .map((t) => ({ tier: t, median: median(t.items.map((x) => price(x) ?? 0).filter((p) => p > 0)) }))
        .filter((b) => Number.isFinite(b.median));
      const t = nearestTier(bands, price(n) ?? 0);
      return {
        id: lf.newId('d'),
        name: tr('lootfilter_useDropSuggestion_2.dropped_show', { n: n }),
        source: 'price' as const,
        enabled: true,
        priority: first + i,
        targets: [{ conditions: [{ key: 'BaseType', op: '==' as const, values: [n] }] }],
        visibility: 'show' as const,
        ...(t ? { styleFrom: tagOf(t) } : {}),
        why: tr('lootfilter_useDropSuggestion.it_dropped_for_you_and', { value: price(n) }),
        createdAt: now,
      };
    });
  };
  return { drops, loaded: sessions !== null, suggestion, rules };
}
