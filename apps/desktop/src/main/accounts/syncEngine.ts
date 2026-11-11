import { createHash, randomUUID } from 'node:crypto';
import type { BuildSyncStatus, ConflictChoice, DeletedCloudBuild, SyncConflict, SyncView, VersionInfo } from '../../shared/accounts.js';
import { readBuildInfo } from '../../shared/buildXml.js';
import { describeChange, describeChangeShort } from '../../shared/syncXml.js';
import { CloudAuthError, CloudNetworkError, type CloudApi, type CloudBuildRow, type PushResult } from './cloudApi.js';
import { displayState, INITIAL, reduce, type MachineState, type SyncEvent } from './syncMachine.js';

export interface LocalBuildRef {
  id: string;
  name: string;
  folder: string;
  mtimeMs: number;
  size: number;
}

/** What the sync needs from the player's local library. The app's adapter wraps BuildStore. */
export interface LocalLibrary {
  list(): Promise<LocalBuildRef[]>;
  folders(): Promise<string[]>;
  read(id: string): Promise<string | null>;
  /** Overwrites an existing build's text. */
  write(id: string, xml: string): Promise<void>;
  /** Makes a new build; a name that is taken gets a number. */
  create(folder: string, name: string, xml: string): Promise<LocalBuildRef>;
  /** To Recently deleted. */
  remove(id: string): Promise<void>;
  /** Gives the build this folder and name (numbered when taken) and returns where it ended up. */
  place(id: string, folder: string, name: string): Promise<LocalBuildRef>;
  createFolder(path: string): Promise<void>;
  /** Removes the folder only when it is empty; returns whether it did. */
  removeFolderIfEmpty(path: string): Promise<boolean>;
}

export interface SyncEntry {
  cloudId: string;
  /** The cloud rev this device last saw for the build. */
  rev: number;
  /** Hash of the local text when it last matched the cloud. */
  sha: string;
  name: string;
  folder: string;
}

export interface SyncState {
  version: 1;
  userId: string;
  deviceId: string;
  entries: Record<string, SyncEntry>;
  folders: string[];
  lastSyncAt: number | null;
}

export interface StateStore {
  load(userId: string): Promise<SyncState | null>;
  save(s: SyncState): Promise<void>;
}

/** The last text that matched the cloud, kept so a save can say what it changed. */
export interface BaseCache {
  get(cloudId: string): Promise<string | null>;
  put(cloudId: string, xml: string): Promise<void>;
  delete(cloudId: string): Promise<void>;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(h: unknown): void;
}

export interface SyncEngineDeps {
  api: CloudApi;
  lib: LocalLibrary;
  state: StateStore;
  base: BaseCache;
  deviceId: string;
  deviceName: string;
  now?: () => number;
  timers?: Timers;
  onChange?: (view: SyncView) => void;
  /** Called when a pass changed local files, so the Library list reloads. */
  onLocalChanged?: (ids: string[]) => void;
  /** A pass found synced builds whose cloud rows are simply gone (no deletion marker): it unlinked them and kept the files.
   *  The host checks whether the account itself is gone (deleted on the website or another PC) and signs out if so. */
  onVanished?: (count: number) => void;
  /** A build's text reached the cloud: the host refreshes the build's share link from it. */
  onPushed?: (p: { localId: string; cloudId: string; xml: string }) => Promise<void>;
  /** Milliseconds between checks for changes made on other devices. */
  pollMs?: number;
  /** The same, while realtime is connected and only has to catch a missed message. */
  livePollMs?: number;
  debounceMs?: number;
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const ts = (s: string | null | undefined): number => (s ? Date.parse(s) : 0);
const refName = (id: string): string => id.slice(id.lastIndexOf('/') + 1).replace(/\.xml$/i, '');
const refFolder = (id: string): string => (id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '');

interface Scan {
  ref: LocalBuildRef;
  xml: string;
  sha: string;
}

interface ConflictInfo {
  cloudRev: number;
  cloudDevice: string;
  cloudUpdatedAt: number;
  localEditedAt: number;
}

export class SyncEngine {
  private st: SyncState | null = null;
  private machine: MachineState = INITIAL;
  private running: Promise<void> | null = null;
  private again = false;
  private timer: unknown = null;
  private poll: unknown = null;
  private conflicts = new Map<string, ConflictInfo>();
  private pendingList: SyncView['pending'] = [];
  private cloudCount = 0;
  private buildStatus: Record<string, BuildSyncStatus> = {};
  private nextNote = new Map<string, string>();
  /** Builds just restored from an earlier version: that push is always its own version row, never folded into the last one. */
  private noCoalesce = new Set<string>();
  private folderPuts = new Set<string>();
  private hashCache = new Map<string, { mtimeMs: number; size: number; sha: string }>();
  private readonly now: () => number;
  private readonly timers: Timers;
  private stopped = true;
  private live = false;
  private vanishedLast = 0;

