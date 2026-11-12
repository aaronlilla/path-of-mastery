import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CharacterAccess, CharacterBundle, CharacterFetchRequest, CharacterImportResult, CharacterList, ImportParts, Realm } from '../../shared/characterImport.js';
import { CharacterApi, ImportError, type WindowFetch } from './api.js';
import { applyCharacter, appendSpecNodes, type ConvertData, type ItemsJson, type PassivesJson } from './convert.js';

interface Prefs {
  signedOut: boolean;
  history: string[];
  lastRealm: Realm;
  lastAccount: string;
  lastLeague: string;
  lastCharacter: string;
}

const BLANK: Prefs = { signedOut: false, history: [], lastRealm: 'pc', lastAccount: '', lastLeague: '', lastCharacter: '' };

export interface CharacterServiceDeps {
  /** Where the history and the last choices are kept. */
  file: string;
  /** Reads a character-window page: the session cookie is added in the main process only. */
  window: WindowFetch;
  /** The connected player, from the Wealth connection. */
  session: () => { connected: boolean; account: string };
  data: () => Promise<ConvertData>;
  /**
   * The engine's `resolveImportedClusters`: which cluster jewel passives the imported `hashes_ex` and `jewel_data` allocate in
   * the build text. Without it (or when it fails) the cluster jewels come in with their passives unallocated, and a note says so.
   */
  clusters?: (xml: string, hashesEx: number[], jewelData: Record<string, unknown>) => Promise<{ allocated: number[]; unmatched: number[] }>;
}

/**
 * Character import for the Import tab and the Import dialog. The session cookie never reaches this class: `window`
 * adds it when `cookie` is true.
 */
export class CharacterService {
  private prefs: Prefs = { ...BLANK };
  private loaded: Promise<void>;
  private readonly api: CharacterApi;

  constructor(private readonly d: CharacterServiceDeps) {
    this.api = new CharacterApi(d.window);
    this.loaded = readFile(d.file, 'utf8')
      .then((t) => {
        this.prefs = { ...BLANK, ...(JSON.parse(t) as Partial<Prefs>) };
      })
      .catch(() => undefined);
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.d.file), { recursive: true });
    const tmp = this.d.file + '.tmp';
    await writeFile(tmp, JSON.stringify(this.prefs), 'utf8');
    await rename(tmp, this.d.file);
  }

  async access(): Promise<CharacterAccess> {
    await this.loaded;
    const s = this.d.session();
    return { connected: s.connected, account: s.account, signedOut: this.prefs.signedOut, history: [...this.prefs.history], lastRealm: this.prefs.lastRealm, lastAccount: this.prefs.lastAccount, lastLeague: this.prefs.lastLeague, lastCharacter: this.prefs.lastCharacter };
  }

  async signOut(): Promise<CharacterAccess> {
    await this.loaded;
    this.prefs.signedOut = true;
    await this.save();
    return this.access();
  }

  /** Uses the stored session again. Without one the player has to connect first (in Wealth). */
  async authorize(): Promise<CharacterAccess> {
    await this.loaded;
    if (!this.d.session().connected) throw new ImportError('There is no Path of Exile session yet. Connect your account in Wealth first, then come back.');
    this.prefs.signedOut = false;
    await this.save();
    return this.access();
  }

  private who(source: 'account' | 'name', account: string): { account: string; cookie: boolean } {
    if (source === 'name') return { account, cookie: false };
    const s = this.d.session();
    if (!s.connected || this.prefs.signedOut) throw new ImportError('Not authenticated.');
    return { account: s.account, cookie: true };
  }

  async list(source: 'account' | 'name', realm: Realm, accountInput: string): Promise<CharacterList> {
    await this.loaded;
    const w = this.who(source, accountInput);
    const out = await this.api.listCharacters(realm, w.account, w.cookie);
    if (source === 'name') {
      this.prefs.lastRealm = realm;
      this.prefs.lastAccount = out.account;
      this.prefs.history = [out.account, ...this.prefs.history.filter((h) => h.toLowerCase() !== out.account.toLowerCase())].slice(0, 20);
      await this.save();
    }
    return out;
  }

  async setHistory(names: string[]): Promise<string[]> {
    await this.loaded;
    this.prefs.history = names.filter((n) => typeof n === 'string').slice(0, 20);
    await this.save();
    return [...this.prefs.history];
  }

  async remember(realm: Realm, league: string, character: string): Promise<void> {
    await this.loaded;
    this.prefs.lastRealm = realm;
    this.prefs.lastLeague = league;
    this.prefs.lastCharacter = character;
    await this.save();
  }

  /** Reads what the parts need from the site. */
  async fetch(req: CharacterFetchRequest): Promise<CharacterBundle> {
    await this.loaded;
    const w = this.who(req.source, req.account);
    const p = req.parts;
    const out: CharacterBundle = { character: req.character };
    if (p.tree || p.jewels) out.passives = await this.api.character('passives', req.realm, w.account, req.character.name, w.cookie);
    if (p.items || p.skills) out.items = await this.api.character('items', req.realm, w.account, req.character.name, w.cookie);
    await this.remember(req.realm, req.character.league, req.character.name);
    return out;
  }

  /** Applies what was read to a build text. The text is the caller's latest: nothing here keeps a copy. */
  async apply(xml: string, bundle: CharacterBundle, parts: ImportParts): Promise<CharacterImportResult> {
    const data = await this.d.data();
    const r = applyCharacter(xml, { character: bundle.character, ...(bundle.passives ? { passives: bundle.passives as PassivesJson } : {}), ...(bundle.items ? { items: bundle.items as ItemsJson } : {}) }, parts, data);
    let out = r.xml;
    const notes = r.notes;
    const passives = bundle.passives as PassivesJson | undefined;
    const hashesEx = passives?.hashes_ex ?? [];
    if (parts.tree && hashesEx.length) {
      if (!this.d.clusters) notes.push('Cluster jewel passives were not allocated: the engine is not available here.');
      else {
        try {
          const c = await this.d.clusters(out, hashesEx, passives?.jewel_data ?? {});
          out = appendSpecNodes(out, c.allocated);
          notes.push(`Cluster jewel passives allocated: ${c.allocated.filter((i) => i >= 65536).length}.`);
          if (c.unmatched.length) notes.push(`${c.unmatched.length} cluster jewel passive${c.unmatched.length === 1 ? '' : 's'} of the character did not match the jewels in the build: ${c.unmatched.join(', ')}.`);
        } catch (e) {
          notes.push(`Cluster jewel passives were not allocated: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    return { xml: out, notes };
  }

  async import(req: CharacterFetchRequest & { xml: string }): Promise<CharacterImportResult> {
    return this.apply(req.xml, await this.fetch(req), req.parts);
  }
}
