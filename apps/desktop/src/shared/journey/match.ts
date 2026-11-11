/**
 * Does a character on the account fit the build Journey is for? Pure code, no network: the caller reads
 * the list (one get-characters hit) and, for a row the player asks about, the items (one get-items hit).
 */
import type { CharacterRow } from '../characterImport.js';
import type { CharacterMatch } from './ipcTypes.js';

export interface MatchBuild {
  /** Base class of the build ("Ranger"). */
  className: string;
  /** Ascendancy of the build ("Pathfinder"), or '' when the build has none. */
  ascendancy: string;
  /** Level the build is planned to reach. */
  level: number;
  /** The league the player selected, or '' for any. */
  league?: string;
  /** Names the main skill gem goes by ("Poisonous Concoction"). */
  mainSkill: string;
  /** The skill the plan levels with before the swap, when there is one. */
  levelingSkill?: string;
}

/** The part of get-items the match needs: gems socketed in the equipped items. */
export interface MatchItems {
  gems: string[];
}

interface RawItem {
  inventoryId?: string;
  typeLine?: string;
  baseType?: string;
  socketedItems?: RawItem[];
}

/** Gem names socketed in the equipped items of a get-items answer (inventory, not the stash or flasks). */
export function socketedGems(itemsJson: unknown): string[] {
  const items = (itemsJson as { items?: RawItem[] } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const it of items) {
    for (const g of it.socketedItems ?? []) {
      const n = g.baseType || g.typeLine;
      if (n) out.push(n);
    }
  }
  return out;
}

const norm = (s: string): string => s.toLowerCase().replace(/^(greater|grand|perfect|awakened)\s+/, '').replace(/\s+support$/, '').trim();

export function hasGem(gems: string[], name: string): boolean {
  if (!name) return false;
  const want = norm(name);
  return gems.some((g) => norm(g) === want);
}

export function matchCharacter(build: MatchBuild, row: CharacterRow, items?: MatchItems | null): CharacterMatch {
  const reasons: string[] = [];
  if (build.league && row.league !== build.league) {
    return { state: 'different', reasons: [`It plays in ${row.league}, not ${build.league}.`] };
  }
  const ascended = !!build.ascendancy && row.class === build.ascendancy;
  const sameBase = row.class === build.className;
  if (!ascended && !sameBase) {
    return { state: 'different', reasons: [`${row.class} is not ${build.ascendancy || build.className}.`] };
  }
  if (row.level > build.level) {
    return { state: 'different', reasons: [`Level ${row.level} is past the build's level ${build.level}.`] };
  }
  if (ascended) reasons.push(`Ascendancy ${row.class} matches.`);
  else reasons.push(`${row.class} is the base class${build.ascendancy ? `; not ${build.ascendancy} yet` : ''}.`);
  if (items) {
    if (hasGem(items.gems, build.mainSkill)) {
      reasons.push(`${build.mainSkill} is socketed.`);
      if (ascended || !build.ascendancy) return { state: 'match', reasons };
      return { state: 'likely', reasons };
    }
    if (build.levelingSkill && hasGem(items.gems, build.levelingSkill)) reasons.push(`Levelling with ${build.levelingSkill}, before the swap.`);
    else reasons.push(`${build.mainSkill} is not socketed.`);
    return { state: 'likely', reasons };
  }
  reasons.push('Gems not checked yet.');
  return { state: 'likely', reasons };
}