  constructor(private readonly d: SyncEngineDeps) {
    this.now = d.now ?? Date.now;
    this.timers = d.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  async start(userId: string): Promise<void> {
    this.stopped = false;
    const loaded = await this.d.state.load(userId);
    this.st = loaded ?? { version: 1, userId, deviceId: this.d.deviceId, entries: {}, folders: [], lastSyncAt: null };
    this.machine = reduce(this.machine, { t: 'signedIn' });
    if (loaded?.lastSyncAt) this.machine = { ...this.machine, lastOkAt: loaded.lastSyncAt };
    this.emit();
    this.request(0);
    this.armPoll();
  }

  stop(): void {
    this.stopped = true;
    this.live = false;
    if (this.timer) this.timers.clear(this.timer);
    if (this.poll) this.timers.clear(this.poll);
    this.timer = this.poll = null;
    this.st = null;
    this.conflicts.clear();
    this.buildStatus = {};
    this.pendingList = [];
    this.cloudCount = 0;
    this.machine = reduce(this.machine, { t: 'signedOut' });
    this.emit();
  }

  /**
   * Account deletion: stop syncing, wait for a pass already running, then forget every link between local builds and the
   * cloud, on disk too (no build is enrolled, no folder is tracked). The server can then erase the cloud rows without any pass,
   * now or after a restart, reading that as "deleted on another device" and removing the files here. Returns the state as it
   * was, for restore() when the deletion is refused before the server erased anything.
   */
  async detachForDeletion(): Promise<SyncState | null> {
    const st = this.st;
    const pass = this.running;
    this.stop();
    if (pass) await pass.catch(() => undefined);
    if (!st) return null;
    const before = JSON.parse(JSON.stringify(st)) as SyncState;
    await this.d.state.save({ ...st, entries: {}, folders: [], lastSyncAt: null });
    return before;
  }

  /** Puts back the state detachForDeletion() returned (start() then resumes from it). */
  async restoreDetached(saved: SyncState): Promise<void> {
    await this.d.state.save(saved);
  }

  private armPoll(): void {
    if (this.poll) this.timers.clear(this.poll);
    this.poll = this.timers.set(() => {
      if (!this.stopped && this.machine.phase !== 'offline' && this.machine.phase !== 'error') this.request(0);
      this.armPoll();
    }, this.live ? this.d.livePollMs ?? 300_000 : this.d.pollMs ?? 60_000);
  }

  /** The host tells the engine whether realtime is connected; it then polls rarely. */
  setLive(live: boolean): void {
    if (this.live === live) return;
    this.live = live;
    if (!this.stopped) {
      this.armPoll();
      this.emit();
    }
  }

  /** Another device changed something: sync soon (a burst of messages becomes one pass). */
  remoteChanged(): void {
    this.request(300);
  }

  /** Runs a pass soon. Many requests in a row become one. */
  request(delayMs = this.d.debounceMs ?? 1500): void {
    if (this.stopped) return;
    if (this.timer) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.syncNow();
    }, delayMs);
  }

  /** Runs a pass and waits for it. A pass already running is followed by one more. */
  syncNow(): Promise<void> {
    if (this.stopped || !this.st) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again && !this.stopped);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  // ---- view -----------------------------------------------------------------------------------

