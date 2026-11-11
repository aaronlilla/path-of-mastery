import { normalizeAccountName, realmOf, type CharacterList, type CharacterRow, type Realm } from '../../shared/characterImport.js';
import { GggError } from '../wealth/ggg.js';

/**
 * Reads a character-window page and returns its text. `cookie` true sends the player's session (main process only),
 * false reads the page as a visitor. Errors are GggError, whose messages never carry the cookie.
 */
export type WindowFetch = (path: string, query: Record<string, string>, cookie: boolean) => Promise<string>;

export class ImportError extends Error {}

function explain(e: unknown, what: string): ImportError {
  if (e instanceof GggError) {
    switch (e.kind) {
      case 'private':
        return new ImportError('Account profile is private or does not exist.');
      case 'not-found':
        return new ImportError(what === 'list' ? 'Account name is incorrect.' : 'Path of Exile has no such character.');
      case 'expired':
        return new ImportError('Your Path of Exile session was refused. It has probably expired: connect again in Wealth.');
      case 'rate-limited':
        return new ImportError(`You're doing that too fast. Please wait ${e.retryAfterSec ?? 60} seconds.`);
      default:
        return new ImportError(`${what === 'list' ? 'Error retrieving character list' : 'Error importing character data'}, try again (${e.message})`);
    }
  }
  return new ImportError(`${what === 'list' ? 'Error retrieving character list' : 'Error importing character data'}, try again (${e instanceof Error ? e.message : String(e)})`);
}

const enc = (s: string) => encodeURIComponent(s);
const accountQuery = (account: string) => account.replace(/#/g, '%23').replace(/ /g, '%20');

function parseRow(r: Record<string, unknown>, realm: Realm): CharacterRow | null {
  if (typeof r.name !== 'string') return null;
  return {
    name: r.name,
    league: typeof r.league === 'string' ? r.league : '?',
    class: typeof r.class === 'string' ? r.class : '?',
    ...(typeof r.classId === 'number' ? { classId: r.classId } : {}),
    level: typeof r.level === 'number' ? r.level : 0,
    realm: r.realm === undefined ? realm : realmOf(String(r.realm)),
  };
}

/** The account name with the site's own casing: it is in the profile page's links ("/view-profile/Name-1234/characters"). */
export function accountFromProfile(html: string): string | null {
  const m = /\/view-profile\/([^/"'\s]+)\/characters/.exec(html);
  if (!m) return null;
  let name = m[1]!;
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep the escaped form */
  }
  return normalizeAccountName(name, 'pc');
}

export class CharacterApi {
  constructor(private readonly win: WindowFetch) {}

  async listCharacters(realm: Realm, accountInput: string, cookie: boolean): Promise<CharacterList> {
    const account = normalizeAccountName(accountInput, realm);
    let body: string;
    try {
      body = await this.win('/character-window/get-characters', { accountName: accountQuery(account), realm }, cookie);
    } catch (e) {
      throw explain(e, 'list');
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new ImportError('Error processing character list, try again later');
    }
    if (!Array.isArray(json)) throw new ImportError('Error processing character list, try again later');
    const characters = json.map((r) => (r && typeof r === 'object' ? parseRow(r as Record<string, unknown>, realm) : null)).filter((r): r is CharacterRow => !!r);
    if (!characters.length) throw new ImportError('The account has no characters to import.');
    // The character routes ignore the case of the name but the item and tree routes do not, so the right casing comes from
    // the profile page. That page is a web page behind a bot check that can turn the app away: then the name as typed is used.
    let real = account;
    try {
      const found = accountFromProfile(await this.win(`/account/view-profile/${accountQuery(account)}`, {}, cookie));
      if (found) real = found;
    } catch (e) {
      if (e instanceof GggError && e.kind === 'rate-limited') throw explain(e, 'list');
    }
    return { account: real, characters };
  }

  /** get-passive-skills or get-items for one character, as the site's JSON. */
  async character(kind: 'passives' | 'items', realm: Realm, account: string, name: string, cookie: boolean): Promise<Record<string, unknown>> {
    const path = kind === 'passives' ? '/character-window/get-passive-skills' : '/character-window/get-items';
    let body: string;
    try {
      body = await this.win(path, { accountName: accountQuery(account), character: enc(name), realm }, cookie);
    } catch (e) {
      throw explain(e, 'character');
    }
    if (body.trim() === 'false') throw new ImportError('Failed to retrieve character data, try again.');
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new ImportError('Error importing character data, try again (the answer was not data).');
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ImportError('Failed to retrieve character data, try again.');
    return json as Record<string, unknown>;
  }
}
