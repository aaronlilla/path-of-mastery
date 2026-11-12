import { Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { parseId, type AtlasPlan, type AtlasStep, type LeagueStamp, type ObjectId, type StepId } from '@pom/mastery-contracts';
import { Dialog, PortalMenu, Segmented, Select, Switch } from '../ui.js';
import { ItemCard } from '../documents/ItemCard.js';
import { NameDialog, MoveDialog, DeleteDialog, CopyLeagueDialog } from '../documents/LifecycleDialogs.js';
import { RecoveryDialog, ConflictDialog, UnsavedCloseDialog } from '../documents/RecoveryDialogs.js';
import { DocumentStatus } from '../documents/DocumentStatus.js';
import { setCloseBlock, setRestartSaver } from '../closeGuard.js';
import { knownLabel, type Art, type Compatibility, type ConflictChoice, type LifecycleAction, type SyncState, type VersionPreview } from '../documents/model.js';
import { AtlasCanvasView } from './canvas/AtlasCanvasView.js';
import type { ArtResolver } from './canvas/art.js';
import { dataLabel, overlayFor } from './canvas/model.js';
import { createPlan } from '../../shared/atlas/plan.js';
import { smartRoute, type SmartMark } from '../../shared/atlas/smartPath.js';
import { encodeOfficialAtlasLink } from '../../shared/atlas/codecs/external.js';
import { GameName, PracticalPanel, type EditorArt } from './editor/PracticalPanel.js';
import { changeTreeData, dataChangePreview } from './editor/dataChange.js';
import type { AtlasGraph } from '../../shared/atlas/graph.js';
import { StepManager } from './editor/StepManager.js';
import { StepDiff, ComparePlans } from './editor/Analysis.js';
import { EditHistory } from './editor/EditHistory.js';
import { ImportAtlas, ExportAtlas } from './editor/ImportExport.js';
import { inFolder, pointSummary, sorts, stepIds, stepTitle, uniqueTitle } from './editor/presenter.js';
import { AtlasEditorSession, type AvailableData, type EditorRecord } from './editor/session.js';
import { isTextTarget } from '../shell/useShortcuts.js';
import { QuickPlan, type QuickMechanic } from './quick/QuickPlan.js';
import { ATLAS_MECHANICS } from '../../shared/leagueContent.js';
import { buildUntouched, type QuickRequest, type QuickSummary } from './quick/quickBuild.js';
const NO_MARKS: ReadonlyMap<string, SmartMark> = new Map();
const QUICK_BUSY = tr('atlas_AtlasArea.available_when_quick_plan_has');
import './editor/editor.css';
import { fromMain, tr, inLanguage } from '../i18n';

type Modal = 'quick' | 'import' | 'export' | 'data' | 'tree-data' | 'rename' | 'move' | 'delete' | 'folder' | 'trash' | 'recovery' | 'draft-preview' | 'copy' | 'conflict' | 'close' | null;
export type TreePreview = { objectId: string; stepId: string; baseIds: readonly string[]; afterIds: readonly string[]; onDiscard: () => void };
export type AtlasAreaProps = {
  session: AtlasEditorSession; data: AvailableData[]; activeStamp: LeagueStamp; online: boolean; signedIn: boolean; sync?: SyncState;
  folders?: { id: string; title: string }[]; art?: EditorArt; nodeArt?: ArtResolver;
  /** Called after a folder is created so the host reloads the folder list (breadcrumb and Move to folder). */
  onFoldersChanged?: () => void | Promise<void>;
  marketplace?: ReactNode; onBrowse?: () => void; onArchive?: () => void; onSignIn?: () => void;
  onSend?: (record: EditorRecord, plan: AtlasPlan, transition?: string) => void; onPublish?: (record: EditorRecord) => void;
  onOpenBuilds?: (input: string) => void; onOptimizer?: (session: AtlasEditorSession) => void; onPlanWithAi?: () => void;
  onAccountHistory?: (record: EditorRecord) => void;
  suggestions?: { count: number; open: () => void; isOpen?: boolean }; optimizer?: ReactNode;
  /** An optimizer or suggestion result drawn as a ghost on the main tree (only on its own step), and the Apply bar the
   * side column keeps pinned to its bottom edge while that result is open. */
  treePreview?: TreePreview | null; sideFooter?: ReactNode; panelOpen?: boolean;
  copyLeague?: { compatibility: Compatibility; run: (source: EditorRecord, title: string, mode: 'source_data' | 'target_data') => Promise<EditorRecord> };
  conflict?: { local: VersionPreview; account: VersionPreview; preview: (choice: 'this_pc' | 'account') => Promise<EditorRecord>; resolve: (choice: ConflictChoice) => Promise<EditorRecord> };
  cachedShare?: { revisionId: string; url: string }; copyText?: (text: string) => Promise<boolean>;
  graphForData?: (data: AvailableData) => Promise<AtlasGraph>;
  cloudObjectIds?: readonly string[]; mechanicsForStep?: (record: EditorRecord, step: AtlasStep) => Art[];
  /** Marketplace "Compare with my plan": open Compare with this plan on the right and the person's own plan on the left. */
  compareRequest?: { rightId: string; nonce: number } | null; onCompareProblem?: (text: string) => void;
  /** Quick plan (New plan): the mechanics to pick from and the one-button build that fills the new plan's tree. */
  quickMechanics?: QuickMechanic[]; quickBuild?: (request: QuickRequest) => Promise<QuickSummary | null>;
  /** Shown after a link or code is copied. */
  onCopied?: (what: string) => void;
};
export function AtlasArea(props: AtlasAreaProps) {
  const { session } = props, state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const [modal, setModal] = useState<Modal>(null), [item, setItem] = useState<EditorRecord | null>(null), [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [safeError, setSafeError] = useState(''), [dataIndex, setDataIndex] = useState('0'), [newTitle, setNewTitle] = useState(false);
  const [menu, setMenu] = useState<'share' | 'more' | 'step' | null>(null), [practicalOpen, setPracticalOpen] = useState(false), [railShown, setRailShown] = useState(false), [highlight, setHighlight] = useState<string[]>([]);
  const [conflictPreview, setConflictPreview] = useState<EditorRecord | null>(null);
  const [selectedCards, setSelectedCards] = useState<string[]>([]), [libraryCompare, setLibraryCompare] = useState<EditorRecord | null>(null), [compareRight, setCompareRight] = useState<EditorRecord | null>(null);
  const [targetGraph, setTargetGraph] = useState<AtlasGraph | null>(null), [removedIds, setRemovedIds] = useState<string[]>([]), [acceptEffects, setAcceptEffects] = useState(false);
  const shareButton = useRef<HTMLButtonElement>(null), moreButton = useRef<HTMLButtonElement>(null), stepButton = useRef<HTMLButtonElement>(null), title = useRef<HTMLInputElement>(null), library = useRef<HTMLInputElement>(null), strip = useRef<HTMLDivElement>(null);
  const importStepId = useRef(session.stepId());
  const [quickBusy, setQuickBusy] = useState(false), [quickError, setQuickError] = useState(''), [quickSummary, setQuickSummary] = useState<QuickSummary | 'building' | null>(null), [quickFor, setQuickFor] = useState<string | null>(null);
  // Quick plan uses the one optimizer the panels share: while it builds, the panels that would take it over stay shut.
  const quickBuilding = quickSummary === 'building';
  const [pasted, setPasted] = useState('');
  // Quick plan builds on the tree data a new plan gets without asking: the current data, else the first listed.
  const quickData = props.data.find(d => d.active) ?? props.data[0];
  const current = state.record, plan = state.plan, shownRecord = state.preview ?? current, shownPlan = state.preview?.view.document.payload ?? plan;
  const selected = shownPlan && (state.selected && shownPlan.stepsById[state.selected] ? state.selected : stepIds(shownPlan)[0]);
  const step = selected && shownPlan?.stepsById[selected], readOnly = !!state.preview || state.previewLoading || current?.ownership === 'saved';
  // A result previews on the main tree only on the step it was computed for, and never over a history preview.
  // Same plan (a copy keeps step ids, so the step alone is not enough) and same step; never over a history preview.
  const treePreview = props.treePreview && step && current && props.treePreview.objectId === current.source.objectId && props.treePreview.stepId === step.stepId && !state.preview ? props.treePreview : null;
  // Smart pathing: wanted/avoided marks per plan step live for the session; every click re-routes the tree as one edit.
  const [smart, setSmart] = useState(true), markStore = useRef(new Map<string, ReadonlyMap<string, SmartMark>>()), [, setMarkTick] = useState(0);
  const markKey = current && step ? `${current.source.objectId}:${step.stepId}` : '', stepMarks = markStore.current.get(markKey) ?? NO_MARKS;
  const smartClick = (nodeId: string, clear: boolean) => {
    const model = shownRecord?.canvas;
    if (!smart || !step || !model || readOnly || treePreview) return;
    const before = stepMarks.get(nodeId), after: SmartMark | undefined = clear ? undefined : before === undefined ? 'want' : before === 'want' ? 'avoid' : undefined;
    if (after === before) return;
    const marks = new Map(stepMarks);
    if (after) marks.set(nodeId, after); else marks.delete(nodeId);
    const wanted = [...marks].filter(([, m]) => m === 'want').map(([id]) => id), avoided = new Set([...marks].filter(([, m]) => m === 'avoid').map(([id]) => id));
    const plain = (id: string) => { const t = model.nodes[model.denseById.get(id) ?? -1]?.type; return t !== 'Notable' && t !== 'Keystone' && t !== 'Mastery' && t !== 'Wormhole'; };
    const route = smartRoute(model.graph.adjacent, model.graph.rootId, wanted, avoided, step.allocatedIds, plain);
    if (route.unreachableId) {
      const name = model.nodes[model.denseById.get(route.unreachableId) ?? -1]?.name ?? tr('atlas_AtlasArea.that_node');
      setUndoNote(tr('atlas_AtlasArea.name_can_t_be_reached', { name })); return;
    }
    const same = route.ids.length === step.allocatedIds.length && route.ids.every(id => step.allocatedIds.includes(id));
    if (!same) session.edit({ kind: 'allocation', stepId: step.stepId, beforeIds: [...step.allocatedIds], afterIds: route.ids, datasetHash: model.scope.datasetHash });
    markStore.current.set(markKey, marks); setMarkTick(v => v + 1);
  };
  // The Quick plan summary belongs to the plan it built: leaving that plan dismisses it.
  useEffect(() => { if (quickSummary && quickSummary !== 'building' && current?.source.objectId !== quickSummary.objectId) setQuickSummary(null); }, [current?.source.objectId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Opening a side panel (optimizer, Plan with AI) or a result's Apply bar moves on from the build: the summary steps
  // aside so the panel and its Apply keep the room, down to the 800x600 minimum.
  const sideOpen = !!props.panelOpen || !!props.sideFooter;
  useEffect(() => { if (sideOpen && quickSummary && quickSummary !== 'building') setQuickSummary(null); }, [sideOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void session.refresh(); return () => { session.flushText(); session.returnCurrent(); }; }, [session]);
  // Below 1024px the side column is an overlay: Suggestions shows there only after the player asks for it, and its X
  // hides the overlay again.
  useEffect(() => { if (props.suggestions?.isOpen === false) setRailShown(false); }, [props.suggestions?.isOpen]);
  const sideRef = useRef<HTMLDivElement>(null), sidePanel = useRef('');
  // A newly opened side panel (optimizer, notables, Plan with AI) starts at its top, not at the last scroll position.
  useLayoutEffect(() => {
    const label = sideRef.current?.querySelector('.atlas-side-optimizer section')?.getAttribute('aria-label') ?? '';
    if (label !== sidePanel.current) { sidePanel.current = label; if (label) sideRef.current?.scrollTo({ top: 0 }); }
  });
  const areaRef = useRef<HTMLElement>(null), findState = useRef({ blocked: false, open: false });
  findState.current = { blocked: !!(modal || state.panel || menu || libraryCompare), open: !!current };
  // Undo / redo with a visible result: the status line names the history entry that was undone or redone.
  const [undoNote, setUndoNote] = useState('');
  useEffect(() => { if (!undoNote) return; const t = setTimeout(() => setUndoNote(''), 6000); return () => clearTimeout(t); }, [undoNote]);
  const historyKey = async (kind: 'undo' | 'redo') => {
    await session.flush();
    const h = session.state.record?.history;
    if (!h || (kind === 'undo' ? !session.canUndo : !session.canRedo)) { setUndoNote(kind === 'undo' ? tr('atlas_AtlasArea.nothing_to_undo') : tr('atlas_AtlasArea.nothing_to_redo')); return; }
    // Redo follows the branch that leads to the tip: walk back from the tip to the entry whose parent is the cursor.
    let next = h.events.find(e => e.transactionId === h.tip);
    while (next && next.parentTransactionId !== h.cursor) { const parent = next.parentTransactionId; next = h.events.find(e => e.transactionId === parent); }
    const label = fromMain('ml_atlas_history', (kind === 'undo' ? h.events.find(e => e.transactionId === h.cursor)?.label : next?.label) ?? '') || undefined;
    await session.historyAction(kind);
    if (session.state.record?.history.cursor !== h.cursor) setUndoNote(`${kind === 'undo' ? tr('atlas_AtlasArea_2.undid') : tr('atlas_AtlasArea_2.redid')}: ${label ?? tr('atlas_AtlasArea_2.last_change')}. ${kind === 'undo' ? tr('atlas_AtlasArea_2.ctrl_y_redoes_it') : tr('atlas_AtlasArea_2.ctrl_z_undoes_it')}`);
  };
  const historyRef = useRef(historyKey); historyRef.current = historyKey;
  useEffect(() => {
    // Area shortcuts: while Atlas is the visible area, Ctrl+F from anywhere outside it (the top-bar button just clicked, a heading,
    // empty space) goes to its search, and Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z undo and redo the open plan (focus can be on the page
    // body after a dialog closes or a clicked control unmounts). Inside the area the section's onKeyDown handles them; text fields
    // keep their own Ctrl+F and Ctrl+Z.
    const onKey = (event: KeyboardEvent) => {
      const area = areaRef.current, target = event.target as HTMLElement | null, key = event.key.toLowerCase();
      if (!area || !(event.ctrlKey || event.metaKey) || event.altKey || event.defaultPrevented) return;
      const find = key === 'f' && !event.shiftKey, undo = key === 'z' || key === 'y' && !event.shiftKey;
      if (!find && !undo) return;
      if (!area.getClientRects().length || findState.current.blocked || area.contains(target) || document.querySelector('[role="dialog"]')) return;
      if (isTextTarget(target)) return;
      if (undo) { if (!findState.current.open) return; event.preventDefault(); void historyRef.current(key === 'y' || event.shiftKey ? 'redo' : 'undo'); return; }
      event.preventDefault();
      if (findState.current.open) area.querySelector<HTMLInputElement>('input[aria-label="Search nodes"]')?.focus(); else library.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  // Restart to update: the plan's pending edits are written first; a failed save opens the Save failed dialog and stops the restart.
  useEffect(() => {
    setRestartSaver('atlas', async () => { await session.flush(); if (session.state.save === 'failed') { setModal('recovery'); return false; } return true; });
    return () => setRestartSaver('atlas', null);
  }, [session]);
  useEffect(() => { if (newTitle && title.current) { title.current.focus(); title.current.select(); setNewTitle(false); } }, [newTitle, current]);
  useEffect(() => { strip.current?.querySelector<HTMLElement>('[aria-current="step"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [selected]);
  useEffect(() => { if (current?.recovery) setModal('recovery'); }, [current?.source.objectId]);
  // A failed save blocks closing the app: the player picks Export recovery file, Keep app open or Close without latest changes.
  useEffect(() => {
    if (state.save !== 'failed') return;
    setCloseBlock('atlas', { title: tr('atlas_AtlasArea.your_latest_changes_are_not'), subtitle: '', body: '', confirmLabel: tr('atlas_AtlasArea.close_without_latest_changes'), ask: () => setModal('close') });
    return () => setCloseBlock('atlas', null);
  }, [state.save]);
  useEffect(() => {
    const request = props.compareRequest;
    if (!request) return;
    let live = true;
    void (async () => {
      try {
        await session.refresh();
        const own = session.state.record?.ownership === 'owned' ? session.state.record
          : [...session.state.library].filter(r => !r.deletedAt && r.ownership === 'owned' && r.source.objectId !== request.rightId).sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))[0];
        if (!own) { props.onCompareProblem?.(tr('atlas_AtlasArea.make_or_open_an_atlas')); return; }
        const [left, right] = await Promise.all([session.port.read(own.source.objectId), session.port.read(request.rightId as never)]);
        if (!live) return;
        setCompareRight(right); setLibraryCompare(left);
      } catch { props.onCompareProblem?.(tr('atlas_AtlasArea.could_not_open_the_comparison')); }
    })();
    return () => { live = false; };
  }, [props.compareRequest?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const copyBase = props.copyText ?? (async (text: string) => { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } });
  const copy = async (text: string) => { const ok = await copyBase(text); if (ok) props.onCopied?.(/^https?:[/][/]/.test(text) ? tr('atlas_AtlasArea.link_copied') : tr('atlas_AtlasArea_2.copied')); return ok; };
  // Ctrl+V on the library (not in a text field): open Import with the pasted link or code.
  const pasteState = useRef({ library: false });
  pasteState.current.library = !current && !modal && !libraryCompare;
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const area = areaRef.current, target = event.target as HTMLElement | null;
      if (!area || !area.getClientRects().length || !pasteState.current.library || document.querySelector('[role="dialog"]')) return;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
      const text = event.clipboardData?.getData('text/plain')?.trim() ?? '';
      if (!text) return;
      event.preventDefault(); setPasted(text); setModal('import');
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);
  const openExport = async (record?: EditorRecord) => { await session.flush(); if (session.state.save === 'failed') { setModal('recovery'); return; } setItem(record ?? null); setModal('export'); };
  const close = () => { setModal(null); setSafeError(''); setItem(null); setPasted(''); };
  const work = async (fn: () => Promise<void>, closeAfter = true) => {
    setBusy(true); setSafeError(''); try { await fn(); if (closeAfter) close(); } catch { setSafeError(tr('atlas_AtlasArea.could_not_complete_this_action')); } finally { setBusy(false); }
  };
  const newPlan = async (data?: AvailableData) => {
    const choices = props.data.filter(d => d.active && d.qualified);
    const choice = data ?? (choices.length === 1 ? choices[0] : null);
    if (!choice) { setDataIndex('0'); setModal('data'); return; }
    const fresh = createPlan(choice.dataset, { ...structuredClone(data ? choice.stamp : props.activeStamp), createdAt: new Date().toISOString() }, session.stepId(), choice.budget, uniqueTitle(tr('atlas_AtlasArea.untitled_atlas_plan'), state.library.filter(r => !r.deletedAt).map(r => r.view.document.payload.title)));
    await session.create(fresh); if (session.state.record && session.state.save === 'saved') setNewTitle(true); close();
  };
  // New plan opens Quick plan when there is tree data to build on; with none, the old flow explains what is missing.
  const openNew = () => { if (props.quickBuild && quickData) { setQuickError(''); setModal('quick'); } else void newPlan(); };
  const createNamed = async (name: string, points: number): Promise<boolean> => {
    if (!quickData) return false;
    const titles = state.library.filter(r => !r.deletedAt).map(r => r.view.document.payload.title);
    const fresh = createPlan(quickData.dataset, { ...structuredClone(props.activeStamp), createdAt: new Date().toISOString() }, session.stepId(), points, uniqueTitle(name, titles));
    await session.create(fresh);
    return !!session.state.record && session.state.record.view.document.payload.title === fresh.title && session.state.save !== 'failed';
  };
  const quickBuild = async (request: QuickRequest) => {
    setQuickBusy(true); setQuickError('');
    try {
      if (!await createNamed(request.name, request.points)) { setQuickError(tr('atlas_AtlasArea.could_not_create_this_plan')); return; }
      const objectId = session.state.record!.source.objectId;
      close(); setQuickFor(objectId); setQuickSummary('building');
      const summary = await props.quickBuild!(request);
      setQuickSummary(summary ?? { objectId, undo: null, rows: [], spent: [], cost: 0, budget: request.points, left: request.points, error: tr('atlas_AtlasArea.could_not_build_the_tree') });
    } catch { setQuickSummary(null); setQuickError(tr('atlas_AtlasArea.could_not_build_this_tree')); }
    finally { setQuickBusy(false); }
  };
  const quickBlank = async (name: string, points: number) => {
    setQuickBusy(true); setQuickError('');
    try { if (await createNamed(name, points)) close(); else setQuickError(tr('atlas_AtlasArea.could_not_create_this_plan')); } finally { setQuickBusy(false); }
  };
  const action = async (record: EditorRecord, name: LifecycleAction) => {
    if (name === 'duplicate') { const duplicate = structuredClone(record.view.document.payload); duplicate.title = uniqueTitle(tr('atlas_AtlasArea_2.copy', { slice: [...duplicate.title].slice(0, 115).join('') }), state.library.filter(r => !r.deletedAt).map(r => r.view.document.payload.title)); duplicate.stamp.createdAt = new Date().toISOString(); await session.create(duplicate, tr('atlas_AtlasArea.copy_source_revision_revisionid', { revisionId: record.source.revisionId })); return; }
    if (name === 'send') { props.onSend?.(record, record.view.document.payload); return; }
    if (name === 'publish') { props.onPublish?.(record); return; }
    if (name === 'edit_history') { await session.open(record.source.objectId); session.update({ panel: 'history' }); return; }
    if (name === 'account_history') { props.onAccountHistory?.(record); return; }
    if (name === 'share') { await openExport(record); return; }
    setItem(record); setModal(({ rename: 'rename', move: 'move', delete: 'delete', copy_league: 'copy' } as const)[name as 'rename'] ?? null);
  };
  // Card menu lists only actions this host can run (send/publish/history/copy are absent when parked or not wired).
  const cardActions: LifecycleAction[] = ['duplicate', 'rename', 'move', 'edit_history', 'share', 'delete', ...(props.onAccountHistory ? ['account_history' as const] : []), ...(props.onSend ? ['send' as const] : []), ...(props.onPublish ? ['publish' as const] : []), ...(props.copyLeague ? ['copy_league' as const] : [])];
  const adjacentStep = (direction: number) => { if (!plan || !state.selected) return undefined; const ids = stepIds(plan); return ids[ids.indexOf(state.selected) + direction]; };
  const selectAdjacent = (direction: number) => { const id = adjacentStep(direction); if (id) session.select(id); };
  const showPanel = async (panel: 'steps' | 'diff' | 'compare' | 'history') => { await session.flush(); setMenu(null); if (session.state.save === 'failed') { setModal('recovery'); return; } session.returnCurrent(); session.update({ panel }); };
  const keyboard = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || modal || state.panel || menu || libraryCompare) return;
    // Only real text entry keeps its own keys: a focused checkbox, radio, slider or button still gets the Atlas shortcuts.
    const target = event.target as HTMLElement, text = isTextTarget(target);
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && event.key.toLowerCase() === 'i') { event.preventDefault(); setModal('import'); return; }
    if (ctrl && event.shiftKey && event.key.toLowerCase() === 'e' && current) { event.preventDefault(); void openExport(); return; }
    if (ctrl && event.shiftKey && event.key.toLowerCase() === 'n') { event.preventDefault(); openNew(); return; }
    if (ctrl && event.key.toLowerCase() === 'f') { event.preventDefault(); if (current) event.currentTarget.querySelector<HTMLInputElement>('input[aria-label="Search nodes"]')?.focus(); else library.current?.focus(); return; }
    if (ctrl && event.key.toLowerCase() === 's' && !text) { event.preventDefault(); if (event.shiftKey && current) void action(current, 'duplicate'); else void session.flush(); return; }
    if (text) return;
    if (ctrl && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); void historyKey(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo'); return; }
    if (event.key === 'Escape' && practicalOpen) { event.preventDefault(); setPracticalOpen(false); }
    if (target.closest('.atlas-steps-strip')) {
      if (ctrl && event.key === 'Tab' || event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); selectAdjacent(event.shiftKey || event.key === 'ArrowUp' ? -1 : 1); }
      if (!ctrl && !event.altKey && /^[1-4]$/.test(event.key)) { event.preventDefault(); session.update({ tab: (['Stats', 'Maps', 'Scarabs', 'Notes'] as const)[Number(event.key) - 1]! }); }
      if (ATLAS_MECHANICS && !ctrl && !event.altKey && event.key.toLowerCase() === 'a' && !quickBuilding) props.onOptimizer?.(session);
    }
  };
  const libraryRecords = state.library.filter(record => {
    const league = record.view.document.payload.stamp.leagueId, active = props.activeStamp.leagueId;
    const old = league.status === 'known' && active.status === 'known' && league.value !== active.value;
    return !record.deletedAt && (state.libraryTab === 'Saved' ? record.ownership === 'saved' : record.ownership === 'owned' && (state.libraryTab === 'Old leagues' ? old : !old)) && inFolder(record.folderId, folder) && record.view.document.payload.title.toLowerCase().includes(state.query.toLowerCase());
  }).sort((a, b) => {
    const group = Number(props.cloudObjectIds?.includes(b.source.objectId) ?? false) - Number(props.cloudObjectIds?.includes(a.source.objectId) ?? false); if (group) return group;
    const x = a.view.document.payload, y = b.view.document.payload;
    return state.sort === 'Name' ? x.title.localeCompare(y.title) : state.sort === 'League' ? knownLabel(x.stamp.leagueId).localeCompare(knownLabel(y.stamp.leagueId)) : (state.sort === 'Created' ? y.stamp.createdAt.localeCompare(x.stamp.createdAt) : state.sort === 'Last opened' ? b.lastOpenedAt.localeCompare(a.lastOpenedAt) : (b.history.events.at(-1)?.createdAt ?? y.stamp.createdAt).localeCompare(a.history.events.at(-1)?.createdAt ?? x.stamp.createdAt));
  });
  const targetItem = item ?? current;
  const sharePlan = item?.view.document.payload ?? plan;
  const snapshot = targetItem && sharePlan ? { document: { kind: 'atlas' as const, payload: sharePlan }, source: targetItem.source } : null;
  const sourceLabel = shownPlan?.dataset.datasetId ?? tr('atlas_AtlasArea_2.unknown');
  const old = plan && plan.stamp.leagueId.status === 'known' && props.activeStamp.leagueId.status === 'known' && plan.stamp.leagueId.value !== props.activeStamp.leagueId.value;
  const treeLink = step ? encodeOfficialAtlasLink(step.allocatedIds) : null;
  return <section ref={areaRef} className="atlas-editor-area" data-open={current && shownPlan && step ? 'plan' : 'library'} aria-label={tr('atlas_AtlasArea.atlas')} onKeyDown={keyboard}>
    {!props.online && <p className="atlas-state-banner">{state.save === 'failed' ? tr('atlas_AtlasArea.offline_your_latest_changes_are') : tr('atlas_AtlasArea.offline_local_changes_are_saved')}</p>}
    {(state.loading || state.previewLoading) && <div className="atlas-loading" role="status">{tr('atlas_AtlasArea.updating')}</div>}
    {!current ? <>
      <header className="atlas-area-header"><h1>{state.libraryTab === 'Old leagues' ? tr('atlas_AtlasArea.old_leagues') : tr('atlas_AtlasArea.atlas_plans')}</h1><div className="atlas-row-actions"><button type="button" className="btn" onClick={() => { props.onArchive?.(); session.update({ libraryTab: 'Old leagues' }); }}>{tr('atlas_AtlasArea.archive')}</button><button type="button" className="btn" onClick={() => setModal('import')}>{tr('atlas_AtlasArea.import')}</button><button type="button" className={libraryRecords.length ? 'btn atlas-primary' : 'btn'} onClick={openNew}>{tr('atlas_AtlasArea.new_plan')}</button></div></header>
      <div className="atlas-library-toolbar"><Segmented ariaLabel={tr('atlas_AtlasArea.atlas_libraries')} value={state.libraryTab} onChange={libraryTab => session.update({ libraryTab })} options={(['My plans', 'Saved', 'Old leagues'] as const).map(value => ({ value, label: inLanguage('h_atlasA_L', value) }))} /><input ref={library} className="field" aria-label={tr('atlas_AtlasArea.search_atlas_plans')} placeholder={tr('atlas_AtlasArea.search_atlas_plans_2')} value={state.query} onChange={e => session.update({ query: e.target.value })} /><Select ariaLabel={tr('atlas_AtlasArea.sort_atlas_plans')} value={state.sort} onChange={sort => session.update({ sort })} options={sorts.map(value => ({ value, label: inLanguage('h_atlasA_L', value) }))} /><Segmented ariaLabel={tr('atlas_AtlasArea.library_view')} value={state.view} onChange={view => session.update({ view })} options={(['grid', 'list'] as const).map(value => ({ value, label: value === 'grid' ? tr('atlas_AtlasArea.grid') : tr('atlas_AtlasArea.list') }))} /></div>
      <nav className="atlas-folder-path" aria-label={tr('atlas_AtlasArea.local_folders')}>{!!props.folders?.length && <button type="button" className="btn ghost" aria-pressed={folder === null} onClick={() => setFolder(null)}>{tr('atlas_AtlasArea.local')}</button>}{props.folders?.map(f => <button type="button" className="btn ghost" key={f.id} aria-pressed={folder === f.id} onClick={() => setFolder(f.id)}>{f.title}</button>)}
        <span className="atlas-folder-actions"><button type="button" className="btn ghost" onClick={() => setModal('folder')}>{tr('atlas_AtlasArea.new_folder')}</button><button type="button" className="btn ghost" onClick={() => setModal('trash')}>{tr('atlas_AtlasArea.recently_deleted')}</button></span></nav>
      {!libraryRecords.length && <div className="atlas-library-empty"><span className="atlas-empty-mark" aria-hidden="true" /><p className="atlas-empty-title">{state.query ? tr('atlas_AtlasArea.no_plans_match_this_search') : state.libraryTab === 'Saved' ? tr('atlas_AtlasArea.no_saved_plans_yet') : tr('atlas_AtlasArea.no_atlas_plans_yet')}</p>
        {state.libraryTab === 'Saved' && !state.query && <p className="atlas-empty-copy">{tr('atlas_AtlasArea.plans_you_save_from_others_show_here')}</p>}
        <div className="atlas-row-actions">{state.query ? <button type="button" className="btn" onClick={() => session.update({ query: '' })}>{tr('atlas_AtlasArea.clear_search')}</button> : state.libraryTab === 'Saved' ? (props.onBrowse && <button type="button" className="btn ghost" onClick={props.onBrowse}>{tr('atlas_AtlasArea.browse_atlas_plans')}</button>) : <><button type="button" className="btn atlas-primary" onClick={openNew}>{tr('atlas_AtlasArea.create_a_plan')}</button><button type="button" className="btn" onClick={() => setModal('import')}>{tr('atlas_AtlasArea.import_a_tree_link')}</button>{props.onBrowse && <button type="button" className="btn ghost" onClick={props.onBrowse}>{tr('atlas_AtlasArea.browse_atlas_plans')}</button>}</>}</div></div>}
      {!!selectedCards.length && <button type="button" className="btn" disabled={selectedCards.length !== 2} onClick={() => setLibraryCompare(libraryRecords.find(r => r.source.objectId === selectedCards[0]) ?? null)}>{tr('atlas_AtlasArea.compare_selection')}</button>}
      <div className="atlas-library-items" data-view={state.view}>{libraryRecords.map((record, index) => {
        const p = record.view.document.payload, retained = state.selectedByObject[record.source.objectId], id = retained && p.stepsById[retained] ? retained : stepIds(p)[0]!, s = p.stepsById[id]!, points = pointSummary(record.canvas?.graph, s);
        const cloud = props.cloudObjectIds?.includes(record.source.objectId) ?? false, previousCloud = index > 0 && (props.cloudObjectIds?.includes(libraryRecords[index - 1]!.source.objectId) ?? false);
        return <Fragment key={record.source.objectId}>{(index === 0 || cloud !== previousCloud) && <h2 className="atlas-library-group">{cloud ? tr('atlas_AtlasArea.cloud') : tr('h_atlasA_M.local_path', { title: props.folders?.find(f => f.id === folder)?.title ?? tr('atlas_AtlasArea.local') })}{cloud && <small>{!props.online ? tr('atlas_AtlasArea.offline_cached_account_copies') : !props.signedIn ? tr('atlas_AtlasArea.signed_out_cached_account_copies') : props.sync ?? tr('atlas_AtlasArea.up_to_date')}</small>}</h2>}<div className="atlas-library-record" data-object-id={record.source.objectId} onKeyDown={e => {
          if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement).closest('[role="menu"]')) return;
          if (e.key === 'F2' && record.ownership === 'owned') { e.preventDefault(); void action(record, 'rename'); }
          if (e.key === 'Delete' && record.ownership === 'owned') { e.preventDefault(); void action(record, 'delete'); }
          if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) { const all = [...e.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('.mastery-card-open')]; const index = all.findIndex(el => el === document.activeElement); e.preventDefault(); all[(index + (e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1) + all.length) % all.length]?.focus(); }
        }}><label><input type="checkbox" aria-label={tr('atlas_AtlasArea.select_title_for_comparison', { title: p.title })} checked={selectedCards.includes(record.source.objectId)} onChange={e => setSelectedCards(old => e.target.checked ? [...old, record.source.objectId] : old.filter(id => id !== record.source.objectId))} />{tr('atlas_AtlasArea.compare')}</label><ItemCard item={{ ownership: 'owned', objectId: record.source.objectId, source: record.source, title: p.title, stamp: p.stamp, art: { name: 'Atlas plan' }, updatedAt: record.history.events.at(-1)?.createdAt ?? p.stamp.createdAt, save: 'saved', summary: { kind: 'atlas', stepId: id, stepName: s.title, points: points.spent, steps: stepIds(p).length, mechanics: props.mechanicsForStep?.(record, s).slice(0, 3) ?? [] } }} view={state.view} onOpen={() => void session.open(record.source.objectId)} onAction={record.ownership === 'owned' ? a => void action(record, a) : undefined} menuActions={cardActions} /><small>{p.dataset.variant}</small>{record.ownership === 'saved' && <p>{tr('atlas_AtlasArea.read_only_saved_plan')}</p>}</div></Fragment>;
      })}</div>
      {state.libraryTab === 'My plans' && libraryRecords.length < 3 && props.marketplace && <section aria-label={tr('atlas_AtlasArea.from_marketplace')}><h2>{tr('atlas_AtlasArea.from_marketplace')}</h2>{props.marketplace}</section>}
    </> : shownPlan && step && shownRecord && <>
      <header className="atlas-area-header atlas-plan-header"><button type="button" className="btn ghost atlas-back" onClick={() => void session.back()}><span aria-hidden="true">‹</span> {tr('atlas_AtlasArea.atlas_plans')}</button><input ref={title} aria-label={tr('atlas_AtlasArea.plan_name')} className="field atlas-title" value={shownPlan.title} disabled={readOnly} onChange={e => session.edit({ kind: 'title', title: e.target.value }, true)} onBlur={() => session.flushText()} />
        <span className="atlas-plan-actions">{plan!.stamp.leagueId.status === 'known' && <span className="atlas-league-chip">{knownLabel(plan!.stamp.leagueId)}</span>}{props.onSend && <button type="button" className="btn" disabled={state.save !== 'saved' || !!state.preview} onClick={() => props.onSend?.(current, plan!)}>{tr('atlas_AtlasArea.send_to_timeline')}</button>}<button ref={shareButton} type="button" className="btn" onClick={() => setMenu(menu === 'share' ? null : 'share')}>{tr('atlas_AtlasArea.share')}</button><button ref={moreButton} type="button" className="btn" aria-label={tr('atlas_AtlasArea.more_actions')} onClick={() => setMenu(menu === 'more' ? null : 'more')}>{tr('atlas_AtlasArea.more')}</button></span></header>
      {old && <p className="atlas-state-banner">{tr('atlas_AtlasArea.saved_for_leagueid', { leagueId: knownLabel(plan!.stamp.leagueId) })} <button type="button" className="btn" disabled={!props.copyLeague} onClick={() => setModal('copy')}>{tr('atlas_AtlasArea.copy_to_leagueid', { leagueId: knownLabel(props.activeStamp.leagueId) })}</button></p>}
      {current.ownership === 'saved' && <p className="atlas-state-banner">{tr('atlas_AtlasArea.read_only_saved_plan_2')} <button type="button" className="btn" onClick={() => void action(current, 'duplicate')}>{tr('atlas_AtlasArea.edit_a_copy')}</button></p>}
      {quickSummary && quickFor === current.source.objectId && (quickSummary === 'building'
        ? <div className="atlas-quick-summary" role="status"><strong>{tr('atlas_AtlasArea.building_your_tree')}</strong> <span>{tr('atlas_AtlasArea.changing_the_tree_its_points')}</span></div>
        : <div className="atlas-quick-summary" role="status" aria-label={tr('atlas_AtlasArea.quick_plan_result')}><strong>{quickSummary.stale || !quickSummary.cost ? tr('atlas_AtlasArea.tree_not_filled') : quickSummary.left ? tr('h_atlasA_M.built_left', { cost: quickSummary.cost, budget: quickSummary.budget, left: quickSummary.left }) : tr('h_atlasA_M.built', { cost: quickSummary.cost, budget: quickSummary.budget })}</strong>
          <ul>{quickSummary.rows.map(r => <li key={r.name} className={r.reached ? 'quick-reached' : 'quick-short'}>{r.name}: {r.label}</li>)}
            {quickSummary.spent.map(line => <li key={line}>{fromMain('ml_atlas_quick', line)}</li>)}{quickSummary.error && <li role="alert">{quickSummary.error}</li>}</ul>
          <div className="atlas-row-actions">{buildUntouched(state, quickSummary) && <button type="button" className="btn" disabled={readOnly} onClick={() => { const s = quickSummary; setQuickSummary(null); if (buildUntouched(session.state, s)) void session.historyAction('undo'); }}>{tr('atlas_AtlasArea.undo')}</button>}<button type="button" className="btn ghost" onClick={() => setQuickSummary(null)}>{tr('atlas_AtlasArea.close')}</button></div></div>)}
      <div className="atlas-step-controls"><button type="button" className="btn ghost" aria-label={tr('atlas_AtlasArea.previous_step')} title={tr('atlas_AtlasArea.previous_step')} disabled={!adjacentStep(-1)} onClick={() => selectAdjacent(-1)}>‹</button><div ref={strip} className="atlas-steps-strip" aria-label={tr('atlas_AtlasArea.steps')} tabIndex={0}>
        {shownPlan.sequencePositions.map((position, index) => <div className="atlas-step-position" key={position.positionId}>{(position.kind === 'step' ? [position.stepId] : position.optionStepIds).map(id => { const spent = pointSummary(shownRecord.canvas?.graph, shownPlan.stepsById[id]!).spent; return <div className="atlas-step-option" key={id}><button type="button" className="btn atlas-step-chip" aria-current={id === selected ? 'step' : undefined} onClick={() => session.select(id)}><span className="atlas-step-index">{index + 1}</span>{stepTitle(shownPlan.stepsById[id]!.title)}<small>{spent.status === 'known' ? spent.value : tr('atlas_AtlasArea.unknown')} {tr('atlas_AtlasArea.points')}</small></button>
          {position.kind === 'alternatives' && <label><input type="radio" name={`run-${position.positionId}`} checked={position.defaultStepId === id} disabled={readOnly} onChange={() => session.edit({ kind: 'default', positionId: position.positionId, stepId: id })} />{tr('atlas_AtlasArea.use_in_run')}</label>}</div>; })}</div>)}
      </div><button type="button" className="btn ghost" aria-label={tr('atlas_AtlasArea.next_step')} title={tr('atlas_AtlasArea.next_step')} disabled={!adjacentStep(1)} onClick={() => selectAdjacent(1)}>›</button><button type="button" className="btn" disabled={readOnly} onClick={() => { const id = session.stepId(); session.edit({ kind: 'add', sourceId: state.selected!, newId: id }); session.select(id); }}>{tr('atlas_AtlasArea.step')}</button><button ref={stepButton} type="button" className="btn ghost atlas-step-more" aria-haspopup="menu" aria-label={tr('atlas_AtlasArea.step_options')} title={tr('atlas_AtlasArea.step_options')} onClick={() => setMenu(menu === 'step' ? null : 'step')}>…</button>
        <span className="atlas-row-end">{ATLAS_MECHANICS && <><span className="atlas-toolbar-sep" aria-hidden="true" /><button type="button" className="btn atlas-primary" disabled={!props.onOptimizer || quickBuilding} title={quickBuilding ? QUICK_BUSY : undefined} onClick={() => props.onOptimizer?.(session)}>{tr('atlas_AtlasArea.optimize_mechanics')}</button><button type="button" className="btn" disabled={!props.onPlanWithAi || quickBuilding} title={quickBuilding ? QUICK_BUSY : undefined} onClick={props.onPlanWithAi}>{tr('atlas_AtlasArea.plan_with_ai')}</button><button type="button" className="btn" disabled={!props.suggestions} onClick={() => { props.suggestions?.open(); setRailShown(true); }}>{tr('atlas_AtlasArea.suggestions')} <span className="atlas-count">{props.suggestions?.count ?? 0}</span></button><span className="atlas-toolbar-sep" aria-hidden="true" /></>}
        <button type="button" className="btn ghost" title={`${sourceLabel} · ${fromMain('ml_atlas_status', shownRecord.view.data?.statusText ?? tr('atlas_AtlasArea.live_compatibility_unverified'))}`} disabled={readOnly || !props.graphForData} onClick={() => { setTargetGraph(null); setRemovedIds([]); setAcceptEffects(false); setModal('tree-data'); }}>{dataLabel(sourceLabel)}</button><label className="atlas-switch-label" title={tr('atlas_AtlasArea.on_click_a_node_to')}><Switch checked={smart} disabled={readOnly} label={tr('atlas_AtlasArea.smart_pathing')} onChange={setSmart} /><span aria-hidden="true">{tr('atlas_AtlasArea.smart_pathing')}</span></label><span className="atlas-toolbar-sep" aria-hidden="true" /><button type="button" className="btn ghost" onClick={() => void showPanel('history')}>{tr('atlas_AtlasArea.history')}</button><button type="button" className="btn atlas-practical-toggle" aria-expanded={practicalOpen} onClick={() => setPracticalOpen(v => !v)}>{tr('atlas_AtlasArea.stats_maps_scarabs_notes')}</button></span></div>
      {undoNote && <p role="status" className="atlas-undo-note">{undoNote}</p>}
      {state.preview && <p className="atlas-state-banner">{tr('atlas_AtlasArea.preview_only_your_current_plan')}</p>}
      <div className="atlas-editing-grid" data-practical-open={practicalOpen} data-rail-shown={railShown && props.suggestions?.isOpen !== false}>
        <div className="atlas-tree-slot">{shownRecord.canvas ? <AtlasCanvasView model={shownRecord.canvas} smart={smart && !readOnly && !treePreview ? { marks: stepMarks, onClick: id => smartClick(id, false), onClear: id => smartClick(id, true) } : undefined} allocatedIds={step.allocatedIds} budget={step.pointBudget} sourceLabel={sourceLabel} compatibilityLabel={shownRecord.view.data?.statusText ?? tr('atlas_AtlasArea.live_compatibility_unverified')}
          onEdit={readOnly ? undefined : e => session.edit({ kind: 'allocation', stepId: step.stepId, beforeIds: e.beforeIds, afterIds: e.afterIds, datasetHash: e.scope.datasetHash })} readOnlyReason={readOnly && !state.preview && current.ownership !== 'saved' ? state.preview ? tr('atlas_AtlasArea.preview_only_your_current_plan') : tr('atlas_AtlasArea.read_only_preview_edit_a') : undefined}
          art={props.nodeArt} view={state.viewports[`${shownRecord.source.objectId}:${step.stepId}`]} onViewChange={view => session.update({ viewports: { ...session.state.viewports, [`${shownRecord.source.objectId}:${step.stepId}`]: view } })}
          overlay={treePreview ? overlayFor(treePreview.baseIds, treePreview.afterIds, 'ghost') : highlight.length ? overlayFor(step.allocatedIds, [...new Set([...step.allocatedIds, ...highlight])], 'ghost') : undefined}
          onDiscardPreview={() => { if (treePreview) treePreview.onDiscard(); else setHighlight([]); }}
          stepMembership={Object.fromEntries([...new Set(stepIds(shownPlan).flatMap(id => shownPlan.stepsById[id]!.allocatedIds))].map(nodeId => [nodeId, stepIds(shownPlan).filter(id => shownPlan.stepsById[id]!.allocatedIds.includes(nodeId)).map(id => ({ stepId: id, label: shownPlan.stepsById[id]!.title }))]))}
          onSelectStep={id => session.select(parseId('step', id))} onCanvasCommand={command => { if (command === 'history') void showPanel('history'); else if (command === 'optimizer') { if (ATLAS_MECHANICS && !quickBuilding) props.onOptimizer?.(session); } else if (command === 'next-step' || command === 'previous-step') selectAdjacent(command === 'next-step' ? 1 : -1); else { setPracticalOpen(true); session.update({ tab: ({ stats: 'Stats', maps: 'Maps', scarabs: 'Scarabs', notes: 'Notes' } as const)[command] }); } }} />
          : <p>{tr('atlas_AtlasArea.tree_data_is_unavailable_the')}</p>}{!step.allocatedIds.length && shownRecord.canvas && <p className="atlas-canvas-hint">{ATLAS_MECHANICS ? tr('atlas_AtlasArea.click_any_node_to_allocate') : tr('atlas_AtlasArea.click_any_node_to_allocate_2')}</p>}</div>
        <div ref={sideRef} className="atlas-side" data-footer={!state.panel && props.sideFooter ? true : undefined}>{!state.panel && props.optimizer && <div className="atlas-side-optimizer">{props.optimizer}</div>}
        <PracticalPanel plan={shownPlan} step={step} graph={shownRecord.canvas?.graph} catalogs={shownRecord.view.data?.catalogs ?? { maps: [], scarabs: [] }} tab={state.tab} onTab={tab => session.update({ tab })} edit={(e, text) => session.edit(e, text)} flush={() => session.flushText()} readOnly={readOnly} art={props.art} scroll={state.scrolls[`${step.stepId}:${state.tab}`] ?? 0} onScroll={value => session.update({ scrolls: { ...session.state.scrolls, [`${step.stepId}:${state.tab}`]: value } })} onHighlight={setHighlight} maximumLabel={shownRecord.view.data?.costs.status === 'known' && shownRecord.view.data.costs.value.maximumPoints.status === 'known' ? tr('atlas_AtlasArea.maximum_value_points', { value: shownRecord.view.data.costs.value.maximumPoints.value }) : tr('atlas_AtlasArea.maximum_unverified')} />
        {!state.panel && props.sideFooter && <div className="atlas-side-footer">{props.sideFooter}</div>}
      </div></div>
      <DocumentStatus local={state.save === 'failed' ? { status: 'failed', safeReason: state.error ? fromMain('ml_atlas_errors', state.error) : tr('atlas_AtlasArea.your_latest_changes_are_not') } : { status: state.save === 'saving' ? 'saving' : 'saved' }} stamp={plan!.stamp} sync={props.sync ?? (!props.online ? 'offline' : props.signedIn ? 'local' : 'signed_out')} onRecovery={() => setModal('recovery')} onConflict={() => setModal('conflict')} />
    </>}
    {state.error && <p role="alert">{fromMain('ml_atlas_errors', state.error)}<button type="button" className="btn" onClick={() => state.save === 'failed' ? setModal('recovery') : current ? void session.open(current.source.objectId) : void session.refresh()}>{tr('atlas_AtlasArea.retry')}</button></p>}
    <PortalMenu anchor={menu === 'more' ? moreButton : menu === 'step' ? stepButton : shareButton} open={!!menu} onClose={() => setMenu(null)} label={menu === 'share' ? tr('atlas_AtlasArea.share') : tr('atlas_AtlasArea.more_actions')}>
      {menu === 'share' && <>{['Copy PoM link', 'Copy official tree link', 'Copy tree code', 'Export file', 'Share options'].map(label => <button type="button" role="menuitem" className="menu-item" key={label} disabled={label.includes('tree') && !treeLink} onClick={async () => {
        setMenu(null); if (label === 'Copy PoM link' && props.cachedShare && props.cachedShare.revisionId === current?.source.revisionId && state.save === 'saved') { if (!await copy(props.cachedShare.url)) setModal('export'); }
        else if (label.includes('tree') && treeLink) { if (!await copy(label === 'Copy tree code' ? treeLink.split('/').at(-1)! : treeLink)) await openExport(); }
        else if (label === 'Export file') await work(async () => { await session.flush(); if (session.state.save !== 'saved' || !session.state.record || !session.state.plan) { setModal('recovery'); return; } await session.port.exportFile({ document: { kind: 'atlas', payload: session.state.plan }, source: session.state.record.source }, { includeNotes: true, includeHistory: false, includePrivateNotes: false }); }); else await openExport();
      }}>{label === 'Copy official tree link' ? tr('atlas_AtlasArea.copy_official_tree_link') : inLanguage('h_atlasA_L', label)}{label.includes('tree') && <small className="meta">{tr('atlas_AtlasArea.tree_only')}</small>}</button>)}{!treeLink && <p>{tr('atlas_AtlasArea.official_link_export_is_unavailable')}</p>}</>}
      {menu === 'more' && <><button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(null); void showPanel('diff'); }}>{tr('atlas_AtlasArea.diff')}</button><button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(null); void showPanel('compare'); }}>{tr('atlas_AtlasArea.compare')}</button><div className="menu-sep" role="separator" />{['Import', ...(props.onPublish ? ['Publish'] : []), 'Save as copy', 'Delete'].map(label => <Fragment key={label}>{label === 'Delete' && <div className="menu-sep" role="separator" />}<button type="button" role="menuitem" className={label === 'Delete' ? 'menu-item danger' : 'menu-item'} disabled={readOnly && label === 'Delete'} onClick={() => { setMenu(null); if (label === 'Import') setModal('import'); else if (label === 'Publish') props.onPublish?.(current!); else if (label === 'Save as copy') void action(current!, 'duplicate'); else setModal('delete'); }}>{inLanguage('h_atlasA_L', label)}</button></Fragment>)}</>}
      {menu === 'step' && <button type="button" role="menuitem" className="menu-item" disabled={readOnly} onClick={() => { setMenu(null); const id = session.stepId(); session.edit({ kind: 'add', sourceId: state.selected!, newId: id, empty: true }); session.select(id); }}>{tr('atlas_AtlasArea.empty_step')}</button>}
      {menu === 'step' && <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(null); void showPanel('steps'); }}>{tr('atlas_AtlasArea.manage_steps')}</button>}
    </PortalMenu>
    {modal === 'quick' && <QuickPlan showMechanics={ATLAS_MECHANICS} mechanics={props.quickMechanics ?? []} maximum={quickData?.budget ?? 0} art={props.art} busy={quickBusy} error={quickError} onCancel={close}
      onBuild={request => void quickBuild(request)} onBlank={(name, points) => void quickBlank(name, points)} onImport={() => setModal('import')}
      onChooseData={props.data.filter(d => d.active && d.qualified).length > 1 ? () => void newPlan() : undefined} />}
    {modal === 'data' && <Dialog title={tr('atlas_AtlasArea.choose_tree_data')} onCancel={close} confirmLabel={tr('atlas_AtlasArea.create_plan')} confirmDisabled={!props.data.length || busy} onConfirm={() => void work(() => newPlan(props.data[Number(dataIndex)]))}>
      {!props.data.length ? <p>{tr('atlas_AtlasArea.download_tree_data_to_create')}</p> : <><Select ariaLabel={tr('atlas_AtlasArea.tree_data')} value={dataIndex} options={props.data.map((d, i) => ({ value: String(i), label: dataLabel(d.dataset.datasetId, d.dataset.variant) }))} onChange={setDataIndex} /><p>{tr('atlas_AtlasArea.variant_variant', { variant: props.data[Number(dataIndex)]?.dataset.variant })}</p><p>{tr('atlas_AtlasArea.live_compatibility_unverified')}</p></>}
    </Dialog>}
    {modal === 'tree-data' && plan && <Dialog title={tr('atlas_AtlasArea.choose_tree_data')} size="large" onCancel={close} confirmLabel={tr('atlas_AtlasArea.use_target_tree_data')} confirmDisabled={!targetGraph || busy || !acceptEffects || dataChangePreview(plan, current?.canvas?.graph, targetGraph).some(row => row.status === 'Missing in target data' && !removedIds.includes(row.id))} onConfirm={() => void work(async () => {
      const data = props.data[Number(dataIndex)]; if (!data || !targetGraph) return; session.replacePlan(changeTreeData(plan, data.dataset, targetGraph, removedIds, session.limits), tr('atlas_AtlasArea.changed_tree_data')); await session.flush(); if (session.state.save !== 'saved') throw new Error('save');
    })}>
      <Select ariaLabel={tr('atlas_AtlasArea.tree_data')} value={dataIndex} options={[{ value: '', label: tr('atlas_AtlasArea.choose_tree_data') }, ...props.data.map((d, index) => ({ value: String(index), label: dataLabel(d.dataset.datasetId, d.dataset.variant) }))]} onChange={index => { setDataIndex(index); setTargetGraph(null); setAcceptEffects(false); const data = props.data[Number(index)]; if (index !== '' && data) void work(async () => setTargetGraph(await props.graphForData!(data)), false); }} />
      {targetGraph && dataChangePreview(plan, current?.canvas?.graph, targetGraph).map(row => <div className="atlas-data-row" key={row.id}><GameName name={row.name} asset={row.asset} id={row.id} art={props.art} /><code>{row.id}</code><span>{inLanguage('h_atlasA_L', row.status)}</span>{row.status === 'Missing in target data' && <label><input type="checkbox" checked={removedIds.includes(row.id)} onChange={e => setRemovedIds(old => e.target.checked ? [...old, row.id] : old.filter(id => id !== row.id))} />{tr('atlas_AtlasArea.remove')}</label>}</div>)}
      <label><input type="checkbox" checked={acceptEffects} onChange={e => setAcceptEffects(e.target.checked)} />{tr('atlas_AtlasArea.accept_reviewed_changes')}</label><p>{tr('atlas_AtlasArea.live_compatibility_unverified_unveri')}</p>{safeError && <p role="alert">{safeError}</p>}
    </Dialog>}
    {modal === 'rename' && targetItem && <NameDialog mode="rename" name={targetItem.view.document.payload.title} busy={busy} safeError={safeError} onClose={close} onSubmit={name => void work(async () => {
      if (current?.source.objectId === targetItem.source.objectId) { session.edit({ kind: 'title', title: name }); await session.flush(); if (session.state.save === 'failed') throw new Error('save'); }
      else { const payload = { ...structuredClone(targetItem.view.document.payload), title: name }; await session.port.save({ objectId: targetItem.source.objectId, expectedRevisionId: targetItem.source.revisionId, payload, stamp: payload.stamp, idempotencyKey: session.uuid() }, tr('atlas_AtlasArea.renamed_plan')); await session.refresh(); }
    })} />}
    {modal === 'folder' && <NameDialog mode="folder" name="" busy={busy} safeError={safeError} onClose={close} onSubmit={name => void work(async () => { await session.port.createFolder(name); await session.refresh(); await props.onFoldersChanged?.(); })} />}
    {modal === 'move' && targetItem && <MoveDialog folders={props.folders ?? []} current={targetItem.folderId} busy={busy} safeError={safeError} onClose={close} onMove={id => void work(async () => { await session.port.move(targetItem.source.objectId, id); await session.refresh(); })} />}
    {modal === 'delete' && targetItem && <DeleteDialog item={{ objectId: targetItem.source.objectId, title: targetItem.view.document.payload.title }} busy={busy} safeError={safeError} onClose={close} onDelete={id => void work(async () => { await session.flush(); if (session.state.save === 'failed') throw new Error('unsaved'); await session.port.trash(id); if (current?.source.objectId === id) await session.back(); else await session.refresh(); })} />}
    {modal === 'trash' && <Dialog title={tr('atlas_AtlasArea.recently_deleted')} size="large" onCancel={close} cancelLabel={tr('atlas_AtlasArea.close')} confirmLabel={null}>{!state.library.some(r => r.deletedAt) && <p>{tr('atlas_AtlasArea.no_recently_deleted_atlas_plans')}</p>}{state.library.filter(r => r.deletedAt).map(r => <div className="atlas-trash-row" key={r.source.objectId}><span>{tr('atlas_AtlasArea.title_deleted_deletedat', { title: r.view.document.payload.title, deletedAt: r.deletedAt })}</span><button type="button" className="btn" disabled={busy} onClick={() => void work(async () => { await session.port.restoreTrash(r.source.objectId); await session.refresh(); }, false)}>{tr('atlas_AtlasArea.restore')}</button></div>)}{safeError && <p role="alert">{safeError}</p>}</Dialog>}
    {modal === 'recovery' && current && plan && <RecoveryDialog draft={{ revision: current.source, title: plan.title, timestamp: new Date().toISOString(), summary: tr('atlas_AtlasArea.count_steps', { count: stepIds(plan).length }) }} safeReason={state.error ? fromMain('ml_atlas_errors', state.error) : tr('atlas_AtlasArea.your_latest_changes_are_not')} busy={busy} safeError={safeError} onClose={close} onPreview={() => setModal('draft-preview')} onExport={() => void work(() => session.recoveryExport(), false)} onRetry={() => void work(async () => { await session.retry(); if (session.state.save !== 'saved') throw new Error('save'); })} />}
    {modal === 'close' && <UnsavedCloseDialog busy={busy} safeError={safeError} onKeepOpen={close} onExport={() => void work(() => session.recoveryExport(), false)} onDiscard={() => void window.pom.win.closeAnyway()} />}
    {modal === 'draft-preview' && current && plan && step && <Dialog title={tr('atlas_AtlasArea.preview_this_pc')} size="large" onCancel={() => setModal('recovery')} cancelLabel={tr('atlas_AtlasArea.back')} confirmLabel={null}><p>{tr('atlas_AtlasArea.title_saved_for_leagueid', { title: plan.title, leagueId: knownLabel(plan.stamp.leagueId) })}</p>{current.canvas && <AtlasCanvasView model={current.canvas} allocatedIds={step.allocatedIds} budget={step.pointBudget} sourceLabel={plan.dataset.datasetId} compatibilityLabel={tr('atlas_AtlasArea.live_compatibility_unverified')} readOnlyReason={tr('atlas_AtlasArea.read_only_preview_your_latest')} art={props.nodeArt} />}<pre>{JSON.stringify({ maps: step.maps, scarabs: step.scarabs, strategy: step.strategy, instructions: step.instructions }, null, 2)}</pre></Dialog>}
    {modal === 'conflict' && props.conflict && <ConflictDialog local={props.conflict.local} account={props.conflict.account} canResolve={props.online && props.signedIn} busy={busy} safeError={safeError} onClose={close} onPreview={which => void work(async () => setConflictPreview(await props.conflict!.preview(which)), false)} onResolve={choice => void work(async () => session.adopt(await props.conflict!.resolve(choice)))} />}
    {conflictPreview && <Dialog title={tr('atlas_AtlasArea.read_only_preview')} size="large" onCancel={() => setConflictPreview(null)} cancelLabel={tr('atlas_AtlasArea.close')} confirmLabel={null}><p>{tr('atlas_AtlasArea.title_saved_for_leagueid', { title: conflictPreview.view.document.payload.title, leagueId: knownLabel(conflictPreview.view.document.payload.stamp.leagueId) })}</p><pre>{JSON.stringify(conflictPreview.view.document.payload, null, 2)}</pre></Dialog>}
    {modal === 'copy' && targetItem && props.copyLeague && <CopyLeagueDialog title={targetItem.view.document.payload.title} source={targetItem.source} target={props.activeStamp} compatibility={props.copyLeague.compatibility} busy={busy} safeError={safeError} onClose={close} onCopy={request => void work(async () => session.adopt(await props.copyLeague!.run(targetItem, request.title, request.provenance.dataMode)))} />}
    {modal === 'import' && <ImportAtlas initialInput={pasted} port={session.port} plan={plan} selected={state.selected} close={close} copy={copy} openBuilds={props.onOpenBuilds} leagues={[props.activeStamp]} data={props.data} limits={session.limits} stepId={importStepId.current} graphForData={props.graphForData} commit={async (result, target, importedStep, stamp) => {
      await session.flush(); if (session.state.save === 'failed') throw new Error('unsaved');
      if (target === 'new') { const input = structuredClone(result); if (stamp && input.snapshot.document.kind === 'atlas') input.snapshot.document.payload.stamp = { ...input.snapshot.document.payload.stamp, leagueId: stamp.leagueId, realm: stamp.realm, mode: stamp.mode }; session.adopt(await session.port.importNew(input)); await session.refresh(); }
      else { session.edit({ kind: 'importStep', source: importedStep, selected: state.selected!, newId: session.stepId(), target }); await session.flush(); if (session.snapshot().save === 'failed') throw new Error('save'); }
    }} />}
    {modal === 'export' && snapshot && <ExportAtlas input={snapshot} selected={state.selected && snapshot.document.payload.stepsById[state.selected] ? state.selected : stepIds(snapshot.document.payload)[0]!} port={session.port} close={close} online={props.online} signedIn={props.signedIn} signIn={props.onSignIn} publish={props.onPublish ? () => props.onPublish?.(targetItem!) : undefined} copy={copy} />}
    {state.panel === 'steps' && plan && state.selected && <StepManager plan={plan} selected={state.selected} edit={(e, text) => session.edit(e, text)} select={id => session.select(id)} id={() => session.stepId()} readOnly={readOnly} undo={() => void session.historyAction('undo')} redo={() => void session.historyAction('redo')} close={() => { session.flushText(); session.update({ panel: null }); }} />}
    {state.panel === 'diff' && current && plan && state.selected && <StepDiff record={current} plan={plan} selected={state.selected} close={() => session.update({ panel: null })} copy={copy} send={props.onSend ? delta => props.onSend?.(current, plan, delta.text) : undefined} art={props.art} nodeArt={props.nodeArt} />}
    {(state.panel === 'compare' && current || libraryCompare) && <ComparePlans origin={libraryCompare ?? current!} initialRight={libraryCompare ? compareRight ?? libraryRecords.find(r => r.source.objectId === selectedCards[1]) : undefined} selected={libraryCompare ? undefined : state.selected ?? undefined} records={state.library.filter(r => !r.deletedAt).map(r => current && r.source.objectId === current.source.objectId ? current : r)} read={r => session.port.read(r.source.objectId)} open={id => { setLibraryCompare(null); session.update({ panel: null }); void session.open(id); }} add={async (sourceStep: AtlasStep, destination) => { await session.open(destination.source.objectId); session.edit({ kind: 'importStep', source: sourceStep, selected: session.state.selected!, newId: session.stepId(), target: 'add' }); }} close={() => { setLibraryCompare(null); setCompareRight(null); session.update({ panel: null }); }} art={props.art} nodeArt={props.nodeArt} />}
    {state.panel === 'history' && current && <EditHistory session={session} close={() => { session.returnCurrent(); session.update({ panel: null }); }} />}
  </section>;
}
