import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, powerMonitor } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IPC } from '../shared/ipc.js';
import type { TradeListing, TravelResult } from '../shared/wealthTrade.js';
import { electronSecureStorage } from './secureStorage.js';
import { SampleGgg } from './wealth/sampleGgg.js';
import { seedSampleHistory } from './wealth/sampleHistory.js';
import { CloudBoardFeed, NeedsAccountFeed, SampleBoardFeed, type BoardFeed } from './wealth/bulkBoard.js';
import { WealthService } from './wealth/service.js';
import type { BoardBackend, CommunityBackend } from './wealth/communityStrategies.js';
import { createPoeSignIn } from './wealth/poeSignInWindow.js';
import { mt } from './mainText.js';

const READS = new Set(['upgradePrefs', 'get', 'market', 'strategies', 'leagues', 'upgradeView', 'upgradeWatched', 'standardPrice', 'countProgress']);

/** The calls the renderer may make. Anything else is refused. */
const METHODS = new Set([
  'get',
  'market',
  'standardPrice',
  'strategies',
  'leagues',
  'connect',
  'signIn',
  'disconnect',
  'setCounted',
  'firstSnapshot',
  'syncNow',
  'retryPrices',
  'countTabs',
  'countProgress',
  'readInbox',
  'clearInbox',
  'removeInbox',
  'startSession',
  'endSession',
  'deleteSession',
  'restoreSession',
  'renameSession',
  'markTransfer',
  'publishSession',
  'setFav',
  'setShareSessions',
  'setGoal',
  'setAlert',
  'setAlertPct',
  'exportCsv',
  'connection',
  'upgradeView',
  'upgradeWatched',
  'upgradeScan',
  'upgradeRule',
  'upgradePrefs',
  'upgradeDismiss',
  'travelToListing',
  'boardView',
  'boardPost',
  'boardVouch',
  'boardReport',
  'boardOffer',
  'boardRemove',
]);

/**
 * Wealth in the main process. POM_WEALTH_SAMPLE=1 is the dev switch: a sample stash (same shapes as the real
 * responses) stands in for pathofexile.com, with a few days of play replayed so every view has data. No cookie is
 * needed. Remove the variable and enter a real POESESSID to run live.
 */
