import type { GameData, CardRewards } from '../shared/lootfilter/profile.js';
import type { LevelingPlan, LevelingProfileLite } from '../shared/leveling/types.js';
import type { TimelessInstallStatus } from '../shared/timelessStatus.js';
import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { autoUiScale } from '../shared/uiScale.js';
import { levelingBridge } from './leveling.js';
import { journeyBridge } from './journey.js';
import type { JourneyBridge } from '../shared/journey/ipcTypes.js';
import type { JourneyLiveBridge } from '../shared/journey/liveExtra.js';
import type { LevelingBridge } from '../shared/leveling/ipcTypes.js';
import type { CommandName, CommandParams, CommandResult, EngineEvent, EngineErrorPayload, SolveGoal } from '@pom/protocol';
import { IPC } from '../shared/ipc.js';
import type { RestartResult, UpdateNotice, UpdateStatus } from '../shared/update.js';
import type {
  AppInfo,
  UpdateOffer,
  AppSettings,
  BuildEntry,
  DecodedImport,
  EngineBuildSummary,
  FolderEntry,
  GameInfo,
  SpectreInfo,
  TreeNodeInfo,
  LibraryListing,
  OpenedBuild,
  Result,
  TrashEntry,
} from '../shared/library.js';
import type { ResistAffix } from '../shared/lootfilter/buildRules.js';
import type { DeepLinkRoute } from '../main/deepLink.js';
import type { SharedItems } from '../shared/sharedItems.js';
import type { WealthApi } from '../shared/wealth.js';
import type { CharacterAccess, CharacterBundle, CharacterFetchRequest, CharacterImportResult, CharacterList, ImportParts, Realm } from '../shared/characterImport.js';
import type { ShareSiteId } from '../shared/buildSites.js';
import type { TraderApi } from '../shared/trader.js';
import type { AccountApi, AccountView } from '../shared/accounts.js';
import type { EntitlementView } from '../shared/entitlements.js';
import type { KbUiStatus } from '../shared/kbStatus.js';
import type { PreviewCommand, PreviewInfo } from '../shared/preview.js';
import type {
  ApplyResult,
  AssistantContextInfo,
  AssistantPrefs,
  AssistantPush,
  ConnectorInfo,
  Proposal,
  ProviderId,
  ProviderStatus,
  SendRequest,
  SolveCpu,
  SolveDetails,
  SolveState,
  Thread,
} from '../shared/assistant/types.js';
import type {
  BaseVersionInfo,
  ClientLogInfo,
  EngineBases,
  FilePick,
  HiddenCounts,
  LevelingCandidateRow,
  LootFilterState,
  PriceResult,
  ReleaseInfo,
  TargetState,
  UpdateCheck,
  WriteOutcome,
  WriteRequest,
} from '../shared/lootfilter/ipcTypes.js';

export interface PomBridge {
  leveling: LevelingBridge;
  journey: JourneyBridge & Omit<JourneyLiveBridge, 'step'>;
  sendCommand<K extends CommandName>(
    command: K,
    params: CommandParams<K>,
  ): Promise<{ ok: true; result: CommandResult<K> } | { ok: false; error: EngineErrorPayload }>;
  onEngineEvent(listener: (event: EngineEvent) => void): () => void;
  onDeepLink(listener: (route: DeepLinkRoute) => void): () => void;
  checkForUpdates(): Promise<unknown>;

