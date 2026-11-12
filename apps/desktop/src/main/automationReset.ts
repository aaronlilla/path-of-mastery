import { BrowserWindow, clipboard, dialog, ipcMain, net, session, shell } from 'electron';
import { DEFAULT_SETTINGS } from '../shared/library.js';
import type { SettingsStore } from './library/settingsStore.js';

/** Scripted runs only (POM_AUTOMATION=1): the "live" test app stays up between cases, and this puts it back to a clean state
 *  without a restart. Call it once the app has registered everything: that moment is the baseline it restores.
 *  Back to baseline: extra windows closed, IPC handlers and the dialog/shell/clipboard/net functions a driver replaced put back,
 *  `globalThis.__mx*` driver leftovers removed, settings back to defaults, saved page storage cleared, the page reloaded
 *  (open builds, dialogs and every UI state go with it). The runner resets the profile FILES (Builds and so on) before it asks.
 *  Exposed as globalThis.__pomAutomationReset() so a driver can call it through the main-process inspector. */
type Handlers = Map<string, (...a: unknown[]) => unknown>;
const PATCHABLE = { dialog, shell, clipboard, net } as unknown as Record<string, Record<string, unknown>>;

export function registerAutomationReset(deps: { settings: SettingsStore; getWindow: () => BrowserWindow | null }): void {
  if (process.env.POM_AUTOMATION !== '1') return;
  const handlers = (ipcMain as unknown as { _invokeHandlers: Handlers })._invokeHandlers;
  const baseHandlers = new Map(handlers);
  const baseFns = Object.fromEntries(Object.entries(PATCHABLE).map(([name, obj]) => [name, Object.fromEntries(Object.keys(obj).map((k) => [k, obj[k]]))]));

  const reset = async (): Promise<{ handlersRestored: number; fnsRestored: number }> => {
    const main = deps.getWindow();
    for (const w of BrowserWindow.getAllWindows()) if (w !== main && !w.isDestroyed()) w.destroy();
    let handlersRestored = 0;
    for (const ch of [...handlers.keys()]) if (!baseHandlers.has(ch)) { handlers.delete(ch); handlersRestored++; }
    for (const [ch, fn] of baseHandlers) if (handlers.get(ch) !== fn) { handlers.set(ch, fn); handlersRestored++; }
    let fnsRestored = 0;
    for (const [name, obj] of Object.entries(PATCHABLE)) {
      for (const [k, v] of Object.entries(baseFns[name]!)) {
        if (obj[k] !== v) { try { obj[k] = v; fnsRestored++; } catch { /* read-only */ } }
      }
    }
    const g = globalThis as Record<string, unknown>;
    for (const k of Object.keys(g)) if (/^__mx(?!Live)/.test(k)) delete g[k];
    await deps.settings.set({ ...DEFAULT_SETTINGS });
    try { await session.defaultSession.clearStorageData(); } catch { /* best effort */ }
    if (main && !main.isDestroyed()) {
      await new Promise<void>((done) => {
        main.webContents.once('did-finish-load', () => done());
        setTimeout(done, 15000);
        main.webContents.reload();
      });
    }
    return { handlersRestored, fnsRestored };
  };
  (globalThis as Record<string, unknown>).__pomAutomationReset = reset;
}
