import type { TimelessInstallStatus } from '../shared/timelessStatus.js';
import { loadBuildWithTables, type TimelessInstaller } from './timelessData.js';
import { app, BrowserWindow, dialog, ipcMain, net, shell } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import type { EngineStatus } from '@pom/protocol';
import type { ShareSiteId } from '../shared/buildSites.js';
import { IPC } from '../shared/ipc.js';
import { HEADLINE_STATS, type AppInfo, type AppSettings, type BuildsDirProblem, type EngineBuildSummary, type EngineSummary, type Result, type UpdateOffer } from '../shared/library.js';
import { blankBuildXml } from '../shared/buildXml.js';
import type { EngineConnection } from './engineConnection.js';
import { encodeBuildCode } from './library/buildCode.js';
import { buildsDirProblem, resolveBuildsDir, setBuildsDir } from './buildsPath.js';
import { BuildStore, StoreError } from './library/buildStore.js';
import { importFromText, shareToBin, shareToSite } from './library/importer.js';
import { importPublicCharacter } from './character/publicImport.js';
import type { SettingsStore } from './library/settingsStore.js';
import type { SyncHooks } from './accounts/host.js';
import { closeAnyway } from './windows.js';
import { mt } from './mainText.js';

async function wrap<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const code = e instanceof StoreError ? e.code : undefined;
    return { ok: false, error: e instanceof Error ? e.message : String(e), ...(code ? { code } : {}) };
  }
}

function summarise(status: EngineStatus | undefined): EngineSummary {
  if (!status) return { state: 'starting', detail: 'The calculation engine is starting.' };
  switch (status.state) {
    case 'ready':
      return { state: 'ready', detail: `Engine ${status.engineVersion}` };
    case 'starting':
      return { state: 'starting', detail: 'The calculation engine is starting.' };
    case 'unavailable':
      return { state: 'unavailable', detail: status.reason };
    case 'error':
      return { state: 'error', detail: status.message };
  }
}


export interface LibraryIpcDeps {
  store: BuildStore;
  settings: SettingsStore;
  engine: EngineConnection;
  buildsDir: string;
  getWindow: () => BrowserWindow | null;
  checkForUpdates: () => Promise<unknown>;
  updateAvailable: () => Promise<UpdateOffer>;
  timelessStatus: () => TimelessInstallStatus;
  timelessInstall: () => TimelessInstallStatus;
  /** The tables' installer (null when the folder of plain tables is given); a build's open waits for the tables it needs. */
  timelessInstaller: () => TimelessInstaller | null;
  /** The layer versions running now (they change when an update is applied). */
  versions?: () => { engine: string; interface: string };
  /** Set when accounts are on: told after each change so cloud sync follows. */
  sync?: SyncHooks;
}

