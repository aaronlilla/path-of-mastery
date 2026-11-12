import { app, ipcMain, type BrowserWindow } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { IPC } from '../shared/ipc.js';
import type { Result } from '../shared/library.js';
import { EMPTY_SHARED, parseShared, type SharedItems } from '../shared/sharedItems.js';

async function wrap<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The items shared between builds live in one file in the user data folder; main reads and writes it, the renderer only asks.
 * `read` / `write` are for the assistant: a write from there tells the window, so the Items tab reloads the list. */
export function registerSharedItemsIpc(
  getWindow: () => BrowserWindow | null = () => null,
  /** Called after the player (or the assistant) changed the list, so the cloud copy follows. */
  onLocalWrite: () => void = () => {},
): { read(): Promise<SharedItems>; write(next: SharedItems): Promise<void>; writeFromSync(next: SharedItems): Promise<void> } {
  const file = join(app.getPath('userData'), 'sharedItems.json');
  const read = async (): Promise<SharedItems> => {
    try {
      return parseShared(await readFile(file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_SHARED };
      throw e;
    }
  };
  const write = async (next: SharedItems): Promise<void> => {
    const clean = parseShared(JSON.stringify(next));
    await mkdir(dirname(file), { recursive: true });
    // Written beside the file first, so a crash never leaves half a list.
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(clean, null, 1), 'utf8');
    await rename(tmp, file);
  };
  ipcMain.handle(IPC.SHARED_GET, () => wrap(read));
  ipcMain.handle(IPC.SHARED_SET, (_e, next: SharedItems) =>
    wrap(async () => {
      await write(next);
      onLocalWrite();
    }),
  );
  const tell = () => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send(IPC.SHARED_CHANGED);
  };
  return {
    read,
    async write(next) {
      await write(next);
      tell();
      onLocalWrite();
    },
    /** What the cloud sync wrote: the window reloads, and nothing is pushed back. */
    async writeFromSync(next) {
      await write(next);
      tell();
    },
  };
}
