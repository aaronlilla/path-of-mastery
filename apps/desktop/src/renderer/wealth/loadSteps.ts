import type { WealthView } from '../../shared/wealth.js';
import { tr } from '../i18n';

/** What is happening right now, in words with real numbers. Nothing here is an error. */
export function loadSteps(w: WealthView): { prices: string; stash: string } {
  const p = w.prices;
  const prices = p.lines > 0 ? tr('wealth_loadSteps.prices_loaded') : p.loading && p.progress ? tr('wealth_loadSteps.loading_prices_done_of_total', { done: p.progress.done, total: p.progress.total }) : tr('wealth_loadSteps.loading_prices');
  const r = w.sync.reading;
  const stash = !w.sync.connected
    ? '' // no account: Market and Strategies use public prices, nothing to say about a stash
    : w.sync.lastSyncAt
    ? tr('wealth_loadSteps.stash_read')
    : r
      ? tr('wealth_loadSteps.reading_your_stash_tab_total', { total: Math.min(r.done + 1, r.total), total2: r.total })
      : w.sync.phase === 'rate-limited'
        ? tr('wealth_loadSteps.your_stash_read_is_waiting')
        : p.lines > 0 || p.failed
          ? tr('wealth_loadSteps.starting_to_read_your_stash')
          : tr('wealth_loadSteps.your_stash_is_read_right');
  return { prices, stash };
}
