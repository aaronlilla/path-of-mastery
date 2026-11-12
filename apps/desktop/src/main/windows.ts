import { BrowserWindow, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { IPC } from '../shared/ipc.js';
import { automationWindowOptions } from './automation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The app icon every window uses: Windows takes the multi-size .ico (16 to 256 px), so the taskbar gets a hand-sized image rather than a scaled one. */
export function appIconPath(platform: string = process.platform): string {
  return join(__dirname, platform === 'win32' ? '../renderer/ds/icon.ico' : '../renderer/ds/icon-256.png');
}

/** Windows whose player confirmed closing in the page's own dialog. */
const confirmedClose = new WeakSet<BrowserWindow>();

/** Windows whose next unload (one navigation) may go through without asking the page: an interface swap after saving. */
const unloadOnce = new WeakSet<BrowserWindow>();

/** Lets the window's next navigation go through without asking its page (the interface swap saved every document first). */
export function allowUnloadOnce(win: BrowserWindow): void {
  unloadOnce.add(win);
}

/** Lets the window close without asking its page (Restart now saved every open document first). */
export function allowClose(win: BrowserWindow): void {
  confirmedClose.add(win);
}

/** Closes the window even though its page refuses to unload (the player said so in the app's dialog). */
export function closeAnyway(win: BrowserWindow): void {
  confirmedClose.add(win);
  win.close();
}

/** `indexPath`: the interface bundle to load (a verified, swapped-in update); default the bundle shipped with the app. */
export function createMainWindow(indexPath?: string): BrowserWindow {
  const auto = automationWindowOptions(process.env);
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    ...(auto.x !== undefined ? { x: auto.x, y: auto.y, skipTaskbar: auto.skipTaskbar } : {}),
    minWidth: 800,
    minHeight: 600,
    frame: false,
    show: false,
    backgroundColor: '#0b0a09',
    title: 'Path of Mastery',
    icon: appIconPath(),
    webPreferences: {
      // A sandboxed preload must be a single CommonJS file: build:main bundles it to index.cjs with esbuild.
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The click bench (clickBench.ts) times animation frames, which Chromium pauses for a covered window.
      backgroundThrottling: auto.backgroundThrottling,
    },
  });

  win.once('ready-to-show', () => (auto.showInactive ? win.showInactive() : win.show()));
  // The Loot Filter asks to confirm leaving while it holds changes that are not in the game folder yet.
  // The page asks in its own dialog (renderer/closeGuard.tsx), never in a system message box: a refused close
  // is reported to the page and stays blocked until the player confirms there (closeAnyway below).
  win.webContents.on('will-prevent-unload', (event) => {
    if (confirmedClose.has(win)) event.preventDefault();
    else if (unloadOnce.has(win)) {
      unloadOnce.delete(win);
      event.preventDefault();
    }
    else if (!win.isDestroyed()) win.webContents.send(IPC.WIN_CLOSE_BLOCKED);
  });
  const sendState = () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.WIN_STATE, win.isMaximized());
  };
  win.on('maximize', sendState);
  win.on('unmaximize', sendState);

  // Links that aren't the app itself open in the player's browser, never in the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith(process.env.POM_RENDERER_DEV_SERVER_URL ?? 'file://')) e.preventDefault();
  });

  const devServerUrl = process.env.POM_RENDERER_DEV_SERVER_URL;
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(indexPath ?? join(__dirname, '../renderer/index.html'));
  }

  return win;
}
