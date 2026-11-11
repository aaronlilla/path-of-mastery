import { join } from 'node:path';
import { rm, stat } from 'node:fs/promises';
import type { KeyObject } from 'node:crypto';
import type { UpdateLayer } from '@pom/protocol';
import type { Downloader, DownloadOptions } from './downloader.js';
import { verifyDownloadedLayer } from './signature.js';

export interface PendingAppUpdate {
  version: string;
  installerPath: string;
  /** The signed manifest entry the installer was verified against; a reused download is verified again with it. */
  layer?: UpdateLayer;
}

/** Persists across app restarts - a real deployment backs this with a small JSON file in userData. */
export interface AppUpdateStore {
  getPending(): Promise<PendingAppUpdate | null>;
  setPending(update: PendingAppUpdate | null): Promise<void>;
}

export interface InstallerLaunch {
  /** The version being installed (written to the install result, so the next start can say whether it worked). */
  version: string;
  /** Start the app again once the installer has finished (Restart now); false = install on quit, nothing relaunches. */
  relaunch: boolean;
}

export interface AppShellUpdaterDeps {
  downloader: Downloader;
  publicKey: KeyObject;
  stagingDir: string;
  store: AppUpdateStore;
  /** Platform-specific: launch the downloaded installer (NSIS/dmg/AppImage) as a detached process. Must start it synchronously (it is called from will-quit). */
  spawnInstaller(installerPath: string, launch?: InstallerLaunch): Promise<void> | void;
}

export type AppShellCheckOutcome =
  | { type: 'upToDate' }
  | { type: 'downloaded'; version: string; reused?: boolean }
  | { type: 'updateFailed'; layer: 'app'; message: string; stillOnVersion: string };

/**
 * electron-updater-style layer 3: download and verify happen in the background whenever a check finds a release; the
 * running app changes only when the player restarts (Restart now, or the update installs as the app quits), when
 * `launchOnQuit` hands off to the platform installer and this process exits. A pending installer left by a run that
 * never quit cleanly is offered again at the next start (the pill shows at once). `installPendingIfAny` is the older
 * install-at-next-launch path, kept for callers that want it. This is the only one of the three layers that needs the
 * app to restart.
 */
export class AppShellUpdater {
  constructor(
    private readonly deps: AppShellUpdaterDeps,
    private readonly currentVersion: string,
  ) {}

  /** The last pending installer this process knows of (read or written), so quitting can start it without awaiting. */
  private known: PendingAppUpdate | null = null;

  getCurrentVersion(): string {
    return this.currentVersion;
  }

  /** The verified installer waiting to be installed, if any. */
  async getPending(): Promise<PendingAppUpdate | null> {
    this.known = await this.deps.store.getPending();
    return this.known;
  }

  /**
   * Starts the installer for the pending update as this process quits (Restart now, or install on quit). Synchronous on
   * purpose: it runs in will-quit, after every store has drained, and the helper it starts waits for this process to exit.
   * The pending marker stays: the next start drops it when the new version is running, and offers it again when the
   * install did not take, so a failing installer is never retried by itself.
   */
  launchOnQuit(relaunch: boolean): boolean {
    const p = this.known;
    if (!p || p.version === this.currentVersion) return false;
    void this.deps.spawnInstaller(p.installerPath, { version: p.version, relaunch });
    return true;
  }

  /**
   * Forgets the waiting installer: it is the running version now, or its release was blocked or pulled (then the file
   * is deleted too). `version` limits it to a pending installer of that version.
   */
  async discardPending(opts: { deleteFile?: boolean; version?: string } = {}): Promise<void> {
    const p = await this.deps.store.getPending();
    if (!p || (opts.version && p.version !== opts.version)) return;
    this.known = null;
    await this.deps.store.setPending(null);
    if (opts.deleteFile) await rm(p.installerPath, { force: true }).catch(() => {});
  }

  /** The waiting installer on disk (the store), without making it installable by this run. */
  peekPending(): Promise<PendingAppUpdate | null> {
    return this.deps.store.getPending();
  }

  /** The waiting installer's version as this run knows it (null after forgetForNow: held, not installable). */
  knownPendingVersion(): string | null {
    return this.known?.version ?? null;
  }

  /** Paused: the verified installer stays on disk and in the marker, but this run will not install it on quit. */
  async forgetForNow(): Promise<void> {
    this.known = null;
  }

  async checkAndDownload(layer: UpdateLayer, opts: DownloadOptions = {}): Promise<AppShellCheckOutcome> {
    if (layer.version === this.currentVersion) {
      return { type: 'upToDate' };
    }

    const destPath = join(this.deps.stagingDir, `app-${layer.version}${installerExtension(layer.url)}`);
    // A check every 30 minutes must not fetch the same installer again: a finished download for exactly this signed
    // entry is reused once it verifies again (signature and sha256), so a file changed on disk is downloaded afresh.
    const pending = await this.deps.store.getPending();
    if (pending && pending.version === layer.version && pending.installerPath === destPath && sameLayer(pending.layer, layer)) {
      const ok = await stat(destPath).then((s) => s.isFile(), () => false);
      if (ok && (await verifyDownloadedLayer('app', layer, destPath, this.deps.publicKey)).ok) {
        this.known = pending;
        return { type: 'downloaded', version: layer.version, reused: true };
      }
    }

    try {
      await this.deps.downloader.download(layer.url, destPath, opts);
    } catch (e) {
      return { type: 'updateFailed', layer: 'app', message: e instanceof Error ? e.message : String(e), stillOnVersion: this.currentVersion };
    }

    const verification = await verifyDownloadedLayer('app', layer, destPath, this.deps.publicKey);
    if (!verification.ok) {
      return { type: 'updateFailed', layer: 'app', message: verification.reason ?? 'verification failed', stillOnVersion: this.currentVersion };
    }

    this.known = { version: layer.version, installerPath: destPath, layer };
    await this.deps.store.setPending(this.known);
    return { type: 'downloaded', version: layer.version };
  }

  /** Install-at-launch: hands a pending installer from the last run to the installer (with a relaunch) before any window opens. */
  async installPendingIfAny(): Promise<'installed' | 'none'> {
    const pending = await this.deps.store.getPending();
    if (!pending) return 'none';
    await this.deps.store.setPending(null);
    // Already on that version (the installer ran and relaunched us): nothing to do.
    if (pending.version === this.currentVersion) return 'none';
    await this.deps.spawnInstaller(pending.installerPath, { version: pending.version, relaunch: true });
    return 'installed';
  }
}

function sameLayer(a: UpdateLayer | undefined, b: UpdateLayer): boolean {
  return !!a && a.version === b.version && a.sha256 === b.sha256 && a.size === b.size && a.url === b.url && a.signature === b.signature;
}

function installerExtension(url: string): string {
  const match = /\.[a-zA-Z0-9]+$/.exec(new URL(url).pathname);
  return match ? match[0] : '';
}
