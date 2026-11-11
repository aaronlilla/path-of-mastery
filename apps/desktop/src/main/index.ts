import { app, BrowserWindow, dialog, ipcMain, net, powerMonitor, session, shell } from 'electron';
import { resolveBuildsDir } from './buildsPath.js';
import { setDefaultResultOrder } from 'node:dns';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpenBuildState } from '@pom/protocol';
import { loadConfig } from './config.js';
import { applyMainSettings } from './network.js';
import { findDeepLinkInArgv, parseDeepLink, PROTOCOLS, type DeepLinkRoute } from './deepLink.js';
import { startMastery, type Mastery } from './mastery/index.js';
import { startupMark } from './startupTrace.js';
import { composeAssistantAi } from './mastery/assistantGate.js';
import { allowClose, allowUnloadOnce, createMainWindow } from './windows.js';
import { exitWhenLauncherDies, launcherPid } from './automation.js';
import { TimelessInstaller } from './timelessData.js';
import type { TimelessInstallStatus } from '../shared/timelessStatus.js';
import { resolveEngineDataDir } from './engineDataDir.js';
import { APP_ID } from './appIdentity.js';

import { runClickBench } from './clickBench.js';

import { BuildStore } from './library/buildStore.js';
import { SettingsStore } from './library/settingsStore.js';
import { registerGameData } from './gameData.js';
import { registerLibraryIpc } from './libraryIpc.js';
import { registerWealthIpc } from './wealthIpc.js';
import { registerCharacterIpc } from './characterIpc.js';
import { setCharacterService } from './character/publicImport.js';
import { registerTraderIpc } from './traderIpc.js';
import { registerLootFilterIpc } from './lootFilterIpc.js';
import { registerLevelingIpc } from './leveling/ipc.js';
import { registerJourneyIpc } from './journey/ipc.js';
import { resistAffixes } from './lootfilter/derived.js';
import { registerSharedItemsIpc } from './sharedItemsIpc.js';
import { registerTreeLinkIpc } from './treeLinkIpc.js';
import { registerAiConnectionsIpc, registerAssistantIpc } from './assistantIpc.js';
import { registerAutomationReset } from './automationReset.js';

import { electronEngineProcessFactory } from './engineProcessAdapter.js';
import { EngineConnection } from './engineConnection.js';
import { registerIpcHandlers } from './ipcBridge.js';
import { fetchDownloader } from './updater/downloader.js';
import { generateKeyPairSync } from 'node:crypto';
import { importEd25519PublicKey } from './updater/signature.js';
import { EngineHotSwapController } from './updater/engineHotSwap.js';
import { clearStagedEngine, readStagedEngine, writeStagedEngine, type StagedEngine } from './updater/stagedEngine.js';
import { gateStaged, readManifestCache } from './updater/startupGate.js';
import { rm } from 'node:fs/promises';
import { InterfaceSwapController, readInterfaceMarker, writeInterfaceMarker } from './updater/interfaceSwap.js';
import { buildBundleDir, readBundle, verifyBundleDir } from './updater/interfaceBundle.js';
import { verifyDownloadedLayer } from './updater/signature.js';
import { AppShellUpdater } from './updater/appShellUpdater.js';
import { JsonFileAppUpdateStore } from './updater/jsonFileStore.js';
import { UpdateManager } from './updater/updateManager.js';
import { AutoUpdater } from './updater/autoUpdater.js';
import { loadInstallId } from './updater/releasePolicy.js';
import { UpdatePolicySource } from './updater/updatePolicySource.js';
import { makeSpawnInstaller, readInstallResult } from './updater/installerLaunch.js';
import { registerUpdateIpc } from './updateIpc.js';
import type { UpdateNotice } from '../shared/update.js';
import { createWebContentsRendererController } from './rendererController.js';
import { electronSecureStorage } from './secureStorage.js';
import { createAccountsHost, type AccountsHost } from './accounts/host.js';
import { measureShareStats } from './accounts/shareStats.js';
import { readStampedVersions, shownVersion } from './layerVersions.js';
import { backendConfig, loadBackend, setBackend } from './accounts/config.js';
import { accountChanged, setAccountSource, setLocalOnly } from './entitlements.js';
import { registerEntitlementsIpc } from './entitlementsIpc.js';
import { IPC } from '../shared/ipc.js';
import { loadGameData, planFor } from './lootfilter/buildData.js';
import { bundledProgressFile, makeGuideProvider } from './assistant/levelingTools.js';
import { LevelingStore } from './leveling/store.js';
import { LEVELING_GUIDE } from '../shared/leagueContent.js';
import { AppKb } from './kb/appKb.js';
import { KbService } from './kb/service.js';
import { registerKbIpc } from './kbIpc.js';
import { PreviewService } from './preview/service.js';
import { registerPreviewIpc } from './previewIpc.js';
import { mt, setMainLanguage } from './mainText.js';

// No page in this app may open a listening socket on the network: that is what makes Windows show its firewall prompt
// (Chromium's mDNS responder for WebRTC does it when a site such as the Path of Exile sign-in page probes for peers).
// The app's own local server binds to 127.0.0.1 only.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
app.on('web-contents-created', (_e, wc) => {
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
});

