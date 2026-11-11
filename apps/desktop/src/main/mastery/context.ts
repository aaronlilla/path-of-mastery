// Central assembly: the one place the new Atlas / Timeline / Run / Marketplace services are built and registered.
// Feature modules keep their logic; the wire*.ts files beside this one only construct them and register their IPC.
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  atlasPlanSchema, buildSnapshotSchema, filterSnapshotSchema, sourceSnapshotSchema, timelineSchema,
  type ValidationLimits,
} from '@pom/mastery-contracts';
import { DocumentStore } from '../documents/store.js';
import { WorkspaceService } from '../workspaces/manifest.js';
import type { AccountsHost } from '../accounts/host.js';
import type { AiAccess } from '../aiGate/gate.js';

/**
 * Production validation limits for every new contract payload.
 * Sized for the largest real objects we expect: an Atlas plan with full history, a Timeline bundle with
 * frozen Build/Atlas/filter sources. They bound memory, not content quality.
 */
export const MASTERY_LIMITS: ValidationLimits = Object.freeze({
  maxBytes: 8_000_000,
  maxDepth: 64,
  maxNodes: 400_000,
  maxArrayLength: 50_000,
  maxStringLength: 2_000_000,
});

/** The IPC registrar every feature ipc.ts accepts (ipcMain satisfies it). */
export type Registrar = {
  handle(channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void;
  removeHandler(channel: string): void;
};

export type MasteryContext = {
  ipc: Registrar;
  userDataDir: string;
  /** apps/desktop/resources in dev, process.resourcesPath when packaged. */
  resourcesDir: string;
  isPackaged: boolean;
  /** app.getVersion(): part of the identity of the validation caches for bundled data (main/validationCache.ts). */
  appVersion?: string;
  limits: ValidationLimits;
  documents: DocumentStore;
  /**
   * Folder holding the archived Atlas catalog: `archive.json`, `packs/` and, once qualified, `catalog.json`.
   * Dev: <repo>/resources/atlas. Packaged: <process.resourcesPath>/atlas (package only archive.json + packs/).
   * Optional; wireAtlas falls back to join(resourcesDir, 'atlas').
   */
  atlasResourcesDir?: string;
  /** The Builds library (XML files), for freezing library builds as Timeline sources. */
  library?: import('./libraryBuilds.js').LibraryAccess;
  /** Null until a verified league scope exists (no Atlas catalog is qualified yet, so first runs have none). */
  workspaces: WorkspaceService | null;
  accounts: AccountsHost;
  /** The AI gate. Fails closed (every check denied) until the server is reachable and the account has AI access. */
  ai: AiAccess;
  /** Origin of the PoM site/API: POM_SITE_ORIGIN, else production when packaged, else the local site dev server (see siteOrigin.ts). */
  siteOrigin: string;
  /** This installation's identity and signing key for the site's app-channel check. Absent: calls go out unsigned and the site refuses the ones that need it. */
  appChannel?: { installation: string; sign(route: string, body: unknown, accountId: string): Record<string, string> };
  /** Filled by the Marketplace wiring: the human check the AI backend uses (it is built before this context exists). */
  humanCheckSlot?: { admission: import('./admission.js').Admission | null };
  mainWindow(): BrowserWindow | null;
  /** True only for the main window's top frame. */
  isMainSender(event: unknown): boolean;
  /** Push to the main window on a `mastery:push:*` channel (the preload only forwards that prefix). */
  push(channel: `mastery:push:${string}`, payload: unknown): void;
  /** Bring the main window back (recreating it after "Keep Run open"), then push; a freshly created window gets the push once it has loaded. */
  revealAndPush(channel: `mastery:push:${string}`, payload: unknown, deferWhenLoading?: boolean): boolean;
  /** Work that must finish before the app quits (drain stores). Runs in registration order, reversed. */
  onQuit(task: () => Promise<void>): void;
  /** Opens a native save dialog for a recovery export; never takes a path from the renderer. */
  chooseSaveFile(defaultName: string): Promise<string | null>;
  /** The Run window's renderer entry (run/index.html: dev-server URL or packaged file URL) and its preload. */
  runEntry: { url: string; preload: string };
  /** Opens a native file picker (Client.txt and imports). */
  chooseOpenFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
};

export function isMainFrameOf(win: () => BrowserWindow | null) {
  return (event: unknown): boolean => {
    const w = win();
    const e = event as { sender?: unknown; senderFrame?: { parent?: unknown } | null } | null;
    if (!w || w.isDestroyed() || !e) return false;
    return e.sender === w.webContents && !!e.senderFrame && !e.senderFrame.parent;
  };
}

/** Document store plus workspaces: everything else hangs off these two. */
export async function openDocumentCore(userDataDir: string, limits: ValidationLimits) {
  const documents = new DocumentStore(userDataDir, {
    limits,
    checkpointEvery: 20,
    schemas: {
      atlas: atlasPlanSchema,
      timeline: timelineSchema,
      build: buildSnapshotSchema,
      filter: filterSnapshotSchema,
      notes: sourceSnapshotSchema,
      checklist: sourceSnapshotSchema,
    },
  });
  await documents.init();
  const workspaces = new WorkspaceService(userDataDir, {
    limits,
    documents,
    // Every new editor writes through the document store at once; main holds no other dirty buffer, and the
    // workspace service itself refuses to switch while the store has an unsaved draft (hasUnsavedChanges).
    flushDirty: async () => {},
  });
  let ready: WorkspaceService | null = workspaces;
  try {
    await workspaces.init();
  } catch (e) {
    // First run with no verified league: the workspace refuses to invent one ("Connect to load this league."). Every object
    // still saves locally; league scoping and copy-to-league stay unavailable until a scope is verified.
    console.warn('League workspaces unavailable:', e instanceof Error ? e.message : String(e));
    ready = null;
  }
  return { documents, workspaces: ready };
}

/**
 * Seam between the Run wiring (wireTimelinesAndRun) and the Marketplace wiring (wireMarketplace):
 * Marketplace "Run this timeline" hands a resolved published bundle to the Run through this.
 */
export type RunLauncher = {
  start(input: import('../run/service.js').StartRun, choice?: 'keep' | 'replace' | null): Promise<{ status: 'started' } | { status: 'blocked'; reason: string } | { status: 'competing' }>;
  /** Opens or raises the Run window for the active Run (no-op when none). */
  raise(): void;
};
