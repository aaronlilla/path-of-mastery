import type { HiddenCounts } from './ipcTypes.js';
import type { PlaySummary } from './play.js';
import { STRICTNESS } from './styles.js';

/**
 * Suggestions the Adapt inbox can prove from real inputs: the level of the areas the player entered (from the game's
 * Client.txt) or, with no log, the level of the open build. Drops are not in the log, so nothing here talks about them.
 */

export interface LevelSuggestion {
  id: string;
  /** What it is based on. */
  basis: 'areas' | 'build';
  /** The fact it starts from, in one sentence. */
  line: string;
  /** The question to the player. */
  question: string;
  toStrictness: number;
  /** What was done, for the Earlier list. */
  done: string;
}

const MIN_AREAS = 5;
const MAPS = 68;
const LEVELING = 55;

/** `buildFilterOn`: the Build Filter's stages already follow area level, so strictness is left alone. */
export function levelSuggestion(sum: PlaySummary, buildLevel: number | null, strictness: number, buildFilterOn = false): LevelSuggestion | null {
  if (buildFilterOn) return null;
  const areas = sum.count >= MIN_AREAS;
  const level = areas ? sum.medianLevel : buildLevel;
  if (level === null || level <= 0) return null;
  const mapping = level >= MAPS && strictness <= 1;
  const leveling = level <= LEVELING && strictness >= 3;
  if (!mapping && !leveling) return null;
  const to = mapping ? 2 : 1;
  const name = STRICTNESS[to]!.name;
  const phase = mapping ? 'mapping' : 'leveling';
  return {
    id: `level:${areas ? 'areas' : 'build'}:${strictness}:${level}`,
    basis: areas ? 'areas' : 'build',
    line: areas ? `Your last ${sum.count} areas were level ${sum.minLevel} to ${sum.maxLevel}, so you are ${phase}.` : `Your build is level ${level}, so you are ${phase}.`,
    question: `${mapping ? 'Raise' : 'Lower'} strictness to ${name}?`,
    toStrictness: to,
    done: `${mapping ? 'Raised' : 'Lowered'} strictness to ${name}${areas ? ` at area level ${level}` : ` at build level ${level}`}`,
  };
}

/** Item types whose visibility differs between two strictness levels, from the real counts. */
export function visibilityChanges(h: HiddenCounts | null, from: number, to: number): { hidden: string[]; shown: string[] } {
  const out = { hidden: [] as string[], shown: [] as string[] };
  if (!h) return out;
  for (const [name, m] of Object.entries(h.mask)) {
    const a = (m >> from) & 1;
    const b = (m >> to) & 1;
    if (a === 0 && b === 1) out.hidden.push(name);
    else if (a === 1 && b === 0) out.shown.push(name);
  }
  return out;
}
