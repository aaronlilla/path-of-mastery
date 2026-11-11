/** What the updater is doing, pushed to the window (title-bar pill, restart toast, Update required modal). */
export interface UpdateStatus {
  /** idle: nothing waiting; downloading: a release is coming down in the background; ready: it is verified and waits for a restart. */
  phase: 'idle' | 'downloading' | 'ready';
  /** The app version running now. */
  current: string;
  /** The version being downloaded or waiting. */
  version?: string;
  /** app: the installer runs at the restart; engine: the staged engine starts at the restart; interface: the new UI bundle is swapped into the window, no restart. */
  kind?: 'app' | 'engine' | 'interface';
  notes: string[];
  /** The running version is below the release's signed minimumVersion: the Update required modal shows. */
  required: boolean;
  /** A security fix. */
  critical: boolean;
  minimumVersion?: string;
  progress?: { received: number; total: number };
  /** The download of a required update failed (the modal offers Retry). */
  error?: string;
  /** The last check: when, and what it found. */
  lastCheck?: { at: number; result: UpdateCheckResult; from?: 'network' | 'cache' | 'revalidated'; message?: string };
}

export type UpdateCheckResult = 'upToDate' | 'paused' | 'blocked' | 'notInRollout' | 'downgradeRefused' | 'offered' | 'offline' | 'error';

/** One-off messages: an interface update applied live, the app came back on the new version, or an install did not take. */
export type UpdateNotice =
  | { kind: 'interfaceApplied'; version: string }
  | { kind: 'updated'; version: string }
  | { kind: 'installFailed'; version: string };

/** What a restart request returned: started (the app is quitting), or why not. */
export type RestartResult = { ok: true } | { ok: false; reason: string };
