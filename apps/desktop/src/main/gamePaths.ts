import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Path of Exile keeps its files on macOS and Linux (Windows lives in clientLog.ts / detect.ts / fileWriter.ts).
 * Sources: Client.txt on Mac is under ~/Library/Caches/com.GGG.PathOfExile/Logs (GGG forum thread 3233960, TraXile README)
 * or ~/Library/Application Support/Path of Exile/Cache/Logs (poecampain issue 2, Steam client). Preferences (with
 * production_Config.ini, where the game reads filters on Windows' My Games folder) is ~/Library/Application Support/Path of Exile/Preferences.
 * Linux runs the Windows build in Proton (Steam app 238960), so its files are in the Proton prefix; the game's own
 * logs folder is under the Steam install. Not checked on a real Mac or Linux install: the settings let the player pick the file or folder.
 */
const POE_STEAM_APP = '238960';

export function steamRoots(home: string = homedir()): string[] {
  return [
    join(home, 'Library', 'Application Support', 'Steam'),
    join(home, '.steam', 'steam'),
    join(home, '.local', 'share', 'Steam'),
    join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
  ];
}

export function posixClientLogCandidates(platform: NodeJS.Platform = process.platform, home: string = homedir()): string[] {
  const steam = steamRoots(home).map((r) => join(r, 'steamapps', 'common', 'Path of Exile', 'logs', 'Client.txt'));
  if (platform === 'darwin') {
    return [
      join(home, 'Library', 'Caches', 'com.GGG.PathOfExile', 'Logs', 'Client.txt'),
      join(home, 'Library', 'Application Support', 'Path of Exile', 'Cache', 'Logs', 'Client.txt'),
      ...steam,
    ];
  }
  return steam;
}

/** The folder the game reads `.filter` files from (Windows: Documents/My Games/Path of Exile). First existing candidate, else the first. */
export function posixGameFolder(platform: NodeJS.Platform = process.platform, home: string = homedir(), exists: (p: string) => boolean = existsSync): string {
  const list =
    platform === 'darwin'
      ? [join(home, 'Library', 'Application Support', 'Path of Exile', 'Preferences')]
      : steamRoots(home).map((r) => join(r, 'steamapps', 'compatdata', POE_STEAM_APP, 'pfx', 'drive_c', 'users', 'steamuser', 'Documents', 'My Games', 'Path of Exile'));
  return list.find(exists) ?? list[0]!;
}
