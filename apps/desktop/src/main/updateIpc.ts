import { ipcMain } from 'electron';
import { IPC } from '../shared/ipc.js';
import type { RestartResult, UpdateNotice, UpdateStatus } from '../shared/update.js';

export interface UpdateIpcDeps {
  status(): UpdateStatus;
  /** A notice from before the window existed (the last install's result), handed over once. */
  takeStartupNotice(): UpdateNotice | null;
  restart(): Promise<RestartResult>;
  /** The last policy check before applying (network): refused when the update was paused, blocked or withdrawn. */
  prepareApply(): Promise<RestartResult>;
  quit(): void;
}

/** The window's side of the updater: read the status, Restart now, and the required modal's Quit. Results are { ok, value }. */
export function registerUpdateIpc(deps: UpdateIpcDeps): void {
  const wrap = async <T>(fn: () => T | Promise<T>) => {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
  ipcMain.handle(IPC.UPDATE_GET_STATUS, () => wrap(() => ({ status: deps.status(), notice: deps.takeStartupNotice() })));
  ipcMain.handle(IPC.UPDATE_RESTART, () => wrap(() => deps.restart()));
  ipcMain.handle(IPC.UPDATE_PREPARE_APPLY, () => wrap(() => deps.prepareApply()));
  ipcMain.handle(IPC.UPDATE_QUIT, () => wrap(() => deps.quit()));
}
