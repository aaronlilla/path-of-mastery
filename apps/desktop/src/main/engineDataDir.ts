import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface EngineDataDirInputs {
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  /** Electron's `process.resourcesPath` (where `extraResources` land in an installed app). */
  resourcesPath?: string;
  /** The app folder (`apps/desktop` in a checkout). */
  appPath: string;
  exists?: (path: string) => boolean;
}

/**
 * The one folder the engine reads game data from. `POM_ENGINE_DATA` wins; an installed app uses the `engine-data`
 * folder shipped beside it; a checkout uses the repository's own. Never the working directory.
 * Returns undefined when none of them exists (the caller reports "data not installed").
 */
export function resolveEngineDataDir(i: EngineDataDirInputs): string | undefined {
  const exists = i.exists ?? existsSync;
  if (i.env.POM_ENGINE_DATA) return i.env.POM_ENGINE_DATA;
  const candidates = i.isPackaged
    ? [i.resourcesPath ? join(i.resourcesPath, 'engine-data') : '']
    : [resolve(i.appPath, '..', '..', 'engine-data')];
  return candidates.find((p) => p && exists(join(p, 'data_index.json')));
}
