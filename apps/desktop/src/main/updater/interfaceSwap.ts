import { join } from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import type { KeyObject } from 'node:crypto';
import type { UpdateLayer } from '@pom/protocol';
import type { Downloader } from './downloader.js';
import { verifyDownloadedLayer } from './signature.js';

/**
 * The window-facing operations the interface-bundle swap needs. In
 * production this is backed by `webContents` (loadFile + executeJavaScript
 * round trips to ask the page to serialize/restore its own state); tests use
 * an in-memory fake that behaves like a tiny single-page app.
 */
export interface RendererController {
  captureState(): Promise<unknown>;
  loadBundle(indexHtmlPath: string): Promise<void>;
  verifyReady(): Promise<boolean>;
  restoreState(state: unknown): Promise<void>;
}

export interface InterfaceSwapDeps {
  downloader: Downloader;
  publicKey: KeyObject;
  stagingDir: string;
  /** Builds the bundle folder from the verified archive and returns its index.html (interfaceBundle.buildBundleDir in production). */
  extractBundle(archivePath: string, destDir: string): Promise<string>;
  /** Called when a bundle is staged (true) or dropped (false): main keeps the marker that the next start loads. */
  onStaged?(staged: StagedInterface | null): Promise<void> | void;
}

/** A verified interface bundle waiting to be swapped in (or loaded at the next start). */
export interface StagedInterface {
  version: string;
  archivePath: string;
  indexPath: string;
  layer: UpdateLayer;
}

export type InterfaceSwapOutcome =
  | { type: 'switched'; version: string }
  | { type: 'staged'; version: string }
  | { type: 'updateFailed'; layer: 'interface'; message: string; stillOnVersion: string };

export const INTERFACE_MARKER = 'interface-staged.json';

/**
 * Interface layer: `prepare` downloads, verifies (signature and sha256) and builds the complete bundle beside the running
 * one without touching the window; `swapNow` loads it into the window (after the page saved its work: the caller's job),
 * waits until the new page has really started, and hands it the page state. Any failure loads the bundle the player was
 * on again, restores the state, and drops the staged bundle. `applyUpdate` does both at once.
 */
export class InterfaceSwapController {
  private staged: StagedInterface | null = null;

  constructor(
    private readonly deps: InterfaceSwapDeps,
    private readonly renderer: RendererController,
    private currentVersion: string,
    private currentBundlePath: string,
  ) {}

  getCurrentVersion(): string {
    return this.currentVersion;
  }

  getCurrentBundlePath(): string {
    return this.currentBundlePath;
  }

  /** The version verified and built, waiting for swapNow (or the next start). */
  getStagedVersion(): string | null {
    return this.staged?.version ?? null;
  }

  async prepare(layer: UpdateLayer): Promise<InterfaceSwapOutcome> {
    if (this.staged?.version === layer.version) return { type: 'staged', version: layer.version };
    const archivePath = join(this.deps.stagingDir, `interface-${layer.version}.archive`);
    try {
      await this.deps.downloader.download(layer.url, archivePath);
    } catch (err) {
      return this.fail(`download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const verification = await verifyDownloadedLayer('interface', layer, archivePath, this.deps.publicKey);
    if (!verification.ok) {
      return this.fail(verification.reason ?? 'verification failed');
    }
    let indexPath: string;
    try {
      indexPath = await this.deps.extractBundle(archivePath, join(this.deps.stagingDir, `interface-${layer.version}`));
    } catch (err) {
      return this.fail(`failed to extract interface bundle: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.staged = { version: layer.version, archivePath, indexPath, layer };
    await this.deps.onStaged?.(this.staged);
    return { type: 'staged', version: layer.version };
  }

  /** A staged bundle found at start-up but held by the update policy: known again, so it can be offered once allowed. */
  adoptStaged(staged: StagedInterface): void {
    this.staged = staged;
  }

  /** Takes back the staged bundle (the policy blocked or superseded it): marker, archive and built folder go. */
  async dropStaged(o: { deleteFile: boolean }): Promise<void> {
    const staged = this.staged;
    if (!o.deleteFile || !staged) return;
    this.staged = null;
    await this.deps.onStaged?.(null);
    await rm(staged.archivePath, { force: true }).catch(() => {});
    await rm(join(staged.indexPath, '..'), { recursive: true, force: true }).catch(() => {});
  }

  async swapNow(): Promise<InterfaceSwapOutcome> {
    const staged = this.staged;
    if (!staged) return this.fail('no interface update is ready');
    const state = await this.renderer.captureState().catch(() => null);
    const previousBundlePath = this.currentBundlePath;
    try {
      await this.renderer.loadBundle(staged.indexPath);
      const ready = await this.renderer.verifyReady();
      if (!ready) {
        throw new Error('new interface bundle did not report ready after load');
      }
      await this.renderer.restoreState(state);
    } catch (err) {
      // Roll back to the bundle the user was already on, restoring the state
      // we captured before we ever touched the web contents. The bad bundle is not kept for the next start.
      this.staged = null;
      await this.deps.onStaged?.(null);
      await this.renderer.loadBundle(previousBundlePath).catch(() => {});
      await this.renderer.restoreState(state).catch(() => {});
      return this.fail(err instanceof Error ? err.message : String(err));
    }
    this.currentVersion = staged.version;
    this.currentBundlePath = staged.indexPath;
    this.staged = null;
    return { type: 'switched', version: staged.version };
  }

  async applyUpdate(layer: UpdateLayer): Promise<InterfaceSwapOutcome> {
    const prepared = await this.prepare(layer);
    if (prepared.type !== 'staged') return prepared;
    return this.swapNow();
  }

  private fail(message: string): InterfaceSwapOutcome {
    return { type: 'updateFailed', layer: 'interface', message, stillOnVersion: this.currentVersion };
  }
}

/** The staged-interface marker the next start reads (main/index.ts). */
export async function writeInterfaceMarker(stagingDir: string, staged: StagedInterface | null, forApp: string): Promise<void> {
  const p = join(stagingDir, INTERFACE_MARKER);
  if (!staged) return void (await rm(p, { force: true }));
  await writeFile(p, JSON.stringify({ ...staged, forApp }), 'utf8');
}

export async function readInterfaceMarker(stagingDir: string): Promise<(StagedInterface & { forApp: string }) | null> {
  try {
    const m = JSON.parse(await readFile(join(stagingDir, INTERFACE_MARKER), 'utf8')) as StagedInterface & { forApp: string };
    if (typeof m.version !== 'string' || typeof m.archivePath !== 'string' || typeof m.forApp !== 'string' || !m.layer) return null;
    return m;
  } catch {
    return null;
  }
}
