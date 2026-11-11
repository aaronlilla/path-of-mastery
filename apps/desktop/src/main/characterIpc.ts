import { ipcMain } from 'electron';
import { join } from 'node:path';
import { IPC } from '../shared/ipc.js';
import type { CharacterAccess, CharacterBundle, CharacterFetchRequest, CharacterImportResult, CharacterList, ImportParts, Realm } from '../shared/characterImport.js';
import type { Result } from '../shared/library.js';
import { loadConvertData } from './character/data.js';
import { sampleWindow } from './character/sample.js';
import { CharacterService } from './character/service.js';
import type { WealthService } from './wealth/service.js';
import type { EngineConnection } from './engineConnection.js';

async function wrap<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Character import in the main process. Pages come through the Wealth service, which holds the player's session cookie
 * and the rate limiter for pathofexile.com; the cookie never goes to the window.
 */
export function registerCharacterIpc(deps: { wealth: WealthService; userDataDir: string; engine: EngineConnection }): CharacterService {
  const sample = process.env.POM_CHARACTER_SAMPLE;
  const sampleAccount = 'Kaelen#4821';
  const svc = new CharacterService({
    file: join(deps.userDataDir, 'character-import.json'),
    window: sample ? sampleWindow(sample, sampleAccount) : (path, query, cookie) => deps.wealth.characterWindow(path, query, cookie),
    session: () => (sample ? { connected: true, account: sampleAccount } : deps.wealth.importAccess()),
    data: loadConvertData,
    clusters: (xml, hashesEx, jewelData) => deps.engine.send('resolveImportedClusters', { xml, hashesEx, jewelData }),
  });
  ipcMain.handle(IPC.CHARACTER_ACCESS, () => wrap<CharacterAccess>(() => svc.access()));
  ipcMain.handle(IPC.CHARACTER_SIGN_OUT, () => wrap<CharacterAccess>(() => svc.signOut()));
  ipcMain.handle(IPC.CHARACTER_AUTHORIZE, () => wrap<CharacterAccess>(() => svc.authorize()));
  ipcMain.handle(IPC.CHARACTER_LIST, (_e, source: 'account' | 'name', realm: Realm, account: string) => wrap<CharacterList>(() => svc.list(source, realm, account)));
  ipcMain.handle(IPC.CHARACTER_FETCH, (_e, req: CharacterFetchRequest) => wrap<CharacterBundle>(() => svc.fetch(req)));
  ipcMain.handle(IPC.CHARACTER_APPLY, (_e, xml: string, bundle: CharacterBundle, parts: ImportParts) => wrap<CharacterImportResult>(() => svc.apply(xml, bundle, parts)));
  ipcMain.handle(IPC.CHARACTER_HISTORY_SET, (_e, names: string[]) => wrap<string[]>(() => svc.setHistory(names)));
  return svc;
}
