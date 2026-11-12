// Builds the mastery context and wires every new area. main/index.ts calls startMastery() once.
import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import { randomBytes, createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isId, type RevisionRef } from '@pom/mastery-contracts';
import { registerDocumentIpc } from '../documents/ipc.js';
import { registerWorkspaceIpc } from '../workspaces/ipc.js';
import { AiGate, type AiAccess } from '../aiGate/gate.js';
import { LocalAiAccess } from '../aiGate/local.js';
import { backendConfig } from '../accounts/config.js';
import { createAiBackend } from '../aiGate/client.js';
import { createAppSigner } from '../aiGate/proof.js';
import { createInstallationRegistrar, installationLabel, retireInstallationIdentity } from './installation.js';
import type { SecureStorage } from '../secureStorage.js';
import type { AccountsHost } from '../accounts/host.js';
import type { DeepLinkRoute } from '../deepLink.js';
import { isMainFrameOf, MASTERY_LIMITS, openDocumentCore, type MasteryContext, type RunLauncher } from './context.js';
import { wireAtlas, type AtlasWiring } from './atlas.js';
import { wireTimelinesAndRun, type RunWiring } from './timelinesRun.js';
import { wireMarketplace, type MarketplaceWiring } from './marketplace.js';
import { wireStarters } from './starters.js';
import { LEAGUE_STARTERS } from '../../shared/leagueContent.js';
import { startupStep } from '../startupTrace.js';

export type MasteryDeps = {
  userDataDir: string;
  accounts: AccountsHost;
  secure: SecureStorage;
  mainWindow(): BrowserWindow | null;
  /** Shows the main window, recreating it when it was closed (Keep Run open). Returns true when it was created just now. */
  showMainWindow?(): boolean;
  /** The renderer dev server URL when running `npm run dev`, else null. */
  devServerUrl: string | null;
  library?: import('./libraryBuilds.js').LibraryAccess;
};

export type Mastery = {
  ctx: MasteryContext;
  atlas: AtlasWiring | null;
  run: RunWiring | null;
  marketplace: MarketplaceWiring | null;
  /** A public item link (pathofmastery://item/...): handed to the main window's Marketplace area. */
  openItem(route: Extract<DeepLinkRoute, { kind: 'item' }>): void;
  /** True while a Run window is open (closing main alone must not quit then). */
  hasRunWindow(): boolean;
  /** Drains every store; call from before-quit. */
  quit(): Promise<void>;
};

/** One random installation id and one app signing key per user-data folder; the key is kept encrypted when the OS allows. */
async function installationIdentity(dir: string, secure: SecureStorage): Promise<{ installation: string; key: KeyObject }> {
  await mkdir(dir, { recursive: true });
  const idFile = join(dir, 'installation.txt');
  let installation = existsSync(idFile) ? (await readFile(idFile, 'utf8')).trim() : '';
  if (!/^[a-f0-9]{64}$/.test(installation)) {
    installation = randomBytes(32).toString('hex');
    await writeFile(idFile, installation, 'utf8');
  }
  const keyFile = join(dir, 'app-key.bin');
  let key: KeyObject | null = null;
  try {
    if (existsSync(keyFile)) {
      const raw = await readFile(keyFile);
      const pem = secure.isAvailable() ? secure.decrypt(raw) : raw.toString('utf8');
      key = createPrivateKey(pem);
    }
  } catch { key = null; }
  if (!key) {
    key = generateKeyPairSync('ed25519').privateKey;
    const pem = key.export({ type: 'pkcs8', format: 'pem' }).toString();
    await writeFile(keyFile, secure.isAvailable() ? secure.encrypt(pem) : Buffer.from(pem, 'utf8'));
  }
  return { installation, key };
}