  lib: {
    list(): Promise<Result<LibraryListing>>;
    read(id: string): Promise<Result<OpenedBuild>>;
    save(id: string, xml: string): Promise<Result<BuildEntry>>;
    create(opts: { folder: string; name: string; xml?: string; className?: string; level?: number; noSync?: boolean }): Promise<Result<BuildEntry>>;
    rename(id: string, name: string): Promise<Result<BuildEntry>>;
    duplicate(id: string): Promise<Result<BuildEntry>>;
    move(id: string, folder: string, keepBoth?: boolean): Promise<Result<BuildEntry>>;
    remove(id: string): Promise<Result<TrashEntry>>;
    restore(token: string): Promise<Result<BuildEntry>>;
    trashList(): Promise<Result<TrashEntry[]>>;
    trashPurge(token: string | null): Promise<Result<void>>;
    folderCreate(parent: string, name: string): Promise<Result<FolderEntry>>;
    folderRename(path: string, name: string): Promise<Result<FolderEntry>>;
    folderDelete(path: string, force: boolean): Promise<Result<void>>;
    folderCount(path: string): Promise<Result<number>>;
    reveal(id?: string): Promise<Result<void>>;
    /** Opens a folder picker (or goes back to the default); the new folder is used from the next start. Null when cancelled. */
    chooseBuildsDir(reset: boolean): Promise<Result<string | null>>;
    relaunch(): Promise<Result<void>>;
  };
  code: {
    importText(text: string): Promise<Result<DecodedImport>>;
    encode(xml: string): Promise<Result<string>>;
    share(xml: string): Promise<Result<string>>;
    /** Uploads the build code to one of the sites upstream can share to; the answer is the link. */
    shareTo(site: ShareSiteId, xml: string): Promise<Result<string>>;
    openFile(): Promise<Result<{ text: string; name: string } | null>>;
    saveFile(name: string, xml: string): Promise<Result<string | null>>;
  };
  /** Character import from pathofexile.com. The session cookie stays in the main process. */
  character: {
    access(): Promise<Result<CharacterAccess>>;
    signOut(): Promise<Result<CharacterAccess>>;
    authorize(): Promise<Result<CharacterAccess>>;
    list(source: 'account' | 'name', realm: Realm, account: string): Promise<Result<CharacterList>>;
    /** Reads one character from the site (the session cookie is added in the main process). */
    fetch(req: CharacterFetchRequest): Promise<Result<CharacterBundle>>;
    /** Applies what was read to a build text and returns the new text. */
    apply(xml: string, bundle: CharacterBundle, parts: ImportParts): Promise<Result<CharacterImportResult>>;
    /** Replaces the list of recent account names (clearing it, or undoing a clear). */
    setHistory(names: string[]): Promise<Result<string[]>>;
  };
  app: {
    info(): Promise<Result<AppInfo>>;
    openExternal(url: string): Promise<Result<void>>;
    /** The trade site's leagues for a realm (pc, xbox, sony). */
    tradeLeagues(realm: string): Promise<Result<{ leagues: string[]; error?: string }>>;
    /** The timeless jewel tables: where they stand, and a start for inflating the missing ones. */
    timelessData: { status(): Promise<Result<TimelessInstallStatus>>; install(): Promise<Result<TimelessInstallStatus>> };
    /** Page zoom: 1 is the system scale. */
    setZoom(factor: number): void;
    /** Scales the UI with the window (the "System" UI scale): 1x up to 1920 wide, then in proportion, up to 2x. */
    setAutoZoom(): void;
    /** Asks main to look for an update on the configured channel. */
    checkForUpdates(): Promise<Result<unknown>>;
    /** Looks at the update server and lists what would change; changes nothing. */
    updateAvailable(): Promise<Result<UpdateOffer>>;
  };
  /** The items and item sets shared between builds. */
  shared: {
    get(): Promise<Result<SharedItems>>;
    set(next: SharedItems): Promise<Result<void>>;
    /** The list changed outside the window (the assistant added to it). */
    onChanged(listener: () => void): () => void;
  };
  /** PoEURL short links for passive tree links, fetched by main (the page cannot read another site's answer). */
  treeLink: {
    /** The long tree link behind a poeurl.com short link. */
    resolve(link: string): Promise<Result<string>>;
    /** A poeurl.com short link for a long one. */
    shrink(link: string): Promise<Result<string>>;
  };
  settings: {
    get(): Promise<Result<AppSettings>>;
    set(patch: Partial<AppSettings>): Promise<Result<AppSettings>>;
  };
  engine: {
    open(xml: string): Promise<Result<EngineBuildSummary>>;
    /** The headline numbers of an open build as they are now (after edits). */
    summary(buildId: string): Promise<Result<EngineBuildSummary>>;
  };
  wealth: WealthApi;
  trader: TraderApi;
  account: AccountApi;
  kb: {
    /** Data patch, live patch and whether the game data is behind. */
    status(): Promise<Result<KbUiStatus>>;
    /** Checks the live patch now and rebuilds what changed. */
    refresh(): Promise<Result<KbUiStatus>>;
    onStatus(listener: (s: KbUiStatus) => void): () => void;
  };
  preview: {
    /** The next-league overlay the app has, or null when none is offered. */
    status(): Promise<Result<PreviewInfo | null>>;
    /** Runs a read-only command on the preview engine for the build text `xml`; `ms` is the whole call. */
    call<K extends PreviewCommand>(command: K, xml: string, params: Omit<CommandParams<K>, 'buildId'>): Promise<Result<{ result: CommandResult<K>; ms: number }>>;
  };
  entitlement: {
    get(): Promise<EntitlementView>;
    onChanged(listener: (v: EntitlementView) => void): () => void;
  };
  game: {
    info(): Promise<Result<GameInfo>>;
    treeNodes(version: string): Promise<Result<Record<string, TreeNodeInfo>>>;
    spectres(): Promise<Result<Record<string, SpectreInfo>>>;
  };
  lootFilter: {
    /** saveError: the last save of the state failed (raw error) and `state` is not on disk yet; file: where it is saved. */
    getState(): Promise<Result<{ state: LootFilterState; defaultFolder: string; userDataDir: string; saveError: string | null; file: string }>>;
    saveState(state: LootFilterState): Promise<Result<void>>;
    baseList(): Promise<Result<{ installed: BaseVersionInfo[]; active: string | null }>>;
    baseFile(version: string, strictnessId: string): Promise<Result<{ version: string; text: string }>>;
    baseCheck(force?: boolean): Promise<Result<UpdateCheck>>;
    baseDownload(release: ReleaseInfo): Promise<Result<{ version: string; syntaxErrors: number }>>;
    inspect(folder: string, fileName: string, lastHash?: string): Promise<Result<TargetState>>;
    write(req: WriteRequest): Promise<Result<WriteOutcome>>;
    readFile(path: string): Promise<Result<string>>;
    chooseFolder(current: string): Promise<Result<string | null>>;
    importFile(): Promise<Result<FilePick | null>>;
    exportFile(name: string, text: string): Promise<Result<string | null>>;
    prices(opts?: { league?: string; force?: boolean }): Promise<Result<PriceResult>>;
    hiddenCounts(version: string): Promise<Result<HiddenCounts>>;
    engineBases(): Promise<Result<EngineBases>>;
    reveal(path: string): Promise<Result<void>>;
    defaultFolder(): Promise<Result<string>>;
    clientLog(): Promise<Result<ClientLogInfo>>;
    resistAffixes(): Promise<Result<ResistAffix[]>>;
    /** Names of support gems as the build file writes them (without " Support"), from the engine's gem data. */
    gemNames(): Promise<Result<string[]>>;
    /** Build Filter: the engine's item bases and gems, reduced. */
    buildGameData(): Promise<Result<GameData>>;
    /** Build Filter: the leveling plan for a build, or none with the reason. */
    buildPlan(lite: LevelingProfileLite, override?: string): Promise<Result<{ plan: LevelingPlan | null; note?: string }>>;
    /** Build Filter: what each divination card turns into. */
    buildCards(): Promise<Result<{ cards: CardRewards; source: string }>>;
    /** Build Filter: the leveling skills to pick from for a build, best first. */
    buildCandidates(lite: LevelingProfileLite): Promise<Result<LevelingCandidateRow[]>>;
    pickClientLog(): Promise<Result<string | null>>;
    /** The .filter files in the game folder (empty folder string: the saved or default one). */
    folderList(folder: string): Promise<Result<{ ok: true; folder: string; files: { name: string; ours: boolean }[] } | { ok: false; error: string }>>;
    /** The text of one .filter file in the game folder. */
    folderRead(folder: string, name: string): Promise<Result<{ ok: true; name: string; text: string } | { ok: false; error: string }>>;
    /** Which of these bare file names exist in the game folder (for custom sounds a rule names). */
    filesExist(folder: string, names: string[]): Promise<Result<string[]>>;
    /** Asks for a sound file and copies it into the game folder under the name a rule asks for. Null when cancelled. */
    copySound(folder: string, wantedName: string): Promise<Result<{ from: string; to: string } | null>>;
  };
  assistant: {
    status(): Promise<Result<ProviderStatus[]>>;
    send(req: SendRequest): Promise<Result<{ turnId: string }>>;
    stop(turnId: string): Promise<Result<void>>;
    setContext(info: AssistantContextInfo | null): Promise<Result<void>>;
    apply(id: string): Promise<Result<ApplyResult>>;
    dismiss(id: string): Promise<Result<Proposal | null>>;
    undo(id: string): Promise<Result<{ xml: string }>>;
    getThread(key: string): Promise<Result<Thread>>;
    setThread(key: string, thread: Thread): Promise<Result<void>>;
    clearThread(key: string): Promise<Result<void>>;
    getPrefs(): Promise<Result<AssistantPrefs>>;
    setPrefs(patch: Partial<AssistantPrefs>): Promise<Result<AssistantPrefs>>;
    connector(): Promise<Result<ConnectorInfo>>;
    installConnector(): Promise<Result<ConnectorInfo>>;
    /** Pairing outside AI apps (main: registerAiConnectionsIpc). */
    connections: {
      verify(): Promise<Result<ConnectorInfo>>; enable(value: boolean): Promise<Result<ConnectorInfo>>;
      begin(publicIdentity: string, scopes: string[]): Promise<Result<ConnectorInfo>>; allow(clientId: string): Promise<Result<ConnectorInfo>>;
      decline(clientId: string): Promise<Result<ConnectorInfo>>; revoke(clientId: string | null): Promise<Result<ConnectorInfo>>;
      install(clientId: string): Promise<Result<ConnectorInfo>>;
    };
    /** Closes and reopens Claude Desktop. The value is false when it was not running. */
    restartDesktop(): Promise<Result<boolean>>;
    openLogin(id: ProviderId): Promise<Result<{ started: boolean; command: string; cancelled?: boolean }>>;
    /** Ends the sign-in program the app started for this provider. */
    cancelLogin(id: ProviderId): Promise<Result<void>>;
    /** Runs the program's own logout, then returns the fresh status of both providers. */
    signOut(id: ProviderId): Promise<Result<ProviderStatus[]>>;
    proposalStatuses(buildKey: string): Promise<Result<Record<string, string>>>;
    onPush(listener: (push: AssistantPush) => void): () => void;
    /** The build solver: the one solve the app runs, shared with the assistant's solve tools. */
    solveState(): Promise<Result<SolveState>>;
    solveGoal(goal: SolveGoal, opts: { timeBudgetMs?: number; cpu?: SolveCpu }): Promise<Result<SolveState>>;
    solveRun(goal: SolveGoal, opts: { timeBudgetMs?: number; cpu?: SolveCpu }): Promise<Result<SolveState>>;
    solveStop(): Promise<Result<SolveState>>;
    solveDetails(index: number): Promise<Result<SolveDetails>>;
    /** One apply/undo card for a result; it arrives in the thread like any suggestion. */
    solveCard(ref: number | string): Promise<Result<Proposal>>;
  };
  /** The automatic updater: the status (pill, toast, required modal), Restart now and the required modal's Quit. */
  update: {
    /** The status now, and a notice from before the window opened (the last install's result), given once. */
    get(): Promise<Result<{ status: UpdateStatus; notice: UpdateNotice | null }>>;
    onStatus(listener: (status: UpdateStatus) => void): () => void;
    onNotice(listener: (notice: UpdateNotice) => void): () => void;
    /** The last policy check before applying (after the page froze input and saved). */
    prepareApply(): Promise<Result<RestartResult>>;
    /** Call after every open document is saved: quits, installs and starts the new version. */
    restart(): Promise<Result<RestartResult>>;
    quit(): Promise<Result<void>>;
  };
  win: {
    minimize(): Promise<void>;
    maximize(): Promise<boolean>;
    close(): Promise<void>;
    onState(listener: (maximized: boolean) => void): () => void;
    /** Close after the player confirmed in the app's dialog, even though the page refuses to unload. */
    closeAnyway(): Promise<void>;
    /** The window was asked to close but the page's beforeunload refused; show the confirm dialog. */
    onCloseBlocked(listener: () => void): () => void;
  };
  /**
   * The Atlas / Timeline / Run / Marketplace / documents services. One request channel per feature
   * (`mastery:<feature>`), each validating its own versioned request in main; one push prefix (`mastery:push:*`).
   * Only those two prefixes pass: nothing else in main can be reached through here.
   */
  mastery: {
    invoke(channel: string, input?: unknown): Promise<unknown>;
    on(channel: string, listener: (payload: unknown) => void): () => void;
  };
}