const ENGINE_HOST_ENTRY = fileURLToPath(new URL('../engine-host/main.js', import.meta.url));
// The numbers scripts/stamp-versions.mjs wrote when the app was built. The updater compares releases against these real
// versions; a build without them ('unknown', e.g. an unstamped dev run) keeps 'dev', which never matches a release.
const STAMPED_VERSIONS = readStampedVersions(new URL('../versions.json', import.meta.url));
// The hosted backend (accounts, cloud, site API) exists only in a build that was given its addresses at build time.
setBackend(loadBackend(new URL('../versions.json', import.meta.url), process.env, app.isPackaged));
setLocalOnly(!backendConfig());
const realOr = (v: string) => (/^\d+\.\d+\.\d+/.test(v) ? v : 'dev');
let CURRENT_ENGINE_VERSION = realOr(STAMPED_VERSIONS.engine);
let CURRENT_INTERFACE_VERSION = realOr(STAMPED_VERSIONS.interface);
const SHIPPED_INDEX = fileURLToPath(new URL('../renderer/index.html', import.meta.url));
const CURRENT_APP_VERSION = app.getVersion();

// A single build, in memory, until a real project/build-management layer exists.
let timelessInstaller: TimelessInstaller | null = null;
let mastery: Mastery | null = null;
const pendingItems: Extract<DeepLinkRoute, { kind: 'item' }>[] = [];
let openBuildState: OpenBuildState = { buildId: 'default', buildXml: '', undoStack: [], redoStack: [] };

/** The tables' state for the window: the installer's, or "ready" when a folder of plain tables was named. */
function timelessStatusNow(): TimelessInstallStatus {
  return timelessInstaller ? timelessInstaller.getStatus() : { state: 'ready', done: 0, total: 0, current: null, percent: 100, dir: process.env.POM_TIMELESS_DATA ?? '', notBundled: [] };
}