export function registerWealthIpc(getWindow: () => BrowserWindow | null, community?: CommunityBackend): WealthService {
  const sample = process.env.POM_WEALTH_SAMPLE === '1';
  const clock = { t: Date.now() };
  let seeding = false;
  const send = (channel: string, payload: unknown) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };
  let locked = false;
  powerMonitor.on('lock-screen', () => void (locked = true));
  powerMonitor.on('unlock-screen', () => void (locked = false));
  powerMonitor.on('suspend', () => void (locked = true));
  powerMonitor.on('resume', () => void (locked = false));
  let sampleApi: SampleGgg | null = null;
  const travelFromAlert = async (listing: TradeListing, cont: boolean): Promise<void> => {
    const r = await svc.travelToListing(listing, cont).catch(() => ({ ok: false, text: 'Could not reach the trade site.' }) as TravelResult);
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: r.ok ? mt('teleporting') : mt('teleport_failed'), body: r.text, silent: true });
    if (r.inDemand) n.on('click', () => void travelFromAlert(listing, true));
    n.show();
  };
  const svc = new WealthService({
    dir: join(app.getPath('userData'), 'wealth'),
    secrets: electronSecureStorage,
    version: app.getVersion(),
    sample,
    ...(community ? { community } : {}),
    ...(sample && process.env.POM_WEALTH_SAMPLE_TRADE ? { sampleTradeMode: process.env.POM_WEALTH_SAMPLE_TRADE as 'expired' } : {}),
    now: () => (seeding ? clock.t : Date.now()),
    sleep: (ms) => (seeding ? Promise.resolve().then(() => void (clock.t += ms)) : new Promise((r) => setTimeout(r, ms))),
    ...(sample ? { sampleGgg: (book, saved) => (sampleApi = new SampleGgg(book, 7, saved)) } : {}),
    emit: (v) => send(IPC.WEALTH_CHANGED, v),
    // Background upgrade checks stop after 30 minutes without input and while the screen is locked.
    active: () => !locked && powerMonitor.getSystemIdleTime() < 30 * 60,
    copyText: (t) => clipboard.writeText(t),
    osNotify: (e) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: e.title, body: e.body, silent: false });
      n.on('click', () => {
        // Same as the trade site's "Travel to Hideout": the game takes focus, not this window.
        if (e.listing) {
          void travelFromAlert(e.listing, false);
          return;
        }
        const w = getWindow();
        if (!w || w.isDestroyed()) return;
        if (w.isMinimized()) w.restore();
        w.show();
        w.focus();
      });
      n.show();
    },
    onAlert: (m) => send(IPC.WEALTH_ALERT, m),
    // The sample stash needs no window; a test build (POM_TEST_LOGIN=1) drives the real window against a local page.
    signIn: sample && process.env.POM_TEST_LOGIN !== '1' ? { open: async () => ({ ok: true as const, cookie: 'sample', account: 'Kaelen#4821' }), clear: async () => undefined } : createPoeSignIn(getWindow),
  });

  // Community listings need the backend (project down, #4): live runs show the needs-account state until it exists.
  const board: BoardFeed =
    community?.bulk && community.userName && process.env.POM_BOARD !== 'needs-account' && process.env.POM_BOARD !== 'sample'
      ? new CloudBoardFeed(community as BoardBackend, async () => (await svc.get()).sync.league, () => 377, () => Date.now())
      : sample && process.env.POM_BOARD !== 'needs-account'
        ? new SampleBoardFeed(() => Date.now(), () => 377)
        : new NeedsAccountFeed();
  const BOARD: Record<string, (...a: any[]) => unknown> = {
    boardView: async () => {
      const v = await board.view();
      return v.status === 'ready' ? { ...v, divine: (await svc.get()).divine || v.divine } : v;
    },
    boardPost: (i) => board.post(i),
    boardVouch: (id) => board.vouch(id),
    boardReport: (id) => board.report(id),
    boardOffer: (id, m) => board.offer(id, m),
    boardRemove: (id) => board.remove(id),
  };

  // The signed-in player's listings stay alive while the app is open: this is what "online" means on the Bulk board.
  if (community?.bulk) setInterval(() => void (community.signedIn() && community.bulk!.heartbeat().catch(() => undefined)), 60_000).unref();

  let started: Promise<void> | null = null;
  const startOnce = () =>
    (started ||= (async () => {
      await svc.whenReady();
      if (sample) {
        await svc.prepareSample();
        if (sampleApi && process.env.POM_WEALTH_FIRST_VISIT === '1') {
          // Opens on the connect screen with the sample stash behind it, so the whole first-visit flow can be walked.
          await svc.wipe();
          await svc.disconnect();
        } else if (sampleApi && !svc.hasHistory()) {
          await svc.wipe();
          seeding = true;
          clock.t = Date.now() - 3.6 * 86_400_000;
          await svc.connect({ account: 'Kaelen#4821', poesessid: 'sample' });
          await seedSampleHistory(svc, sampleApi, clock, Date.now());
          seeding = false;
        }
        // POM_WEALTH_SAMPLE_FAIL=expired|rate-limited|private|down shows how each failure looks.
        const fail = process.env.POM_WEALTH_SAMPLE_FAIL as 'expired' | 'rate-limited' | 'private' | 'down' | undefined;
        if (fail && sampleApi) {
          sampleApi.failWith = { kind: fail, retryAfter: 90 };
          void svc.syncNow();
        }
      }
      svc.start();
    })());

  ipcMain.handle(IPC.WEALTH_CALL, async (_e, method: string, ...args: unknown[]) => {
    if (!METHODS.has(method)) throw new Error(`Unknown Wealth call ${method}`);
    if (BOARD[method]) return BOARD[method]!(...args);
    if (method === 'exportCsv') {
      const [name, text] = args as [string, string];
      const w = getWindow();
      const opts = { title: mt('export_stash'), defaultPath: String(name).replace(/[^\w.-]+/g, '_'), filters: [{ name: 'CSV', extensions: ['csv'] }] };
      const r = w && !w.isDestroyed() ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
      if (r.canceled || !r.filePath) return null;
      await writeFile(r.filePath, String(text), 'utf8');
      return r.filePath;
    }
    // Reads answer from what is saved at once; the sync, price fetch and sample replay carry on behind them.
    if (READS.has(method)) {
      await svc.whenReady();
      void startOnce();
    } else await startOnce();
    const fn = (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
    return fn!.apply(svc, args);
  });
  return svc;
}