  view(): SyncView {
    const s = this.machine;
    const state = displayState(s);
    let meta = '';
    switch (state) {
      case 'synced':
        meta = `${s.lastOkAt ? `Last synced ${clock(s.lastOkAt)}` : 'Up to date'} · ${this.cloudCount} cloud ${this.cloudCount === 1 ? 'build' : 'builds'}${this.live ? ' · Live' : ''}`;
        break;
      case 'syncing':
        meta = s.pending > 0 ? 'Uploading changes from this PC' : 'Checking for changes';
        break;
      case 'conflict':
        meta = 'It changed on two devices while one was offline';
        break;
      case 'offline':
        meta = 'Changes are saved on this PC and sync when you reconnect';
        break;
      case 'error':
        meta = s.error ?? 'Something went wrong. It will try again.';
        break;
      case 'local':
        meta = 'Builds are saved on this PC';
    }
    return {
      state,
      meta,
      lastSyncAt: s.lastOkAt,
      cloudCount: this.cloudCount,
      pending: this.pendingList.filter((x) => !this.conflicts.has(x.localId)),
      conflicts: [...this.conflicts.entries()].map(([id, c]) => this.conflictView(id, c)),
      builds: this.buildStatus,
      ...(s.phase === 'error' && s.error ? { detail: s.error } : {}),
    };
  }

  private conflictView(localId: string, c: ConflictInfo): SyncConflict {
    return {
      localId,
      name: refName(localId),
      className: '',
      mine: { deviceName: this.d.deviceName, here: true, editedAt: c.localEditedAt },
      theirs: { deviceName: c.cloudDevice || 'Another device', here: false, editedAt: c.cloudUpdatedAt },
    };
  }

  private emit(): void {
    this.d.onChange?.(this.view());
  }

  private dispatch(e: SyncEvent): void {
    this.machine = reduce(this.machine, e);
  }

  // ---- hooks from the library -----------------------------------------------------------------

  /** A build was renamed or moved by the player. */
  async renamed(oldId: string, newId: string): Promise<void> {
    if (!this.st) return;
    const e = this.st.entries[oldId];
    if (!e) return;
    delete this.st.entries[oldId];
    this.st.entries[newId] = e;
    const h = this.hashCache.get(oldId);
    if (h) {
      this.hashCache.delete(oldId);
      this.hashCache.set(newId, h);
    }
    const c = this.conflicts.get(oldId);
    if (c) {
      this.conflicts.delete(oldId);
      this.conflicts.set(newId, c);
    }
    await this.d.state.save(this.st);
    this.request();
  }

  async folderRenamed(oldPath: string, newPath: string): Promise<void> {
    if (!this.st) return;
    const next: Record<string, SyncEntry> = {};
    for (const [id, e] of Object.entries(this.st.entries)) {
      if (id.startsWith(oldPath + '/')) next[newPath + id.slice(oldPath.length)] = e;
      else next[id] = e;
    }
    this.st.entries = next;
    this.st.folders = this.st.folders.map((f) => (f === oldPath ? newPath : f.startsWith(oldPath + '/') ? newPath + f.slice(oldPath.length) : f));
    this.hashCache.clear();
    await this.d.state.save(this.st);
    this.request();
  }

  /** A folder was deleted by the player; the next pass sends it. */
  folderRemoved(): void {
    this.request();
  }

  /** The player made or imported a build while signed in: it syncs from the start. */
  async created(id: string): Promise<void> {
    await this.enroll(id);
  }

  isTracked(id: string): boolean {
    return !!this.st?.entries[id];
  }

  /** Puts a local build in the cloud. */
  async enroll(id: string): Promise<void> {
    if (!this.st || this.st.entries[id]) return;
    this.st.entries[id] = { cloudId: randomUUID(), rev: 0, sha: '', name: refName(id), folder: refFolder(id) };
    await this.d.state.save(this.st);
    this.request(0);
  }

  async enrollAll(): Promise<number> {
    if (!this.st) return 0;
    let n = 0;
    for (const b of await this.d.lib.list()) {
      if (!this.st.entries[b.id]) {
        this.st.entries[b.id] = { cloudId: randomUUID(), rev: 0, sha: '', name: b.name, folder: b.folder };
        n++;
      }
    }
    if (n) {
      await this.d.state.save(this.st);
      this.request(0);
    }
    return n;
  }

  /** Stops syncing a build. The local file stays; with removeFromCloud the cloud copy is deleted too. */
  async unenroll(id: string, removeFromCloud: boolean): Promise<void> {
    const e = this.st?.entries[id];
    if (!this.st || !e) return;
    if (removeFromCloud && e.rev > 0) {
      try {
        await this.d.api.remove(e.cloudId, e.rev, true);
      } catch (err) {
        if (err instanceof CloudNetworkError) throw new Error('The cloud could not be reached, so the build was not removed from it.');
        throw err;
      }
    }
    delete this.st.entries[id];
    this.conflicts.delete(id);
    delete this.buildStatus[id];
    await this.d.base.delete(e.cloudId);
    await this.d.state.save(this.st);
    this.emit();
  }

