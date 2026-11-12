import type { UpdateLayerName } from '@pom/protocol';
import { pendingAction, type UpdateDecision } from '@pom/protocol/updatePolicy';
import type { UpdateCheckResult, UpdateNotice, UpdateStatus } from '../../shared/update.js';
import type { AppShellUpdater } from './appShellUpdater.js';
import { ManifestNetworkError } from './manifestClient.js';
import type { UpdateManager, UpdateCheckSummary, UpdatePlan } from './updateManager.js';

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AutoUpdaterDeps {
  manager: UpdateManager;
  appShell: AppShellUpdater;
  emitStatus(status: UpdateStatus): void;
  emitNotice(notice: UpdateNotice): void;
  /** Electron's net.isOnline(): watched all the time; going from offline to online schedules a check. */
  isOnline?(): boolean;
  timers?: Timers;
  random?(): number;
  now?(): number;
  log?(message: string): void;
  /** Re-reads the server's update policy; `changed` triggers a check (manifest from cache). */
  refreshPolicy?(): Promise<{ changed: boolean }>;
  policyIntervalMs?: number;
  /** First automatic check after start (10 s), the period (30 min), after resume or network return (15 s / 5 s), network poll (30 s). */
  firstDelayMs?: number;
  intervalMs?: number;
  resumeDelayMs?: number;
  networkReturnDelayMs?: number;
  onlinePollMs?: number;
  /** How long quitting may wait for the last policy check (default 4 s). */
  quitCheckMs?: number;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

const LAYERS: UpdateLayerName[] = ['app', 'engine', 'interface'];
type Offer = Extract<UpdateDecision, { action: 'offer' }>;
const IDLE = { phase: 'idle' as const, kind: undefined, version: undefined, notes: [], required: false, critical: false, minimumVersion: undefined, progress: undefined, error: undefined };

/**
 * Automatic updates, the way desktop apps do them: a first check ~10 s after start, then every ~30 min, again shortly
 * after the PC wakes and whenever the network comes back; every delay is jittered (+-20%). Automatic checks are silent
 * when there is nothing new and when offline. A release found is downloaded and verified in the background.
 *
 * The update policy (signed fields and the server's pause / block / require / rollout) is applied to
 * every layer at every step: before a download, again (fresh policy, revalidated manifest) after it and before anything
 * is shown as ready, before Restart now / Apply now, when the app quits, and at the next launch (startupGate.ts). What a
 * decision no longer offers is taken back: a blocked download is deleted, a paused or held-back one is kept, unused.
 */
export class AutoUpdater {
  private status: UpdateStatus;
  private timer: unknown = null;
  private dueAt = 0;
  private onlineTimer: unknown = null;
  private policyTimer: unknown = null;
  private lastOnline: boolean | null = null;
  private inFlight: Promise<UpdateStatus> | null = null;
  private stopped = true;
  private failure: string | null = null;
  private readonly t: Timers;

  constructor(private readonly deps: AutoUpdaterDeps) {
    this.t = deps.timers ?? realTimers;
    this.status = { phase: 'idle', current: deps.appShell.getCurrentVersion(), notes: [], required: false, critical: false };
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  /** Why the last pass did not finish a layer it took (a download or verification failed), or null. */
  lastFailure(): string | null {
    return this.failure;
  }

  /** The waiting update was applied (or dropped) outside a check: back to idle. */
  clearReady(): void {
    this.set(IDLE);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private jitter(ms: number): number {
    const r = this.deps.random?.() ?? Math.random();
    return Math.round(ms * (0.8 + 0.4 * r));
  }

  private set(next: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...next };
    for (const k of Object.keys(next) as (keyof UpdateStatus)[]) if (next[k] === undefined) delete this.status[k];
    this.deps.emitStatus(this.status);
  }

  // ---- schedule -------------------------------------------------------------------------------------------------

  /**
   * Starts the schedule. A verified installer left by the last run is not offered until the first check has judged it
   * again against the current policy (it may have been paused or blocked since); that check reuses the file.
   */
  async start(): Promise<void> {
    this.stopped = false;
    const pending = await this.deps.appShell.getPending().catch(() => null);
    // The installer ran and this is the new version: the marker has done its job.
    if (pending && pending.version === this.status.current) await this.deps.appShell.discardPending().catch(() => {});
    // Not this run's to install until a check has judged it.
    this.deps.appShell.forgetForNow();
    this.schedule(this.jitter(this.deps.firstDelayMs ?? 10_000));
    this.schedulePolicy();
    this.watchNetwork();
  }

  stop(): void {
    this.stopped = true;
    for (const h of [this.timer, this.onlineTimer, this.policyTimer]) if (h) this.t.clearTimeout(h);
    this.timer = this.onlineTimer = this.policyTimer = null;
  }

  /** The server policy (pause, block, required) is re-read every ~5 min, so a pause reaches a running app without waiting 30 min. */
  private schedulePolicy(): void {
    if (this.stopped || !this.deps.refreshPolicy) return;
    this.policyTimer = this.t.setTimeout(() => {
      this.policyTimer = null;
      void this.deps.refreshPolicy!().then((r) => { if (r.changed) return this.check({ manual: false }); }).catch(() => {}).finally(() => this.schedulePolicy());
    }, this.jitter(this.deps.policyIntervalMs ?? 5 * 60_000));
  }

  /** Check soon, unless a check is already due sooner (so a burst of wake-ups or network flaps makes one check). */
  private soon(ms: number): void {
    if (this.stopped) return;
    const d = this.jitter(ms);
    if (!this.timer || this.now() + d < this.dueAt) this.schedule(d);
  }

  /** powerMonitor 'resume': the network needs a moment after waking. */
  onResume(): void {
    this.soon(this.deps.resumeDelayMs ?? 15_000);
  }

  /** The network came back (seen by the watcher, or told by the window). */
  onNetworkReturn(): void {
    this.soon(this.deps.networkReturnDelayMs ?? 5_000);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) this.t.clearTimeout(this.timer);
    this.dueAt = this.now() + ms;
    this.timer = this.t.setTimeout(() => {
      this.timer = null;
      void this.check({ manual: false });
    }, ms);
  }

  /** Watches the network all the time (cheap: net.isOnline every 30 s); offline then online schedules a check. */
  private watchNetwork(): void {
    if (this.stopped || !this.deps.isOnline || this.onlineTimer) return;
    const poll = () => {
      this.onlineTimer = null;
      if (this.stopped) return;
      const online = this.deps.isOnline!();
      if (this.lastOnline === false && online) this.onNetworkReturn();
      this.lastOnline = online;
      this.onlineTimer = this.t.setTimeout(poll, this.deps.onlinePollMs ?? 30_000);
    };
    this.lastOnline = this.deps.isOnline();
    this.onlineTimer = this.t.setTimeout(poll, this.deps.onlinePollMs ?? 30_000);
  }

  // ---- checks ---------------------------------------------------------------------------------------------------

  /** One check. Single-flight: a check while one runs (or while a download is under way) joins it. */
  check(opts: { manual: boolean }): Promise<UpdateStatus> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run(opts).finally(() => {
      this.inFlight = null;
      // A required update whose download failed is tried again in about two minutes, not half an hour.
      this.schedule(this.jitter(this.status.required && this.status.error ? 120_000 : this.deps.intervalMs ?? 30 * 60_000));
    });
    return this.inFlight;
  }

  private checked(result: UpdateCheckResult, extra: { from?: 'network' | 'cache' | 'revalidated'; message?: string } = {}): void {
    this.set({ lastCheck: { at: this.now(), result, ...extra } });
  }

  private resultOf(plan: UpdatePlan): UpdateCheckResult {
    const L = plan.decision.layers;
    if (LAYERS.some((n) => L[n].action === 'offer')) return 'offered';
    const app = L.app as Exclude<UpdateDecision, Offer>;
    if (app.reason === 'unsigned' || app.reason === 'inconsistentSigned') return 'error';
    if (app.reason === 'otherApp') return 'upToDate';
    // A held-back engine or interface layer is reported the same way as an app one.
    for (const n of ['engine', 'interface'] as const) {
      const d = L[n];
      if (d.action === 'none' && (d.reason === 'paused' || d.reason === 'blocked' || d.reason === 'notInRollout') && app.reason === 'upToDate') return d.reason;
    }
    return app.reason;
  }

  /**
   * Takes back whatever is downloaded or staged that this plan no longer offers in exactly that version: a blocked (or
   * superseded, unsigned, refused) one is deleted, a paused or held-back one is kept but cannot be applied or installed.
   */
  private async reconcile(plan: UpdatePlan): Promise<void> {
    const staged = await this.deps.manager.stagedOnDisk();
    const running = this.deps.manager.installed();
    for (const layer of LAYERS) {
      const sv = staged[layer];
      if (!sv || sv === running[layer]) continue;
      const d = plan.decision.layers[layer];
      // Judged by its own version first, with the latest policy answer: a blocked copy goes even when this plan offers it
      // (an older plan) or the manifest has moved on to a paused replacement.
      const ownBlocked = this.deps.manager.blocksVersion(layer, sv);
      if (!ownBlocked && d.action === 'offer' && plan.manifest.layers[layer].version === sv) continue;
      const act = ownBlocked || d.action === 'offer' ? 'delete' : pendingAction(d);
      this.deps.log?.(`update ${layer} ${sv}: ${act === 'delete' ? 'deleted' : 'held'} (${ownBlocked ? 'blocked' : d.action === 'offer' ? 'superseded' : d.reason})`);
      await this.deps.manager.dropStaged(layer, act === 'delete').catch(() => {});
      if (this.status.kind === layer && this.status.phase !== 'idle') this.set(IDLE);
    }
    // A layer shown as ready whose staged copy is gone (dropped above, or by a failed step) is not ready any more.
    if (this.status.phase === 'ready' && this.status.kind && this.deps.manager.staged()[this.status.kind] !== this.status.version) this.set(IDLE);
  }

  /**
   * The manifest could not be read, but the policy was just refreshed (UpdateManager.plan awaits it either way): whatever
   * waits is judged with it, so a pause or block from the dashboard holds or deletes it even while the manifest is down.
   */
  private async reconcileWithoutManifest(): Promise<void> {
    const staged = await this.deps.manager.stagedOnDisk();
    const running = this.deps.manager.installed();
    for (const layer of LAYERS) {
      const sv = staged[layer];
      if (!sv || sv === running[layer]) continue;
      const v = this.deps.manager.judgeWithoutManifest(layer, sv);
      if (v === 'keep') continue;
      this.deps.log?.(`update ${layer} ${sv}: ${v === 'delete' ? 'deleted' : 'held'} by the policy (manifest unavailable)`);
      await this.deps.manager.dropStaged(layer, v === 'delete').catch(() => {});
      if (this.status.kind === layer && this.status.phase !== 'idle') this.set(IDLE);
    }
  }

  /** Shows as ready only what is staged AND offered by `plan` in that version; a required layer comes first. */
  private markReady(plan: UpdatePlan): void {
    const staged = this.deps.manager.staged();
    const ready = LAYERS.flatMap((layer) => {
      const d = plan.decision.layers[layer];
      const v = plan.manifest.layers[layer].version;
      // Also offered under the latest policy answer (the plan may be older than it, e.g. when the revalidation failed).
      return d.action === 'offer' && staged[layer] === v && this.deps.manager.gateCached(layer, v)?.action === 'offer' ? [{ layer, d, v }] : [];
    });
    if (!ready.length) {
      if (this.status.phase === 'downloading' && !this.status.error) this.set(IDLE);
      return;
    }
    const pick = ready.find((r) => r.d.required) ?? ready[0]!;
    this.set({
      phase: 'ready', kind: pick.layer, version: pick.v, notes: plan.manifest.layers[pick.layer].notes ?? [],
      required: pick.d.required, critical: pick.d.required && pick.d.critical, minimumVersion: pick.d.minimum, progress: undefined, error: undefined,
    });
  }

  private async run(opts: { manual: boolean }): Promise<UpdateStatus> {
    this.failure = null;
    let plan: UpdatePlan;
    try {
      plan = await this.deps.manager.plan({ force: opts.manual });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof ManifestNetworkError) {
        this.deps.log?.(`update check: offline (${message})`);
        this.checked('offline', { message });
      } else {
        this.deps.log?.(`update check failed: ${message}`);
        this.checked('error', { message });
      }
      await this.reconcileWithoutManifest();
      if (opts.manual) throw e;
      return this.status;
    }
    const result = this.resultOf(plan);
    this.checked(result, { from: plan.from });
    this.deps.log?.(`update check: ${result} (manifest from ${plan.from}, app ${plan.manifest.layers.app.version}, policy ${plan.decision.policyUsed ? 'used' : 'none'})`);
    await this.reconcile(plan);
    if (result !== 'offered') return this.status;

    const L = plan.decision.layers;
    const app = L.app;
    if (app.action === 'offer' && !(this.status.phase === 'ready' && this.status.kind === 'app' && this.status.version === plan.manifest.layers.app.version)) {
      this.set({ phase: 'downloading', kind: 'app', version: plan.manifest.layers.app.version, notes: plan.manifest.layers.app.notes ?? [], required: app.required, critical: app.required && app.critical, minimumVersion: app.minimum, error: undefined });
    } else if (this.status.phase === 'idle') {
      const req = (['engine', 'interface'] as const).find((n) => L[n].action === 'offer' && (L[n] as Offer).required);
      if (req) {
        const d = L[req] as Offer;
        this.set({ phase: 'downloading', kind: req, version: plan.manifest.layers[req].version, notes: plan.manifest.layers[req].notes ?? [], required: true, critical: d.critical, minimumVersion: d.minimum, error: undefined });
      }
    }

    let summary: UpdateCheckSummary;
    try {
      summary = await this.deps.manager.checkForUpdates({
        plan,
        app: { onProgress: (received, total) => { if (this.status.phase === 'downloading') this.set({ progress: { received, total } }); } },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.log?.(`update download failed: ${message}`);
      if (this.status.phase === 'downloading') this.set(this.status.required ? { error: message } : IDLE);
      if (opts.manual) throw e;
      return this.status;
    }
    this.failure = [summary.app, summary.engine, summary.interface].map((o) => (o?.type === 'updateFailed' ? o.message : null)).find(Boolean) ?? null;
    if (this.failure && this.status.phase === 'downloading') this.set(this.status.required ? { error: this.failure, progress: undefined } : IDLE);

    // The policy may have changed while the download ran: judge again with a fresh policy and a revalidated manifest
    // (a 304 when nothing changed) before anything is offered as ready.
    // The policy request is awaited either way (UpdateManager.plan); when the manifest request fails, what was downloaded
    // is judged by its own version with that fresh policy (paused: kept, not offered; blocked: deleted) before markReady,
    // which also re-checks every candidate against the latest policy.
    let after = plan;
    try {
      after = await this.deps.manager.plan({ force: true });
      await this.reconcile(after);
    } catch (e) {
      this.deps.log?.(`update re-check after download failed (${e instanceof Error ? e.message : String(e)}); judged with the fresh policy and the check's own manifest`);
      await this.reconcileWithoutManifest();
    }
    this.markReady(after);
    return this.status;
  }

  // ---- gates at apply and quit ----------------------------------------------------------------------------------

  /**
   * Restart now / Apply now: judges the waiting update again (fresh policy, revalidated manifest; offline: the last known
   * ones) and refuses when it is no longer offered. Nothing is changed then, and the pill goes.
   */
  async recheckBeforeApply(): Promise<{ ok: boolean; reason?: string }> {
    const s = this.status;
    if (s.phase !== 'ready' || !s.kind || !s.version) return { ok: false, reason: 'Nothing is ready to apply.' };
    let plan: UpdatePlan | null = null;
    try {
      plan = await this.deps.manager.plan({ force: true });
    } catch {
      await this.reconcileWithoutManifest();
      if (this.status.phase !== 'ready' || this.status.kind !== s.kind || this.status.version !== s.version) {
        return { ok: false, reason: 'This update was paused or withdrawn, so nothing was changed.' };
      }
      const d = this.deps.manager.gateCached(s.kind, s.version);
      if (!d || d.action !== 'offer') {
        this.set(IDLE);
        return { ok: false, reason: 'This update was paused or withdrawn, so nothing was changed.' };
      }
      return { ok: true };
    }
    await this.reconcile(plan);
    this.markReady(plan);
    const now = this.status;
    if (now.phase === 'ready' && now.kind === s.kind && now.version === s.version) return { ok: true };
    return { ok: false, reason: 'This update was paused or withdrawn, so nothing was changed.' };
  }

  /** As the app quits: one last judgement (at most a few seconds) of whatever waits, so a paused or blocked update is not installed. */
  async beforeQuit(): Promise<void> {
    const staged = await this.deps.manager.stagedOnDisk();
    const running = this.deps.manager.installed();
    const anything = this.status.phase === 'ready' || LAYERS.some((l) => staged[l] && staged[l] !== running[l]);
    if (!anything) return;
    const work = (async () => {
      let plan: UpdatePlan;
      try {
        plan = await this.deps.manager.plan({ force: true });
      } catch (e) {
        this.deps.log?.(`update check at quit failed: ${e instanceof Error ? e.message : String(e)}`);
        await this.reconcileWithoutManifest();
        return;
      }
      await this.reconcile(plan);
      this.markReady(plan);
    })().catch((e) => this.deps.log?.(`update check at quit failed: ${e instanceof Error ? e.message : String(e)}`));
    await Promise.race([work, new Promise((r) => setTimeout(r, this.deps.quitCheckMs ?? 4000))]);
  }

  /** will-quit (synchronous): install on quit only an app update that is ready and still offered by the last known policy. */
  mayInstallOnQuit(): boolean {
    const s = this.status;
    if (s.phase !== 'ready' || s.kind !== 'app' || !s.version) return false;
    return this.deps.manager.gateCached('app', s.version)?.action === 'offer';
  }
}
