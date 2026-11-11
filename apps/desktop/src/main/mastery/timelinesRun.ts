// Wiring for Timelines and the durable Run. Constructs the services and registers IPC;
// no feature logic lives here.
import { BrowserWindow, globalShortcut, screen } from 'electron';
import { join } from 'node:path';
import { parseId, type FrozenSource, type LeagueStamp, type ObjectId, type ObjectKind, type RevisionRef } from '@pom/mastery-contracts';
import type { MasteryContext, RunLauncher } from './context.js';
import type { AtlasService } from '../atlas/service.js';
import { TimelineService } from '../timelines/service.js';
import { registerTimelineIpc } from '../timelines/ipc.js';
import { RunStore } from '../run/store.js';
import { RunService, type StartRun } from '../run/service.js';
import { RunWindowHost, WindowPlacementStore, type Monitor, type RunNativeWindow } from '../run/window.js';
import { RunLogHost } from '../run/log.js';
import { detectClientTxt } from '../run/detect.js';
import { RunHotkeys } from '../run/hotkeys.js';
import { isRunSender, registerRunIpc } from '../run/ipc.js';
import { wireLibrarySources } from './libraryBuilds.js';
import { documentSource, SOURCE_KINDS } from '../timelines/sources.js';
import { JourneyTelemetry, LocalTelemetryStore } from '../journey/telemetry.js';
import type { AtlasRules } from '../../shared/journey/telemetry.js';
import type { RunView } from '../../shared/run/types.js';
import type { RunInfo, RunPublicServices, RunServiceCall } from '../../shared/run/services.js';
import { feedbackRequestSchema } from '@pom/mastery-contracts';
import { appIconPath } from '../windows.js';

export const TIMELINE_SOURCES_CHANNEL = 'mastery:timelines:sources';
/** Pushed to the main window when the Run window asks to open its Timeline or a source. */
export const RUN_OPEN_PUSH = 'mastery:push:run-open';

export type RunWiring = {
  run: RunService;
  timelines: TimelineService;
  launcher: RunLauncher;
  /** Main-window close choice from the close dialog. */
  mainClosing(choice: 'keep_run_open' | 'close_both'): Promise<void>;
  hasRunWindow(): boolean;
  /** Library Builds frozen as Timeline sources (null when the main process gave no library). */
  librarySources: import('./libraryBuilds.js').LibrarySources | null;
  /**
   * Receipt delivery for the Marketplace wiring: call `run.deliverReceipts` with the outbox sender. Serialized inside
   * RunService; safe to call after every change and after sign-in.
   */
  deliverReceipts(send: Parameters<RunService['deliverReceipts']>[0]): Promise<void>;
  /** The Marketplace wiring plugs its vote / feedback calls in here once it exists (the Run starts first). */
  setPublicServices(services: RunPublicServices | null): void;
  /** The Marketplace wiring plugs in how a saved public item id becomes a frozen Timeline source. */
  setSavedSource(fn: ((objectId: ObjectId) => Promise<FrozenSource>) | null): void;
  /** Fires after every committed Run change (use it to trigger deliverReceipts). Returns an unsubscribe. */
  onRunChange(listener: (view: RunView | null) => void): () => void;
  dispose(): void;
};

const unknownStamp = (): LeagueStamp => {
  const u = { status: 'unknown' as const, reason: 'No verified league is selected.' };
  return { leagueId: u, realm: u, mode: u, patchVersion: u, datasetVersion: u, createdAt: new Date().toISOString() };
};

function stageCount(snapshot: FrozenSource['fallbackSnapshot']): number {
  switch (snapshot.kind) {
    case 'build': return snapshot.payload.guide.length;
    case 'atlas': return Object.keys(snapshot.payload.stepsById).length;
    case 'filter': return snapshot.payload.stages.length;
    default: return snapshot.payload.instructions.length;
  }
}

