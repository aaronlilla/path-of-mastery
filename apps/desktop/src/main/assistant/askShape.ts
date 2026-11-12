import { STAT_META } from '../../shared/assistant/statLabels.js';
import { wantsSupportSwap } from './firstLine.js';
import { keywords } from './router.js';

// The app changes the build before the model has read the message only when the whole message is one of the closed shapes
// below. A word match on part of the text is not enough: "spend my points on damage, but do not lose any life" holds every
// word of a points ask and means the opposite. Anything that does not parse falls through to the model, which is slower and
// never wrong.

const norm = (text: string): string => text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "Solve update ..." is written by the app, never typed by the player. */
export const isAppMessage = (text: string): boolean => /^\s*Solve update/i.test(text);

/** Stat words a player types, longest first so "effective hp" is read before "hp" and "full dps" before "dps". */
const WORDS: Array<[string, string]> = [['ehp', 'TotalEHP'], ['dps', 'CombinedDPS'], ['damage', 'CombinedDPS']];
const STATS: Array<[string, string]> = [...STAT_META.map((m): [string, string] => [norm(m.label), m.id]), ...WORDS].sort((a, b) => b[0].length - a[0].length);

/** The one engine stat the text names, and the text without it; null when it names none or more than one. */
function takeStat(t: string): { id: string; rest: string } | null {
  const ids = new Set<string>();
  let rest = ` ${t} `;
  for (const [phrase, id] of STATS) {
    const next = rest.replace(new RegExp(`(?<= )${escape(phrase)}(?= )`, 'g'), ' ');
    if (next !== rest) { ids.add(id); rest = next; }
  }
  const [id] = ids;
  return ids.size === 1 && id ? { id, rest } : null;
}

/** Words that belong to the shape itself. Anything else left over is the player saying more than the shape holds. */
const POINT_WORDS = /\b(spend|allocate|use|put|points?|passive|unspent|free|spare|remaining|most|possible|add|adds|get|into|them|they|as|best|maximum|max|more|extra)\b/g;
const SWAP_WORDS = /\b(replace|swap|weakest|supports?|damage|dps|best|one|adds?|most|link|setup|group|gem|skill)\b/g;

/** "Spend my 5 free points on life": a spend verb, an optional count, "points" and one stat, nothing else. */
export function pointsShape(text: string): { stat: string } | null {
  let t = ` ${norm(text)} `;
  if (!/ (spend|allocate|use|put) /.test(t) || !/ points? /.test(t)) return null;
  const n = /\b(\d{1,2}) (?:(?:free|unspent|passive|skill) )*points?\b/.exec(t);
  if (n) {
    if (Number(n[1]) < 1 || Number(n[1]) > 20) return null;
    t = `${t.slice(0, n.index)} ${t.slice(n.index + n[1]!.length)}`;
  }
  if (/\d/.test(t)) return null;
  const s = takeStat(t);
  return s && !keywords(s.rest.replace(POINT_WORDS, ' ')).length ? { stat: s.id } : null;
}

/** "Replace the weakest support in my <skill> setup with the best one for damage": a skill of the build, a damage goal, nothing else. */
export function isSupportSwap(text: string, skillNames: string[]): boolean {
  if (!wantsSupportSwap(text)) return false;
  let t = norm(text);
  const skill = skillNames.map(norm).filter((n) => n.length > 3 && t.includes(n)).sort((a, b) => b.length - a.length)[0];
  if (!skill || !/\b(damage|dps)\b/.test(t)) return false;
  t = t.replace(skill, ' ').replace(SWAP_WORDS, ' ');
  return !keywords(t).length;
}

/** "What should I upgrade next?" with no object and no goal. */
export const isUpgradeShape = (text: string): boolean =>
  /^(?:(?:ok|okay|so|hey|please) )*(?:what (?:should|can|do) i (?:upgrade|improve|do|fix)(?: next| now| first)?|what'?s next|what next|upgrade next|next upgrade)(?: please)?$/.test(norm(text));

/** Any upgrade question, plain or not: the plan is worked out for it. */
const UPGRADE_ASK = /\b(upgrade next|next upgrade|what (should|can|do) i (upgrade|improve|do next|fix next|buy)|what'?s next|what next|what should i do)\b/i;

/** How much of the plan the app puts in live: all of it for the bare ask, the broken-thing fixes alone when the ask says more. */
export type PlanApply = 'all' | 'fixes' | false;

export function planApply(text: string): PlanApply {
  if (isUpgradeShape(text)) return 'all';
  return UPGRADE_ASK.test(text) && !/\b(max hit|how does|how do|what is|explain)\b/i.test(text) ? 'fixes' : false;
}
