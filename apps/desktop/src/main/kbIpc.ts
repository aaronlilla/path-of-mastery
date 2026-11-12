import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../shared/ipc.js';
import type { Result } from '../shared/library.js';
import type { KbService, KbUiStatus } from './kb/service.js';

async function wrap<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Status, a forced refresh, and a push whenever the status changes. `ready` resolves once the service is started. */
export function registerKbIpc(ready: Promise<KbService>, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.KB_STATUS, () => wrap(async () => (await ready).status()));
  ipcMain.handle(IPC.KB_REFRESH, () =>
    wrap(async () => {
      const kb = await ready;
      await kb.check();
      return kb.status();
    }),
  );
  void ready.then((kb) =>
    kb.onStatus((s: KbUiStatus) => {
      const w = getWindow();
      if (w && !w.webContents.isDestroyed()) w.webContents.send(IPC.KB_PUSH, s);
    }),
  );
}
