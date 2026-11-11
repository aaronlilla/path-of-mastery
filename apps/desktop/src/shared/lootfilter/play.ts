import type { AreaVisit, HiddenCounts } from './ipcTypes.js';
import { STRICTNESS } from './styles.js';

/**
 * What can honestly be said from the game's Client.txt: which areas the player entered and at what level.
 * The log has no item drops or pickups, so nothing here claims to know what dropped.
 */

export interface PlaySummary {
  /** Areas counted (hideouts and towns left out), newest last. */
  recent: AreaVisit[];
  count: number;
  minLevel: number;
  maxLevel: number;
  medianLevel: number;
  last: AreaVisit | null;
}

const isTown = (a: AreaVisit): boolean => /Hideout|^1_\d_town|_town$|^HeistHub|^KaruiHub|^Sanctum_town/i.test(a.id) || a.level <= 1;

export function summarize(areas: AreaVisit[], take = 15): PlaySummary {
  const real = areas.filter((a) => !isTown(a));
  const recent = real.slice(-take);
  if (!recent.length) return { recent, count: 0, minLevel: 0, maxLevel: 0, medianLevel: 0, last: null };
  const lv = recent.map((a) => a.level).sort((a, b) => a - b);
  return { recent, count: recent.length, minLevel: lv[0]!, maxLevel: lv[lv.length - 1]!, medianLevel: lv[Math.floor(lv.length / 2)]!, last: recent[recent.length - 1]! };
}

export interface PlaySuggestion {
  id: string;
  title: string;
  text: string;
  /** Strictness index to switch to. */
  toStrictness: number;
}

/**
 * Strictness hints from the levels of the last areas: mapping (area level 68 or more) on a loose level, or
 * leveling (55 or less) on a strict one. The counts are NeverSink's own, from running every item type through each file.
 */
export function suggestFromPlay(sum: PlaySummary, strictness: number, hidden: HiddenCounts | null): PlaySuggestion[] {
  if (sum.count < 8 || !hidden) return [];
  const out: PlaySuggestion[] = [];
  const h = hidden.hidden;
  if (sum.medianLevel >= 68 && strictness <= 1) {
    out.push({
      id: `play:map:${strictness}:${sum.medianLevel}`,
      title: `You are mapping at area level ${sum.medianLevel}`,
      text: `Your last ${sum.count} areas were level ${sum.minLevel} to ${sum.maxLevel}. ${STRICTNESS[strictness]!.name} hides ${h[strictness]} of ${hidden.total} item types; ${STRICTNESS[2].name} hides ${h[2]}.`,
      toStrictness: 2,
    });
  }
  if (sum.medianLevel <= 55 && strictness >= 3) {
    out.push({
      id: `play:level:${strictness}:${sum.medianLevel}`,
      title: `You are leveling at area level ${sum.medianLevel}`,
      text: `Your last ${sum.count} areas were level ${sum.minLevel} to ${sum.maxLevel}. ${STRICTNESS[strictness]!.name} hides ${h[strictness]} of ${hidden.total} item types; ${STRICTNESS[1].name} hides ${h[1]}.`,
      toStrictness: 1,
    });
  }
  return out;
}

export function ageText(ms: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
