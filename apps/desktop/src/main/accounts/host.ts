import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { OFFICIAL_ONLY, shareUrl, type AccountView, type ConflictChoice, type ProviderId, type ProviderStatus, type ShareInfo, type ShareSettings, type SharedBuild, type VersionInfo } from '../../shared/accounts.js';
import type { CommunityPublishInput } from '../../shared/community.js';
import { readBuildInfo } from '../../shared/buildXml.js';
import { shareSnapshot } from '../../shared/syncXml.js';
import type { BuildStore } from '../library/buildStore.js';
import { AccountService } from './accountService.js';
import { AuthClient, type FetchLike } from './authClient.js';
import { CloudNetworkError, RestCloudApi, type CloudApi, type ShareRow } from './cloudApi.js';
import { backendConfig, githubAllowed } from './config.js';
import { FileBaseCache, FileStateStore, StoreLibrary } from './fileStores.js';
import { Realtime } from './realtime.js';
import { SessionStore } from './sessionStore.js';
import { SyncEngine, type SyncState } from './syncEngine.js';
import { SharedItemsSync, type SharedItemsStore } from './sharedItemsSync.js';
import type { SecureStorage } from '../secureStorage.js';

export interface AccountsHostDeps {
  /** <userData> */
  dataDir: string;
  store: BuildStore;
  secure: SecureStorage;
  fetch: FetchLike;
  openExternal: (url: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  /** Tells the window about a new view or changed files. */
  onView: (v: AccountView) => void;
  onLibraryChanged: (ids: string[]) => void;
  /** Life, DPS and the like of a build, measured by the engine, for the share page. Null when it cannot be measured. */
  measureStats?: (xml: string) => Promise<Record<string, number> | null>;
  /** The PoM site (mastery/siteOrigin.ts): account deletion runs there, POST /api/account/delete. */
  siteOrigin?: string;
}

/** What the library handlers call after they change a file, so the sync follows. */
export interface SyncHooks {
  saved(id: string): void;
  created(id: string): void;
  renamed(oldId: string, newId: string): void;
  removed(id: string): void;
  folderCreated(path: string): void;
  folderRenamed(oldPath: string, newPath: string): void;
  folderRemoved(path: string): void;
}

export interface AccountsHost {
  service: AccountService;
  engine: SyncEngine;
  hooks: SyncHooks;
  view(): AccountView;
  start(): Promise<void>;
  handleDeepLink(url: string): Promise<void>;
  call(method: string, args: unknown[]): Promise<unknown>;
  /** Connects the shared-items file to the cloud copy; returns what the file's writers call after a local change. */
  attachSharedItems(store: SharedItemsStore): { localChanged(): void };
  /** The community calls the Wealth screen makes (strategy index and session results). */
  community: { api: RestCloudApi; signedIn(): boolean };
}

async function deviceIdentity(dir: string, env: NodeJS.ProcessEnv): Promise<{ id: string; name: string }> {
  const path = join(dir, 'device.json');
  let id = '';
  try {
    id = (JSON.parse(await readFile(path, 'utf8')) as { id?: string }).id ?? '';
  } catch {
    /* first run */
  }
  if (!id) {
    id = randomUUID();
    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify({ id }), 'utf8');
  }
  return { id, name: (env.POM_DEVICE_NAME || hostname() || 'This PC').slice(0, 80) };
}