const MASTERY_INVOKE = /^mastery:[a-z][a-z-]*(?::[a-z][a-z-]*){0,2}$/;
const MASTERY_PUSH = /^mastery:push:[a-z][a-z-]*$/;

const inv = <T>(channel: string, ...args: unknown[]): Promise<Result<T>> => ipcRenderer.invoke(channel, ...args);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const acct = (method: string, ...args: unknown[]): Promise<any> => ipcRenderer.invoke(IPC.ACCT_CALL, method, args);


// "System" UI scale: the page grows with the window (see autoUiScale).
let autoZoom = false;
function applyAutoZoom(): void {
  if (!autoZoom) return;
  // The window's size and the page's zoom are read from the page itself (the outer size is in screen units, the inner size
  // in zoomed page units). webFrame.getZoomFactor() is a synchronous call to the main process, and during start-up it held
  // the page for as long as the main process was busy: 657 ms in a trace.
  const outer = window.outerWidth > 0 && window.innerWidth > 0;
  const zoom = outer ? window.outerWidth / window.innerWidth : webFrame.getZoomFactor();
  const width = outer ? window.outerWidth : window.innerWidth * zoom;
  const height = outer ? window.outerHeight : window.innerHeight * zoom;
  const factor = autoUiScale(width, height);
  if (Math.abs(factor - zoom) > 0.004) webFrame.setZoomFactor(factor);
}
window.addEventListener('resize', applyAutoZoom);

