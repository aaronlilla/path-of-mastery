import { ipcMain, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import type { CommandName, CommandParams, EngineEvent } from '@pom/protocol';
import { IPC } from '../shared/ipc.js';
import type { EngineConnection } from './engineConnection.js';
import type { UpdateManager } from './updater/updateManager.js';

export function registerIpcHandlers(
  webContents: WebContents,
  engine: EngineConnection,
  updates: UpdateManager,
): void {
  ipcMain.handle(IPC.ENGINE_COMMAND, async (_event, command: CommandName, params: CommandParams<CommandName>) => {
    try {
      const result = await engine.send(command, params);
      return { id: randomUUID(), command, ok: true, result };
    } catch (err) {
      return { command, ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
    }
  });

  ipcMain.handle(IPC.UPDATE_CHECK, async () => updates.checkForUpdates());

  engine.onEvent((event: EngineEvent) => {
    webContents.send(IPC.ENGINE_EVENT, event);
  });
}
