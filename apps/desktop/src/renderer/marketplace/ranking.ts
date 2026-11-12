// The published ranking rules.
// Votes and time are the only inputs. The real order is computed by the service; these
// functions exist so the "How sorting works" text, the fixture service and the tests share one formula.
export type FeedSort = 'hot' | 'top' | 'new' | 'old' | 'rising';
export type TopWindow = '24_hours' | '7_days' | '30_days' | 'league' | 'all_time';
export const HOT_DIVISOR_SECONDS = 45000;
export const RISING_MAX_AGE_HOURS = 72;
export const RISING_VOTE_HOURS = 24;
export const sortLabels: Record<FeedSort, string> = { hot: 'Hot', top: 'Top', new: 'New', old: 'Old', rising: 'Rising' };
export const windowLabels: Record<TopWindow, string> = { '24_hours': 'Last 24 hours', '7_days': 'Last 7 days', '30_days': 'Last 30 days', league: 'This league', all_time: 'All time' };
export const windowOrder: TopWindow[] = ['24_hours', '7_days', '30_days', 'league', 'all_time'];
export const DEFAULT_SORT: FeedSort = 'hot';
export const DEFAULT_WINDOW: TopWindow = '7_days';
export const primarySorts: FeedSort[] = ['hot', 'top', 'new', 'old'];

export type RankInput = { id: string; publishedAt: number; net: number; votes: { at: number; delta: number }[]; leagueStart: number };
const sign = (value: number) => value > 0 ? 1 : value < 0 ? -1 : 0;
/** sign(net) * log10(max(abs(net), 1)) + secondsSinceLeagueStartAtPublication / 45000 */
export function hotScore(net: number, publishedAt: number, leagueStart: number): number {
  return sign(net) * Math.log10(Math.max(Math.abs(net), 1)) + Math.max(0, (publishedAt - leagueStart) / 1000) / HOT_DIVISOR_SECONDS;
}
export function windowStart(window: TopWindow, now: number, leagueStart: number): number {
  const hour = 3600_000;
  return window === '24_hours' ? now - 24 * hour : window === '7_days' ? now - 7 * 24 * hour : window === '30_days' ? now - 30 * 24 * hour
    : window === 'league' ? leagueStart : -Infinity;
}
export const netInWindow = (votes: RankInput['votes'], from: number, now: number) => votes.filter(v => v.at >= from && v.at <= now).reduce((sum, v) => sum + v.delta, 0);
/** Net votes received in the last 24 hours divided by max(ageHours, 1). Only posts younger than 72 hours rank. */
export function risingScore(item: RankInput, now: number): number | null {
  const ageHours = (now - item.publishedAt) / 3600_000;
  if (ageHours >= RISING_MAX_AGE_HOURS || ageHours < 0) return null;
  return netInWindow(item.votes, now - RISING_VOTE_HOURS * 3600_000, now) / Math.max(ageHours, 1);
}
const newerThenId = (a: RankInput, b: RankInput) => b.publishedAt - a.publishedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export function rank(items: readonly RankInput[], sort: FeedSort, window: TopWindow, now: number): RankInput[] {
  const copy = [...items];
  if (sort === 'new') return copy.sort((a, b) => newerThenId(a, b));
  if (sort === 'old') return copy.sort((a, b) => a.publishedAt - b.publishedAt || (a.id < b.id ? -1 : 1));
  if (sort === 'hot') return copy.sort((a, b) => hotScore(b.net, b.publishedAt, b.leagueStart) - hotScore(a.net, a.publishedAt, a.leagueStart) || newerThenId(a, b));
  if (sort === 'top') {
    const net = (item: RankInput) => netInWindow(item.votes, windowStart(window, now, item.leagueStart), now);
    return copy.sort((a, b) => net(b) - net(a) || newerThenId(a, b));
  }
  return copy.flatMap(item => { const score = risingScore(item, now); return score === null ? [] : [{ item, score }]; })
    .sort((a, b) => b.score - a.score || newerThenId(a.item, b.item)).map(entry => entry.item);
}

export type SortExplanation = { title: string; summary: string; formula: string | null; timeBasis: string };
/** Plain text for "How sorting works". `league` names the catalog league the time basis refers to. */
export function sortExplanation(sort: FeedSort, window: TopWindow, league: string): SortExplanation {
  const leagueBasis = `League start for ${league}`;
  switch (sort) {
    case 'hot': return { title: 'Hot', summary: 'Posts with more net votes rank higher, and newer posts get a steady lift. Net votes are upvotes minus downvotes.',
      formula: 'sign(net votes) x log10(max(|net votes|, 1)) + seconds since league start at publication / 45000',
      timeBasis: `${leagueBasis}. For an archive league its own start is used. If the start is unknown, one fixed documented date is used for every post in that league.` };
    case 'top': return { title: `Top: ${windowLabels[window]}`, summary: `Net votes cast ${window === 'all_time' ? 'at any time' : window === 'league' ? `since ${league} started` : `in the ${windowLabels[window].toLowerCase()}`}, highest first. Ties go to the newer post, then to the lower ID.`,
      formula: null, timeBasis: window === 'league' ? `${leagueBasis}.` : window === 'all_time' ? 'No time limit.' : `Counted back from now, by when each vote was cast.` };
    case 'new': return { title: 'New', summary: 'Newest first-publication time first. Editing a post does not change it.', formula: null, timeBasis: 'First publication time. Ties go to the lower ID.' };
    case 'old': return { title: 'Old', summary: 'Oldest first-publication time first. Editing a post does not change it.', formula: null, timeBasis: 'First publication time. Ties go to the lower ID.' };
    case 'rising': return { title: 'Rising', summary: 'Posts younger than 72 hours, ranked by the net votes they received in the last 24 hours divided by their age in hours (at least 1).',
      formula: 'net votes in the last 24 hours / max(age in hours, 1)', timeBasis: 'Counted back from now. Ties go to the newer post, then to the lower ID.' };
  }
}