const bridge: PomBridge = {
  leveling: levelingBridge,
  journey: journeyBridge,
  sendCommand: (command, params) => ipcRenderer.invoke(IPC.ENGINE_COMMAND, command, params),

  onEngineEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: EngineEvent) => listener(payload);
    ipcRenderer.on(IPC.ENGINE_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC.ENGINE_EVENT, handler);
  },

  onDeepLink: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: DeepLinkRoute) => listener(payload);
    ipcRenderer.on('pom:deep-link', handler);
    return () => ipcRenderer.removeListener('pom:deep-link', handler);
  },

  checkForUpdates: () => ipcRenderer.invoke(IPC.UPDATE_CHECK),

  lib: {
    list: () => inv(IPC.LIB_LIST),
    read: (id) => inv(IPC.LIB_READ, id),
    save: (id, xml) => inv(IPC.LIB_SAVE, id, xml),
    create: (opts) => inv(IPC.LIB_CREATE, opts),
    rename: (id, name) => inv(IPC.LIB_RENAME, id, name),
    duplicate: (id) => inv(IPC.LIB_DUPLICATE, id),
    move: (id, folder, keepBoth = false) => inv(IPC.LIB_MOVE, id, folder, keepBoth),
    remove: (id) => inv(IPC.LIB_DELETE, id),
    restore: (token) => inv(IPC.LIB_RESTORE, token),
    trashList: () => inv(IPC.LIB_TRASH_LIST),
    trashPurge: (token) => inv(IPC.LIB_TRASH_PURGE, token),
    folderCreate: (parent, name) => inv(IPC.LIB_FOLDER_CREATE, parent, name),
    folderRename: (path, name) => inv(IPC.LIB_FOLDER_RENAME, path, name),
    folderDelete: (path, force) => inv(IPC.LIB_FOLDER_DELETE, path, force),
    folderCount: (path) => inv(IPC.LIB_FOLDER_COUNT, path),
    reveal: (id) => inv(IPC.LIB_REVEAL, id),
    chooseBuildsDir: (reset) => inv(IPC.LIB_BUILDSDIR_CHOOSE, reset),
    relaunch: () => inv(IPC.APP_RELAUNCH),
  },
  code: {
    importText: (text) => inv(IPC.CODE_IMPORT, text),
    encode: (xml) => inv(IPC.CODE_ENCODE, xml),
    share: (xml) => inv(IPC.CODE_SHARE, xml),
    shareTo: (site, xml) => inv(IPC.CODE_SHARE_TO, site, xml),
    openFile: () => inv(IPC.FILE_OPEN_XML),
    saveFile: (name, xml) => inv(IPC.FILE_SAVE_XML, name, xml),
  },
  character: {
    access: () => inv(IPC.CHARACTER_ACCESS),
    signOut: () => inv(IPC.CHARACTER_SIGN_OUT),
    authorize: () => inv(IPC.CHARACTER_AUTHORIZE),
    list: (source, realm, account) => inv(IPC.CHARACTER_LIST, source, realm, account),
    fetch: (req) => inv(IPC.CHARACTER_FETCH, req),
    apply: (xml, bundle, parts) => inv(IPC.CHARACTER_APPLY, xml, bundle, parts),
    setHistory: (names) => inv(IPC.CHARACTER_HISTORY_SET, names),
  },
  app: {
    info: () => inv(IPC.APP_INFO),
    openExternal: (url) => inv(IPC.OPEN_EXTERNAL, url),
    setZoom: (factor) => {
      autoZoom = false;
      webFrame.setZoomFactor(Math.max(0.5, Math.min(3, factor)));
    },
    setAutoZoom: () => {
      autoZoom = true;
      applyAutoZoom();
    },
    tradeLeagues: (realm) => inv(IPC.TRADE_LEAGUES, realm),
    timelessData: { status: () => inv(IPC.TIMELESS_STATUS), install: () => inv(IPC.TIMELESS_INSTALL) },
    checkForUpdates: () => inv(IPC.UPDATE_CHECK_SAFE),
    updateAvailable: () => inv(IPC.UPDATE_AVAILABLE),
  },
  shared: {
    get: () => inv(IPC.SHARED_GET),
    set: (next) => inv(IPC.SHARED_SET, next),
    onChanged: (listener) => {
      const handler = () => listener();
      ipcRenderer.on(IPC.SHARED_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC.SHARED_CHANGED, handler);
    },
  },
  treeLink: {
    resolve: (link) => inv(IPC.TREE_LINK, 'resolve', link),
    shrink: (link) => inv(IPC.TREE_LINK, 'shrink', link),
  },
  settings: {
    get: () => inv(IPC.SETTINGS_GET),
    set: (patch) => inv(IPC.SETTINGS_SET, patch),
  },
  engine: {
    open: (xml) => inv(IPC.ENGINE_OPEN, xml),
    summary: (buildId) => inv(IPC.ENGINE_SUMMARY, buildId),
  },
  trader: {
    auth: () => ipcRenderer.invoke(IPC.TRADER_CALL, 'auth'),
    search: (i) => ipcRenderer.invoke(IPC.TRADER_CALL, 'search', i),
    fromUrl: (i) => ipcRenderer.invoke(IPC.TRADER_CALL, 'fromUrl', i),
    rates: (realm) => ipcRenderer.invoke(IPC.TRADER_CALL, 'rates', realm),
  },
  wealth: {
    get: () => ipcRenderer.invoke(IPC.WEALTH_CALL, 'get'),
    market: () => ipcRenderer.invoke(IPC.WEALTH_CALL, 'market'),
    standardPrice: (key) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'standardPrice', key),
    strategies: () => ipcRenderer.invoke(IPC.WEALTH_CALL, 'strategies'),
    leagues: () => ipcRenderer.invoke(IPC.WEALTH_CALL, 'leagues'),
    exportCsv: (name, text) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'exportCsv', name, text),
    connection: () => ipcRenderer.invoke(IPC.WEALTH_CALL, 'connection'),
    upgradeView: (k, x) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'upgradeView', k, x),
    upgradeWatched: () => ipcRenderer.invoke(IPC.WEALTH_CALL, 'upgradeWatched'),
    upgradeScan: (i) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'upgradeScan', i),
    upgradeRule: (k, s, p) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'upgradeRule', k, s, p),
    upgradePrefs: (p) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'upgradePrefs', p),
    travelToListing: (l, c) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'travelToListing', l, c),
    upgradeDismiss: (k, s, id, w) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'upgradeDismiss', k, s, id, w),
    boardView: () => ipcRenderer.invoke(IPC.WEALTH_CALL, 'boardView'),
    boardPost: (i) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'boardPost', i),
    boardVouch: (id) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'boardVouch', id),
    boardReport: (id) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'boardReport', id),
    boardOffer: (id, m) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'boardOffer', id, m),
    boardRemove: (id) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'boardRemove', id),
    connect: (input) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'connect', input),
    signIn: () => ipcRenderer.invoke(IPC.WEALTH_CALL, 'signIn'),
    disconnect: () => ipcRenderer.invoke(IPC.WEALTH_CALL, 'disconnect'),
    setCounted: (ids) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'setCounted', ids),
    firstSnapshot: () => ipcRenderer.invoke(IPC.WEALTH_CALL, 'firstSnapshot'),
    syncNow: () => ipcRenderer.invoke(IPC.WEALTH_CALL, 'syncNow'),
    retryPrices: () => ipcRenderer.invoke(IPC.WEALTH_CALL, 'retryPrices'),
    countTabs: () => ipcRenderer.invoke(IPC.WEALTH_CALL, 'countTabs'),
    countProgress: () => ipcRenderer.invoke(IPC.WEALTH_CALL, 'countProgress'),
    readInbox: () => ipcRenderer.invoke(IPC.WEALTH_CALL, 'readInbox'),
    clearInbox: () => ipcRenderer.invoke(IPC.WEALTH_CALL, 'clearInbox'),
    removeInbox: (id) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'removeInbox', id),
    startSession: (name, strategyId) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'startSession', name, strategyId),
    endSession: () => ipcRenderer.invoke(IPC.WEALTH_CALL, 'endSession'),
    deleteSession: (id) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'deleteSession', id),
    restoreSession: (id) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'restoreSession', id),
    renameSession: (id, name) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'renameSession', id, name),
    markTransfer: (id, key, on) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'markTransfer', id, key, on),
    publishSession: (id) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'publishSession', id),
    setFav: (id, on) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'setFav', id, on),
    setShareSessions: (on) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'setShareSessions', on),
    setGoal: (key) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'setGoal', key),
    setAlert: (key, on) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'setAlert', key, on),
    setAlertPct: (pct) => ipcRenderer.invoke(IPC.WEALTH_CALL, 'setAlertPct', pct),
    onChange: (cb) => {
      const h = (_e: Electron.IpcRendererEvent, v: unknown) => cb(v as Parameters<typeof cb>[0]);
      ipcRenderer.on(IPC.WEALTH_CHANGED, h);
      return () => ipcRenderer.removeListener(IPC.WEALTH_CHANGED, h);
    },
    onAlert: (cb) => {
      const h = (_e: Electron.IpcRendererEvent, m: string) => cb(m);
      ipcRenderer.on(IPC.WEALTH_ALERT, h);
      return () => ipcRenderer.removeListener(IPC.WEALTH_ALERT, h);
    },
  },
  game: {
    info: () => inv(IPC.GAME_INFO),
    treeNodes: (version) => inv(IPC.TREE_NODES, version),
    spectres: () => inv(IPC.GAME_SPECTRES),
  },
  lootFilter: {
    getState: () => inv(IPC.LF_STATE_GET),
    saveState: (state) => inv(IPC.LF_STATE_SAVE, state),
    baseList: () => inv(IPC.LF_BASE_LIST),
    baseFile: (version, strictnessId) => inv(IPC.LF_BASE_FILE, version, strictnessId),
    baseCheck: (force = false) => inv(IPC.LF_BASE_CHECK, force),
    baseDownload: (release) => inv(IPC.LF_BASE_DOWNLOAD, release),
    inspect: (folder, fileName, lastHash) => inv(IPC.LF_FILE_INSPECT, folder, fileName, lastHash),
    write: (req) => inv(IPC.LF_FILE_WRITE, req),
    readFile: (path) => inv(IPC.LF_FILE_READ, path),
    chooseFolder: (current) => inv(IPC.LF_FOLDER_CHOOSE, current),
    importFile: () => inv(IPC.LF_FILE_IMPORT),
    exportFile: (name, text) => inv(IPC.LF_FILE_EXPORT, name, text),
    prices: (opts = {}) => inv(IPC.LF_PRICES, opts),
    hiddenCounts: (version) => inv(IPC.LF_HIDDEN_COUNTS, version),
    engineBases: () => inv(IPC.LF_ENGINE_BASES),
    reveal: (path) => inv(IPC.LF_REVEAL, path),
    defaultFolder: () => inv(IPC.LF_DEFAULT_FOLDER),
    clientLog: () => inv(IPC.LF_CLIENT_LOG),
    resistAffixes: () => inv(IPC.LF_RESIST_AFFIXES),
    gemNames: () => inv(IPC.LF_GEM_NAMES),
    buildGameData: () => inv(IPC.LF_BUILD_DATA),
    buildPlan: (lite, override) => inv(IPC.LF_BUILD_PLAN, lite, override),
    buildCards: () => inv(IPC.LF_BUILD_CARDS),
    buildCandidates: (lite) => inv(IPC.LF_BUILD_CANDIDATES, lite),
    pickClientLog: () => inv(IPC.LF_PICK_LOG),
    filesExist: (folder, names) => inv(IPC.LF_FILES_EXIST, folder, names),
    folderList: (folder) => inv(IPC.LF_FOLDER_LIST, folder),
    folderRead: (folder, name) => inv(IPC.LF_FOLDER_READ, folder, name),
    copySound: (folder, wantedName) => inv(IPC.LF_SOUND_COPY, folder, wantedName),
  },
  assistant: {
    status: () => inv(IPC.ASSISTANT_STATUS),
    send: (req) => inv(IPC.ASSISTANT_SEND, req),
    stop: (turnId) => inv(IPC.ASSISTANT_STOP, turnId),
    setContext: (info) => inv(IPC.ASSISTANT_CONTEXT, info),
    apply: (id) => inv(IPC.ASSISTANT_APPLY, id),
    dismiss: (id) => inv(IPC.ASSISTANT_DISMISS, id),
    undo: (id) => inv(IPC.ASSISTANT_UNDO, id),
    getThread: (key) => inv(IPC.ASSISTANT_THREAD_GET, key),
    setThread: (key, thread) => inv(IPC.ASSISTANT_THREAD_SET, key, thread),
    clearThread: (key) => inv(IPC.ASSISTANT_THREAD_CLEAR, key),
    getPrefs: () => inv(IPC.ASSISTANT_PREFS_GET),
    setPrefs: (patch) => inv(IPC.ASSISTANT_PREFS_SET, patch),
    connector: () => inv(IPC.ASSISTANT_CONNECTOR),
    installConnector: () => inv(IPC.ASSISTANT_CONNECTOR_INSTALL),
    // Same strings as AI_CONNECTION_CHANNELS in src/main/assistantIpc.ts.
    connections: {
      verify: () => inv('mastery:ai:verify'), enable: (value) => inv('mastery:ai:enable', value),
      begin: (publicIdentity, scopes) => inv('mastery:ai:pair:begin', { publicIdentity, scopes }), allow: (clientId) => inv('mastery:ai:pair:allow', clientId),
      decline: (clientId) => inv('mastery:ai:pair:decline', clientId), revoke: (clientId) => inv('mastery:ai:revoke', clientId),
      install: (clientId) => inv('mastery:ai:install', clientId),
    },
    restartDesktop: () => inv(IPC.ASSISTANT_CONNECTOR_RESTART),
    openLogin: (id) => inv(IPC.ASSISTANT_LOGIN, id),
    cancelLogin: (id) => inv(IPC.ASSISTANT_LOGIN_CANCEL, id),
    signOut: (id) => inv(IPC.ASSISTANT_LOGOUT, id),
    proposalStatuses: (key) => inv(IPC.ASSISTANT_PROPOSALS, key),
    solveState: () => inv(IPC.SOLVE_STATE),
    solveGoal: (goal, opts) => inv(IPC.SOLVE_GOAL, goal, opts),
    solveRun: (goal, opts) => inv(IPC.SOLVE_RUN, goal, opts),
    solveStop: () => inv(IPC.SOLVE_STOP),
    solveDetails: (index) => inv(IPC.SOLVE_DETAILS, index),
    solveCard: (ref) => inv(IPC.SOLVE_CARD, ref),
    onPush: (listener) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: AssistantPush) => listener(payload);
      ipcRenderer.on(IPC.ASSISTANT_PUSH, handler);
      return () => ipcRenderer.removeListener(IPC.ASSISTANT_PUSH, handler);
    },
  },
  kb: {
    status: () => inv(IPC.KB_STATUS),
    refresh: () => inv(IPC.KB_REFRESH),
    onStatus: (listener) => {
      const handler = (_e: Electron.IpcRendererEvent, s: KbUiStatus) => listener(s);
      ipcRenderer.on(IPC.KB_PUSH, handler);
      return () => ipcRenderer.removeListener(IPC.KB_PUSH, handler);
    },
  },
  preview: {
    status: () => inv(IPC.PREVIEW_STATUS),
    call: (command, xml, params) => inv(IPC.PREVIEW_CALL, command, xml, params),
  },
  entitlement: {
    get: () => ipcRenderer.invoke(IPC.ENTITLEMENT_GET),
    onChanged: (listener) => {
      const handler = (_e: Electron.IpcRendererEvent, v: EntitlementView) => listener(v);
      ipcRenderer.on(IPC.ENTITLEMENT_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC.ENTITLEMENT_CHANGED, handler);
    },
  },
  account: {
    view: () => acct('view'),
    providers: () => acct('providers'),
    signInProvider: (p) => acct('signInProvider', p),
    signInEmail: (email) => acct('signInEmail', email),
    cancelSignIn: () => acct('cancelSignIn'),
    signOut: () => acct('signOut'),
    syncNow: () => acct('syncNow'),
    enroll: (id) => acct('enroll', id),
    enrollAll: () => acct('enrollAll'),
    unenroll: (id, remove) => acct('unenroll', id, remove),
    conflictTexts: (id) => acct('conflictTexts', id),
    resolve: (id, choice) => acct('resolve', id, choice),
    versions: (id) => acct('versions', id),
    versionText: (id, rev) => acct('versionText', id, rev),
    restore: (id, rev, label) => acct('restore', id, rev, label),
    restoreAsCopy: (id, rev, label) => acct('restoreAsCopy', id, rev, label),
    deletedBuilds: () => acct('deletedBuilds'),
    restoreDeleted: (cloudId) => acct('restoreDeleted', cloudId),
    shareGet: (id) => acct('shareGet', id),
    shareSet: (id, s) => acct('shareSet', id, s),
    shareRevoke: (id) => acct('shareRevoke', id),
    sharedOpen: (token) => acct('sharedOpen', token),
    feedbackSend: (i) => acct('feedbackSend', i),
    communityList: (i) => acct('communityList', i),
    communitySimilar: (i) => acct('communitySimilar', i),
    communityGet: (id) => acct('communityGet', id),
    communityMine: () => acct('communityMine'),
    communityPublish: (i) => acct('communityPublish', i),
    communityUnpublish: (id) => acct('communityUnpublish', id),
    communityReport: (id, reason) => acct('communityReport', id, reason),
    deleteMyCommunityData: () => acct('deleteMyCommunityData'),
    deleteAccount: () => acct('deleteAccount'),
    cancelDeleteAccount: () => acct('cancelDeleteAccount'),
    onChanged: (listener) => {
      const handler = (_e: Electron.IpcRendererEvent, v: AccountView) => listener(v);
      ipcRenderer.on(IPC.ACCT_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC.ACCT_CHANGED, handler);
    },
    onLibraryChanged: (listener) => {
      const handler = (_e: Electron.IpcRendererEvent, ids: string[]) => listener(ids);
      ipcRenderer.on(IPC.LIB_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC.LIB_CHANGED, handler);
    },
  },
  update: {
    get: () => inv(IPC.UPDATE_GET_STATUS),
    onStatus: (listener) => {
      const handler = (_e: Electron.IpcRendererEvent, s: UpdateStatus) => listener(s);
      ipcRenderer.on(IPC.UPDATE_STATUS, handler);
      return () => ipcRenderer.removeListener(IPC.UPDATE_STATUS, handler);
    },
    onNotice: (listener) => {
      const handler = (_e: Electron.IpcRendererEvent, n: UpdateNotice) => listener(n);
      ipcRenderer.on(IPC.UPDATE_NOTICE, handler);
      return () => ipcRenderer.removeListener(IPC.UPDATE_NOTICE, handler);
    },
    restart: () => inv(IPC.UPDATE_RESTART),
    prepareApply: () => inv(IPC.UPDATE_PREPARE_APPLY),
    quit: () => inv(IPC.UPDATE_QUIT),
  },
  win: {
    minimize: () => ipcRenderer.invoke(IPC.WIN_MINIMIZE),
    maximize: () => ipcRenderer.invoke(IPC.WIN_MAXIMIZE),
    close: () => ipcRenderer.invoke(IPC.WIN_CLOSE),
    closeAnyway: () => ipcRenderer.invoke(IPC.WIN_CLOSE_ANYWAY),
    onState: (listener) => {
      const handler = (_e: Electron.IpcRendererEvent, maximized: boolean) => listener(maximized);
      ipcRenderer.on(IPC.WIN_STATE, handler);
      return () => ipcRenderer.removeListener(IPC.WIN_STATE, handler);
    },
    onCloseBlocked: (listener) => {
      const handler = () => listener();
      ipcRenderer.on(IPC.WIN_CLOSE_BLOCKED, handler);
      return () => ipcRenderer.removeListener(IPC.WIN_CLOSE_BLOCKED, handler);
    },
  },
  mastery: {
    invoke: (channel, input) => {
      if (!MASTERY_INVOKE.test(channel) || MASTERY_PUSH.test(channel)) return Promise.reject(new Error('Unknown request.'));
      return ipcRenderer.invoke(channel, input);
    },
    on: (channel, listener) => {
      if (!MASTERY_PUSH.test(channel)) return () => undefined;
      const handler = (_e: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },
};

contextBridge.exposeInMainWorld('pom', bridge);
