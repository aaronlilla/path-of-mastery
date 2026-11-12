import { useMemo } from 'react';
import { useLf } from '../../lfStore';
import { usePlay } from '../../usePlay';
import { useDropSuggestion } from '../../useDropSuggestion';
import { useRetier } from '../retier/useRetier';

/**
 * How many suggestions the Adapt inbox would show right now, for the bell. The ids match the ones the inbox
 * screen makes, so a suggestion dismissed there stops counting here.
 */
export function useInboxCount(): number {
  const lf = useLf();
  const rt = useRetier();
  const play = usePlay();
  const dr = useDropSuggestion();
  return useMemo(() => {
    const watchState = (lf.ui.adaptWatch ?? {}) as Record<string, boolean>;
    const dismissed = (lf.ui.adaptDismissed ?? {}) as Record<string, true>;
    const watching = (k: string): boolean => watchState[k] !== false;
    const ids: { id: string; watch: string }[] = [];
    const up = lf.update;
    if (up?.newer && up.latest && lf.settings.dismissedVersion !== up.latest.tag) ids.push({ id: `update:${up.latest.tag}`, watch: 'update' });
    if (rt.total > 0) {
      const all = rt.types.flatMap((t) => t.rows).filter((r) => !r.done);
      all.sort((a, b) => Math.abs(Math.log(b.price / b.fromMedian)) - Math.abs(Math.log(a.price / a.fromMedian)));
      ids.push({ id: `price:${rt.total}:${all[0]?.item.name ?? ''}`, watch: 'price' });
    }
    for (const n of lf.gen?.needsReview ?? []) ids.push({ id: `review:${n.ruleId}:${n.kind}`, watch: 'review' });
    for (const sg of play.suggestions) ids.push({ id: sg.id, watch: 'play' });
    if (dr.suggestion) ids.push({ id: dr.suggestion.id, watch: 'drops' });
    return ids.filter((x) => watching(x.watch) && !dismissed[x.id]).length;
  }, [lf.ui.adaptWatch, lf.ui.adaptDismissed, lf.update, lf.settings.dismissedVersion, lf.gen, rt, play.suggestions, dr.suggestion]);
}
