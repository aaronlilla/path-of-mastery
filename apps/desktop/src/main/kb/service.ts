import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppKb } from './appKb.js';
import { buildKb, type BuildOptions, type BuildReport } from './build.js';
import { downloadCentralSnapshot, fetchCentralManifest, type CentralKbOptions } from './central.js';
import { PoliteHttp } from './http.js';
import type { KbStore } from './knowledgeBase.js';
import type { KbStatus } from './query.js';
import type { KbUiStatus as SharedKbUiStatus } from '../../shared/kbStatus.js';
import { readLatestPatch } from './sources/cdn.js';
import { parseThreadList, PATCH_LIST_URL } from './sources/forum.js';
import type { AppDataPaths } from './sources/types.js';

/**
 * Keeps the app's KB current. On start and every 45 minutes it checks the live patch (latest.txt) and the newest
 * patch-notes thread, then the signed central snapshot (central.ts): a newer one is downloaded, verified and swapped in.
 * The app builds locally only when the central snapshot cannot be had (offline, missing, bad signature) or is behind the
 * live patch: a new patch re-pulls every source; a new thread re-pulls the forum only. The rebuild runs in the
 * background on a copy, then the copy is swapped in and the store reopened (Journey's onChange fires per table).
 */

export const CHECK_EVERY_MS = 45 * 60_000;

export interface KbUiStatus extends KbStatus, SharedKbUiStatus {}

export interface KbServiceOptions {
  appKb: AppKb;
  app: AppDataPaths;
  /** Download and HTTP cache folder (user data). */
  cacheDir: string;
  intervalMs?: number;
  http?: PoliteHttp;
  log?: (m: string) => void;
  /** Replaces buildKb (tests). */
  build?: (o: BuildOptions) => Promise<BuildReport>;
  /** Where the signed snapshot comes from; false turns the central snapshot off (local builds only). */
  central?: CentralKbOptions | false;
  /** Replaces the live checks (tests). */
  live?: () => Promise<{ livePatch: string | null; newestThread: { id: number; title: string } | null }>;
}

async function retry<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
}

export class KbService {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private listeners = new Set<(s: KbUiStatus) => void>();
  refreshing = false;
  lastError: string | null = null;
  readonly http: PoliteHttp;

  constructor(private readonly o: KbServiceOptions) {
    this.http = o.http ?? new PoliteHttp({ cacheDir: o.cacheDir, log: o.log });
  }

  private get livePath(): string {
    return join(this.o.cacheDir, 'live.json');
  }