  cloudIdOf(localId: string): string | null {
    return this.st?.entries[localId]?.cloudId ?? null;
  }

  // ---- the pass -------------------------------------------------------------------------------

  private async scan(): Promise<Map<string, Scan>> {
    const out = new Map<string, Scan>();
    const refs = await this.d.lib.list();
    for (const ref of refs) {
      const hit = this.hashCache.get(ref.id);
      if (hit && hit.mtimeMs === ref.mtimeMs && hit.size === ref.size) {
        out.set(ref.id, { ref, xml: '', sha: hit.sha });
        continue;
      }
      const xml = await this.d.lib.read(ref.id);
      if (xml === null) continue;
      const sha = sha256(xml);
      this.hashCache.set(ref.id, { mtimeMs: ref.mtimeMs, size: ref.size, sha });
      out.set(ref.id, { ref, xml, sha });
    }
    return out;
  }

  private async textOf(scan: Scan): Promise<string> {
    if (scan.xml) return scan.xml;
    const x = (await this.d.lib.read(scan.ref.id)) ?? '';
    scan.xml = x;
    return x;
  }

  /** Works out what is waiting without touching the network. */
  private async measure(scan: Map<string, Scan>): Promise<{ pending: SyncView['pending']; localChanged: Set<string> }> {
    const st = this.st!;
    const pending: SyncView['pending'] = [];
    const localChanged = new Set<string>();
    for (const [id, e] of Object.entries(st.entries)) {
      const s = scan.get(id);
      if (!s) {
        if (e.rev > 0) {
          localChanged.add(id);
          pending.push({ localId: id, name: refName(id), className: '', what: 'Deleted' });
        }
        continue;
      }
      if (e.rev === 0 || s.sha !== e.sha || refName(id) !== e.name || refFolder(id) !== e.folder) {
        localChanged.add(id);
        const base = e.rev === 0 ? null : await this.d.base.get(e.cloudId);
        const xml = await this.textOf(s);
        const info = readBuildInfo(xml);
        pending.push({
          localId: id,
          name: refName(id),
          className: info.ascendClassName || info.className,
          what: e.rev === 0 ? 'New build' : base && s.sha !== e.sha ? describeChangeShort(base, xml) : 'Renamed or moved',
        });
      }
    }
    return { pending, localChanged };
  }

  /** Re-keys entries whose file disappeared when an untracked file with the same text appeared (a rename done outside the app's hooks). */
  private detectRenames(scan: Map<string, Scan>): void {
    const st = this.st!;
    const missing = Object.entries(st.entries).filter(([id]) => !scan.has(id));
    if (!missing.length) return;
    const untracked = [...scan.values()].filter((s) => !st.entries[s.ref.id]);
    for (const [id, e] of missing) {
      if (!e.sha) continue;
      const match = untracked.find((u) => u.sha === e.sha);
      if (match) {
        delete st.entries[id];
        st.entries[match.ref.id] = e;
        untracked.splice(untracked.indexOf(match), 1);
      }
    }
  }