export function registerLibraryIpc(deps: LibraryIpcDeps): void {
  const { store, settings, engine } = deps;
  let engineStatus: EngineStatus | undefined;
  engine.onEvent((e) => {
    if (e.type === 'status') engineStatus = e.status;
  });

  const handle = <A extends unknown[], T>(channel: string, fn: (...args: A) => Promise<T>) => {
    ipcMain.handle(channel, (_e, ...args) => wrap(() => fn(...(args as A))));
  };

  handle(IPC.LIB_LIST, () => store.list());
  handle(IPC.LIB_READ, (id: string) => store.read(id));
  handle(IPC.LIB_SAVE, async (id: string, xml: string) => {
    const e = await store.write(id, xml);
    deps.sync?.saved(id);
    return e;
  });
  handle(IPC.LIB_CREATE, async (opts: { folder: string; name: string; xml?: string; className?: string; level?: number; noSync?: boolean }) => {
    const s = await settings.get();
    const xml = opts.xml ?? blankBuildXml(opts.className ?? 'Scion', opts.level ?? s.defaultLevel);
    const e = await store.create(opts.folder, opts.name, xml);
    if (!opts.noSync) deps.sync?.created(e.id);
    return e;
  });
  handle(IPC.LIB_RENAME, async (id: string, name: string) => {
    const e = await store.renameBuild(id, name);
    if (e.id !== id) deps.sync?.renamed(id, e.id);
    return e;
  });
  handle(IPC.LIB_DUPLICATE, async (id: string) => {
    const e = await store.duplicate(id);
    deps.sync?.created(e.id);
    return e;
  });
  handle(IPC.LIB_MOVE, async (id: string, folder: string, keepBoth: boolean) => {
    const e = await store.move(id, folder, keepBoth);
    if (e.id !== id) deps.sync?.renamed(id, e.id);
    return e;
  });
  handle(IPC.LIB_DELETE, async (id: string) => {
    const t = await store.remove(id);
    deps.sync?.removed(id);
    return t;
  });
  handle(IPC.LIB_RESTORE, (token: string) => store.restore(token));
  handle(IPC.LIB_TRASH_LIST, () => store.listTrash());
  handle(IPC.LIB_TRASH_PURGE, async (token: string | null) => {
    if (token === null) for (const t of await store.listTrash()) await store.purge(t.token);
    else await store.purge(token);
  });
  handle(IPC.LIB_FOLDER_CREATE, async (parent: string, name: string) => {
    const f = await store.createFolder(parent, name);
    deps.sync?.folderCreated(f.path);
    return f;
  });
  handle(IPC.LIB_FOLDER_RENAME, async (path: string, name: string) => {
    const f = await store.renameFolder(path, name);
    if (f.path !== path) deps.sync?.folderRenamed(path, f.path);
    return f;
  });
  handle(IPC.LIB_FOLDER_DELETE, async (path: string, force: boolean) => {
    await store.removeFolder(path, force);
    deps.sync?.folderRemoved(path);
  });
  handle(IPC.LIB_FOLDER_COUNT, (path: string) => store.countIn(path));
  handle(IPC.LIB_REVEAL, async (id?: string) => {
    if (id) shell.showItemInFolder(store.pathOf(id));
    else await shell.openPath(deps.buildsDir);
  });

  /** Picks the folder builds are saved in from the next start (null = ask for a folder, 'default' = go back to the default). */
  handle(IPC.LIB_BUILDSDIR_CHOOSE, async (reset: boolean): Promise<string | null> => {
    const userData = app.getPath('userData');
    if (reset) return setBuildsDir(userData, null);
    const win = deps.getWindow();
    const opts = { title: mt('builds_dir'), defaultPath: deps.buildsDir, properties: ['openDirectory' as const, 'createDirectory' as const] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const dir = r.filePaths[0];
    if (r.canceled || !dir) return null;
    return setBuildsDir(userData, dir);
  });
  handle(IPC.APP_RELAUNCH, async () => {
    app.relaunch();
    app.exit(0);
  });

  handle(IPC.CODE_IMPORT, (text: string) => importFromText(text, undefined, (account, character) => importPublicCharacter(account, character)));
  handle(IPC.CODE_ENCODE, async (xml: string) => encodeBuildCode(xml));
  handle(IPC.CODE_SHARE, (xml: string) => shareToBin(xml));
  handle(IPC.CODE_SHARE_TO, (site: ShareSiteId, xml: string) => shareToSite(site, xml));

  handle(IPC.FILE_OPEN_XML, async () => {
    const win = deps.getWindow();
    const opts = { title: mt('open_build'), properties: ['openFile' as const], filters: [{ name: 'Path of Building builds', extensions: ['xml', 'txt'] }, { name: mt('all_files'), extensions: ['*'] }] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const path = r.filePaths[0];
    if (r.canceled || !path) return null;
    const text = await readFile(path, 'utf8');
    return { text, name: path.replace(/^.*[\\/]/, '').replace(/\.(xml|txt)$/i, '') };
  });
  handle(IPC.FILE_SAVE_XML, async (name: string, xml: string) => {
    const win = deps.getWindow();
    const opts = { title: mt('save_build'), defaultPath: `${name}.xml`, filters: [{ name: 'Path of Building builds', extensions: ['xml'] }] };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, xml, 'utf8');
    return r.filePath;
  });

  handle(IPC.APP_INFO, async (): Promise<AppInfo> => {
    const problem: BuildsDirProblem | null = buildsDirProblem(app.getPath('userData'));
    return {
    version: app.getVersion(),
    ...(deps.versions ? { engineVersion: deps.versions().engine, interfaceVersion: deps.versions().interface } : {}),
    platform: process.platform,
    userDataDir: app.getPath('userData'),
    buildsDir: deps.buildsDir,
    nextBuildsDir: resolveBuildsDir(app.getPath('userData')),
    ...(problem ? { buildsDirProblem: problem } : {}),
    engine: summarise(engineStatus),
    maximized: deps.getWindow()?.isMaximized() ?? false,
    };
  });
  handle(IPC.SETTINGS_GET, () => settings.get());
  handle(IPC.SETTINGS_SET, (patch: Partial<AppSettings>) => settings.set(patch));

  const summaryOf = async (buildId: string): Promise<EngineBuildSummary> => {
    const { stats } = await engine.send('getStats', { buildId });
    const byId = new Map(stats.map((s) => [s.id, s.value]));
    const headline = HEADLINE_STATS.flatMap((h) => {
      const v = byId.get(h.id);
      return typeof v === 'number' ? [{ id: h.id, label: h.label, value: v }] : [];
    });
    return { buildId, statCount: stats.length, headline };
  };
  handle(IPC.ENGINE_OPEN, async (xml: string): Promise<EngineBuildSummary> => {
    // The player's open build: the engine never closes it to make room for drafts or scratch copies.
    return summaryOf(await loadBuildWithTables(engine, xml, deps.timelessInstaller()));
  });
  handle(IPC.ENGINE_SUMMARY, (buildId: string) => summaryOf(buildId));

  handle(IPC.UPDATE_CHECK_SAFE, () => deps.checkForUpdates());
  handle(IPC.UPDATE_AVAILABLE, () => deps.updateAvailable());
  handle(IPC.TIMELESS_STATUS, async (): Promise<TimelessInstallStatus> => deps.timelessStatus());
  handle(IPC.TIMELESS_INSTALL, async (): Promise<TimelessInstallStatus> => deps.timelessInstall());
  handle(IPC.OPEN_EXTERNAL, async (url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only web links can be opened.');
    await shell.openExternal(url);
  });

  // The leagues the trade site lists (a public page, as upstream's trade window reads it). A failure gives
  // the two leagues that always exist, with the reason.
  handle(IPC.TRADE_LEAGUES, async (realm: string): Promise<{ leagues: string[]; error?: string }> => {
    const fallback = ['Standard', 'Hardcore'];
    try {
      const res = await net.fetch('https://www.pathofexile.com/api/trade/data/leagues', { headers: { 'User-Agent': `PathOfMastery/${app.getVersion()} (item trade search links)`, Accept: 'application/json' } });
      if (!res.ok) return { leagues: fallback, error: `The trade site answered ${res.status}.` };
      const body = (await res.json()) as { result?: Array<{ id: string; realm: string }> };
      const leagues = (body.result ?? []).filter((l) => l.realm === realm).map((l) => l.id);
      return leagues.length ? { leagues } : { leagues: fallback, error: 'The trade site listed no leagues.' };
    } catch (e) {
      return { leagues: fallback, error: e instanceof Error ? e.message : String(e) };
    }
  });

  const win = (e: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.handle(IPC.WIN_MINIMIZE, (e) => win(e)?.minimize());
  ipcMain.handle(IPC.WIN_MAXIMIZE, (e) => {
    const w = win(e);
    if (!w) return false;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
    return w.isMaximized();
  });
  ipcMain.handle(IPC.WIN_CLOSE, (e) => win(e)?.close());
  ipcMain.handle(IPC.WIN_CLOSE_ANYWAY, (e) => {
    const w = win(e);
    if (w) closeAnyway(w);
  });
}
