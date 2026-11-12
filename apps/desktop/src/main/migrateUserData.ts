import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The data folder name before the pob-v2 to pom rename (bbec67204); 0.1.15 to 0.1.17 wrote here. */
export const OLD_USER_DATA_FOLDER = '@pob-v2/desktop';
const MARKER = 'migrated-from-old-folder.txt';
const STARTED = 'migration-started.txt';

/**
 * The player's own files and folders, as the readers name them. Left out on purpose: Chromium and Electron caches,
 * lock files, logs, and everything the app rebuilds (engine-cache, timeless-data, updates, kb, update-policy.json,
 * pending-app-update.json, update-install-id). "Local Storage" is left out too: it is Chromium's database, not ours.
 */
const KEEP = [
  'Builds', 'Recently deleted', 'builds-path.txt', // buildsPath.ts, index.ts
  'settings.json', 'character-import.json', 'sharedItems.json', // sharedItemsIpc.ts; its sync record is accounts/sharedItems.sync.json
  'accounts', 'sync', // sign-in session (safeStorage-encrypted, see ENCRYPTED) and cloud-save state
  'leveling', 'journey', 'lootfilter', 'wealth', 'assistant', 'mastery',
];

/**
 * Files encrypted with Electron safeStorage. On Windows its AES key is DPAPI-wrapped and stored as os_crypt.encrypted_key
 * in the userData folder's own "Local State" file, so these only decrypt next to the Local State they were written with.
 * mastery/identity holds installation.txt (the id) and app-key.bin (its key): they stay together or not at all.
 */
const ENCRYPTED = ['accounts/session.bin', 'accounts/pending.bin', 'wealth/session.bin', 'mastery/identity'];
const LOCAL_STATE = 'Local State';

/** Copies the player's data from the old folder into the new one, once. Never touches the old folder or an existing file. Returns files-or-folders copied. */
export function migrateOldUserData(oldDir: string, newDir: string): number {
  if (existsSync(join(newDir, MARKER)) || !existsSync(oldDir)) return 0;
  const started = existsSync(join(newDir, STARTED));
  // Builds already there with no started marker = the player used the new folder first: copy nothing. With it = our own half-done copy: finish it.
  const hasBuilds = !started && existsSync(join(newDir, 'Builds')) && readdirSync(join(newDir, 'Builds')).length > 0;
  let copied = 0;
  let failed = 0;
  if (!hasBuilds) {
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, STARTED), 'copy started; the done marker is written when every item copied');
    // A new folder with no Local State of its own takes the old one, so the copied encrypted files decrypt. One that has its own key
    // (the player already ran the new version) keeps it, and the encrypted files are left behind: they would never decrypt.
    // Identical bytes = our own earlier copy of it (a half-done run being finished), not the new folder's key.
    const ownKey = existsSync(join(newDir, LOCAL_STATE)) && !(existsSync(join(oldDir, LOCAL_STATE)) && readFileSync(join(newDir, LOCAL_STATE)).equals(readFileSync(join(oldDir, LOCAL_STATE))));
    const filter = (src: string) => !ownKey || !ENCRYPTED.includes(relative(oldDir, src).split(sep).join('/'));
    if (!ownKey && existsSync(join(oldDir, LOCAL_STATE))) {
      try { cpSync(join(oldDir, LOCAL_STATE), join(newDir, LOCAL_STATE), { force: false, errorOnExist: false }); } catch { failed++; }
    }
    for (const name of KEEP) {
      const from = join(oldDir, name);
      if (!existsSync(from)) continue;
      try {
        mkdirSync(newDir, { recursive: true });
        cpSync(from, join(newDir, name), { recursive: true, force: false, errorOnExist: false, filter });
        copied++;
      } catch {
        failed++;
      }
    }
  }
  if (!failed) {
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, MARKER), 'copied once from the old data folder');
  }
  return copied;
}