export async function wireTimelinesAndRun(ctx: MasteryContext, deps: { atlas: { service: AtlasService } | null }): Promise<RunWiring> {
  const runDir = join(ctx.userDataDir, 'mastery', 'runs');
  const changeListeners = new Set<(view: RunView | null) => void>();
  let host: RunWindowHost | null = null;
  let nativeWindow: BrowserWindow | null = null;

  const laneCount = (view: RunView | null) => Math.max(1, new Set(view?.snapshot.actions.map(a => a.laneId)).size);
  const openWindow = () => {
    const view = run.view();
    if (!host || !view) return;
    host.open(laneCount(view)).catch(e => console.warn('Run window failed to open:', e));
  };

  // Run store and service. Documents are the already initialised store.
  const store = new RunStore(ctx.userDataDir, ctx.limits);
  const run: RunService = new RunService(store, {
    limits: ctx.limits, documents: ctx.documents,
    onChange: view => {
      host?.send(view);
      for (const l of changeListeners) { try { l(view); } catch (e) { console.warn('Run change listener failed:', e); } }
    },
    raiseWindow: openWindow,
  });
  await run.init();

  const monitors = (): Monitor[] => {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map(d => ({ id: String(d.id), name: d.label || `Display ${d.id}`, workArea: { ...d.workArea }, primary: d.id === primary }));
  };

  const hotkeys = new RunHotkeys(globalShortcut, run, e => console.warn('Run hotkey failed:', e));

  host = new RunWindowHost({
    create: options => {
      const win = new BrowserWindow({ ...options, icon: appIconPath() });
      nativeWindow = win;
      return win as unknown as RunNativeWindow;
    },
    entryUrl: ctx.runEntry.url, preload: ctx.runEntry.preload, monitors,
    placement: new WindowPlacementStore(join(runDir, 'window.json')),
    flush: () => run.flush(),
    closeRun: async () => { hotkeys.disable(); await run.closeRun(); },
    onError: e => console.warn('Run window error:', e),
  });
  const windowHost = host;

  // Telemetry: every projection is handed to the Run before the reader checkpoint commits.
  // No qualified Atlas catalog exists yet, so rules are the honest "unavailable" dataset: First map and Atlas counts stay Unknown.
  const rules: AtlasRules = {
    dataset: { datasetId: 'unavailable', contentHash: '0'.repeat(64) as never, variant: 'unavailable', stamp: unknownStamp() },
    logNodeIds: {}, costs: { status: 'unknown', reason: 'No qualified Atlas catalog is installed.' },
  };
  const telemetryStore = new LocalTelemetryStore(join(runDir, 'telemetry.json'), ctx.limits);
  let restored: Awaited<ReturnType<LocalTelemetryStore['load']>> = null;
  try { restored = await telemetryStore.load(); } catch (e) { console.warn('Run log checkpoint unreadable, starting fresh:', e); }
  let observationsWritten: Promise<void> = Promise.resolve();
  const telemetry = new JourneyTelemetry({
    rules,
    onChange: state => {
      // One failed save must not poison the chain: every step recovers, so later checkpoints still commit.
      observationsWritten = observationsWritten.then(() => run.acceptTelemetry(state)).then(() => {}, e => { console.warn('Run log read failed:', e); });
    },
    commit: async (state, cursor) => { await observationsWritten; await telemetryStore.commit(state, cursor); },
  }, restored ?? undefined);
  const log = new RunLogHost(telemetry, run, () => ctx.chooseOpenFile([{ name: 'Client.txt', extensions: ['txt'] }]), () => detectClientTxt());

  let publicServices: RunPublicServices | null = null;
  const showMain = () => { const w = ctx.mainWindow(); if (w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); } };
  const runServices = async (raw: unknown): Promise<unknown> => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid request.');
    const c = raw as RunServiceCall, view = run.view();
    switch (c.kind) {
      case 'info': {
        const info: RunInfo = { ownership: view?.snapshot.publishedOrigin ? 'public' : 'owned', netVotes: null, detectedLog: log.detected(), signedIn: publicServices?.signedIn() ?? false };
        return info;
      }
      case 'vote': {
        const origin = view?.snapshot.publishedOrigin;
        if (!origin || !publicServices || (c.direction !== 1 && c.direction !== -1)) throw new Error('Voting is not available for this Run.');
        return publicServices.vote(origin.postId, c.direction);
      }
      case 'saveFeedback': case 'sendFeedback': {
        const origin = view?.snapshot.publishedOrigin, checked = feedbackRequestSchema.parse(c.request, ctx.limits);
        if (!origin || !publicServices || !checked.ok || typeof c.allowReplies !== 'boolean') throw new Error('Feedback is not available for this Run.');
        if (checked.value.publishedRevision.postId !== origin.postId || checked.value.publishedRevision.revisionId !== origin.revisionId) throw new Error('Feedback must name this Run.');
        if (c.kind === 'saveFeedback') { await publicServices.saveFeedback(checked.value, c.allowReplies); return null; }
        return publicServices.sendFeedback(checked.value, c.allowReplies);
      }
      case 'publish':
        if (!view) throw new Error('No active Run.');
        ctx.push(RUN_OPEN_PUSH, { target: 'publish', objectId: view.snapshot.timelineRevision.objectId }); showMain(); return null;
      case 'openLootFilter': ctx.push(RUN_OPEN_PUSH, { target: 'lootfilter' }); showMain(); return null;
      default: throw new Error('Unsupported.');
    }
  };

  const unregisterRunIpc = registerRunIpc(ctx.ipc as never, run, {
    isTrustedRunSender: event => isRunSender(event, windowHost.senderId(), ctx.runEntry.url),
    limits: ctx.limits,
    closeWindow: () => windowHost.close(),
    windowSettings: () => windowHost.settings(),
    saveWindowSettings: p => windowHost.setPreferences(p),
    configureHotkeys: (next, back) => hotkeys.configure(next, back),
    disableHotkeys: () => hotkeys.disable(),
    chooseRecoveryDestination: () => ctx.chooseSaveFile('run-recovery.json'),
    log, monitors, services: runServices,
    openTimeline: async snapshot => {
      ctx.revealAndPush(RUN_OPEN_PUSH, { target: 'timeline', objectId: snapshot.timelineRevision.objectId, revisionId: snapshot.timelineRevision.revisionId });
      const w = ctx.mainWindow(); if (w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
    },
    openSource: async source => {
      ctx.revealAndPush(RUN_OPEN_PUSH, { target: 'source', kind: source.snapshot.kind, objectId: source.ref.objectId, revisionId: source.ref.revisionId });
      const w = ctx.mainWindow(); if (w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
    },
  });

  const onDisplays = () => { void windowHost.monitorsChanged().catch(e => console.warn('Run window re-home failed:', e)); };
  screen.on('display-added', onDisplays); screen.on('display-removed', onDisplays); screen.on('display-metrics-changed', onDisplays);

  // Receipts are bound to the signed-in account.
  const syncAccount = () => { void run.setAccount(ctx.accounts.service.user?.id ?? null).catch(e => console.warn('Run account binding failed:', e)); };
  syncAccount();
  const offAccount = ctx.accounts.service.onChange(syncAccount);

  // Timelines.
  const timelines = new TimelineService(ctx.documents, {
    limits: ctx.limits,
    activeStamp: () => ctx.workspaces ? ctx.workspaces.active().stamp : unknownStamp(),
    registerObject: async (objectId: ObjectId) => {
      if (!ctx.workspaces) return;
      try { await ctx.workspaces.enroll(ctx.workspaces.active().activeScope, 'timeline', objectId); }
      catch (e) { console.warn('Timeline saved but not added to the workspace:', e instanceof Error ? e.message : e); }
    },
    flushSource: async source => {
      const id = source.ref.objectId;
      if (ctx.documents.pendingSnapshot(id)) throw new Error('Save the source before adding it to a timeline.');
      return source;
    },
    runContext: async () => {
      const view = run.view();
      return { incompatible: [], dependencies: [], competingRun: !!view && !view.state.endedAt, start: undefined };
    },
    startRun: async input => {
      const start: StartRun = { bundle: input.bundle, timelineRevision: input.revision, omittedClipIds: input.omittedClipIds };
      // A competing Run is saved (store barrier) inside RunService.start before the replacement is exposed.
      await run.flush();
      await run.start(start, input.replaceCurrent ? 'replace' : null);
      return { status: 'started' };
    },
  });
  // Library Builds become Timeline sources (frozen in the background; the picker reloads on the push).
  const librarySources = ctx.library ? wireLibrarySources(ctx, ctx.library, () => ctx.workspaces ? ctx.workspaces.active().stamp : unknownStamp()) : null;
  const unregisterTimelineIpc = registerTimelineIpc(ctx.ipc as never, timelines, ctx.isMainSender);

  // Renderer-side source catalog: own Documents-store sources (build/atlas/filter/notes/checklist objects) and saved timelines.
  // Builds that live only in the XML library are not Documents-store objects and cannot be frozen here (see report).
  const sourceRow = async (objectId: ObjectId) => {
    const source = await documentSource(ctx.documents, objectId, ctx.limits);
    return { id: objectId, source, ownership: 'own' as const, revisionLabel: source.ref.revisionId.slice(0, 8), stages: stageCount(source.fallbackSnapshot), cached: true, guideAvailable: true };
  };
  // Opening a timeline must not re-read and re-validate every document: rows are cached per object+revision (a new revision replaces its entry).
  type SourceRow = Awaited<ReturnType<typeof sourceRow>>;
  const rowCache = new Map<string, SourceRow>(), insertionCache = new Map<string, { bundle: unknown; revision: RevisionRef }>();
  const cachedRow = async (row: { objectId: ObjectId; revisionId: string }): Promise<SourceRow> => {
    const key = `${row.objectId}:${row.revisionId}`, hit = rowCache.get(key);
    if (hit) return hit;
    const made = await sourceRow(row.objectId);
    for (const k of rowCache.keys()) if (k.startsWith(`${row.objectId}:`)) rowCache.delete(k);
    rowCache.set(key, made); return made;
  };
  let savedSource: ((objectId: ObjectId) => Promise<FrozenSource>) | null = null;
  ctx.ipc.handle(TIMELINE_SOURCES_CHANNEL, async (event, input) => {
    try {
      if (!ctx.isMainSender(event)) throw new Error('Unavailable.');
      const call = (input ?? {}) as { method?: string; objectId?: string; libraryId?: string };
      switch (call.method) {
        case 'limits': return { ok: true, value: ctx.limits };
        case 'activeStamp': return { ok: true, value: ctx.workspaces ? ctx.workspaces.active().stamp : unknownStamp() };
        case 'runStatus': {
          const view = run.view(), active = !!view && !view.state.endedAt;
          return { ok: true, value: { competing: active, objectId: active ? view!.snapshot.timelineRevision.objectId : null, position: active ? `Guide ${view!.state.guideCursor.level}` : null } };
        }
        // Library "Resume": bring the saved Run's window back (it restores itself from the durable session).
        case 'resumeRun': { const view = run.view(); if (!view || view.state.endedAt || view.snapshot.timelineRevision.objectId !== call.objectId) throw new Error('This Run is no longer the saved one.'); openWindow(); return { ok: true, value: null }; }
        case 'sources': {
          if (librarySources) void librarySources.refresh();
          const rows = [];
          for (const row of ctx.documents.list()) if (SOURCE_KINDS.includes(row.kind)) { try { rows.push(await cachedRow(row)); } catch { /* unreadable source: skip */ } }
          return { ok: true, value: rows };
        }
        case 'freezeBuild': {
          // A Build open in the workspace becomes a Timeline source on demand (the background pass can lag behind a fresh save).
          if (!librarySources || !ctx.library || typeof call.libraryId !== 'string') throw new Error('Unavailable.');
          const row = (await ctx.library.list()).find(r => r.id === call.libraryId);
          if (!row) throw new Error('Unavailable.');
          return { ok: true, value: { objectId: await librarySources.freeze(row.id, row.name) } };
        }
        case 'source': {
          const objectId = parseId('object', call.objectId as string);
          const own = ctx.documents.list().find(r => r.objectId === objectId);
          if (own) return { ok: true, value: await cachedRow(own) };
          // Not a document: a saved public item (Marketplace) is frozen from its pinned cached copy.
          if (!savedSource) throw new Error('Unavailable.');
          const source = await savedSource(objectId);
          return { ok: true, value: { id: objectId, source, ownership: 'saved' as const, revisionLabel: source.ref.revisionId.slice(0, 8), stages: stageCount(source.fallbackSnapshot), cached: true, guideAvailable: true } };
        }
        case 'insertions': {
          const out = [];
          for (const row of ctx.documents.list()) if (row.kind === 'timeline' && row.objectId !== call.objectId) {
            const key = `${row.objectId}:${row.revisionId}`;
            try {
              let hit = insertionCache.get(key);
              if (!hit) {
                hit = { bundle: await timelines.bundle(row.objectId), revision: ctx.documents.revisionRef(row.objectId, row.revisionId) };
                for (const k of insertionCache.keys()) if (k.startsWith(`${row.objectId}:`)) insertionCache.delete(k);
                insertionCache.set(key, hit);
              }
              out.push(hit);
            } catch { /* unresolved alternatives: not insertable */ }
          }
          return { ok: true, value: out };
        }
        default: throw new Error('Unsupported.');
      }
    } catch {
      return { ok: false, error: { code: 'TIMELINE_FAILED', message: 'Could not load timeline sources.' } };
    }
  });

  const launcher: RunLauncher = {
    async start(input, choice = null) {
      try { await run.start(input, choice); return { status: 'started' }; }
      catch (e) {
        const message = e instanceof Error ? e.message : 'Could not start the Run.';
        return message.startsWith('A Run is already open') ? { status: 'competing' } : { status: 'blocked', reason: message };
      }
    },
    raise: openWindow,
  };

  // Quit barrier: stop reading, release hotkeys, drain Run (and its store), then destroy the Run window so quit is not
  // vetoed by its close handler. Document stores are drained by the lead's own quit task.
  ctx.onQuit(async () => {
    hotkeys.disable();
    telemetry.stopReading();
    await observationsWritten.catch(() => {});
    await windowHost.saveBounds().catch(() => {});
    if (nativeWindow && !nativeWindow.isDestroyed()) nativeWindow.destroy();
    await run.close();
  });

  return {
    run, timelines, launcher, librarySources,
    async mainClosing(choice) { if (choice === 'close_both') hotkeys.disable(); await windowHost.mainClose(choice); },
    hasRunWindow: () => windowHost.senderId() !== null,
    setPublicServices: s => { publicServices = s; },
    setSavedSource: fn => { savedSource = fn; },
    deliverReceipts: send => run.deliverReceipts(send),
    onRunChange: listener => { changeListeners.add(listener); return () => { changeListeners.delete(listener); }; },
    dispose() {
      unregisterRunIpc(); unregisterTimelineIpc(); ctx.ipc.removeHandler(TIMELINE_SOURCES_CHANNEL);
      screen.removeListener('display-added', onDisplays); screen.removeListener('display-removed', onDisplays); screen.removeListener('display-metrics-changed', onDisplays);
      offAccount(); hotkeys.disable(); changeListeners.clear();
    },
  };
}
