import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC } from '../shared/ipc.js';
import type { Result } from '../shared/library.js';
import type { FilePick, LootFilterState, ReleaseInfo, WriteRequest } from '../shared/lootfilter/ipcTypes.js';
import { engineBases, hiddenCounts, resistAffixes, supportGemNames } from './lootfilter/derived.js';
import { readClientLog } from './lootfilter/clientLog.js';
import { copySoundInto, defaultGameFolder, existingFiles, inspectTarget, listFilterFiles, readFilterFile, writeFilterFile } from './lootfilter/fileWriter.js';
import { NeverSinkStore } from './lootfilter/neversink.js';
import { PoeNinjaPrices } from './lootfilter/prices.js';
import { LootFilterStore } from './lootfilter/store.js';
import { candidateRows, loadGameData, planFor, setPlanProvider } from './lootfilter/buildData.js';
import { loadLevelingData } from './leveling/data.js';
import { planLeveling } from '../shared/leveling/plan.js';
import { LEVELING_GUIDE } from '../shared/leagueContent.js';
import { CardRewardStore } from './lootfilter/cardRewards.js';
import type { CardRewards } from '../shared/lootfilter/profile.js';
import { mt } from './mainText.js';

async function wrap<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface LootFilterIpcDeps {
  getWindow: () => BrowserWindow | null;
}

/** Where the bundled NeverSink files live: next to the app in a package, in resources/ in development. */
export function bundledNeverSinkDir(): string {
  const packaged = join(process.resourcesPath ?? '', 'neversink');
  if (app.isPackaged) return packaged;
  return fileURLToPath(new URL('../../resources/neversink', import.meta.url));
}

