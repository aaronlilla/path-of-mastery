// Timelines area backed by the real main services over the mastery bridge ('mastery:timelines').
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { parseId, type ClipOption, type DocumentEnvelope, type FrozenSource, type LaneId, type Timeline } from '@pom/mastery-contracts';
import { contentHash, pinSource } from '../../shared/timelines/adapters/common.js';
import { TimelineArea, SendToTimeline } from '../timelines';
import { Dialog } from '../ui';
import { NameDialog, DeleteDialog } from '../documents/LifecycleDialogs';
import { StarterChooser } from './StarterChooser';
import type { TimelineEditorProps, TimelineInsertion, TimelineLibraryProps, TimelineLibraryRow, TimelineSourceRow } from '../timelines/types.js';
import { inActiveLeague, sourceClip, type CollisionChoice } from '../../shared/timelines/editor/index.js';
import { call, on } from './bridge';
import type { MasteryShell } from './shell';
import { tr } from '../i18n';

const TL = 'mastery:timelines', SRC = 'mastery:timelines:sources';
const rpc = <T,>(method: string, args: Record<string, unknown> = {}) => call<T>(TL, { schemaVersion: 1, method, ...args });
const src = <T,>(method: string, args: Record<string, unknown> = {}) => call<T>(SRC, { method, ...args });
type Limits = TimelineEditorProps['limits'];
type Doc = DocumentEnvelope<Timeline> & { trashedAt?: string | null };
const failure = (e: unknown) => e instanceof Error ? e.message : tr('mastery_TimelinesHost.something_went_wrong');
// Per-viewer conveniences kept in the browser profile: the dismissed league-start card and the "Keep this version" choices.
const DISMISS_KEY = 'pom-timelines-starter-dismissed', KEPT_KEY = 'pom-timelines-kept-revisions';
const readStored = <T,>(key: string, fallback: T): T => { try { const raw = localStorage.getItem(key); return raw === null ? fallback : JSON.parse(raw) as T; } catch { return fallback; } };
const writeStored = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* the choice just does not stick */ } };
/** "<title> copy", then "<title> copy 2", ... so a duplicate never shares a card title with its original (120 characters max). */
function copyTitle(title: string, existing: string[]): string {
  const base = [...title].slice(0, 112).join('');
  for (let n = 1; ; n++) { const next = n === 1 ? tr('mastery_TimelinesHost.base_copy', { base }) : tr('mastery_TimelinesHost.base_copy_n', { base, n }); if (!existing.includes(next)) return next; }
}

type RunStatus = { competing: boolean; objectId?: string | null; position?: string | null };
function toRow(doc: Doc, status: RunStatus | null, active: Timeline['stamp']['leagueId'] | null): TimelineLibraryRow {
  const timeline = doc.payload;
  return { id: doc.objectId, timeline, createdAt: timeline.stamp.createdAt, lastUsed: Date.parse(timeline.stamp.createdAt) || 0,
    activeLeague: inActiveLeague(timeline.stamp.leagueId, active), ...(status?.competing && status.objectId === doc.objectId ? { resume: true, resumeAt: status.position ?? undefined } : {}),
    card: { ownership: 'owned', objectId: doc.objectId, title: timeline.title, stamp: timeline.stamp, art: { name: 'Timeline' }, updatedAt: timeline.stamp.createdAt,
      save: 'saved', source: { objectId: doc.objectId, revisionId: doc.revision.revisionId, payloadHash: doc.revision.payloadHash, stamp: doc.revision.stamp, fallbackSnapshotHash: doc.revision.payloadHash },
      summary: { kind: 'timeline', lanes: timeline.lanes.map(l => l.title), lastRun: status?.competing && status.objectId === doc.objectId ? tr('mastery_TimelinesHost.position_in_progress', { position: status.position ?? 'in progress' }) : null } } };
}

