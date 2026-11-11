import type { HiddenCounts } from '../../shared/lootfilter/ipcTypes.js';
import { tr } from '../i18n';

/** The one wording for how much a strictness level hides, used by every label, card, toast and preview. */
/** What one Hide rule hides: the item types of NeverSink's list that its conditions match. */
export function hidesCount(n: number): string {
  return tr(n === 1 ? 'h_lootB_Names.hides_one' : 'h_lootB_Names.hides_other', { n: n.toLocaleString() });
}

export function hidesText(hidden: number, total: number): string {
  return tr('lootfilter_hidesText.hides_tolocalestring_of_tolocalestri', { hidden: hidden.toLocaleString(), total: total.toLocaleString() });
}

/** A strictness tile's caption. Until the counts arrive it is a stand-in in the final wording (`ready: false`): laid out
 *  but not shown, so the tile already has its final size and no empty caption is drawn and then replaced. */
export function strictnessCaption(h: HiddenCounts | null, level: number): { text: string; ready: boolean } {
  return h ? { text: hidesText(h.hidden[level] ?? 0, h.total), ready: true } : { text: hidesText(8888, 8888), ready: false };
}

/** How old the prices are, in the one wording every screen uses: "just now", "5 min ago", "3 h ago", "2 days ago". */
export function priceAge(fetchedAt: number, now = Date.now()): string {
  const m = Math.max(0, Math.floor((now - fetchedAt) / 60000));
  if (m < 1) return tr('lootfilter_hidesText_2.just_now');
  if (m < 60) return tr('lootfilter_hidesText.m_min_ago', { value: m });
  const h = Math.floor(m / 60);
  return h < 48 ? tr('lootfilter_hidesText.h_h_ago', { h }) : tr('lootfilter_hidesText.v1_days_ago', { value: Math.floor(h / 24) });
}
