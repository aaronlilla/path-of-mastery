import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GggError } from '../wealth/ggg.js';
import type { WindowFetch } from './api.js';

/**
 * Dev switch (POM_CHARACTER_SAMPLE=<folder>): answers the character-window pages from recorded files instead of
 * pathofexile.com, and acts as a connected player, so the signed-in screens can be walked without a session cookie.
 * The folder holds characters.json (the get-characters answer), passives.json (get-passive-skills) and items.json (get-items).
 */
export function sampleWindow(dir: string, account: string): WindowFetch {
  const read = async (name: string) => {
    try {
      return await readFile(join(dir, name), 'utf8');
    } catch {
      throw new GggError('not-found', `The sample folder has no ${name}.`);
    }
  };
  return async (path, query) => {
    if (path.endsWith('/get-characters')) return read('characters.json');
    if (path.startsWith('/account/view-profile/')) return `<a href="/account/view-profile/${account.replace('#', '-')}/characters">Characters</a>`;
    if (path.endsWith('/get-passive-skills')) return read('passives.json');
    if (path.endsWith('/get-items')) return read('items.json');
    void query;
    throw new GggError('not-found', 'No such page in the sample.');
  };
}