export async function startMastery(d: MasteryDeps): Promise<Mastery> {
  const limits = MASTERY_LIMITS;
  const quitTasks: (() => Promise<void>)[] = [];
  const { documents, workspaces } = await openDocumentCore(d.userDataDir, limits);
  quitTasks.push(async () => {
    try { await documents.close(); } catch { await documents.close(true).catch(() => undefined); }
  });
  if (workspaces) quitTasks.push(() => workspaces.close());

  // No backend, no site: the registrar, the hosted AI gate and the Marketplace stay off, and the assistant runs locally.
  const backend = backendConfig();
  const siteOrigin = backend?.siteOrigin ?? '';
  const isMainSender = isMainFrameOf(d.mainWindow);
  const resourcesDir = app.isPackaged ? process.resourcesPath : fileURLToPath(new URL('../../../resources', import.meta.url));

  // AI gate: every AI call is decided by the server. No server, no account or no AI access means denied (fails closed).
  const identityDir = join(d.userDataDir, 'mastery', 'identity');
  const identity = await installationIdentity(identityDir, d.secure);
  const signer = createAppSigner(identity.key);
  // App channel: register this installation's public key to the signed-in account (site: /api/app/installations).
  const registrar = !backend ? null : createInstallationRegistrar({
    origin: siteOrigin, allowLoopback: !app.isPackaged, installation: identity.installation, publicKey: signer.publicKey, label: installationLabel(),
    sign: (route, body, accountId) => signer.headers(route, body, accountId, identity.installation, Date.now() + 60_000),
    accountId: () => d.accounts.service.user?.id ?? null,
    accessToken: async () => (d.accounts.service.user ? await d.accounts.service.accessToken().catch(() => null) : null),
    onRevoked: async () => {
      console.warn('This installation was revoked on the account page; a new one is made on the next launch.');
      await retireInstallationIdentity(identityDir).catch(() => undefined);
    },
  });
  void registrar?.register();
  d.accounts.service.onChange(() => { void registrar?.register(); }); // registers again only for a different account
  const humanCheckSlot: { admission: import('./admission.js').Admission | null } = { admission: null };
  // An AI request is bound to an exact revision; only the current local revision of that object qualifies.
  const current = async (target: RevisionRef) => {
    try { return documents.list(false).some((row) => row.objectId === target.objectId && row.revisionId === target.revisionId); } catch { return false; }
  };
  let ai: AiAccess & { reset(): void };
  if (!backend) ai = new LocalAiAccess(current);
  else try {
    ai = new AiGate({
      limits,
      backend: createAiBackend({
        baseUrl: `${siteOrigin}/`,
        installation: identity.installation,
        accountId: () => d.accounts.service.user?.id ?? null,
        token: async () => (d.accounts.service.user ? await d.accounts.service.accessToken().catch(() => null) : null),
        appHeaders: async (route, body, accountId) => { await registrar?.register(); return signer.headers(route, body, accountId, identity.installation, Date.now() + 60_000); },
        limits,
        allowLoopback: !app.isPackaged,
        // Human check: reuse a cleared check, or ask for one when the site answers HUMAN_CHECK_REQUIRED (then retry once).
        clearanceHeaders: async (route, body, actor) => humanCheckSlot.admission?.aiCached(route, body, actor) ?? {},
        humanCheck: (route, body, actor) => humanCheckSlot.admission?.aiRequire(route, body, actor) ?? Promise.resolve(null),
        humanCheckOutcome: (route, body, actor, result, again) => humanCheckSlot.admission?.aiOutcome(route, body, actor, result, again),
      }),
      current,
    });
  } catch (e) {
    console.warn('AI gate configuration refused; AI stays off:', e instanceof Error ? e.message : String(e));
    ai = new AiGate({
      limits,
      backend: { post: async () => ({ ok: false, code: 'ENTITLEMENT_UNAVAILABLE', message: 'AI is not configured.' }) } as unknown as ConstructorParameters<typeof AiGate>[0]['backend'],
      current: async () => false,
    });
  }
  // The account view changes on every token refresh and state step, not only on a switch. Only a different account ends AI access:
  // signing out asks to sign in again, a new account starts from Off (never "Expired / This connection ended" for an account that
  // never paired anything; matrix aigate 29/30).
  let aiAccount = d.accounts.service.user?.id ?? null;
  d.accounts.service.onChange(() => {
    const next = d.accounts.service.user?.id ?? null;
    if (next === aiAccount) return;
    aiAccount = next;
    if (next === null) ai.invalidate('SIGN_IN_REQUIRED'); else ai.reset();
  });

  const runPage = d.devServerUrl
    ? new URL('run/index.html', d.devServerUrl.endsWith('/') ? d.devServerUrl : `${d.devServerUrl}/`).href
    : pathToFileURL(fileURLToPath(new URL('../../renderer/run/index.html', import.meta.url))).href;
  const runPreload = fileURLToPath(new URL('../run/preload.cjs', import.meta.url));

  const ctx: MasteryContext = {
    ipc: ipcMain,
    userDataDir: d.userDataDir,
    resourcesDir,
    isPackaged: app.isPackaged,
    appVersion: app.getVersion(),
    limits,
    documents,
    workspaces,
    ...(d.library ? { library: d.library } : {}),
    accounts: d.accounts,
    ai,
    humanCheckSlot,
    siteOrigin,
    appChannel: { installation: identity.installation, sign: (route, body, accountId) => signer.headers(route, body, accountId, identity.installation, Date.now() + 60_000) },
    mainWindow: d.mainWindow,
    isMainSender,
    push: (channel, payload) => {
      const w = d.mainWindow();
      if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
    },
    revealAndPush: (channel, payload, deferWhenLoading = true) => {
      const fresh = d.showMainWindow?.() ?? false;
      const w = d.mainWindow();
      if (!w || w.isDestroyed()) return false;
      if (fresh || w.webContents.isLoading()) {
        if (deferWhenLoading) w.webContents.once('did-finish-load', () => setTimeout(() => { if (!w.isDestroyed()) w.webContents.send(channel, payload); }, 1500));
        return false;
      }
      w.webContents.send(channel, payload); return true;
    },
    onQuit: (task) => { quitTasks.push(task); },
    chooseSaveFile: async (defaultName) => {
      const w = d.mainWindow();
      const r = w ? await dialog.showSaveDialog(w, { defaultPath: defaultName }) : await dialog.showSaveDialog({ defaultPath: defaultName });
      return r.canceled || !r.filePath ? null : r.filePath;
    },
    chooseOpenFile: async (filters) => {
      const w = d.mainWindow();
      const opts = { properties: ['openFile' as const], ...(filters ? { filters } : {}) };
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    },
    runEntry: { url: runPage, preload: runPreload },
    // Atlas catalogs live at the repository root in a checkout (tools/atlas-data writes them there).
    atlasResourcesDir: app.isPackaged ? join(process.resourcesPath, 'atlas') : fileURLToPath(new URL('../../../../../resources/atlas', import.meta.url)),
  };

  registerDocumentIpc(ipcMain, documents, { isTrustedSender: isMainSender, chooseRecoveryDestination: () => ctx.chooseSaveFile('recovery.json') });
  if (workspaces) {
    registerWorkspaceIpc(ipcMain, workspaces, {
      isTrustedSender: isMainSender,
      limits,
      // Feature copy adapters are not composed yet: copy-to-league is refused with a clear message.
      copyAdapter: () => ({
        references: () => [],
        catalog: async () => null,
        copy: () => { throw new Error('Copy to another league is not available yet.'); },
      }),
    });
  } else {
    // No verified league yet: answer the workspace channel honestly instead of leaving it unregistered.
    ipcMain.handle('mastery:workspaces', () => ({ ok: false, error: { code: 'NOT_FOUND', message: 'Connect to load this league.' } }));
  }

  // Each area is independent: one failing to start leaves the rest of the app (and the other areas) working.
  const attempt = async <T>(name: string, work: () => Promise<T>): Promise<T | null> => {
    try { return await startupStep(name, work); } catch (e) {
      console.warn(`${name} could not start:`, e instanceof Error ? e.stack ?? e.message : String(e));
      return null;
    }
  };
  // League starts are parked (shared/leagueContent.ts): the starter pack is not read and its channel is not registered.
  const starters = LEAGUE_STARTERS ? await attempt('Starters', async () => wireStarters(ctx)) : null;
  const atlas = await attempt('Atlas', () => wireAtlas(ctx));
  const run = await attempt('Timelines and Run', () => wireTimelinesAndRun(ctx, { atlas }));
  const launcher: RunLauncher | null = run?.launcher ?? null;
  // The window still asks the human-check channel; without a backend there is nothing to check.
  if (!backend) ipcMain.handle('mastery:network', () => ({ ok: false, error: { code: 'OPERATION_FAILED', message: 'The check is unavailable.' } }));
  const marketplace = !backend ? null : await attempt('Marketplace', () => wireMarketplace(ctx, { launcher, timelines: run?.timelines ?? null, library: run?.librarySources ?? null, atlas }));
  if (run && marketplace) { connectReceipts(run, marketplace, d.accounts); run.setPublicServices(marketplace.runServices); run.setSavedSource(id => marketplace.savedSource(id)); }

  let pendingItem: Extract<DeepLinkRoute, { kind: 'item' }> | null = null;
  ipcMain.handle('mastery:links', (event) => {
    if (!isMainSender(event)) return { ok: false, error: { code: 'INVALID', message: 'Unavailable.' } };
    const value = pendingItem; pendingItem = null;
    return { ok: true, value };
  });

  return {
    ctx, atlas, run, marketplace,
    openItem(route) {
      if (!isId('public', route.publicId)) return;
      pendingItem = route;
      // Delivered once: the push below clears it when a live window takes it; the pull (`mastery:links`) covers a window still loading.
      // A window that is still loading pulls it on mount instead; a live one took the push, so a later reload must not replay it.
      if (ctx.revealAndPush('mastery:push:item-link', route, false)) pendingItem = null;
    },
    hasRunWindow: () => run?.hasRunWindow() ?? false,
    async quit() {
      for (const task of [starters?.dispose, atlas?.dispose, run?.dispose, marketplace?.dispose]) { try { task?.(); } catch { /* keep draining */ } }
      for (const task of quitTasks.reverse()) { try { await task(); } catch (e) { console.warn('A store did not close cleanly:', e instanceof Error ? e.message : e); } }
    },
  };
}

/** Run receipts go to the Marketplace outbox, with their evidence. */
function connectReceipts(run: RunWiring, marketplace: MarketplaceWiring, accounts: AccountsHost): void {
  // RunService.deliverReceipts serializes delivery and acknowledges each receipt only after the outbox accepted it.
  const deliver = () => void run.deliverReceipts((receipt, accountId, evidence) => marketplace.deliverReceipt(receipt, accountId, evidence))
    .catch((e: unknown) => console.warn('Run receipts were not delivered yet:', e instanceof Error ? e.message : String(e)));
  run.onRunChange(deliver);
  accounts.service.onChange(deliver);
  deliver();
}
