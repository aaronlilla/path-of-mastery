import { ipcMain } from 'electron';
import { IPC } from '../shared/ipc.js';
import type { Result } from '../shared/library.js';
import { resolvePoeUrl, shrinkWithPoeUrl } from '../shared/poeUrl.js';

async function wrap<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function registerTreeLinkIpc(): void {
  ipcMain.handle(IPC.TREE_LINK, (_e, op: string, link: string) => wrap(() => (op === 'shrink' ? shrinkWithPoeUrl(String(link)) : resolvePoeUrl(String(link)))));
}
