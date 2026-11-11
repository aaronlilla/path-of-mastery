import type { EngineEvent, OpenBuildState, UpdateChannel, UpdateLayerName } from '@pom/protocol';
import type { UpdateOffer } from '../../shared/library.js';
import { ManifestFetcher, manifestUrlFor, type FetchLike, type ParsedManifest } from './manifestClient.js';
import type { EngineHotSwapController, EngineHotSwapOutcome } from './engineHotSwap.js';
import type { InterfaceSwapController, InterfaceSwapOutcome } from './interfaceSwap.js';
import type { AppShellCheckOutcome, AppShellUpdater } from './appShellUpdater.js';
import type { DownloadOptions } from './downloader.js';
import { verifyLayerSignature } from './signature.js';
import { decideRelease, type InstalledVersions, type ReleaseDecision } from './releasePolicy.js';
import type { UpdatePolicySource } from './updatePolicySource.js';
import type { KeyObject } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pendingAction, updateBucket, updateDecision, type UpdateDecision } from '@pom/protocol/updatePolicy';

export interface UpdateManagerDeps {
  manifestBaseUrl: string;
  channel: UpdateChannel;
  fetchImpl?: FetchLike;
  /** The key every layer of the manifest must be signed with before an update is offered. */
  publicKey?: KeyObject;
  /** This installation's rollout seed (releasePolicy.loadInstallId). Tests and old callers without one use ''. */
  installId?: string;
  /** The server's unsigned update policy (remote config). Absent or never fetched: the signed manifest alone decides. */
  policy?: UpdatePolicySource;
  /** Where the last verified manifest is kept for the next start's gate (startupGate.ts). */
  manifestCacheFile?: string;
  engineSwap: EngineHotSwapController;
  interfaceSwap: InterfaceSwapController;
  appShellUpdater: AppShellUpdater;
  getOpenBuildState(): OpenBuildState;
  emit(event: EngineEvent): void;
}

export interface UpdateCheckSummary {
  engine?: EngineHotSwapOutcome;
  interface?: InterfaceSwapOutcome;
  app?: AppShellCheckOutcome;
}

/** A manifest read and judged for this installation: what it offers, and why not when it offers nothing. */
export interface UpdatePlan {
  manifest: ParsedManifest;
  decision: ReleaseDecision;
  /** Where the manifest came from: a fresh download, the cache within max-age, or a 304 revalidation. */
  from: 'network' | 'cache' | 'revalidated';
}

/**
 * Orchestrates update passes: fetch the manifest for the current channel (cached as the server says), refuse it unless
 * its policy and every layer that would be taken are signed with the trusted key, decide what this installation takes
 * (pause, rollout, minimum version, downgrade: releasePolicy.ts), and run each layer's own controller. Each controller
 * owns its own signature/hash verification and failure handling.
 */
export class UpdateManager {
  private readonly fetcher: ManifestFetcher;

  constructor(private readonly deps: UpdateManagerDeps) {
    this.fetcher = new ManifestFetcher(deps.fetchImpl ?? (fetch as unknown as FetchLike));
  }

  private last: ParsedManifest | null = null;

  /** The last manifest a plan read (verified). */
  lastManifest(): ParsedManifest | null {
    return this.last;
  }

  get channel(): UpdateChannel {
    return this.deps.channel;
  }

  setChannel(channel: UpdateChannel): void {
    this.deps.channel = channel;
  }

  /**
   * What RUNS now. Decisions are always made against these, never against a staged version, so a pause or block of a
   * staged layer is seen (and the staged copy taken back) instead of the layer looking up to date.
   */
  installed(): InstalledVersions {
    return {
      app: this.deps.appShellUpdater.getCurrentVersion(),
      engine: this.deps.engineSwap.getCurrentVersion(),
      interface: this.deps.interfaceSwap.getCurrentVersion(),
    };
  }

  /**
   * What is downloaded or staged ON DISK, per layer, held or not: what the policy must reconcile (a held installer that is
   * later blocked must still be deleted).
   */
  async stagedOnDisk(): Promise<Record<UpdateLayerName, string | null>> {
    const pending = await this.deps.appShellUpdater.peekPending?.().catch(() => null);
    return { ...this.staged(), app: pending?.version ?? null };
  }

  /**
   * The live server policy blocks exactly this version of `layer`: a downloaded or staged copy
   * of it is deleted, whatever the manifest offers now (a newer paused replacement does not make it holdable).
   */
  blocksVersion(layer: UpdateLayerName, version: string): boolean {
    const doc = this.deps.policy?.current() ?? null;
    const blocked = (doc?.[this.deps.channel]?.[layer] as { blockedVersions?: unknown } | undefined)?.blockedVersions;
    return Array.isArray(blocked) && blocked.includes(version);
  }

  /**
   * What to do with a downloaded or staged copy when no manifest could be read: the policy just refreshed decides, with
   * the last verified manifest for that version when there is one. Blocked: delete. Paused or no longer offered: hold.
   */
  judgeWithoutManifest(layer: UpdateLayerName, version: string): 'keep' | 'hold' | 'delete' {
    if (this.blocksVersion(layer, version)) return 'delete';
    const d = this.gateCached(layer, version);
    if (d) return d.action === 'offer' ? 'keep' : pendingAction(d) === 'delete' ? 'delete' : 'hold';
    const p = (this.deps.policy?.current()?.[this.deps.channel]?.[layer] ?? null) as { paused?: unknown } | null;
    return p?.paused === true ? 'hold' : 'keep';
  }

  /** What is downloaded or staged and may be applied by this run, per layer (null: nothing; a held app installer is null). */
  staged(): Record<UpdateLayerName, string | null> {
    return {
      app: this.deps.appShellUpdater.knownPendingVersion?.() ?? null,
      engine: this.deps.engineSwap.getStagedVersion?.() ?? null,
      interface: this.deps.interfaceSwap.getStagedVersion?.() ?? null,
    };
  }

