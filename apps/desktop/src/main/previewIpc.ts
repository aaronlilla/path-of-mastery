import { ipcMain } from 'electron';
import { IPC } from '../shared/ipc.js';
import type { Result } from '../shared/library.js';
import type { PreviewCommand } from '../shared/preview.js';
import type { PreviewService } from './preview/service.js';

/** The overlay the app has (once the service has looked), and read-only preview engine calls for a build text. */
export function registerPreviewIpc(ready: Promise<PreviewService>): void {
  const wrap = async <T>(fn: () => Promise<T>): Promise<Result<T>> => {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
  ipcMain.handle(IPC.PREVIEW_STATUS, () => wrap(async () => (await ready).info()));
  ipcMain.handle(IPC.PREVIEW_CALL, (_e, command: PreviewCommand, xml: string, params: Record<string, unknown>) =>
    wrap(async () => {
      if (typeof xml !== 'string' || !xml) throw new Error('no build text');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (await ready).call(command, xml, (params ?? {}) as any);
    }),
  );
}