  private async pass(): Promise<void> {
    const st = this.st;
    if (!st) return;
    this.dispatch({ t: 'start' });
    this.emit();
    this.vanishedLast = 0;
    const changedLocal: string[] = [];
    let scan = await this.scan();
    this.detectRenames(scan);
    let m = await this.measure(scan);
    this.buildStatus = Object.fromEntries(Object.keys(st.entries).map((id) => [id, this.conflicts.has(id) ? { status: 'conflict' as const, pending: 1 } : m.localChanged.has(id) ? { status: 'syncing' as const, pending: 1 } : { status: 'synced' as const, pending: 0 }]));
    this.pendingList = m.pending;
    this.emit();
    try {
      const listing = await this.d.api.list();
      const cloud = new Map(listing.builds.map((b) => [b.id, b]));
      this.cloudCount = listing.builds.filter((b) => !b.deleted_at).length;
      const byCloudId = new Map(Object.entries(st.entries).map(([id, e]) => [e.cloudId, id]));
      let vanished = 0;
      this.conflicts = new Map([...this.conflicts].filter(([id]) => !!st.entries[id]));

      for (const [id, e] of Object.entries({ ...st.entries })) {
        const row = cloud.get(e.cloudId);
        const s = scan.get(id);
        const localDeleted = !s && e.rev > 0;
        const localChanged = m.localChanged.has(id) && !localDeleted;
        // Only a deletion marker (deleted_at) means "deleted on another device". A row that is simply missing (the account
        // was erased, rows were purged, the listing belongs to a user that no longer exists) proves nothing about this build.
        const tombstoned = !!row && !!row.deleted_at;
        const rowVanished = !row && e.rev > 0;
        const cloudGone = !row || !!row.deleted_at;
        const cloudChanged = !!row && !row.deleted_at && row.rev !== e.rev && e.rev > 0;

        if (localDeleted) {
          if (cloudGone) {
            await this.drop(id, e);
          } else if (!cloudChanged) {
            const r = await this.d.api.remove(e.cloudId, e.rev);
            if (r.status === 'ok') await this.drop(id, e);
            else await this.pullInto(id, e, row!, changedLocal, scan); // changed elsewhere: bring it back
          } else {
            await this.pullInto(id, e, row!, changedLocal, scan);
          }
          continue;
        }
        if (!s) continue;
        if (rowVanished) {
          // Unlink and keep: the file stays in the library as a local-only build; nothing is pushed back.
          await this.drop(id, e);
          vanished++;
          continue;
        }
        if (tombstoned && e.rev > 0) {
          if (!localChanged) {
            // Deleted on another device and untouched here: delete it here too.
            await this.d.lib.remove(id);
            changedLocal.push(id);
            await this.drop(id, e);
            continue;
          }
          // Edited here after it was deleted elsewhere: the edit wins and the build comes back.
          await this.push(id, e, s, row?.rev ?? e.rev, true);
          continue;
        }
        if (e.rev === 0) {
          // A new build; its cloud id is ours alone, so there is nothing to conflict with.
          await this.push(id, e, s, 0, false);
          continue;
        }
        if (localChanged && cloudChanged) {
          if (row!.sha === e.sha) {
            // The cloud only renamed or moved it; the text is as we last saw it, so our edit goes on top.
            await this.push(id, e, s, row!.rev, false);
          } else if (row!.sha === s.sha) {
            e.rev = row!.rev;
            e.sha = s.sha;
            if (refName(id) !== row!.name || refFolder(id) !== row!.folder) await this.push(id, e, s, row!.rev, false);
            else {
              e.name = row!.name;
              e.folder = row!.folder;
            }
          } else {
            this.conflicts.set(id, { cloudRev: row!.rev, cloudDevice: row!.device_name, cloudUpdatedAt: ts(row!.updated_at), localEditedAt: s.ref.mtimeMs });
          }
          continue;
        }
        if (localChanged) {
          const out = await this.push(id, e, s, e.rev, false);
          if (out === 'conflict') {
            const fresh = (await this.d.api.list()).builds.find((b) => b.id === e.cloudId);
            if (fresh) this.conflicts.set(id, { cloudRev: fresh.rev, cloudDevice: fresh.device_name, cloudUpdatedAt: ts(fresh.updated_at), localEditedAt: s.ref.mtimeMs });
          }
          continue;
        }
        if (cloudChanged) {
          await this.pullInto(id, e, row!, changedLocal, scan);
          continue;
        }
        this.conflicts.delete(id);
      }

      // Cloud builds this device has never seen.
      for (const row of listing.builds) {
        if (row.deleted_at || byCloudId.has(row.id)) continue;
        await this.download(row, changedLocal);
      }

      // Folders follow the builds' rule: when rows vanished (an erased account), no local folder is removed either.
      if (!vanished) await this.syncFolders(listing.folders, changedLocal);
      void this.d.api.purge().catch(() => undefined);

      scan = await this.scan();
      m = await this.measure(scan);
      this.cloudCount = Object.values(st.entries).filter((x) => x.rev > 0).length;
      const status: Record<string, BuildSyncStatus> = {};
      for (const id of Object.keys(st.entries)) {
        status[id] = this.conflicts.has(id) ? { status: 'conflict', pending: 1 } : m.localChanged.has(id) ? { status: 'syncing', pending: 1 } : { status: 'synced', pending: 0 };
      }
      this.buildStatus = status;
      this.pendingList = m.pending;
      st.lastSyncAt = this.now();
      this.vanishedLast = vanished;
      await this.d.state.save(st);
      this.dispatch({ t: 'ok', at: this.now(), pending: m.pending.length, conflicts: this.conflicts.size });
    } catch (e) {
      this.pendingList = m.pending;
      this.buildStatus = Object.fromEntries(Object.keys(st.entries).map((id) => [id, this.conflicts.has(id) ? { status: 'conflict' as const, pending: 1 } : m.localChanged.has(id) ? { status: 'offline' as const, pending: 1 } : { status: 'synced' as const, pending: 0 }]));
      await this.d.state.save(st).catch(() => undefined);
      if (e instanceof CloudNetworkError) {
        this.dispatch({ t: 'network', at: this.now(), pending: m.pending.length });
        this.scheduleRetry();
      } else if (e instanceof CloudAuthError) {
        this.dispatch({ t: 'fail', at: this.now(), pending: m.pending.length, error: 'Your sign-in ended. Sign in again to sync.' });
      } else {
        this.dispatch({ t: 'fail', at: this.now(), pending: m.pending.length, error: e instanceof Error ? e.message : String(e) });
        this.scheduleRetry();
      }
    }
    if (changedLocal.length) this.d.onLocalChanged?.(changedLocal);
    this.emit();
    if (this.vanishedLast) this.d.onVanished?.(this.vanishedLast);
  }