  /** Takes back a layer's waiting copy: deleted (blocked, superseded) or only held (paused, outside the rollout). */
  async dropStaged(layer: UpdateLayerName, deleteFile: boolean): Promise<void> {
    if (layer === 'app') {
      if (deleteFile) await this.deps.appShellUpdater.discardPending({ deleteFile: true });
      else await this.deps.appShellUpdater.forgetForNow();
    } else if (deleteFile) {
      const c = (layer === 'engine' ? this.deps.engineSwap : this.deps.interfaceSwap) as unknown as { dropStaged?(o: { deleteFile: boolean }): Promise<void> };
      await c.dropStaged?.({ deleteFile: true });
    }
  }

  /**
   * The decision for one layer version from the last verified manifest and the last known policy, without the network
   * (quitting cannot wait for it). Null when the last manifest does not offer that version.
   */
  gateCached(layer: UpdateLayerName, version: string): UpdateDecision | null {
    const m = this.last;
    if (!m || m.layers[layer].version !== version) return null;
    const doc = this.deps.policy?.current() ?? null;
    const p = doc ? (doc[this.deps.channel]?.[layer] ?? {}) : null;
    const running = this.installed();
    const key = this.deps.publicKey;
    const verified = !key || verifyLayerSignature(layer, m.layers[layer], key);
    return updateDecision({ ...m.layers[layer], verified }, p, running[layer], updateBucket(this.deps.installId ?? '', version), layer === 'interface' ? running.app : undefined);
  }

  /** Reads and judges the manifest. Throws on a network failure, a malformed manifest or one not signed with the trusted key. */
  async plan(opts: { force?: boolean } = {}): Promise<UpdatePlan> {
    const url = manifestUrlFor(this.deps.manifestBaseUrl, this.deps.channel);
    // Both requests run together, but the policy answer is always awaited, also when the manifest request fails: the
    // caller then judges what waits with the fresh policy (judgeWithoutManifest), never with an older one.
    const policyDone = this.deps.policy?.refresh().catch(() => null);
    let fetched: Awaited<ReturnType<ManifestFetcher["fetch"]>>;
    try {
      fetched = await this.fetcher.fetch(url, opts);
    } finally {
      await policyDone;
    }
    const { manifest, from } = fetched;
    const key = this.deps.publicKey;
    // A layer that would be taken but is not signed with the trusted key refuses the whole manifest.
    const decision = decideRelease(manifest, this.installed(), this.deps.installId ?? '', this.deps.policy?.current() ?? null, (layer) => !key || verifyLayerSignature(layer, manifest.layers[layer], key), this.deps.channel);
    this.last = manifest;
    // Kept for the next start's gate on staged layers (startupGate.ts), which has no network to ask.
    if (this.deps.manifestCacheFile) {
      const f = this.deps.manifestCacheFile;
      await mkdir(dirname(f), { recursive: true }).then(() => writeFile(f, JSON.stringify(manifest), 'utf8')).catch(() => {});
    }
    return { manifest, decision, from };
  }

  private takenLayers(d: ReleaseDecision): UpdateLayerName[] {
    return (['app', 'engine', 'interface'] as const).filter((n) => d.layers[n].action === 'offer');
  }

  /** Reads the manifest and says which layers this installation would take. Changes nothing; "Update" runs checkForUpdates. */
  async checkAvailable(): Promise<UpdateOffer> {
    const { manifest, decision } = await this.plan({ force: true });
    const current = this.installed();
    const layers: UpdateOffer['layers'] = this.takenLayers(decision).map((layer) => ({
      layer,
      current: current[layer],
      next: manifest.layers[layer].version,
      notes: manifest.layers[layer].notes ?? [],
    }));
    return { channel: this.deps.channel, layers };
  }

  /**
   * One update pass: everything the plan takes is downloaded and verified; the engine stages, the interface bundle is built
   * beside the running one (swapped in only by Apply now, after the page saved its work), the app installer waits.
   */
  async checkForUpdates(opts: { plan?: UpdatePlan; app?: DownloadOptions } = {}): Promise<UpdateCheckSummary> {
    const { manifest, decision } = opts.plan ?? (await this.plan({ force: true }));
    const summary: UpdateCheckSummary = {};

    if (decision.layers.engine.action === 'offer' && this.deps.engineSwap.getStagedVersion?.() === manifest.layers.engine.version) {
      summary.engine = { type: 'staged', version: manifest.layers.engine.version };
    } else if (decision.layers.engine.action === 'offer') {
      const outcome = await this.deps.engineSwap.applyUpdate(manifest.layers.engine, this.deps.getOpenBuildState());
      summary.engine = outcome;
      this.reportIfFailed(outcome);
    }

    if (decision.layers.interface.action === 'offer') {
      const outcome = await this.deps.interfaceSwap.prepare(manifest.layers.interface);
      summary.interface = outcome;
      this.reportIfFailed(outcome);
    }

    if (decision.layers.app.action === 'offer') {
      const appOutcome = await this.deps.appShellUpdater.checkAndDownload(manifest.layers.app, opts.app);
      summary.app = appOutcome;
      this.reportIfFailed(appOutcome);
    } else {
      summary.app = { type: 'upToDate' };
    }

    return summary;
  }

  private reportIfFailed(outcome: { type: string } & Record<string, unknown>): void {
    if (outcome.type !== 'updateFailed') return;
    this.deps.emit({
      type: 'updateFailed',
      layer: outcome.layer as 'engine' | 'interface' | 'app',
      message: outcome.message as string,
      stillOnVersion: outcome.stillOnVersion as string,
    });
  }
}