async function main(): Promise<void> {
  if (process.env.POM_USER_DATA) app.setPath('userData', process.env.POM_USER_DATA);
  console.log(`[app] user data: ${app.getPath('userData')}`);
  // The engine reads game data only from this folder, whatever the working directory is; the engine host and the
  // main-process readers inherit it. An installed app keeps its derived caches in user data (the install may be read-only).
  const engineData = resolveEngineDataDir({
    env: process.env,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  if (engineData) process.env.POM_ENGINE_DATA = engineData;
  if (app.isPackaged) process.env.POM_PJS_DIR ??= join(app.getPath('userData'), 'engine-cache');
  // The timeless jewel tables: the app ships them compressed (resources/timeless) and inflates them into the
  // user-data folder when a build or the search needs them. POM_TIMELESS_DATA names a folder of plain tables
  // instead (a development checkout), and then nothing is inflated. The engine host inherits the folder.
  const bundledTimeless = app.isPackaged ? join(process.resourcesPath, 'timeless') : join(app.getAppPath(), 'resources', 'timeless');
  if (!process.env.POM_TIMELESS_DATA && existsSync(join(bundledTimeless, 'manifest.json'))) {
    const tables = join(app.getPath('userData'), 'timeless-data');
    timelessInstaller = new TimelessInstaller(bundledTimeless, tables);
    await timelessInstaller.prepare();
    process.env.POM_TIMELESS_DATA = tables;
  }
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  // A dev run (electron .) must tell the OS which script to open with the link; an installed app does not.
  // POM_NO_PROTOCOL_REGISTER keeps test runs from taking the player's pathofmastery:// handler.
  if (!process.env.POM_NO_PROTOCOL_REGISTER) {
    for (const scheme of PROTOCOLS) {
      if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient(scheme, process.execPath, [resolve(process.argv[1])]);
      else app.setAsDefaultProtocolClient(scheme);
    }
  }
  // A sign-in link can arrive before the accounts host exists (it may be what launched the app).
  let resolveAccounts: (a: AccountsHost) => void = () => undefined;
  const accountsReady = new Promise<AccountsHost>((r) => (resolveAccounts = r));

  // Owned here, not in the renderer: whatever needs OS-keychain-backed
  // secrets later (cloud-build auth tokens, etc.) goes through this, never
  // through a value handed to the renderer to hold onto itself.
  if (!electronSecureStorage.isAvailable()) {
    console.warn('safeStorage encryption is not available on this platform/session');
  }

  const config = loadConfig(process.env, { isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
  // Without a configured update key the app still starts, with a throwaway key whose private half no one has:
  // every update signature then fails to verify, so updates are refused rather than trusted.
  const updateSigningKey = config.updateSigningPublicKey
    ? importEd25519PublicKey(config.updateSigningPublicKey)
    : generateKeyPairSync('ed25519').publicKey;
  const userDataDir = app.getPath('userData');
  const stagingDir = join(userDataDir, 'updates');
  await mkdir(stagingDir, { recursive: true });

  const appUpdateStore = new JsonFileAppUpdateStore(join(userDataDir, 'pending-app-update.json'));
  const appShellUpdater = new AppShellUpdater(
    {
      downloader: fetchDownloader,
      publicKey: updateSigningKey,
      stagingDir,
      store: appUpdateStore,
      // A hidden helper waits for this process to exit, runs the installer silently and starts the app again (installerLaunch.ts).
      spawnInstaller: makeSpawnInstaller({ execPath: process.execPath, argv: process.argv.slice(1), stagingDir, pid: process.pid }),
    },
    CURRENT_APP_VERSION,
  );
  // What the last install attempt did (the helper's record): "Updated to x" or "the update did not install".
  let startupNotice: UpdateNotice | null = await readInstallResult(stagingDir, CURRENT_APP_VERSION).catch(() => null);
  const installId = await loadInstallId(join(userDataDir, 'update-install-id')).catch(() => '');

  // Set once the main window exists; links and relaunches that arrive earlier are queued (no access to `window` before that).
  let mainReady = false;
  const earlyRoutes: DeepLinkRoute[] = [];
  app.on('second-instance', (_event, argv) => {
    const link = findDeepLinkInArgv(argv);
    if (link) handleDeepLink(link);
    else if (mainReady) showMainWindow();
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  // Groups the taskbar button under the app and ties it to the window icon (matches appId in electron-builder.yml).
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  // An app opened from Finder or a desktop launcher gets a bare PATH, so the claude/codex command lines (installed by npm, brew or their own installers) would not be found.
  else process.env.PATH = [process.env.PATH, join(homedir(), '.local', 'bin'), join(homedir(), '.claude', 'local'), join(homedir(), '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':');
  await app.whenReady();
  startupMark('app ready');
  exitWhenLauncherDies({ env: process.env, ppid: launcherPid(process.env, process.ppid), markerDir: app.getPath('userData'), exit: () => app.exit(0) });

  const buildsDir = resolveBuildsDir(userDataDir);
  const store = new BuildStore(buildsDir, join(userDataDir, 'Recently deleted'));
  await store.init();
  const settingsStore = new SettingsStore(join(userDataDir, 'settings.json'));

  // The dashboard's unsigned update policy (pause, block, required, rollout below the signed ceiling); last good copy
  // cached. Loaded before anything staged is used: the next-launch gate judges staged layers with it (startupGate.ts).
  const updatePolicy = new UpdatePolicySource({ url: config.remoteConfigUrl, cacheFile: join(userDataDir, 'update-policy.json'), log: (m) => console.log(`[updater] ${m}`) });
  await updatePolicy.load();
  const manifestCacheFile = join(stagingDir, 'manifest-cache.json');
  const cachedManifest = await readManifestCache(manifestCacheFile, updateSigningKey);
  const gate = (name: 'engine' | 'interface', staged: import('@pom/protocol').UpdateLayer, running: string) =>
    gateStaged({ name, staged, cached: cachedManifest?.layers[name] ?? null, policy: updatePolicy.current(), channel: config.channel, running, seed: installId, installedApp: CURRENT_APP_VERSION });

  // An engine update that was verified during the last run starts now (it never replaces the engine under open builds),
  // when the last known policy still offers it: paused or held back, it waits unused; blocked, it is deleted.
  let stagedEngine: StagedEngine | null = await readStagedEngine(stagingDir, updateSigningKey);
  let heldEngine: string | null = null;
  const iface = await readInterfaceMarker(stagingDir);
  // Spec 10-admin 8.2 step 4: before a staged engine or interface is used, the live policy is asked (bounded by the policy
  // source's 3 s deadline), so a release paused or blocked since the last run is never shown. No answer in time, or
  // offline: the cached policy decides. Nothing staged: the start does not wait.
  if (stagedEngine?.layer || iface) {
    const t0 = Date.now();
    const live = await updatePolicy.refresh().catch(() => ({ ok: false, changed: false }));
    console.log(`[updater] start-up policy for the staged update: ${live.ok ? 'live answer' : 'no answer, cached policy'} (${Date.now() - t0} ms)`);
  }
  if (stagedEngine?.layer) {
    const verdict = gate('engine', stagedEngine.layer, CURRENT_ENGINE_VERSION);
    if (verdict !== 'load') {
      console.warn(`[updater] the staged engine ${stagedEngine.version} is ${verdict === 'hold' ? 'held' : 'deleted'} by the update policy`);
      if (verdict === 'hold') heldEngine = stagedEngine.version;
      else {
        await clearStagedEngine(stagingDir).catch(() => {});
        await rm(stagedEngine.packPath, { force: true }).catch(() => {});
      }
      stagedEngine = null;
    }
  }
  if (stagedEngine) CURRENT_ENGINE_VERSION = stagedEngine.version;
  const engineEnv: Record<string, string> = stagedEngine
    ? { POM_NATIVE_ENGINE_PATH: stagedEngine.packPath }
    : config.nativeEngineModulePath
      ? { POM_NATIVE_ENGINE_PATH: config.nativeEngineModulePath }
      : {};
  const engineProcess = electronEngineProcessFactory({ modulePath: ENGINE_HOST_ENTRY, env: engineEnv });
  const engineConnection = new EngineConnection(engineProcess);
  if (stagedEngine) {
    // A staged engine that cannot start is dropped: the next start runs the bundled engine again.
    const off = engineConnection.onEvent((e) => {
      if (e.type !== 'status') return;
      if (e.status.state === 'ready') off();
      else if (e.status.state === 'error' || e.status.state === 'unavailable') {
        off();
        void clearStagedEngine(stagingDir);
      }
    });
  }

  // An interface update swapped in (or staged) during an earlier run starts now, when it was built for this app version and
  // its archive (signature, sha256) and code files still verify. Otherwise the shipped interface loads and the marker goes.
  let startIndex: string | undefined;
  let heldInterface: Awaited<ReturnType<typeof readInterfaceMarker>> = null;
  if (iface) {
    const good = iface.forApp === CURRENT_APP_VERSION
      && (await verifyDownloadedLayer('interface', iface.layer, iface.archivePath, updateSigningKey).catch(() => ({ ok: false }))).ok
      && (await verifyBundleDir(dirname(iface.indexPath), readBundle(await readFile(iface.archivePath)).files).catch(() => false));
    const verdict = good ? gate('interface', iface.layer, CURRENT_INTERFACE_VERSION) : 'delete';
    if (verdict === 'hold') {
      console.warn(`[updater] the staged interface ${iface.version} is held by the update policy`);
      heldInterface = iface;
    } else if (verdict === 'load') {
      startIndex = iface.indexPath;
      CURRENT_INTERFACE_VERSION = iface.version;
    } else {
      console.warn(`[updater] the staged interface ${iface.version} is not used (built for ${iface.forApp}, no longer verifies, or the update policy blocks it)`);
      await writeInterfaceMarker(stagingDir, null, CURRENT_APP_VERSION).catch(() => {});
      await rm(iface.archivePath, { force: true }).catch(() => {});
      await rm(dirname(iface.indexPath), { recursive: true, force: true }).catch(() => {});
    }
  }
  let window = createMainWindow(startIndex);
  startupMark('main window created');
  window.webContents.once('did-finish-load', () => startupMark('page loaded'));
  runClickBench(window);
  mainReady = true;
  for (const route of earlyRoutes.splice(0)) window.webContents.once('did-finish-load', () => window.webContents.send('pom:deep-link', route));

  const engineHotSwap = new EngineHotSwapController(
    {
      downloader: fetchDownloader,
      publicKey: updateSigningKey,
      processFactory: electronEngineProcessFactory,
      stagingDir,
      engineHostEntryPath: ENGINE_HOST_ENTRY,
      onStaged: (staged) => writeStagedEngine(stagingDir, staged),
      onDropped: async () => {
        const marker = await readStagedEngine(stagingDir);
        await clearStagedEngine(stagingDir);
        if (marker) await rm(marker.packPath, { force: true }).catch(() => {});
      },
    },
    engineProcess,
    CURRENT_ENGINE_VERSION,
  );
  // A held engine stays staged, so the policy gate sees it (and Restart now offers it once the policy allows).
  if (heldEngine) engineHotSwap.adoptStaged(heldEngine);

  const currentBundle = (): string => interfaceSwap.getCurrentBundlePath();
  const interfaceSwap: InterfaceSwapController = new InterfaceSwapController(
    {
      downloader: fetchDownloader,
      publicKey: updateSigningKey,
      stagingDir,
      // The whole renderer bundle: the files the archive carries plus the unchanged ones from the bundle running now or
      // the shipped one, every file checked against the signed list (interfaceBundle.ts).
      extractBundle: async (archivePath: string, destDir: string): Promise<string> =>
        (await buildBundleDir(archivePath, destDir, [dirname(currentBundle()), dirname(SHIPPED_INDEX)])).indexPath,
      onStaged: (staged) => writeInterfaceMarker(stagingDir, staged, CURRENT_APP_VERSION),
    },
    createWebContentsRendererController(() => window.webContents, () => allowUnloadOnce(window)),
    CURRENT_INTERFACE_VERSION,
    startIndex ?? SHIPPED_INDEX,
  );
  if (heldInterface) interfaceSwap.adoptStaged(heldInterface);

  const updateManager = new UpdateManager({
    manifestBaseUrl: config.updateManifestBaseUrl,
    publicKey: updateSigningKey,
    installId,
    policy: updatePolicy,
    manifestCacheFile,
    channel: config.channel,
    engineSwap: engineHotSwap,
    interfaceSwap,
    appShellUpdater,
    getOpenBuildState: () => openBuildState,
    emit: (event) => { if (!window.isDestroyed()) window.webContents.send('pom:engine-event', event); },
  });

  // Settings the main process owns: the update channel (Beta builds), the proxy and the address family.
  const nodeFetch = globalThis.fetch;
  const applySettings = (s: import('../shared/library.js').AppSettings) =>
    void applyMainSettings(s, {
      setProxy: (rules) => session.defaultSession.setProxy(rules ? { mode: 'fixed_servers', proxyRules: rules } : { mode: 'system' }),
      setDnsOrder: setDefaultResultOrder,
      routeFetchThroughChromium: (on) => {
        globalThis.fetch = on ? (((input: RequestInfo | URL, init?: RequestInit) => net.fetch(input as string, init as never)) as typeof fetch) : nodeFetch;
      },
      setUpdateChannel: (c) => updateManager.setChannel(c),
    }).catch((e: unknown) => console.warn('Could not apply the network settings:', e instanceof Error ? e.message : e));
  settingsStore.onChange(applySettings);
  void settingsStore.get().then(applySettings);

  registerIpcHandlers(window.webContents, engineConnection, updateManager);

  // Automatic updates (autoUpdater.ts): an official release build checks on its own (a build you make yourself never does,
  // so it cannot replace itself with the official installer); a development run only when it is pointed at a manifest
  // (POM_UPDATE_MANIFEST_URL), so test runs never reach the real site. POM_UPDATE_AUTO=0 turns it off.
  const sendToWindow = (channel: string, payload: unknown) => { if (!window.isDestroyed()) window.webContents.send(channel, payload); };
  const autoUpdater = new AutoUpdater({
    manager: updateManager,
    appShell: appShellUpdater,
    emitStatus: (s) => sendToWindow(IPC.UPDATE_STATUS, s),
    emitNotice: (n) => sendToWindow(IPC.UPDATE_NOTICE, n),
    isOnline: () => net.isOnline(),
    refreshPolicy: () => updatePolicy.refresh(),
    log: (m) => console.log(`[updater] ${m}`),
  });
  /** Set by Restart now: 'install' runs the installer as this process exits and starts the new version; 'relaunch' only restarts (a staged engine). */
  let restartMode: 'none' | 'install' | 'relaunch' = 'none';
  registerUpdateIpc({
    status: () => autoUpdater.getStatus(),
    takeStartupNotice: () => { const n = startupNotice; startupNotice = null; return n; },
    restart: async () => {
      // The page froze input, saved, asked prepareApply (the network policy check) and saved again; here only the last
      // known decision is checked, so nothing slow sits between the page's final save and the restart or swap.
      const s = autoUpdater.getStatus();
      if (s.phase !== 'ready' || !s.kind || !s.version) return { ok: false, reason: 'The update is no longer ready.' };
      if (updateManager.gateCached(s.kind, s.version)?.action !== 'offer') {
        autoUpdater.clearReady();
        return { ok: false, reason: 'This update was paused or withdrawn, so nothing was changed.' };
      }
      if (s.kind === 'interface') {
        // A UI-only update: the page saved its documents; the new bundle goes into this window, no restart. The reply
        // is sent first (the page that asked is about to be replaced); the new page hears how it went as a notice.
        // The new page must not mount on a "ready" status (it would offer the update it is already running).
        autoUpdater.clearReady();
        setTimeout(() => {
          void interfaceSwap.swapNow().then((out) => {
            if (out.type === 'switched') {
              autoUpdater.clearReady();
              sendToWindow(IPC.UPDATE_NOTICE, { kind: 'interfaceApplied', version: out.version });
              sendToWindow(IPC.UPDATE_STATUS, autoUpdater.getStatus());
            } else {
              console.warn(`[updater] interface swap failed, the previous interface is back: ${out.type === 'updateFailed' ? out.message : out.type}`);
              autoUpdater.clearReady();
              sendToWindow(IPC.UPDATE_NOTICE, { kind: 'installFailed', version: s.version ?? '' });
            }
          });
        }, 50);
        return { ok: true };
      }
      // The page has saved every open document. An open Run saves its position and closes, as with "Close both".
      const run = mastery?.run;
      if (run?.hasRunWindow()) await run.mainClosing('close_both');
      restartMode = s.kind === 'app' ? 'install' : 'relaunch';
      if (restartMode === 'relaunch') app.relaunch({ args: process.argv.slice(1).filter((a) => !a.startsWith('--updated')) });
      for (const w of BrowserWindow.getAllWindows()) allowClose(w);
      app.quit();
      return { ok: true };
    },
    prepareApply: async () => {
      if (autoUpdater.getStatus().phase !== 'ready') return { ok: false, reason: 'The update is still downloading.' };
      const gateNow = await autoUpdater.recheckBeforeApply();
      return gateNow.ok ? { ok: true } : { ok: false, reason: gateNow.reason ?? 'This update was paused or withdrawn, so nothing was changed.' };
    },
    quit: () => app.quit(),
  });
  // Install on quit (electron-updater's autoInstallOnAppQuit): after every store drained, the helper waits for this process to end.
  // Only an app update that the last policy check (at quit, see the quit barrier) still offers is installed.
  app.on('will-quit', () => {
    if (restartMode === 'install') appShellUpdater.launchOnQuit(true);
    else if (restartMode === 'none' && autoUpdater.mayInstallOnQuit()) appShellUpdater.launchOnQuit(false);
  });
  const autoUpdates = process.env.POM_UPDATE_AUTO !== '0' && (STAMPED_VERSIONS.official || !!process.env.POM_UPDATE_MANIFEST_URL || process.env.POM_UPDATE_AUTO === '1');
  if (autoUpdates) {
    void autoUpdater.start();
    powerMonitor.on('resume', () => autoUpdater.onResume());
    app.on('before-quit', () => autoUpdater.stop());
  }
  const accounts = await createAccountsHost({
    dataDir: userDataDir,
    store,
    secure: electronSecureStorage,
    fetch: (url, init) => net.fetch(url, init as RequestInit),
    openExternal: (url) => shell.openExternal(url),
    onView: (v) => {
      if (!window.isDestroyed()) window.webContents.send(IPC.ACCT_CHANGED, v);
    },
    onLibraryChanged: (ids) => {
      if (!window.isDestroyed()) window.webContents.send(IPC.LIB_CHANGED, ids);
    },
    measureStats: (xml) => measureShareStats(engineConnection, xml),
    ...(backendConfig() ? { siteOrigin: backendConfig()!.siteOrigin } : {}),
  });
  ipcMain.handle(IPC.ACCT_CALL, async (_e, method: string, args: unknown[]) => {
    try {
      return { ok: true, value: await accounts.call(method, args ?? []) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  resolveAccounts(accounts);
  // AI features need a signed-in account; the hosted service checks every request (main enforces it, not the window).
  setAccountSource(() => accounts.service.user?.id ?? null);
  registerEntitlementsIpc(() => (window.isDestroyed() ? null : window));
  accounts.service.onChange(() => accountChanged());
  // Silent sign-in from the stored session; the window opens and works while it runs.
  void accounts.start();
  registerLibraryIpc({
    sync: accounts.hooks,
    store,
    settings: settingsStore,
    engine: engineConnection,
    buildsDir,
    getWindow: () => (window.isDestroyed() ? null : window),
    timelessStatus: timelessStatusNow,
    versions: () => ({ engine: shownVersion(engineHotSwap.getCurrentVersion(), STAMPED_VERSIONS.engine), interface: shownVersion(interfaceSwap.getCurrentVersion(), STAMPED_VERSIONS.interface) }),
    timelessInstall: () => {
      if (timelessInstaller) void timelessInstaller.ensure();
      return timelessStatusNow();
    },
    // Check for update's Update button: the same pass as the automatic checks, so the pill and restart toast follow.
    checkForUpdates: async () => {
      const status = await autoUpdater.check({ manual: true });
      return { status, failed: autoUpdater.lastFailure() };
    },
    updateAvailable: async () => {
      return updateManager.checkAvailable();
    },
  });
  registerGameData();

  // Atlas, Timelines, Run, Marketplace, documents and workspaces. A failure here leaves Builds/Wealth/Loot Filter working.
  // Not awaited: the stores open while the rest of main registers its handlers (the page asks for those at once).
  let attachCloseGuard: ((win: BrowserWindow) => void) | null = null;
  /** The main window may have been closed with "Keep Run open": bring it back (or create it again) and focus it. */
  function showMainWindow(): boolean {
    let created = false;
    if (window.isDestroyed()) {
      window = createMainWindow(interfaceSwap.getCurrentBundlePath());
      attachCloseGuard?.(window);
      created = true;
    }
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
    return created;
  }
  const masteryStarted = (async () => { try {
    mastery = await startMastery({
      userDataDir,
      accounts,
      secure: electronSecureStorage,
      mainWindow: () => (window.isDestroyed() ? null : window),
      showMainWindow: () => showMainWindow(),
      devServerUrl: process.env.POM_RENDERER_DEV_SERVER_URL || null,
      library: { list: async () => (await store.list()).builds, readXml: async (id) => (await store.read(id)).xml, signature: (id) => store.signature(id) },
    });
    startupMark('mastery started');
    for (const route of pendingItems.splice(0)) mastery.openItem(route);
    // Closing the main window while a Run window is open: the player chooses. The Run survives "Keep".
    attachCloseGuard = (win: BrowserWindow) => {
    let closeDecided = false;
    win.on('close', (event) => {
      const run = mastery?.run;
      if (closeDecided || !run || !run.hasRunWindow()) return;
      event.preventDefault();
      void dialog.showMessageBox(win, {
        type: 'question', title: 'Path of Mastery', message: mt('run_open'),
        detail: mt('run_detail'),
        buttons: [mt('run_keep'), mt('run_both'), mt('cancel')], defaultId: 0, cancelId: 2, noLink: true,
      }).then(async ({ response }) => {
        if (response === 2) return;
        await run.mainClosing(response === 0 ? 'keep_run_open' : 'close_both').catch((e: unknown) => console.warn('Run close:', e));
        closeDecided = true;
        if (!win.isDestroyed()) win.close();
      });
    });
    };
    attachCloseGuard(window);
  } catch (e) {
    console.warn('The Atlas, Timelines and Marketplace services could not start:', e instanceof Error ? e.stack ?? e.message : String(e));
  } })();
  let draining = false;
  app.on('before-quit', (event) => {
    if (draining) return;
    // Quit barrier: Run and document stores finish their writes, and whatever update waits is judged once more against
    // the policy (a few seconds at most), before the process exits.
    event.preventDefault();
    draining = true;
    const m = mastery;
    mastery = null;
    void Promise.all([m?.quit(), restartMode === 'none' ? autoUpdater.beforeQuit() : undefined]).finally(() => app.quit());
  });

  // The sample stash (POM_WEALTH_SAMPLE) stays offline unless a backend is named, so a test run never reaches the real project.
  const communityApi = accounts.community.api;
  const wealth = registerWealthIpc(
    () => (window.isDestroyed() ? null : window),
    !backendConfig() || (process.env.POM_WEALTH_SAMPLE === '1' && !process.env.POM_SUPABASE_URL)
      ? undefined
      : {
          index: (league) => communityApi.strategyIndex(league),
          submit: (row) => communityApi.submitStrategySession(row),
          signedIn: () => accounts.community.signedIn(),
          userName: () => accounts.service.user?.name ?? '',
          bulk: {
            view: (l) => communityApi.bulkView(l),
            post: (i) => communityApi.bulkPost(i),
            heartbeat: () => communityApi.bulkHeartbeat(),
            vote: (id, k) => communityApi.bulkVote(id, k),
            offer: (id, m, n) => communityApi.bulkOffer(id, m, n),
            remove: (id) => communityApi.bulkRemove(id),
          },
        },
  );
  wealth.attachEngine(engineConnection);
  const character = registerCharacterIpc({ wealth, userDataDir, engine: engineConnection });
  setCharacterService(character);
  registerTraderIpc(wealth);
  const lootFilter = registerLootFilterIpc({ getWindow: () => (window.isDestroyed() ? null : window) });
  // The leveling guide and Journey are parked (shared/leagueContent.ts): no leveling data, progress watcher or Journey service.
  if (LEVELING_GUIDE) {
    const leveling = registerLevelingIpc({ getWindow: () => (window.isDestroyed() ? null : window), lootStore: lootFilter.store });
    registerJourneyIpc({ getWindow: () => (window.isDestroyed() ? null : window), wealth, lootStore: lootFilter.store, levelingStore: leveling.store });
  }
  let sharedItemsLocalChanged = (): void => {};
  const sharedItems = registerSharedItemsIpc(() => (window.isDestroyed() ? null : window), () => sharedItemsLocalChanged());
  sharedItemsLocalChanged = accounts.attachSharedItems(sharedItems).localChanged;
  registerTreeLinkIpc();

  // The assistant's modules (the tool server and its schemas) load a moment after the page has loaded. As a static import
  // they held the window back by about 230 ms at every start; loaded any earlier they block the main process while the
  // page asks it for its preload script and the Library list. Its handlers are registered at once and wait for it.
  const pageLoaded = new Promise<void>((done) => {
    window.webContents.once('did-finish-load', () => setTimeout(done, 1500));
    setTimeout(done, 6000);
  });
  let resolveKb!: (k: KbService) => void;
  const kbReady = new Promise<KbService>((r) => (resolveKb = r));
  registerKbIpc(kbReady, () => (window.isDestroyed() ? null : window));
  // The next-league preview: a second engine host on the overlay's data dir (the engine reads one data dir per process),
  // started only when the window first asks for a preview number. POM_PREVIEW_DIR names an applied overlay dir (dev).
  const preview = new PreviewService({
    liveDataDir: process.env.POM_ENGINE_DATA ?? '',
    userDataDir,
    devDir: process.env.POM_PREVIEW_DIR || undefined,
    spawn: (dir) => electronEngineProcessFactory({ modulePath: ENGINE_HOST_ENTRY, env: { ...engineEnv, POM_ENGINE_DATA: dir } }),
    log: (m) => console.log(m),
  });
  registerPreviewIpc(pageLoaded.then(() => preview.start()).then(() => preview));
  app.on('before-quit', () => preview.stop());
  const assistantReady = (async () => {
    await pageLoaded;
    await masteryStarted; // the AI gate lives in the mastery context
    const [{ AssistantService }, { wealthPriceSource, uniqueDivines }, { wealthTradeSource }] = await Promise.all([
      import('./assistant/service.js'),
      import('./assistant/wealthPrices.js'),
      import('./assistant/wealthTrade.js'),
    ]);
    const libChanged = (ids: string[]) => {
      if (!window.isDestroyed()) window.webContents.send(IPC.LIB_CHANGED, ids);
    };
    // The game knowledge base: the assistant's game facts (searchGame, lookupGame, patchChanges, getMechanic).
    const resourcesDir = app.isPackaged ? process.resourcesPath : fileURLToPath(new URL('../../resources', import.meta.url));
    const kb = new AppKb({ resourcesDir, userDataDir, log: (m) => console.log(m) });
    // Keeps the KB at the live patch: checks on start and every 45 min, rebuilds in the background, tells the window.
    const kbService = new KbService({
      appKb: kb,
      cacheDir: join(userDataDir, 'kb', 'cache'),
      app: { levelingDir: join(resourcesDir, 'leveling'), lootfilterDir: join(resourcesDir, 'lootfilter'), engineDataDir: process.env.POM_ENGINE_DATA ?? '' },
      log: (m) => console.log(m),
    });
    resolveKb(kbService);
    void kbService.start().catch((e: unknown) => console.warn('The game knowledge base could not start:', e instanceof Error ? e.message : String(e)));
    app.on('before-quit', () => kbService.stop());
    let assistantRef: InstanceType<typeof AssistantService> | null = null;
    const aiDeps = mastery ? composeAssistantAi(mastery.ctx, mastery.run?.librarySources ?? null, () => assistantRef?.openContext() ?? null) : {};
    // The assistant answers in the app language (English: no line). 'system' follows the OS language like the renderer does.
    const LANGUAGE_NAMES: Record<string, string> = { de: 'German', es: 'Spanish', fr: 'French', ja: 'Japanese', ko: 'Korean', 'pt-BR': 'Brazilian Portuguese', ru: 'Russian', th: 'Thai' };
    let assistantLanguage: string | undefined;
    const readLanguage = (s: { language: string }): void => {
      setMainLanguage(s.language, app.getLocale());
      const l = (s.language === 'system' ? app.getLocale() : s.language).toLowerCase();
      assistantLanguage = LANGUAGE_NAMES[l.startsWith('pt') ? 'pt-BR' : Object.keys(LANGUAGE_NAMES).find((c) => c !== 'pt-BR' && l.startsWith(c)) ?? ''];
    };
    settingsStore.onChange(readLanguage);
    void settingsStore.get().then(readLanguage);
    const assistant = new AssistantService({
    ...aiDeps,
    language: () => assistantLanguage,
    engine: engineConnection,
    dataDir: userDataDir,
    kb,
    version: app.getVersion(),
    // Claude Desktop runs this file itself, so an installed app keeps it outside app.asar (extraResources in electron-builder.yml).
    bridgePath: app.isPackaged ? join(process.resourcesPath, 'mcp', 'bridge.cjs') : fileURLToPath(new URL('../mcp/bridge.cjs', import.meta.url)),
    prices: wealthPriceSource(wealth),
    trade: wealthTradeSource(wealth),
    uniquePrices: async () => uniqueDivines(wealth),
    library: {
      async save(name, xml) {
        const e = await store.create('', name, xml);
        accounts.hooks.created(e.id);
        libChanged([e.id]);
        return { id: e.id, name: e.name };
      },
      list: () => store.list(),
      read: (id) => store.read(id),
      // The same store calls and sync hooks as the Library's own buttons (libraryIpc.ts).
      async rename(id, name) {
        const e = await store.renameBuild(id, name);
        if (e.id !== id) accounts.hooks.renamed(id, e.id);
        libChanged([id, e.id]);
        return e;
      },
      async move(id, folder) {
        const e = await store.move(id, folder);
        if (e.id !== id) accounts.hooks.renamed(id, e.id);
        libChanged([id, e.id]);
        return e;
      },
      async remove(id) {
        const t = await store.remove(id);
        accounts.hooks.removed(id);
        libChanged([id]);
        return t;
      },
    },
    shared: sharedItems,
    character,
    wealth,
    });
    assistantRef = assistant;
    const engineDataDir = (): string => process.env.POM_ENGINE_DATA ?? '';
    const levelingDir = app.isPackaged ? join(process.resourcesPath ?? '', 'leveling') : fileURLToPath(new URL('../../resources/leveling', import.meta.url));
    assistant.setLootContext({
      store: lootFilter.store,
      ns: lootFilter.ns,
      prices: async () => (await lootFilter.prices.getPrices()).table,
      build: {
        game: () => loadGameData(engineDataDir()),
        plan: planFor,
        cards: () => lootFilter.cards(),
        affixes: () => resistAffixes(engineDataDir()),
        ...(LEVELING_GUIDE ? {
          guide: makeGuideProvider(levelingDir, engineDataDir(), () => loadGameData(engineDataDir())),
          ticked: (id: string) => new LevelingStore(bundledProgressFile(app.getPath('userData'))).get(id).ticked,
        } : {}),
      },
    });
    return assistant;
  })();
  registerAssistantIpc(assistantReady, () => (window.isDestroyed() ? null : window));
  registerAiConnectionsIpc(assistantReady, () => (window.isDestroyed() ? null : window));
  void assistantReady
    .then((a) => a.start())
    .catch((e: unknown) => console.warn('The assistant tools could not start:', e instanceof Error ? e.message : String(e)));
  app.on('before-quit', () => void assistantReady.then((a) => a.stop()));
  // Scripted runs: a way back to a clean state without a restart (no-op outside POM_AUTOMATION=1).
  registerAutomationReset({ settings: settingsStore, getWindow: () => (window.isDestroyed() ? null : window) });

  function handleDeepLink(url: string): void {
    const route = parseDeepLink(url);
    if (route.kind === 'unknown') return;
    if (route.kind === 'authCallback') {
      void accountsReady.then((a) => a.handleDeepLink(route.url));
      return;
    }
    if (route.kind === 'item') {
      // Cold start: queued until the Marketplace is ready; the renderer also asks for it once it mounts.
      if (mastery) mastery.openItem(route);
      else pendingItems.push(route);
      if (mainReady) showMainWindow();
      return;
    }
    if (!mainReady) { earlyRoutes.push(route); return; }
    showMainWindow();
    const target = window;
    if (target.webContents.isLoading()) target.webContents.once('did-finish-load', () => { if (!target.isDestroyed()) target.webContents.send('pom:deep-link', route); });
    else target.webContents.send('pom:deep-link', route);
  }

  const initialLink = findDeepLinkInArgv(process.argv);
  if (initialLink) handleDeepLink(initialLink);

  app.on('activate', () => {
    if (mainReady && window.isDestroyed()) showMainWindow();
    else if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}

app.on('window-all-closed', () => {
  // A Run window is independent of the main window: closing main alone must not end a Run.
  if (mastery?.hasRunWindow()) return;
  if (process.platform !== 'darwin') app.quit();
});

void main();