export async function createAccountsHost(d: AccountsHostDeps): Promise<AccountsHost> {
  const env = d.env ?? process.env;
  // Without a backend nothing here reaches the network: start, deep links and every call except the view are refused.
  const backend = backendConfig();
  const cfg = { url: backend?.supabaseUrl ?? '', key: backend?.supabaseKey ?? '' };
  const dir = join(d.dataDir, 'accounts');
  const device = await deviceIdentity(dir, env);
  const client = new AuthClient(cfg, d.fetch);
  const service = new AccountService({
    client,
    store: new SessionStore(dir, d.secure),
    openExternal: d.openExternal,
    allowed: { google: true, discord: true, github: githubAllowed(env) },
  });
  const rest = new RestCloudApi(cfg, d.fetch, async () => (service.user ? await service.accessToken() : null));
  const api: CloudApi = rest;
  const sharedSync = new SharedItemsSync({ api: rest, dataDir: dir, deviceId: device.id, pollMs: Number(env.POM_SYNC_POLL_MS) || 60_000, onError: (e) => console.warn('Shared items sync:', e instanceof Error ? e.message : e) });
  const lib = new StoreLibrary(d.store);

  const buildInfo = (xml: string) => readBuildInfo(xml);
  const measure = async (xml: string): Promise<Record<string, number> | null> => {
    try {
      return (await d.measureStats?.(xml)) ?? null;
    } catch {
      return null;
    }
  };

  const engine = new SyncEngine({
    api,
    lib,
    state: new FileStateStore(join(d.dataDir, 'sync')),
    base: new FileBaseCache(join(d.dataDir, 'sync', 'base')),
    deviceId: device.id,
    deviceName: device.name,
    pollMs: Number(env.POM_SYNC_POLL_MS) || 60_000,
    debounceMs: Number(env.POM_SYNC_DEBOUNCE_MS) || 1500,
    onChange: () => d.onView(view()),
    onLocalChanged: (ids) => d.onLibraryChanged(ids),
    // Synced builds lost their cloud rows without a deletion marker: if the account itself is gone, sign out here.
    onVanished: () => { void service.signOutIfGone().catch(() => undefined); },
    onPushed: async ({ localId, cloudId, xml }) => {
      const s = await api.shareGet(cloudId);
      if (!s) return;
      const info = buildInfo(xml);
      const stats = await measure(xml);
      await api.shareUpsert({
        buildId: cloudId,
        access: s.access,
        includeNotes: s.include_notes,
        includeLoadouts: s.include_loadouts,
        allowDuplicate: s.allow_duplicate,
        name: localId.slice(localId.lastIndexOf('/') + 1).replace(/\.xml$/i, ''),
        xml: shareSnapshot(xml, { includeNotes: s.include_notes, includeLoadouts: s.include_loadouts }),
        className: info.className,
        ascendClassName: info.ascendClassName,
        level: info.level,
        mainSkill: info.mainSkill,
        ...(stats ? { stats } : {}),
      });
    },
  });

  const view = (): AccountView => {
    const a = service.view();
    const signedIn = a.auth.state === 'signedIn' || a.auth.state === 'restoring';
    return { auth: a.auth, ...(a.error ? { error: a.error } : {}), sync: signedIn ? engine.view() : null, deviceName: device.name, ...(backend ? {} : { unavailable: true }) };
  };

  let lastUser: string | null = null;
  let realtime: Realtime | null = null;
  const startSync = (userId: string) => {
    void engine.start(userId);
    sharedSync.start(userId);
    realtime?.stop();
    realtime = env.POM_REALTIME === '0' ? null : new Realtime({ url: cfg.url, key: cfg.key, userId, token: async () => (service.user ? await service.accessToken() : null), onChange: () => { engine.remoteChanged(); void sharedSync.sync(); }, onLive: (v) => engine.setLive(v) });
    realtime?.start();
  };
  /** An unfinished account deletion on this PC: whose it is, and the sync links saved before it started. Sync for that
   *  account stays off while it is set; every other account syncs as normal. */
  let deleting: { userId: string; saved: SyncState | null } | null = null;
  /**
   * Ends an unfinished deletion (Cancel, a refusal, sign-out, another account signing in): puts that account's saved sync
   * links back on disk and, when `resumeFor` is that account and it is still signed in here, resumes its sync. Safe whatever
   * the server did: if the account was erased its cloud rows are gone without a deletion marker, and SyncEngine unlinks (never
   * trashes) builds whose rows vanished, then the app signs out (signOutIfGone).
   */
  const endDeleting = async (resumeFor: string | null) => {
    const ending = deleting;
    if (!ending) return;
    deleting = null;
    if (ending.saved) await engine.restoreDetached(ending.saved);
    if (resumeFor && resumeFor === ending.userId && service.user?.id === resumeFor && lastUser === resumeFor) startSync(resumeFor);
  };
  service.onChange(() => {
    const u = service.user;
    if (u && u.id !== lastUser) {
      lastUser = u.id;
      const id = u.id;
      void (async () => {
        if (deleting && deleting.userId !== id) await endDeleting(null); // another account: the old attempt is over
        if (!deleting && lastUser === id) startSync(id);
      })();
    } else if (!u && lastUser) {
      lastUser = null;
      realtime?.stop();
      realtime = null;
      engine.stop();
      sharedSync.stop();
      void endDeleting(null); // signed out: the attempt is over; the next sign-in syncs normally
    }
    d.onView(view());
  });

  const asSignedIn = () => {
    if (!service.user) throw new Error('Sign in to use the cloud.');
  };

  /**
   * Deletes the signed-in account and everything of it on the server (the site route cancels Pro billing, erases every
   * row and the auth user), then signs this PC out. Builds on this PC are files in the library and stay:
   *   - before the server is called, sync stops and every local build is unlinked from the cloud (SyncEngine.detachForDeletion),
   *     so the erased cloud rows can never be read as "deleted elsewhere" and take the local files with them;
   *   - only an explicit 4xx refusal from the route that proves nothing was erased puts the links back and resumes sync; any
   *     other failure (5xx, a gateway page, no answer) leaves the builds unlinked and that account's sync off until the retry,
   *     Cancel (cancelDeleteAccount), sign-out or another account signing in (endDeleting).
   * Independently of this, SyncEngine never trashes a build whose cloud row merely vanished (only a deletion marker does), so
   * a deletion done on the website or another PC cannot remove builds here either; the app then signs out (signOutIfGone).
   * A retry after an answer was lost completes: the route answers "already deleted" and the app signs out.
   * Only an https origin, or loopback in development, ever receives the access token.
   */
  async function deleteAccount(): Promise<void> {
    asSignedIn();
    const origin = (d.siteOrigin ?? '').replace(/\/+$/, '');
    if (!/^https:\/\/[^/]+$/i.test(origin) && !/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) throw new Error('Account deletion is not available in this build.');
    const token = await service.accessToken().catch(() => null);
    if (!token) throw new Error('Sign in again, then delete your account.');
    const userId = service.user!.id;
    if (deleting?.userId !== userId) {
      await endDeleting(null);
      realtime?.stop();
      realtime = null;
      sharedSync.stop();
      deleting = { userId, saved: null };
      deleting.saved = await engine.detachForDeletion();
    }
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await d.fetch(`${origin}/api/account/delete`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    } catch {
      throw new Error('The Path of Mastery server did not answer, so the deletion may not have finished. Try again to finish it. Your builds on this PC are safe.');
    }
    let body: { ok?: boolean; error?: string; step?: string } = {};
    try { body = JSON.parse(await res.text()) as typeof body; } catch { /* not JSON */ }
    if (res.ok && body.ok === true) {
      deleting = null; // the account is gone: its links are not put back
      await service.signOut();
      return;
    }
    // Sync comes back only on an explicit refusal from the route itself that proves nothing was erased: a 4xx answer whose
    // JSON says ok:false and either names no deletion step (the sign-in or set-up was refused before anything ran) or the
    // billing check. Anything else (a 5xx, a gateway page, text that is not the route's JSON) may follow a deletion that went
    // through, so the builds stay unlinked and sync stays off until the retry or sign-out.
    const explicitRefusal = res.status >= 400 && res.status < 500 && body.ok === false && (!body.step || body.step === 'billing_unconfigured');
    if (explicitRefusal) await endDeleting(userId);
    throw new Error(body.error || `The deletion may not have finished (the server answered ${res.status}). Try again to finish it. Your builds on this PC are safe.`);
  }
  const toInfo = (row: ShareRow): ShareInfo => ({ token: row.token, url: shareUrl(row.token), access: row.access, includeNotes: row.include_notes, includeLoadouts: row.include_loadouts, allowDuplicate: row.allow_duplicate, updatedAt: Date.parse(row.updated_at) });

  async function shareSet(localId: string, o: ShareSettings): Promise<ShareInfo> {
    asSignedIn();
    const cloudId = engine.cloudIdOf(localId);
    if (!cloudId) throw new Error('This build is not in your cloud library yet. Sync it first.');
    const xml = await lib.read(localId);
    if (xml === null) throw new Error('That build file is gone.');
    // A build with changes the cloud has not got yet is sent first, so the link shows what the player sees.
    await engine.syncNow();
    const info = buildInfo(xml);
    const stats = await measure(xml);
    try {
      return toInfo(
        await api.shareUpsert({
          buildId: cloudId,
          access: o.access,
          includeNotes: o.includeNotes,
          includeLoadouts: o.includeLoadouts,
          allowDuplicate: o.allowDuplicate,
          name: localId.slice(localId.lastIndexOf('/') + 1).replace(/\.xml$/i, ''),
          xml: shareSnapshot(xml, o),
          className: info.className,
          ascendClassName: info.ascendClassName,
          level: info.level,
          mainSkill: info.mainSkill,
          ...(stats ? { stats } : {}),
        }),
      );
    } catch (e) {
      if (e instanceof CloudNetworkError) throw new Error('The cloud could not be reached. Try again when you are online.');
      throw e;
    }
  }

  /** Community calls: a network failure says so in plain words instead of the raw error. */
  const net = async <T,>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof CloudNetworkError) throw new Error('Could not reach the community server. Check your connection and try again.');
      throw e;
    }
  };

  const methods: Record<string, (...a: any[]) => Promise<unknown> | unknown> = {
    view: () => view(),
    providers: (): Promise<ProviderStatus[]> => service.providers(),
    signInProvider: (p: ProviderId) => service.signInWithProvider(p),
    signInEmail: (email: string) => service.signInWithEmail(email),
    cancelSignIn: () => service.cancelSignIn(),
    signOut: () => service.signOut(),
    syncNow: () => engine.syncNow(),
    feedbackSend: async (i: { message: string; kind: string; contact: string; version: string; platform: string }) => {
      try {
        await rest.feedbackSend(i, !!service.user);
      } catch (e) {
        if (e instanceof CloudNetworkError) throw new Error('Could not reach the server. Check your connection, or send it by email instead.');
        throw e;
      }
    },
    communityList: (i: { limit?: number; offset?: number } | undefined) => net(() => rest.communityList(i ?? {})),
    communitySimilar: (i: { className: string; ascendClassName: string; mainSkill: string; exclude?: string }) => net(() => rest.communitySimilar(i)),
    communityGet: (id: string) => net(() => rest.communityGet(id)),
    communityMine: () => net(() => rest.communityMine()),
    communityPublish: async (i: CommunityPublishInput) => {
      asSignedIn();
      return net(() => rest.communityPublish(i));
    },
    communityUnpublish: async (id: string) => {
      asSignedIn();
      await net(() => rest.communityUnpublish(id));
    },
    communityReport: async (id: string, reason: string) => {
      asSignedIn();
      return net(() => rest.communityReport(id, reason));
    },
    deleteMyCommunityData: async () => {
      asSignedIn();
      await net(() => rest.deleteMyCommunityData());
    },
    deleteAccount: () => deleteAccount(),
    /** The delete dialog was closed after a failed try: the attempt is over, sync for this account comes back. */
    cancelDeleteAccount: async () => {
      if (deleting && deleting.userId === service.user?.id) await endDeleting(deleting.userId);
    },
    enroll: async (id: string) => {
      asSignedIn();
      await engine.enroll(id);
      // "Sync to cloud" is asked for by hand: if the cloud cannot be reached, say so and leave the build local instead of queueing it silently.
      await engine.syncNow();
      const v = engine.view();
      if (v.state === 'offline' || v.state === 'error') {
        await engine.unenroll(id, false);
        throw new Error(`Couldn’t reach your cloud library, so the build was not synced and stays on this PC. ${v.state === 'error' ? v.meta : 'Check your connection and try again.'}`);
      }
    },
    enrollAll: () => engine.enrollAll(),
    unenroll: (id: string, removeFromCloud: boolean) => engine.unenroll(id, removeFromCloud),
    conflictTexts: (id: string) => engine.conflictTexts(id),
    resolve: (id: string, choice: ConflictChoice) => engine.resolve(id, choice),
    versions: (id: string): Promise<VersionInfo[] | null> => engine.versions(id),
    versionText: (id: string, rev: number) => engine.versionText(id, rev),
    restore: (id: string, rev: number, label: string) => engine.restore(id, rev, label),
    restoreAsCopy: (id: string, rev: number, label: string) => engine.restoreAsCopy(id, rev, label),
    deletedBuilds: () => {
      asSignedIn();
      return engine.deletedBuilds();
    },
    restoreDeleted: (cloudId: string) => {
      asSignedIn();
      return engine.restoreDeleted(cloudId);
    },
    shareGet: async (id: string): Promise<ShareInfo | null> => {
      asSignedIn();
      const c = engine.cloudIdOf(id);
      if (!c) return null;
      const r = await api.shareGet(c);
      return r ? toInfo(r) : null;
    },
    shareSet: (id: string, o: ShareSettings) => shareSet(id, o),
    shareRevoke: async (id: string) => {
      asSignedIn();
      const c = engine.cloudIdOf(id);
      if (c) await api.shareRevoke(c);
    },
    sharedOpen: async (token: string): Promise<SharedBuild | null> => {
      const r = await api.sharedBuild(token);
      if (!r) return null;
      return { name: r.name, className: r.class_name, ascendClassName: r.ascend_class_name, level: r.level, mainSkill: r.main_skill, xml: r.xml, allowDuplicate: r.allow_duplicate, updatedAt: Date.parse(r.updated_at) };
    },
  };

  const hooks: SyncHooks = {
    saved: () => engine.request(),
    created: (id) => void engine.created(id),
    renamed: (a, b) => void engine.renamed(a, b),
    removed: () => engine.request(),
    folderCreated: (p) => engine.folderCreated(p),
    folderRenamed: (a, b) => void engine.folderRenamed(a, b),
    folderRemoved: () => engine.folderRemoved(),
  };

  return {
    service,
    engine,
    hooks,
    view,
    start: () => (backend ? service.restore() : Promise.resolve()),
    handleDeepLink: (url) => (backend ? service.handleCallback(url) : Promise.resolve()),
    community: { api: rest, signedIn: () => !!service.user },
    attachSharedItems: (store) => {
      sharedSync.attach(store);
      return { localChanged: () => void sharedSync.sync() };
    },
    call: async (method, args) => {
      if (!backend) {
        if (method === 'view') return view();
        if (method === 'providers') return [];
        throw new Error(OFFICIAL_ONLY);
      }
      const fn = methods[method];
      if (!fn) throw new Error(`Unknown account call ${method}`);
      return fn(...args);
    },
  };
}
