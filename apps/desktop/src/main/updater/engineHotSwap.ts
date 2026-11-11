import { join } from 'node:path';
import type { KeyObject } from 'node:crypto';
import type { EngineStatus, OpenBuildState, UpdateLayer } from '@pom/protocol';
import type { ProcessFactory, ProcessHandle } from '../../shared/processHandle.js';
import type { HostControlResponse } from '../../engine-host/controlProtocol.js';
import type { Downloader } from './downloader.js';
import { verifyDownloadedLayer } from './signature.js';

export interface EngineHotSwapDeps {
  downloader: Downloader;
  publicKey: KeyObject;
  processFactory: ProcessFactory;
  stagingDir: string;
  /**
   * The fixed engine-host bootstrap script (engine-host/main.ts, built).
   * Only the native module a downloaded pack points at changes between
   * versions - the process entry point that loads it does not, so every
   * hot-swapped engine process forks this same file.
   */
  engineHostEntryPath: string;
  /** How long to wait for the new process to ack the switch and recalculate, counted from when it says it is ready. */
  verifyTimeoutMs?: number;
  /**
   * How long a freshly forked process may take to load and announce it is ready. Kept apart from `verifyTimeoutMs`: a cold
   * start depends on how busy the machine is, the switch does not.
   */
  startTimeoutMs?: number;
  /** Called once a new engine has proved itself, with its pack: it is kept for the next app start. */
  onStaged?(staged: { version: string; packPath: string; layer?: UpdateLayer }): Promise<void> | void;
  /** Called when a staged engine is taken back (blocked or superseded): its marker and pack go. */
  onDropped?(): Promise<void> | void;
}

export type EngineHotSwapOutcome =
  | { type: 'staged'; version: string }
  | { type: 'updateFailed'; layer: 'engine'; message: string; stillOnVersion: string };

interface VerifyResult {
  ok: boolean;
  error?: string;
}

/**
 * Drives one engine+data layer update end to end: background download,
 * verify, spin up a second engine process on the new pack and check it can
 * load and recalculate. The running engine is never replaced under open
 * builds: a verified pack is staged and the next app start runs it. On any
 * failure nothing is staged and the running engine is left untouched.
 */
export class EngineHotSwapController {
  private currentProcess: ProcessHandle;
  private currentVersion: string;
  private stagedVersion: string | null = null;

  constructor(
    private readonly deps: EngineHotSwapDeps,
    initialProcess: ProcessHandle,
    initialVersion: string,
  ) {
    this.currentProcess = initialProcess;
    this.currentVersion = initialVersion;
  }

  getCurrentProcess(): ProcessHandle {
    return this.currentProcess;
  }

  getCurrentVersion(): string {
    return this.currentVersion;
  }

  /** The version that starts running at the next app start, once an update has been verified and staged. */
  getStagedVersion(): string | null {
    return this.stagedVersion;
  }

  /** Takes back the staged engine (the policy blocked or superseded it): the next start runs the engine it runs today. */
  async dropStaged(o: { deleteFile: boolean }): Promise<void> {
    if (!o.deleteFile || !this.stagedVersion) return;
    this.stagedVersion = null;
    await this.deps.onDropped?.();
  }

  /** The staged engine found at start-up (its marker), so the policy gate and Restart now know it. */
  adoptStaged(version: string | null): void {
    this.stagedVersion = version;
  }

  async applyUpdate(layer: UpdateLayer, buildState: OpenBuildState): Promise<EngineHotSwapOutcome> {
    const destPath = join(this.deps.stagingDir, `engine-${layer.version}.pack`);
    await this.deps.downloader.download(layer.url, destPath);

    const verification = await verifyDownloadedLayer('engine', layer, destPath, this.deps.publicKey);
    if (!verification.ok) {
      return this.fail(verification.reason ?? 'verification failed');
    }

    const newProcess = this.deps.processFactory({
      modulePath: this.deps.engineHostEntryPath,
      env: { POM_NATIVE_ENGINE_PATH: destPath },
    });

    const result = await this.verifyNewProcess(newProcess, buildState);
    if (!result.ok) {
      newProcess.kill();
      return this.fail(result.error ?? 'new engine failed verification');
    }

    // The check process has done its job. The running engine keeps serving the open builds until the next start.
    newProcess.kill();
    await this.deps.onStaged?.({ version: layer.version, packPath: destPath, layer });
    this.stagedVersion = layer.version;
    return { type: 'staged', version: layer.version };
  }

  private fail(message: string): EngineHotSwapOutcome {
    return { type: 'updateFailed', layer: 'engine', message, stillOnVersion: this.currentVersion };
  }

  private verifyNewProcess(proc: ProcessHandle, buildState: OpenBuildState): Promise<VerifyResult> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: VerifyResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      let timer = setTimeout(() => {
        finish({ ok: false, error: 'timed out waiting for the new engine to start' });
      }, this.deps.startTimeoutMs ?? 30_000);

      proc.onExit((code) => {
        finish({ ok: false, error: `new engine process exited before verification completed (code ${code})` });
      });

      proc.onMessage((message) => {
        // A fresh process only listens once it has loaded (a cold start can take a while), and a message sent before that is
        // lost. The host announces its status when it is listening, so the switch waits for that.
        const announced = message as { type?: string; status?: EngineStatus };
        if (announced?.type === 'status' && announced.status) {
          if (announced.status.state === 'ready') {
            // The process is listening: the switch gets its own deadline from here.
            clearTimeout(timer);
            timer = setTimeout(() => {
              finish({ ok: false, error: 'timed out waiting for the new engine to verify the handed-off build' });
            }, this.deps.verifyTimeoutMs ?? 10_000);
            // With no build open there is nothing to hand over: an engine that announces ready has loaded its pack.
            if (!buildState.buildXml.trim()) {
              finish({ ok: true });
              return;
            }
            proc.postMessage({ kind: 'control', type: 'loadBuildState', state: buildState });
          } else if (announced.status.state === 'unavailable' || announced.status.state === 'error') {
            finish({ ok: false, error: announced.status.state === 'error' ? announced.status.message : announced.status.reason });
          }
          return;
        }
        const envelope = message as { kind?: string; response?: HostControlResponse };
        if (envelope?.kind !== 'control-response' || !envelope.response) return;
        const response = envelope.response;
        if (response.type === 'loadBuildStateAck') {
          if (!response.ok) {
            finish({ ok: false, error: response.error });
            return;
          }
          proc.postMessage({ kind: 'control', type: 'recalculate' });
        } else if (response.type === 'recalculateResult') {
          finish(response.ok ? { ok: true } : { ok: false, error: response.error });
        }
      });
    });
  }
}

export type { ProcessFactory };