export function TimelinesHost({ shell }: { shell: MasteryShell }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  // The newest documents, readable the moment a save lands (React state only updates on the next render). Back-to-back edits, Undo and Redo
  // must each send the revision the previous one produced, not the one their render saw.
  const docsRef = useRef<Doc[]>([]);
  const putDocs = (next: Doc[] | ((all: Doc[]) => Doc[])) => { const value = typeof next === 'function' ? next(docsRef.current) : next; docsRef.current = value; setDocs(value); };
  const [state, setState] = useState<TimelineLibraryProps['state']>('loading');
  const [limits, setLimits] = useState<Limits | null>(null);
  const [sources, setSources] = useState<TimelineSourceRow[]>([]);
  const [insertions, setInsertions] = useState<TimelineInsertion[]>([]);
  const [competing, setCompeting] = useState(false);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [sending, setSending] = useState<{ source: FrozenSource } | null>(null);
  const [sendCollision, setSendCollision] = useState<string>();
  const [prefs, setPrefs] = useState<{ recentId?: string; openAfterAdding: boolean }>({ openAfterAdding: true });
  const [dialog, setDialog] = useState<{ k: 'rename' | 'delete'; id: string } | { k: 'trash' } | { k: 'starter' } | null>(null);
  const [trashed, setTrashed] = useState<Doc[]>([]);
  const [busy, setBusy] = useState(false), [dialogError, setDialogError] = useState<string>();
  const [runOnOpen, setRunOnOpen] = useState<string | null>(null);
  const [kept, setKept] = useState<Record<string, string>>(() => readStored(KEPT_KEY, {}));
  const [latestOptions, setLatestOptions] = useState<Record<string, ClipOption>>({});
  const [starterDismissed, setStarterDismissed] = useState(() => readStored(DISMISS_KEY, false));
  const [activeLeague, setActiveLeague] = useState<Timeline['stamp']['leagueId'] | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      const [list, lim, status, stamp] = await Promise.all([rpc<Doc[]>('list'), src<Limits>('limits'), src<RunStatus>('runStatus'), src<{ leagueId: Timeline['stamp']['leagueId'] }>('activeStamp')]);
      setActiveLeague(stamp.leagueId); putDocs(list); setLimits(lim); setCompeting(status.competing); setRunStatus(status);
      setState(shell.online ? undefined : 'offline');
    } catch { setState('error'); }
  }, [shell.online]);
  useEffect(() => { void reload(); }, [reload]);
  // The Resume card follows the live Run: another Run can replace it from elsewhere, so keep the status fresh while this area is mounted.
  useEffect(() => {
    // Only the small Run status is polled (documents are never replaced by the poll, so an open editor keeps its preview position; a Run of a timeline not in this list simply shows no Resume card).
    const refreshStatus = () => {
      void src<RunStatus>('runStatus').then(next => {
        setRunStatus(prev => JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
        setCompeting(next.competing);
      }, () => undefined);
    };
    const timer = setInterval(refreshStatus, 2000);
    addEventListener('focus', refreshStatus);
    return () => { clearInterval(timer); removeEventListener('focus', refreshStatus); };
  }, [reload]);
  const loadSources = useCallback(async (objectId?: string) => {
    try { setSources(await src<TimelineSourceRow[]>('sources')); setInsertions(await src<TimelineInsertion[]>('insertions', { objectId })); } catch { /* sources stay as they were */ }
  }, []);

  // Coming back to Timelines (for example after editing and saving a Build) asks main for fresh sources; a changed Build shows up as an offered update.
  useEffect(() => { if (shell.active && openId) void loadSources(openId); }, [shell.active]); // eslint-disable-line react-hooks/exhaustive-deps
  // Library Builds are frozen in the background by main; the picker refreshes when a new one is ready.
  useEffect(() => on('mastery:push:timeline-sources', () => { void loadSources(openId ?? undefined); }), [openId, loadSources]);

  const doc = docs.find(d => d.objectId === openId);
  useEffect(() => { if (openId) void loadSources(openId); }, [openId, loadSources]);

  // A newer revision of a clip's source (an edited library Build, a re-saved Atlas plan) is offered in the inspector as a preview only;
  // the clip itself keeps its pinned revision until the author applies the update.
  useEffect(() => {
    if (!doc || !limits) { setLatestOptions({}); return; }
    let live = true;
    void (async () => {
      const out: Record<string, ClipOption> = {};
      for (const clip of doc.payload.clips) {
        const option = clip.options.find(o => o.optionId === clip.selectedOptionId);
        const row = option && sources.find(r => r.source.ref.objectId === option.source.ref.objectId);
        if (!option || !row || row.source.ref.revisionId === option.source.ref.revisionId) continue;
        try {
          const made = await sourceClip(row.source, clip.laneId, limits, { clipId: clip.clipId, optionId: option.optionId, anchorId: doc.payload.firstMapAnchor?.anchorId ?? 'first-map' });
          if (made.options[0]) out[clip.clipId] = made.options[0];
        } catch { /* a source that cannot be re-adapted offers no update */ }
      }
      if (live) setLatestOptions(out);
    })();
    return () => { live = false; };
  }, [doc?.revision.revisionId, sources, limits]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cross-area intents.
  useEffect(() => {
    const intent = shell.intent;
    if (!intent) return;
    if (intent.kind === 'open-document') { setOpenId(intent.objectId); shell.clearIntent(); }
    else if (intent.kind === 'send-to-timeline') {
      shell.clearIntent();
      void (async () => {
        try {
          if (intent.transition && limits) {
            // The transition itself (removals before additions, as the diff panel wrote it) goes in as a note, not the whole plan.
            const snapshot = { kind: 'notes' as const, payload: { schemaVersion: 1 as const, title: `Transition: ${intent.transition.title}`.slice(0, 160), stamp: intent.transition.stamp,
              instructions: [{ firstAction: tr('mastery_TimelinesHost.atlas_transition'), details: [...intent.transition.text].slice(0, 10000).join(''), whenReady: '' }] } };
            const source = await pinSource({ objectId: parseId('object', crypto.randomUUID()), revisionId: parseId('revision', crypto.randomUUID()), payloadHash: await contentHash(snapshot), stamp: intent.transition.stamp }, snapshot, limits);
            await reload(); setSending({ source }); return;
          }
          const row = await src<TimelineSourceRow>('source', { objectId: intent.source.objectId }); await reload(); setSending({ source: row.source });
        }
        catch { shell.toast(tr('mastery_TimelinesHost.this_item_cannot_be_added')); }
      })();
    }
  }, [shell.intent]); // eslint-disable-line react-hooks/exhaustive-deps

  const replaceDoc = (next: Doc) => putDocs(all => all.some(d => d.objectId === next.objectId) ? all.map(d => d.objectId === next.objectId ? next : d) : [...all, next]);
  const refresh = async (objectId: string): Promise<Doc> => { const next = await rpc<Doc>('read', { objectId }); replaceDoc(next); return next; };
  const startRun = async (objectId: string, revisionId: string, extra: Record<string, unknown>) => {
    const result = await rpc<{ ready?: boolean; status?: string }>('run', { objectId, expectedRevisionId: revisionId, ...extra });
    // Only a real blocker (an unchosen alternative, a missing source, an empty timeline, a Run already open) opens the setup dialog.
    if (result && result.ready === false) { setRunOnOpen(objectId); setOpenId(objectId); return; }
    shell.toast(tr('mastery_TimelinesHost.run_started')); void reload();
  };

  const loadTrash = async () => { try { setTrashed((await rpc<Doc[]>('list', { includeTrash: true })).filter(d => d.trashedAt)); } catch { setDialogError(tr('mastery_TimelinesHost.could_not_load_recently_deleted')); } };
  const duplicate = async (d: Doc) => {
    const copy = structuredClone(d.payload);
    copy.title = copyTitle(copy.title, docs.map(x => x.payload.title));
    copy.stamp = { ...copy.stamp, createdAt: new Date().toISOString() };
    await rpc('save', { request: { objectId: crypto.randomUUID(), expectedRevisionId: null, payload: copy, stamp: copy.stamp, idempotencyKey: crypto.randomUUID() }, label: tr('mastery_TimelinesHost.duplicate_timeline') });
    await reload();
  };
  // Share = the pinned bundle as a .pom file text on the clipboard (Import reads the same format).
  const share = async (objectId: string) => {
    try {
      const text = await rpc<string>('export', { objectId });
      shell.toast(await shell.copyText(text) ? tr('mastery_TimelinesHost.timeline_bundle_copied_import_it') : tr('mastery_TimelinesHost.could_not_copy_the_timeline'));
    } catch (e) { shell.toast(failure(e)); }
  };
  const work = async (job: () => Promise<void>) => {
    setBusy(true); setDialogError(undefined);
    try { await job(); setDialog(null); } catch (e) { setDialogError(failure(e)); } finally { setBusy(false); }
  };

  const rows = docs.map(d => toRow(d, runStatus, activeLeague));
  const library: TimelineLibraryProps = {
    rows, state,
    onOpen: row => setOpenId(row.id),
    onRun: row => {
      if (row.resume) { void src('resumeRun', { objectId: row.id }).catch(e => { shell.toast(failure(e)); void reload(); }); return; }
      const d = docs.find(x => x.objectId === row.id); if (d) void startRun(d.objectId, d.revision.revisionId, {}).catch(e => shell.toast(failure(e))); },
    starterDismissed,
    onDismissStarter: () => { setStarterDismissed(true); writeStored(DISMISS_KEY, true); },
    onNew: () => { void rpc<{ revision: { objectId: string } }>('create', { idempotencyKey: crypto.randomUUID() }).then(async created => { await reload(); setOpenId(created.revision.objectId); }).catch(e => shell.toast(failure(e))); },
    onImport: () => importRef.current?.click(),
    onAction: (row, action) => {
      const d = docs.find(x => x.objectId === row.id); if (!d) return;
      setDialogError(undefined);
      if (action === 'delete') setDialog({ k: 'delete', id: d.objectId });
      else if (action === 'rename') setDialog({ k: 'rename', id: d.objectId });
      else if (action === 'duplicate') void duplicate(d).catch(e => shell.toast(failure(e)));
      else if (action === 'share') void share(d.objectId);
      else if (action === 'publish') shell.go('marketplace', { kind: 'publish', source: { kind: 'timeline', objectId: d.objectId } });
    },
    onArchive: () => undefined,
    onStarter: () => setDialog({ k: 'starter' }),
    onTrash: () => { setDialogError(undefined); void loadTrash(); setDialog({ k: 'trash' }); },
    onRetry: () => { setState('loading'); void reload(); },
  };

  const live = () => (doc && docsRef.current.find(d => d.objectId === doc.objectId)) || doc!;
  const editor: TimelineEditorProps | undefined = doc && limits ? {
    timeline: doc.payload, sources, limits, revision: { objectId: doc.objectId, revisionId: doc.revision.revisionId, payloadHash: doc.revision.payloadHash, stamp: doc.revision.stamp, fallbackSnapshotHash: doc.revision.payloadHash },
    offline: !shell.online, timelineSources: insertions, runContext: { competingRun: competing },
    onPersist: async (timeline, label) => {
      await rpc('save', { request: { objectId: doc.objectId, expectedRevisionId: live().revision.revisionId, payload: timeline, stamp: timeline.stamp, idempotencyKey: crypto.randomUUID() }, label });
      await refresh(doc.objectId);
    },
    onRun: async (result, replaceCurrent) => {
      const manual = result.start.mode === 'manual' ? { level: result.start.level, atlasPoints: result.start.atlasPoints.status === 'known' ? result.start.atlasPoints.value : null } : undefined;
      await startRun(doc.objectId, live().revision.revisionId, { omittedClipIds: result.omittedClipIds, replaceCurrent, ...(manual ? { manualStart: manual } : {}) });
    },
    onUndo: async () => { await rpc('undo', { objectId: doc.objectId, expectedRevisionId: live().revision.revisionId }); return (await refresh(doc.objectId)).payload; },
    onRedo: async () => { await rpc('redo', { objectId: doc.objectId, expectedRevisionId: live().revision.revisionId }); return (await refresh(doc.objectId)).payload; },
    onBack: () => { setOpenId(null); setRunOnOpen(null); void reload(); },
    runOnOpen: runOnOpen === doc.objectId,
    latestOptions, keptRevisions: kept,
    onKeepRevision: (clipId, revisionId) => { const next = { ...kept, [clipId]: revisionId }; setKept(next); writeStored(KEPT_KEY, next); },
    onShare: () => { void share(doc.objectId); },
    onOpenSource: source => {
      const kind = source.fallbackSnapshot.kind, id = source.ref.objectId;
      if (kind === 'atlas') shell.go('atlas', { kind: 'open-document', objectId: id, revisionId: source.ref.revisionId });
      else if (kind === 'filter') shell.go('filter');
      else if (kind === 'build') shell.go('build');
      else shell.toast(tr('mastery_TimelinesHost.notes_open_inside_the_timeline'));
    },
    onBrowse: () => shell.go('marketplace', { kind: 'marketplace-view', view: 'feed' }),
    onPublish: timeline => { void timeline; shell.go('marketplace', { kind: 'publish', source: { kind: 'timeline', objectId: doc.objectId } }); },
  } : undefined;

  const onAdd = async (input: { timelineId: string | null; newTitle: string; laneId: LaneId | null; range: { start: number; endExclusive: number }; openAfterAdding: boolean; choice?: CollisionChoice }) => {
    if (!sending) return;
    let target: Doc;
    if (input.timelineId) target = await refresh(input.timelineId);
    else {
      const created = await rpc<{ revision: { objectId: string } }>('create', { title: input.newTitle, idempotencyKey: crypto.randomUUID() });
      target = await refresh(created.revision.objectId);
    }
    const kind = sending.source.fallbackSnapshot.kind;
    const laneId = input.laneId ?? target.payload.lanes.find(l => l.type === kind)?.laneId;
    if (!laneId) throw new Error(tr('mastery_TimelinesHost_2.no_compatible_lane'));
    const result = await rpc<{ status: string; clips?: unknown[] }>('send', { objectId: target.objectId, expectedRevisionId: target.revision.revisionId, source: sending.source,
      laneId, range: input.range, choice: input.choice, idempotencyKey: crypto.randomUUID() });
    if (result.status === 'collision') { setSendCollision(tr('mastery_TimelinesHost.length_existing_clip_s', { value: result.clips?.length ?? 1 })); throw new Error('Collision'); }
    if (result.status !== 'applied') return;
    setSendCollision(undefined); setSending(null); await reload();
    shell.toast(tr('mastery_TimelinesHost.added_to_title', { title: target.payload.title }));
    if (input.openAfterAdding) setOpenId(target.objectId);
  };

  return <>
    <TimelineArea library={library} editor={editor} objectKey={openId ?? undefined} />
    <input ref={importRef} type="file" accept=".json,.txt,application/json" hidden onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file) return;
      try { await rpc('import', { text: await file.text(), idempotencyKey: crypto.randomUUID() }); await reload(); shell.toast(tr('mastery_TimelinesHost.timeline_imported')); }
      catch (e) { shell.toast(failure(e)); }
    }} />
    {dialog?.k === 'rename' && (() => { const d = docs.find(x => x.objectId === dialog.id); return d ? <NameDialog mode="rename" name={d.payload.title} busy={busy} safeError={dialogError} onClose={() => setDialog(null)}
      onSubmit={title => void work(async () => { await rpc('save', { request: { objectId: d.objectId, expectedRevisionId: d.revision.revisionId, payload: { ...d.payload, title }, stamp: d.payload.stamp, idempotencyKey: crypto.randomUUID() }, label: tr('mastery_TimelinesHost.rename_timeline') }); await reload(); })} /> : null; })()}
    {dialog?.k === 'delete' && (() => { const d = docs.find(x => x.objectId === dialog.id); return d ? <DeleteDialog item={{ objectId: parseId('object', d.objectId), title: d.payload.title }} busy={busy} safeError={dialogError} onClose={() => setDialog(null)}
      onDelete={() => void work(async () => { await rpc('trash', { objectId: d.objectId, expectedRevisionId: d.revision.revisionId }); await reload(); })} /> : null; })()}
    {dialog?.k === 'trash' && <Dialog title={tr('mastery_TimelinesHost.recently_deleted')} size="large" onCancel={() => setDialog(null)} cancelLabel={tr('mastery_TimelinesHost.close')} confirmLabel={null}>
      {!trashed.length && <p>{tr('mastery_TimelinesHost.no_recently_deleted_timelines')}</p>}
      {trashed.map(d => <div className="timeline-trash-row" key={d.objectId}><span>{tr('mastery_TimelinesHost.title_deleted', { title: d.payload.title })} {d.trashedAt ? new Date(d.trashedAt).toLocaleString() : ''}</span>
        <button type="button" className="btn" disabled={busy} onClick={() => { setBusy(true); setDialogError(undefined); void rpc('restoreTrash', { objectId: d.objectId }).then(async () => { await reload(); await loadTrash(); }).catch(e => setDialogError(failure(e))).finally(() => setBusy(false)); }}>{tr('mastery_TimelinesHost.restore')}</button></div>)}
      {dialogError && <p role="alert">{dialogError}</p>}
    </Dialog>}
    {dialog?.k === 'starter' && <StarterOverlay onClose={() => setDialog(null)}>
      <StarterChooser onFollow={async id => { setDialog(null); await shell.followStarter?.(id); }}
        onNewBuild={() => { setDialog(null); shell.go('build'); window.dispatchEvent(new Event('pom:new-build')); }}
        onImportBuild={() => { setDialog(null); window.dispatchEvent(new Event('pom:open-import')); }} onImportTimeline={() => { setDialog(null); importRef.current?.click(); }}
        onOpenBuilds={() => { setDialog(null); shell.go('build'); }} onCreateTimeline={() => { setDialog(null); library.onNew(); }} onBrowse={() => { setDialog(null); shell.go('marketplace', { kind: 'marketplace-view', view: 'feed' }); }} />
    </StarterOverlay>}
    {sending && <SendToTimeline source={sending.source} destinations={rows.map(r => ({ id: r.id, timeline: r.timeline, lastUsed: r.lastUsed, activeLeague: r.activeLeague }))}
      suggestedRange={{ start: 1, endExclusive: 101 }} preferences={prefs} onPreferences={setPrefs} onAdd={onAdd} collision={sendCollision}
      onCancel={() => { setSending(null); setSendCollision(undefined); }} />}
  </>;
}

/** The league-start chooser over the Timelines library; Escape or Close returns to the library. */
function StarterOverlay({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', esc, true);
    return () => document.removeEventListener('keydown', esc, true);
  }, [onClose]);
  return <div ref={ref} className="timeline-starter-overlay" role="dialog" aria-label={tr('mastery_TimelinesHost.pick_a_league_start')} tabIndex={-1}>
    <div className="timeline-starter-bar"><button type="button" className="btn" onClick={onClose}>{tr('mastery_TimelinesHost.back_to_timelines')}</button></div>
    {children}
  </div>;
}
