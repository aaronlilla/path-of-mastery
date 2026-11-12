import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { posixClientLogCandidates } from '../gamePaths.js';

/** Client.txt at the usual install folders (Steam and the standalone client, on the common drive letters). Only an existing file counts. */
export function detectClientTxt(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32') return posixClientLogCandidates(platform).find(exists) ?? null;
  const roots = [env['ProgramFiles(x86)'], env['ProgramFiles'], ...['C', 'D', 'E', 'F'].map(d => `${d}:/`)].filter((r): r is string => !!r);
  const tails = ['Steam/steamapps/common/Path of Exile', 'SteamLibrary/steamapps/common/Path of Exile', 'Grinding Gear Games/Path of Exile', 'Games/Path of Exile'];
  for (const r of roots) for (const t of tails) { const p = join(r, t, 'logs', 'Client.txt'); if (exists(p)) return p; }
  return null;
}
