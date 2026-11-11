/**
 * Game data the screens need by name: gem colours, passive node names. It is read from the
 * engine's own data files (`POM_ENGINE_DATA`), once, on first use. Art comes from renderer/gameArt.ts.
 */
import { ipcMain } from 'electron';
import { IPC } from '../shared/ipc.js';
import type { GameInfo, Result, SpectreInfo, TreeNodeInfo } from '../shared/library.js';
import { runDataJob } from './dataWorker.js';

let infoCache: Promise<GameInfo> | undefined;
const treeCache = new Map<string, Promise<Record<string, TreeNodeInfo>>>();
let spectreCache: Promise<Record<string, SpectreInfo>> | undefined;

/** The files are parsed on a worker thread (dataWorker.ts): data_gems.json and each tree are 6 to 10 MB of JSON. */
function loadTree(version: string): Promise<Record<string, TreeNodeInfo>> {
  if (!/^[0-9]+_[0-9]+(?:_[a-z_]+)?$/.test(version)) return Promise.reject(new Error(`unknown tree version ${version}`));
  return runDataJob('treeNodes', version);
}

export function registerGameData(): void {
  ipcMain.handle(IPC.GAME_SPECTRES, async (): Promise<Result<Record<string, SpectreInfo>>> => {
    spectreCache ??= runDataJob('spectres');
    try {
      return { ok: true, value: await spectreCache };
    } catch (e) {
      spectreCache = undefined;
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC.GAME_INFO, async (): Promise<Result<GameInfo>> => {
    infoCache ??= runDataJob('gameInfo');
    try {
      return { ok: true, value: await infoCache };
    } catch (e) {
      infoCache = undefined;
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC.TREE_NODES, async (_e, version: string): Promise<Result<Record<string, TreeNodeInfo>>> => {
    let p = treeCache.get(version);
    if (!p) {
      p = loadTree(version);
      treeCache.set(version, p);
    }
    try {
      return { ok: true, value: await p };
    } catch (e) {
      treeCache.delete(version);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