  /** Opens the KB, restores the last live check, checks now (in the background) and every interval after. */
  async start(): Promise<void> {
    const store = await this.o.appKb.ready();
    try {
      const saved = JSON.parse(await readFile(this.livePath, 'utf8')) as KbStore['live'];
      if (saved && typeof saved.checkedAt === 'number') store.setLive(saved);
    } catch {
      /* first run */
    }
    store.onStatus(() => this.emit());
    void this.check();
    this.timer = setInterval(() => void this.check(), this.o.intervalMs ?? CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onStatus(cb: (s: KbUiStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async status(): Promise<KbUiStatus> {
    const store = await this.o.appKb.ready();
    return { ...store.status(), refreshing: this.refreshing, lastError: this.lastError };
  }

  private emit(): void {
    if (!this.listeners.size || !this.o.appKb.store) return;
    const s: KbUiStatus = { ...this.o.appKb.store.status(), refreshing: this.refreshing, lastError: this.lastError };
    for (const cb of this.listeners) {
      try {
        cb(s);
      } catch {
        /* listener's problem */
      }
    }
  }

  private async liveCheck(): Promise<{ livePatch: string | null; newestThread: { id: number; title: string } | null }> {
    if (this.o.live) return this.o.live();
    let livePatch: string | null = null;
    let newestThread: { id: number; title: string } | null = null;
    try {
      livePatch = await readLatestPatch({ http: this.http });
    } catch (e) {
      this.o.log?.(`kb: latest.txt check failed: ${(e as Error).message}`);
    }
    try {
      const rows = parseThreadList((await this.http.text(PATCH_LIST_URL)).body);
      if (rows[0]) newestThread = { id: rows[0].id, title: rows[0].title };
    } catch (e) {
      this.o.log?.(`kb: patch-notes check failed: ${(e as Error).message}`);
    }
    return { livePatch, newestThread };
  }

  /** One live check; starts a background refresh when the KB is behind. Resolves when the check (and refresh) end. */
  check(): Promise<void> {
    this.running ??= (async () => {
      try {
        const store = await this.o.appKb.ready();
        const live = await this.liveCheck();
        const prev = store.live;
        store.setLive({
          livePatch: live.livePatch ?? prev.livePatch,
          checkedAt: live.livePatch || live.newestThread ? Date.now() : prev.checkedAt,
          newestThread: live.newestThread ?? prev.newestThread ?? null,
        });
        await writeFile(this.livePath, JSON.stringify(store.live)).catch(() => undefined);
        const central = await this.central();
        const dataPatch = store.query.meta('data_patch');
        // the central snapshot is enough unless it is behind the live game (the job missed a patch): then build locally
        // on top of it, as before, and it stays in place until the local build lands
        if (central && !(live.livePatch && dataPatch && live.livePatch !== dataPatch)) return;
        const knownThread = Number(store.query.meta('forum_newest_thread') || 0);
        if (live.livePatch && dataPatch && live.livePatch !== dataPatch) await this.refresh(undefined, live.livePatch);
        else if (live.newestThread && live.newestThread.id > knownThread) await this.refresh(['forum'], live.livePatch ?? undefined);
      } catch (e) {
        this.lastError = (e as Error).message;
        this.o.log?.(`kb: check failed: ${this.lastError}`);
        this.emit();
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /**
   * The central snapshot: installs it when it is newer than the open KB. True when the central KB was reached and
   * verified (installed or already current). False (offline, missing, bad signature or hash) sends the caller to the
   * local build.
   */
  private async central(): Promise<boolean> {
    if (this.o.central === false) return false;
    const opts = this.o.central ?? {};
    let staging: string | null = null;
    try {
      const m = await fetchCentralManifest(opts);
      const store = await this.o.appKb.ready();
      if (m.builtAt <= (store.query.meta('built_at') ?? '')) return true;
      this.refreshing = true;
      this.emit();
      staging = `${this.o.appKb.path}.central`;
      await downloadCentralSnapshot(m, staging, opts);
      store.close();
      try {
        await retry(() => rename(staging!, this.o.appKb.path));
      } finally {
        store.reload();
      }
      this.lastError = null;
      this.o.log?.(`kb: installed the central snapshot for ${m.dataPatch} built ${m.builtAt}`);
      return true;
    } catch (e) {
      this.o.log?.(`kb: central snapshot unavailable, using the local build: ${(e as Error).message}`);
      if (staging) await rm(staging, { force: true }).catch(() => undefined);
      return false;
    } finally {
      if (this.refreshing && staging) {
        this.refreshing = false;
        this.emit();
      }
    }
  }

  /** Rebuild `only` these sources (all when omitted) on a copy, then swap it in. */
  async refresh(only?: string[], livePatch?: string): Promise<BuildReport | null> {
    if (this.refreshing) return null;
    this.refreshing = true;
    this.emit();
    const store = await this.o.appKb.ready();
    const path = this.o.appKb.path;
    const staging = `${path}.build`;
    try {
      await rm(staging, { force: true });
      await copyFile(path, staging);
      const report = await (this.o.build ?? buildKb)({
        out: staging,
        cacheDir: this.o.cacheDir,
        app: this.o.app,
        http: this.http,
        ...(only ? { only } : {}),
        ...(livePatch ? { livePatch } : {}),
        log: (m) => this.o.log?.(`kb: ${m}`),
      });
      store.close();
      try {
        await retry(() => rename(staging, path));
      } finally {
        store.reload();
      }
      this.lastError = null;
      this.o.log?.(`kb: refreshed ${only?.join(',') ?? 'all sources'} to data patch ${report.dataPatch} in ${(report.ms / 1000).toFixed(1)} s`);
      return report;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.o.log?.(`kb: refresh failed: ${this.lastError}`);
      await rm(staging, { force: true }).catch(() => undefined);
      return null;
    } finally {
      this.refreshing = false;
      this.emit();
    }
  }
}
