/**
 * Character import: what the Import tab and the Import dialog share with the main process. The rules follow Path of
 * Building's ImportTab (realm list, account name handling, which parts can be imported and what "delete first" means).
 */

export type Realm = 'pc' | 'xbox' | 'sony';

export const REALMS: { id: 'PC' | 'XBOX' | 'SONY'; code: Realm; label: string }[] = [
  { id: 'PC', code: 'pc', label: 'PC' },
  { id: 'XBOX', code: 'xbox', label: 'Xbox' },
  { id: 'SONY', code: 'sony', label: 'Sony' },
];

/** One row of get-characters. */
export interface CharacterRow {
  name: string;
  league: string;
  class: string;
  classId?: number;
  level: number;
  realm: Realm;
}

/** Whether the app holds a session cookie (from the Wealth connection) and may import private characters with it. */
export interface CharacterAccess {
  /** A session cookie is stored. */
  connected: boolean;
  /** The account it belongs to, with its #1234 discriminator when it has one. */
  account: string;
  /** The player pressed Logout in the Import tab, so the stored session is not used here until Authorize is pressed. */
  signedOut: boolean;
  /** Recent account names for Import By Account Name, and the last choices. */
  history: string[];
  lastRealm: Realm;
  lastAccount: string;
  lastLeague: string;
  lastCharacter: string;
}

export interface CharacterList {
  /** The account name with the casing the site uses. */
  account: string;
  characters: CharacterRow[];
}

/** What to take from the character, and what to clear first (upstream's check boxes). */
export interface ImportParts {
  tree: boolean;
  jewels: boolean;
  items: boolean;
  skills: boolean;
  deleteJewels: boolean;
  deleteItems: boolean;
  deleteSkills: boolean;
  ignoreWeaponSwap: boolean;
}

export const TREE_AND_JEWELS: ImportParts = { tree: true, jewels: true, items: false, skills: false, deleteJewels: false, deleteItems: false, deleteSkills: false, ignoreWeaponSwap: false };
export const ITEMS_AND_SKILLS: ImportParts = { tree: false, jewels: false, items: true, skills: true, deleteJewels: false, deleteItems: false, deleteSkills: false, ignoreWeaponSwap: false };

/** What to read from the site for a character. */
export interface CharacterFetchRequest {
  /** 'account' reads the connected player's characters with their session; 'name' reads a public profile. */
  source: 'account' | 'name';
  realm: Realm;
  /** The account name for a public read; ignored for the connected player's own. */
  account: string;
  character: CharacterRow;
  parts: ImportParts;
}

/** The site's answer for one character, as received (the passive tree and jewels, and the items). */
export interface CharacterBundle {
  character: CharacterRow;
  passives?: Record<string, unknown>;
  items?: Record<string, unknown>;
}

export interface CharacterImportResult {
  xml: string;
  /** What happened, one line each: what was imported and anything that was left out. */
  notes: string[];
}

/** The account name as the site wants it: spaces dropped (PC) or joined with +, and the last "-" or "#" is the # of the discriminator. */
export function normalizeAccountName(raw: string, realm: Realm): string {
  const t = realm === 'pc' ? raw.replace(/\s+/g, '') : raw.replace(/^[\s?]+/, '').replace(/[\s?]+$/, '').replace(/\s/g, '+');
  return t.replace(/^(.*)[#-]/s, '$1#');
}

/** The Start button is enabled for a name that ends in a discriminator, like upstream. */
export function hasDiscriminator(raw: string): boolean {
  return /[#-]\d{4}$/.test(raw.trim());
}

export function startEnabled(raw: string): boolean {
  return /\S[#-]\d{4}$/.test(raw);
}

/** League names present in a character list, sorted, then "Any". */
export function leaguesOf(list: CharacterRow[], realm: Realm): string[] {
  const set = new Set<string>();
  for (const c of list) if (c.realm === realm && c.league) set.add(c.league);
  return [...set].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** The characters of one league ("" for every league) in the realm, by name. */
export function charactersIn(list: CharacterRow[], realm: Realm, league: string): CharacterRow[] {
  return list
    .filter((c) => c.realm === realm && (!league || c.league === league))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

/** A Standard league to fall back on when the last used league is over (upstream's FindMatchingStandardLeague). */
export function standardLeagueFor(league: string): string {
  if (league.includes('Hardcore')) return 'Hardcore';
  if (league.includes('HC SSF')) return 'SSF Hardcore';
  if (league.includes('SSF')) return 'SSF Standard';
  return 'Standard';
}

export function pickLeague(leagues: string[], last: string): string {
  if (!leagues.length) return '';
  if (last && leagues.includes(last)) return last;
  if (last) {
    const std = standardLeagueFor(last);
    if (leagues.includes(std)) return std;
  }
  return leagues[0]!;
}

/** A realm code from the site; anything unknown is PC. */
export function realmOf(code: string): Realm {
  return code === 'xbox' || code === 'sony' ? code : 'pc';
}