export function registerLootFilterIpc(deps: LootFilterIpcDeps): { store: LootFilterStore; ns: NeverSinkStore; prices: PoeNinjaPrices; cards: () => Promise<CardRewards> } {
  const userData = app.getPath('userData');
  const root = join(userData, 'lootfilter');
  const store = new LootFilterStore(join(root, 'filters.json'));
  const ns = new NeverSinkStore(bundledNeverSinkDir(), join(root, 'neversink'));
  const prices = new PoeNinjaPrices(join(root, 'prices'));
  const backupsDir = join(root, 'backups');
  const engineDataDir = process.env.POM_ENGINE_DATA ?? '';
  let lastCheck: Awaited<ReturnType<NeverSinkStore['check']>> | null = null;

  const documents = (): string => {
    try {
      return app.getPath('documents');
    } catch {
      return join(app.getPath('home'), 'Documents');
    }
  };
  const gameFolder = (configured: string): string => configured || process.env.POM_GAME_FOLDER || defaultGameFolder(documents());

  const handle = <A extends unknown[], T>(channel: string, fn: (...args: A) => Promise<T>) => {
    ipcMain.handle(channel, (_e, ...args) => wrap(() => fn(...(args as A))));
  };

  handle(IPC.LF_STATE_GET, async () => {
    const st = await store.load();
    return { state: st, defaultFolder: gameFolder(''), userDataDir: root, saveError: store.saveError, file: store.file };
  });
  handle(IPC.LF_STATE_SAVE, async (next: LootFilterState) => {
    await store.save(next);
  });
  handle(IPC.LF_BASE_LIST, async () => {
    const st = await store.load();
    const installed = await ns.installed();
    const active = await ns.resolveVersion(st.settings.baseVersion);
    return { installed, active };
  });
  handle(IPC.LF_BASE_FILE, async (version: string, strictnessId: string) => {
    const text = await ns.readOne(version, strictnessId);
    return { version, text };
  });
  handle(IPC.LF_BASE_CHECK, async (force: boolean) => {
    if (lastCheck && !force && Date.now() - lastCheck.checkedAt < 6 * 3600 * 1000) return lastCheck;
    lastCheck = await ns.check();
    return lastCheck;
  });
  handle(IPC.LF_BASE_DOWNLOAD, async (release: ReleaseInfo) => {
    const r = await ns.download(release);
    lastCheck = null;
    return r;
  });
  handle(IPC.LF_FILE_INSPECT, async (folder: string, fileName: string, lastHash?: string) => {
    const st = await store.load();
    return inspectTarget(gameFolder(folder || st.settings.gameFolder), fileName, lastHash);
  });
  handle(IPC.LF_FILE_WRITE, async (req: WriteRequest) => {
    const st = await store.load();
    return writeFilterFile({ ...req, folder: gameFolder(req.folder || st.settings.gameFolder) }, { dir: backupsDir, keep: st.settings.backups });
  });
  handle(IPC.LF_FILE_READ, async (path: string) => readFile(path, 'utf8'));
  handle(IPC.LF_FOLDER_CHOOSE, async (current: string) => {
    const w = deps.getWindow();
    const st = await store.load();
    const opts = { title: mt('lf_game_folder'), defaultPath: gameFolder(current || st.settings.gameFolder), properties: ['openDirectory' as const] };
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  handle(IPC.LF_FILE_IMPORT, async (): Promise<FilePick | null> => {
    const w = deps.getWindow();
    const st = await store.load();
    const opts = { title: mt('lf_open'), defaultPath: gameFolder(st.settings.gameFolder), properties: ['openFile' as const], filters: [{ name: mt('lf_open_files'), extensions: ['filter', 'pomrules', 'json'] }, { name: mt('all_files'), extensions: ['*'] }] };
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    const path = r.filePaths[0];
    if (r.canceled || !path) return null;
    return { path, name: path.replace(/^.*[\\/]/, '').replace(/\.(filter|pomrules)$/i, ''), text: await readFile(path, 'utf8') };
  });
  handle(IPC.LF_FILE_EXPORT, async (name: string, text: string) => {
    const w = deps.getWindow();
    const given = /\.([a-z]+)$/i.exec(name)?.[1]?.toLowerCase();
    const ext = given === 'pomrules' || given === 'json' ? given : 'filter';
    // .json: the recovery file of a failed save (the saved filters as filters.json holds them).
    const opts = { title: { pomrules: mt('lf_save_pack'), json: mt('lf_export_recovery'), filter: mt('lf_save_copy') }[ext], defaultPath: name, filters: [{ name: { pomrules: mt('lf_rule_packs'), json: mt('lf_recovery'), filter: mt('lf_filters') }[ext], extensions: [ext] }] };
    const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, text, 'utf8');
    return r.filePath;
  });
  handle(IPC.LF_PRICES, async (opts: { league?: string; force?: boolean }) => {
    const st = await store.load();
    return prices.getPrices({ league: opts?.league || st.settings.league || undefined, force: opts?.force ?? false });
  });
  handle(IPC.LF_HIDDEN_COUNTS, async (version: string) => hiddenCounts(ns, version, join(root, 'derived'), (await engineBases(engineDataDir)).bases));
  handle(IPC.LF_ENGINE_BASES, async () => engineBases(engineDataDir));
  handle(IPC.LF_REVEAL, async (path: string) => {
    shell.showItemInFolder(path);
  });
  handle(IPC.LF_DEFAULT_FOLDER, async () => gameFolder(''));
  handle(IPC.LF_RESIST_AFFIXES, async () => resistAffixes(engineDataDir));
  handle(IPC.LF_GEM_NAMES, async () => supportGemNames(engineDataDir));
  const cardStore = new CardRewardStore(join(root, 'cards.json'), join(app.isPackaged ? join(process.resourcesPath ?? '', 'lootfilter') : fileURLToPath(new URL('../../resources/lootfilter', import.meta.url)), 'cardRewards.json'));
  // The Build Filter's leveling stage comes from the leveling planner and its bundled data.
  const levelingDir = app.isPackaged ? join(process.resourcesPath ?? '', 'leveling') : fileURLToPath(new URL('../../resources/leveling', import.meta.url));
  let levelingData: ReturnType<typeof loadLevelingData> | null = null;
  // Parked leveling guide (shared/leagueContent.ts): no planner and no leveling data, so the build filter has no leveling stage.
  if (LEVELING_GUIDE) setPlanProvider(async (lite, override) => {
    levelingData ??= loadLevelingData(levelingDir);
    const { data, warning } = await levelingData;
    return { plan: planLeveling(lite, data, override), ...(warning ? { note: warning } : {}) };
  });
  handle(IPC.LF_BUILD_DATA, async () => loadGameData(engineDataDir));
  handle(IPC.LF_BUILD_PLAN, async (lite: Parameters<typeof planFor>[0], override?: string) => planFor(lite, override));
  handle(IPC.LF_BUILD_CARDS, async () => cardStore.get());
  handle(IPC.LF_BUILD_CANDIDATES, async (lite: Parameters<typeof planFor>[0]) => {
    if (!LEVELING_GUIDE) return [];
    levelingData ??= loadLevelingData(levelingDir);
    return candidateRows(lite, (await levelingData).data);
  });

  // Warm the numbers the Loot Filter shows first (the hidden-item counts take seconds the first time, and the price table
  // comes over the network) a few seconds after start, so the screen opens with them ready.
  const warm = setTimeout(() => {
    void (async () => {
      try {
        const st = await store.load();
        const active = await ns.resolveVersion(st.settings.baseVersion);
        void prices.getPrices({ league: st.settings.league || undefined, force: false }).catch(() => undefined);
        if (active) await hiddenCounts(ns, active, join(root, 'derived'), (await engineBases(engineDataDir)).bases);
      } catch {
        // the screen computes them itself when opened
      }
    })();
  }, 4000);
  warm.unref?.();
  handle(IPC.LF_CLIENT_LOG, async () => {
    const st = await store.load();
    return readClientLog(st.settings.clientLogPath);
  });
  handle(IPC.LF_FOLDER_LIST, async (folder: string) => {
    const st = await store.load();
    return listFilterFiles(gameFolder(folder || st.settings.gameFolder));
  });
  handle(IPC.LF_FOLDER_READ, async (folder: string, name: string) => {
    const st = await store.load();
    return readFilterFile(gameFolder(folder || st.settings.gameFolder), String(name));
  });
  handle(IPC.LF_FILES_EXIST, async (folder: string, names: string[]) => {
    const st = await store.load();
    return existingFiles(gameFolder(folder || st.settings.gameFolder), names);
  });
  handle(IPC.LF_SOUND_COPY, async (folder: string, wantedName: string) => {
    const w = deps.getWindow();
    const st = await store.load();
    const opts = { title: mt('lf_sound', { name: wantedName }), properties: ['openFile' as const], filters: [{ name: mt('lf_sounds'), extensions: ['mp3', 'wav', 'ogg'] }] };
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    const from = r.filePaths[0];
    if (r.canceled || !from) return null;
    const to = await copySoundInto(from, gameFolder(folder || st.settings.gameFolder), wantedName);
    return { from, to };
  });
  handle(IPC.LF_PICK_LOG, async () => {
    const w = deps.getWindow();
    const opts = { title: mt('lf_pick_log'), properties: ['openFile' as const], filters: [{ name: 'Client.txt', extensions: ['txt'] }] };
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });

  // On launch: look for a newer NeverSink release in the background. A download only happens when the player agrees.
  setTimeout(() => {
    void store.load().then(async (st) => {
      if (!st.settings.checkNeverSink) return;
      lastCheck = await ns.check();
    });
  }, 4000);

  return { store, ns, prices, cards: async () => (await cardStore.get()).cards };
}