  private scheduleRetry(): void {
    if (this.stopped || !this.machine.retryAt) return;
    if (this.timer) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.syncNow();
    }, Math.max(0, this.machine.retryAt - this.now()));
  }

  private async drop(id: string, e: SyncEntry): Promise<void> {
    delete this.st!.entries[id];
    this.conflicts.delete(id);
    await this.d.base.delete(e.cloudId);
  }

  private async push(id: string, e: SyncEntry, s: Scan, baseRev: number, force: boolean, opts: { note?: string; coalesce?: number } = {}): Promise<'ok' | 'conflict'> {
    const xml = await this.textOf(s);
    const info = readBuildInfo(xml);
    const base = e.rev > 0 ? await this.d.base.get(e.cloudId) : null;
    const note = opts.note ?? this.nextNote.get(id) ?? (e.rev === 0 ? 'Created' : describeChange(base, xml));
    const r: PushResult = await this.d.api.push({
      id: e.cloudId,
      baseRev,
      name: refName(id),
      folder: refFolder(id),
      xml,
      deviceId: this.d.deviceId,
      deviceName: this.d.deviceName,
      note,
      className: info.className,
      ascendClassName: info.ascendClassName,
      level: info.level,
      mainSkill: info.mainSkill,
      treeVersion: info.treeVersion,
      force,
      ...(opts.coalesce !== undefined ? { coalesceMinutes: opts.coalesce } : this.noCoalesce.has(id) ? { coalesceMinutes: 0 } : {}),
    });
    this.nextNote.delete(id);
    this.noCoalesce.delete(id);
    if (r.status === 'conflict') return 'conflict';
    e.rev = r.rev;
    e.sha = s.sha;
    e.name = refName(id);
    e.folder = refFolder(id);
    await this.d.base.put(e.cloudId, xml);
    this.conflicts.delete(id);
    try {
      await this.d.onPushed?.({ localId: id, cloudId: e.cloudId, xml });
    } catch {
      /* a share link that could not refresh must not fail the save */
    }
    return 'ok';
  }

  /** Writes the cloud copy over the local file (and renames the file if the build was renamed elsewhere). */
  private async pullInto(id: string, e: SyncEntry, row: CloudBuildRow, changedLocal: string[], scan: Map<string, Scan>): Promise<void> {
    const local = scan.get(id);
    let xml: string | null = null;
    if (!local || local.sha !== row.sha) {
      const full = await this.d.api.get(e.cloudId);
      if (!full) return;
      xml = full.xml;
    }
    let target = id;
    if (!local) {
      const created = await this.d.lib.create(row.folder, row.name, xml!);
      target = created.id;
    } else {
      if (xml !== null) {
        await this.d.lib.write(id, xml);
        changedLocal.push(id);
      }
      if (refName(id) !== row.name || refFolder(id) !== row.folder) {
        const placed = await this.d.lib.place(id, row.folder, row.name);
        target = placed.id;
        changedLocal.push(target);
      }
    }
    delete this.st!.entries[id];
    this.st!.entries[target] = { cloudId: e.cloudId, rev: row.rev, sha: row.sha, name: refName(target), folder: refFolder(target) };
    this.hashCache.delete(id);
    this.conflicts.delete(id);
    if (xml !== null) await this.d.base.put(e.cloudId, xml);
    else if (local) await this.d.base.put(e.cloudId, await this.textOf(local));
    changedLocal.push(target);
  }

  private async download(row: CloudBuildRow, changedLocal: string[]): Promise<void> {
    const full = await this.d.api.get(row.id);
    if (!full) return;
    const created = await this.d.lib.create(row.folder, row.name, full.xml);
    this.st!.entries[created.id] = { cloudId: row.id, rev: row.rev, sha: full.sha, name: created.name, folder: created.folder };
    await this.d.base.put(row.id, full.xml);
    changedLocal.push(created.id);
    // The local name may be numbered when the name was taken; the next pass sends the new name up.
  }

  /** Three-way: what the cloud has, what this PC has, and what both had at the last pass. */
  private async syncFolders(cloudFolders: string[], changedLocal: string[]): Promise<void> {
    const st = this.st!;
    const local = new Set(await this.d.lib.folders());
    const cloud = new Set(cloudFolders);
    const known = new Set(st.folders);
    const sent = new Set<string>();
    for (const f of cloud) {
      if (!local.has(f) && !known.has(f)) {
        await this.d.lib.createFolder(f);
        changedLocal.push(f);
      }
    }
    for (const f of local) {
      if (cloud.has(f) || known.has(f)) continue;
      // New on this PC. Folders of local-only builds stay local; one that holds a synced build or was made while signed in goes up.
      if (this.folderPuts.has(f) || Object.keys(st.entries).some((id) => id.startsWith(f + '/'))) {
        await this.d.api.folderPut(f);
        sent.add(f);
      }
    }
    for (const f of known) {
      if (cloud.has(f) && !local.has(f)) await this.d.api.folderDelete(f);
      else if (!cloud.has(f) && local.has(f) && (await this.d.lib.removeFolderIfEmpty(f))) changedLocal.push(f);
    }
    this.folderPuts.clear();
    const after = await this.d.lib.folders();
    st.folders = after.filter((f) => (cloud.has(f) && !(known.has(f) && !local.has(f))) || sent.has(f));
  }

  /** The player made a folder while signed in: it goes to the cloud even when it is still empty. */
  folderCreated(path: string): void {
    this.folderPuts.add(path);
    this.request();
  }

  // ---- conflicts ------------------------------------------------------------------------------

  /** Both copies' text, for the dialog's comparison. */
  async conflictTexts(localId: string): Promise<{ mine: string; theirs: string } | null> {
    const e = this.st?.entries[localId];
    if (!e) return null;
    const mine = await this.d.lib.read(localId);
    const theirs = await this.d.api.get(e.cloudId);
    if (mine === null || !theirs) return null;
    return { mine, theirs: theirs.xml };
  }

  async resolve(localId: string, choice: ConflictChoice): Promise<void> {
    const st = this.st;
    const e = st?.entries[localId];
    if (!st || !e) return;
    const theirs = await this.d.api.get(e.cloudId);
    const mineXml = await this.d.lib.read(localId);
    if (!theirs || mineXml === null) {
      this.conflicts.delete(localId);
      this.request(0);
      return;
    }
    const mine: Scan = { ref: { id: localId, name: refName(localId), folder: refFolder(localId), mtimeMs: 0, size: 0 }, xml: mineXml, sha: sha256(mineXml) };
    if (choice === 'mine') {
      // Theirs is already a version in the history; mine becomes the current one.
      await this.push(localId, e, mine, theirs.rev, true, { note: 'Kept the copy from ' + this.d.deviceName, coalesce: 0 });
    } else if (choice === 'theirs') {
      // Mine goes into the history first, so it can be restored, then theirs becomes current again.
      await this.push(localId, e, mine, theirs.rev, true, { note: `Replaced by the copy from ${theirs.device_name || 'another device'}`, coalesce: 0 });
      const back = await this.d.api.push({
        id: e.cloudId, baseRev: e.rev, name: theirs.name, folder: theirs.folder, xml: theirs.xml, deviceId: 'resolve', deviceName: theirs.device_name,
        note: 'Kept the copy from ' + (theirs.device_name || 'another device'), className: '', ascendClassName: '', level: 1, mainSkill: '', treeVersion: '', force: true, coalesceMinutes: 0,
      });
      if (back.status === 'ok') {
        e.rev = back.rev;
        e.sha = theirs.sha;
        await this.d.lib.write(localId, theirs.xml);
        this.hashCache.delete(localId);
        await this.d.base.put(e.cloudId, theirs.xml);
        this.d.onLocalChanged?.([localId]);
      }
    } else {
      // Keep both: theirs stays this build, mine becomes a new build next to it.
      const copy = await this.d.lib.create(refFolder(localId), `${refName(localId)} (${this.d.deviceName})`, mineXml);
      await this.d.lib.write(localId, theirs.xml);
      this.hashCache.delete(localId);
      e.rev = theirs.rev;
      e.sha = theirs.sha;
      await this.d.base.put(e.cloudId, theirs.xml);
      st.entries[copy.id] = { cloudId: randomUUID(), rev: 0, sha: '', name: copy.name, folder: copy.folder };
      this.d.onLocalChanged?.([localId, copy.id]);
    }
    this.conflicts.delete(localId);
    this.dispatch({ t: 'scanned', pending: this.machine.pending, conflicts: this.conflicts.size });
    await this.d.state.save(st);
    this.request(0);
    this.emit();
  }

  // ---- deleted builds -------------------------------------------------------------------------

  /** Cloud builds deleted in the last 90 days (the cloud keeps them that long), newest first. */
  async deletedBuilds(): Promise<DeletedCloudBuild[]> {
    const { builds } = await this.d.api.list();
    return builds
      .filter((b) => b.deleted_at)
      .sort((a, b) => ts(b.deleted_at) - ts(a.deleted_at))
      .map((b) => ({ cloudId: b.id, name: b.name, folder: b.folder, className: b.class_name, ascendClassName: b.ascend_class_name, level: b.level, deletedAt: ts(b.deleted_at), deviceName: b.device_name }));
  }

  /** Brings a deleted cloud build back with its last text; every device then downloads it as a new build. */
  async restoreDeleted(cloudId: string): Promise<boolean> {
    if (!this.st) return false;
    const full = await this.d.api.get(cloudId);
    if (!full || !full.deleted_at) return false;
    const info = readBuildInfo(full.xml);
    const r = await this.d.api.push({
      id: cloudId,
      baseRev: full.rev,
      name: full.name,
      folder: full.folder,
      xml: full.xml,
      deviceId: this.st.deviceId,
      deviceName: this.d.deviceName,
      note: '',
      className: info.className,
      ascendClassName: info.ascendClassName,
      level: info.level,
      mainSkill: info.mainSkill,
      treeVersion: '',
      coalesceMinutes: 0,
    });
    if (r.status !== 'ok') return false;
    await this.syncNow();
    return true;
  }

  // ---- history --------------------------------------------------------------------------------

  async versions(localId: string): Promise<VersionInfo[] | null> {
    const e = this.st?.entries[localId];
    if (!e || e.rev === 0) return null;
    const rows = await this.d.api.versions(e.cloudId);
    return rows.map((v, i) => ({
      rev: v.rev,
      name: v.name,
      deviceName: v.device_id === this.d.deviceId ? 'This PC' : v.device_name || 'Another device',
      here: v.device_id === this.d.deviceId,
      note: v.note,
      at: ts(v.updated_at),
      size: v.size,
      current: i === 0,
    }));
  }

  async versionText(localId: string, rev: number): Promise<string | null> {
    const e = this.st?.entries[localId];
    if (!e) return null;
    return (await this.d.api.get(e.cloudId, rev))?.xml ?? null;
  }

  /** Puts an earlier version back as the current text; it uploads as a new version. */
  async restore(localId: string, rev: number, label: string): Promise<boolean> {
    const e = this.st?.entries[localId];
    if (!e) return false;
    const xml = await this.versionText(localId, rev);
    if (xml === null) return false;
    await this.d.lib.write(localId, xml);
    this.hashCache.delete(localId);
    this.nextNote.set(localId, `Restored ${label}`);
    this.noCoalesce.add(localId);
    this.d.onLocalChanged?.([localId]);
    this.request(0);
    return true;
  }

  async restoreAsCopy(localId: string, rev: number, label: string): Promise<LocalBuildRef | null> {
    const xml = await this.versionText(localId, rev);
    if (xml === null) return null;
    const copy = await this.d.lib.create(refFolder(localId), `${refName(localId)} (${label})`, xml);
    await this.enroll(copy.id);
    this.d.onLocalChanged?.([copy.id]);
    return copy;
  }
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
