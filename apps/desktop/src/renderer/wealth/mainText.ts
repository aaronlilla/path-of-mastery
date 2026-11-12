// English text that main and shared code build for Wealth (errors, status lines, times, variants, strategies), in the player's language.
import { fmtAgo as agoEn, fmtOld as oldEn, standardPriceText as stdEn, type CxQuote } from '../../shared/wealth.js';
import { lotSummary } from '../../shared/bulk.js';
import { fromMain, tr } from '../i18n';

const time = (s: string): string => fromMain('ml_wealth_time', s);

export const fmtAgo = (ms: number): string => time(agoEn(ms));
export const fmtOld = (ms: number): string => time(oldEn(ms));
export const standardPriceText = (...a: Parameters<typeof stdEn>): string => time(stdEn(...a));
export const never = (): string => time('never');
export const cxText = (q: CxQuote, now: number, fmt: (chaos: number) => string): string =>
  `${fmt(q.chaos)} · ${fmtOld(now - q.at)}${q.volume > 0 ? ` · ${time(`${Math.round(q.volume).toLocaleString()} traded`)}` : ''}`;

/** A sentence from main code: an error, a status line, a bell entry, a rule. The diagnostics' `"a" and "b"` lists become `"a", "b"`. */
export const msg = (s: string): string => fromMain('ml_wealth_msg', s.replace(/" and "/g, '", "'));
/** A short name from main code: a variant ("21/20 corrupted", "6 links · 2 flasks"), a stash tab reason, a price source, a default session name. */
export const item = (s: string): string => s.split(' · ').map((p) => fromMain('ml_wealth_item', p)).join(' · ');
/** A session's name: the player's own stays as typed, the app's ("Session") is translated. */
export const sessName = (s: { name: string; custom?: boolean }): string => (s.custom ? s.name : item(s.name));
/** A curated strategy's text (name, tag, note, ...). */
export const strat = (s: string): string => fromMain('ml_wealth_strat', s);
/** A loot filter suggestion's title or reason. */
export const sugg = (s: string): string => fromMain('ml_wealth_filter', s);
/** The first items of a bulk lot, then "and N more". */
export const lot = (items: { name: string; qty: number }[], max = 3): string =>
  items.length > max ? tr('ml_wealth_item.lot_more', { head: lotSummary(items.slice(0, max), max), count: items.length - max }) : lotSummary(items, max);
