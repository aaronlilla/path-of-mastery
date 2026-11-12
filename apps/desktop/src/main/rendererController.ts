import type { WebContents } from 'electron';
import type { RendererController } from './updater/interfaceSwap.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `RendererController` backed by the main window's `webContents`. The page opts in with `window.__pomCaptureState` /
 * `window.__pomRestoreState` (renderer/App.tsx: the area, the open build and its tab). `allowUnload` lets the one
 * navigation through even though the page refuses to unload (its documents were saved first: the caller's job).
 */
export function createWebContentsRendererController(contents: () => WebContents, allowUnload: () => void = () => {}): RendererController {
  const wc = () => contents();
  return {
    async captureState(): Promise<unknown> {
      return wc().executeJavaScript('window.__pomCaptureState ? window.__pomCaptureState() : null');
    },

    async loadBundle(indexHtmlPath: string): Promise<void> {
      allowUnload();
      // loadFile resolves once the page finished loading (and rejects when it failed to).
      await wc().loadFile(indexHtmlPath);
    },

    async verifyReady(): Promise<boolean> {
      // Loaded is not started: the new bundle must run its scripts, reach the preload API and mount the app.
      for (let i = 0; i < 100; i++) {
        const ok = await wc()
          .executeJavaScript("!!(window.pom && document.getElementById('root') && document.getElementById('root').children.length && window.__pomRestoreState)")
          .catch(() => false);
        if (ok) return true;
        await sleep(100);
      }
      return false;
    },

    async restoreState(state: unknown): Promise<void> {
      if (state === null || state === undefined) return;
      for (let i = 0; i < 50; i++) {
        const has = await wc().executeJavaScript('!!window.__pomRestoreState').catch(() => false);
        if (has) break;
        await sleep(100);
      }
      await wc().executeJavaScript(`window.__pomRestoreState && window.__pomRestoreState(${JSON.stringify(state)})`);
    },
  };
}
