import { useEffect, useRef, useState } from 'react';
import { parseId, type Clip, type ClipId, type LaneId, type LaneType, type Timeline } from '@pom/mastery-contracts';
import { Dialog, Icon, Segmented, Switch } from '../ui';
import { setCloseBlock, setRestartSaver } from '../closeGuard';
import { timelineCloseBlock } from './closeBlock';
import { knownLabel } from '../documents/model.js';
import { contentHash, pinSource } from '../../shared/timelines/adapters/common.js';
import { addLane, adoptClip, applySourceUpdate, atlasSourceSpan, copyClip, excludedByCoverage, pointRangeLabel, withAtlasPoints, laneLabels, moveLevelMarker, nextFreeRange, placeClip, preflightRun,
  previewResize, previewSourceUpdate, rangeLabel, removeClip, removeLane, reorderLane, resolveUpdateConflict, snapBoundary, sourceClip, updateBlockers,
  startPosition, type CollisionChoice, type PreflightResult, type Range } from '../../shared/timelines/editor/index.js';
import { chunkOverlay, compileSchedule, type SchedulerChunk } from '../../shared/timelines/scheduler/index.js';
import { ClipLibrary } from './ClipLibrary';
import { ClipInspector, triggerLabel } from './ClipInspector';
import { RunSetup } from './RunSetup';
import { AddLanesDialog } from './AddLanesDialog';
import { flattenTimeline } from '../../shared/timelines/adapters/flatten.js';
import type { TimelineEditorProps, TimelineSourceRow } from './types.js';
import { useAreaFind } from './useAreaFind';
import './timelines.css';

type PendingPlacement = { clip: Clip; label: string; collision?: string; excluded: string[]; changes?: { actionId: string; from: number; to: number }[] };
type Gesture = { clip: Clip; edge: 'move' | 'start' | 'end'; x: number; range: Range; cancelled: boolean };
export function TimelineEditor(props: TimelineEditorProps) {
  const [timeline, setTimeline] = useState(() => ({ ...props.timeline, editorMetadata: { ...props.timeline.editorMetadata, previewLevel: props.initialView?.previewLevel ?? props.timeline.editorMetadata.previewLevel } })), state = useRef(timeline);
  const [titleDraft, setTitleDraft] = useState(timeline.title);
  const [selected, setSelected] = useState<ClipId | undefined>(props.initialView?.clipId ? parseId('clip', props.initialView.clipId) : undefined), [library, setLibrary] = useState(true), [inspector, setInspector] = useState(props.initialView?.inspector ?? false),
    [zoom, setZoom] = useState(100), [landmarks, setLandmarks] = useState(true), [boundaries, setBoundaries] = useState(true),
    [saveState, setSaveState] = useState<'saved' | 'saving' | 'failed'>('saved'), [message, setMessage] = useState(''), [chunks, setChunks] = useState<SchedulerChunk[]>([]),
    [ghost, setGhost] = useState<{ clipId: ClipId; range: Range }>(), [pending, setPending] = useState<PendingPlacement>(),
    [placement, setPlacement] = useState<{ clip: Clip; laneId: LaneId; start: number; end: number; replacing?: ClipId; pointFrom?: string; pointTo?: string }>(),
    [note, setNote] = useState<{ type: 'notes' | 'checklist'; first: string; details: string; level: number; manual: boolean }>(),
    [laneMenu, setLaneMenu] = useState<LaneId>(), [remove, setRemove] = useState<LaneId>(), [addLaneOpen, setAddLaneOpen] = useState(false),
    [update, setUpdate] = useState<Awaited<ReturnType<typeof previewSourceUpdate>>>(), [keptUpdates, setKeptUpdates] = useState<Record<string, string>>(props.keptRevisions ?? {}), [addLanes, setAddLanes] = useState(false), [chooseSourceFor, setChooseSourceFor] = useState<ClipId>(),
    [runSetup, setRunSetup] = useState<PreflightResult>(), [omitted, setOmitted] = useState<ClipId[]>([]), [runBusy, setRunBusy] = useState(false),
    [startLevel, setStartLevel] = useState(1), [points, setPoints] = useState(''), [replaceCurrent, setReplaceCurrent] = useState(false),
    [showEvents, setShowEvents] = useState<Record<string, boolean>>({}), [playing, setPlaying] = useState(false), [missingGuide, setMissingGuide] = useState<TimelineSourceRow>();
  const viewport = useRef<HTMLDivElement>(null), gesture = useRef<Gesture>(), clipboard = useRef<Clip>(), past = useRef<Timeline[]>([]), future = useRef<Timeline[]>([]),
    queue = useRef<Promise<void>>(Promise.resolve()), retrySnapshot = useRef<{ timeline: Timeline; label: string }>();
  const [viewportWidth, setViewportWidth] = useState(1200);
  const incoming = useRef(props.timeline);
  // Grid is the saved snap setting of the timeline itself, so it survives closing and reopening.
  const grid = timeline.editorMetadata.snap;
  // The library's Run found a real blocker: the editor opens straight into the Resolve Run setup dialog.
  useEffect(() => { if (props.runOnOpen) void run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [updateChoices, setUpdateChoices] = useState<Record<string, 'keep_mine' | 'use_creator'>>({});
  const resolvedUpdate = update && update.conflicts.reduce((value, conflict) => resolveUpdateConflict(value, conflict,
    updateChoices[`${conflict.actionId}:${conflict.field}`] ?? 'keep_mine'), update.clip);
  const updateErrors = resolvedUpdate ? updateBlockers(resolvedUpdate) : [];
  const pixels = Math.max(12, (viewportWidth - 140) / 100) * zoom / 100;
  // Zoom never reduces the required level-column hit target.
  const px = Math.max(12, pixels);
  const clip = timeline.clips.find(row => row.clipId === selected), lane = timeline.lanes.find(row => row.laneId === clip?.laneId);
  const latest = selected ? props.latestOptions?.[selected] : undefined;
  const updateVisible = latest && latest.source.ref.revisionId !== keptUpdates[selected ?? ''] ? latest : undefined;
  const setDraft = (next: Timeline) => { state.current = next; setTimeline(next); };
  useEffect(() => {
    if (incoming.current === props.timeline) return;
    incoming.current = props.timeline;
    if (JSON.stringify(props.timeline) === JSON.stringify(state.current)) return;
    if (retrySnapshot.current) { setMessage('Timeline changed. Save or recover your pending edits.'); return; }
    setDraft(structuredClone(props.timeline));
    if (runSetup) { setRunSetup(undefined); setMessage('Timeline changed. Review the updated run.'); }
  }, [props.timeline]);
  useEffect(() => setTitleDraft(timeline.title), [timeline.title]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    element.scrollLeft = props.initialView?.scrollLeft ?? 0;
    const observer = new ResizeObserver(() => setViewportWidth(element.clientWidth)); observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let current = true;
    compileSchedule({ timeline, options: { limits: props.limits, landmarks: (props.landmarks ?? []).map(row => row.level) } }).then(schedule => { if (current) setChunks(chunkOverlay(schedule)); }).catch(() => { if (current) setChunks([]); });
    return () => { current = false; };
  }, [timeline, props.limits, props.landmarks]);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => { const next = Math.min(100, state.current.editorMetadata.previewLevel + 1); setDraft({ ...state.current, editorMetadata: { ...state.current.editorMetadata, previewLevel: next } }); if (next === 100) setPlaying(false); }, 500);
    return () => window.clearInterval(timer);
  }, [playing]);
  const persist = async (next: Timeline, label: string) => {
    retrySnapshot.current = { timeline: next, label }; setSaveState('saving');
    try { await props.onPersist(structuredClone(next), label); retrySnapshot.current = undefined; setSaveState('saved'); }
    catch { setSaveState('failed'); setMessage('Unsaved changes'); }
  };
  const transact = (label: string, change: (timeline: Timeline) => Timeline | Promise<Timeline>, history = true) => {
    queue.current = queue.current.then(async () => {
      try {
        const before = structuredClone(state.current), next = await change(before);
        if (JSON.stringify(next) === JSON.stringify(before)) return;
        if (history) { past.current.push(before); future.current = []; }
        setDraft(next); await persist(next, label);
      } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not edit the timeline.'); }
    });
    return queue.current;
  };
  // Restart to update: queued edits and a pending rename are written first; a save that still fails keeps its
  // "Unsaved changes" message on screen and stops the restart.
  const restartRefs = useRef({ persist, transact, titleDraft });
  restartRefs.current = { persist, transact, titleDraft };
  useEffect(() => {
    setRestartSaver('timeline', async () => {
      const r = restartRefs.current;
      if (r.titleDraft !== state.current.title) await r.transact('Rename timeline', (value) => ({ ...value, title: r.titleDraft }));
      await queue.current;
      const retry = retrySnapshot.current;
      if (retry) await restartRefs.current.persist(retry.timeline, retry.label);
      return !retrySnapshot.current;
    });
    return () => setRestartSaver('timeline', null);
  }, []);
  // Closing the app while changes are unsaved or a save failed asks first (the shared close dialog) instead of dropping them silently.
  useEffect(() => {
    setCloseBlock('timeline', timelineCloseBlock(saveState, titleDraft !== timeline.title));
    return () => setCloseBlock('timeline', null);
  }, [saveState, titleDraft, timeline.title]);
  const replaceClip = (next: Clip, label: string) => transact(label, timeline => ({ ...timeline, clips: timeline.clips.map(clip => clip.clipId === next.clipId ? next : clip) }));
  useEffect(() => {
    if (titleDraft === timeline.title) return;
    const timer = window.setTimeout(() => void transact('Rename timeline', value => ({ ...value, title: titleDraft })), 500);
    return () => window.clearTimeout(timer);
  }, [titleDraft, timeline.title]);
  const undo = () => {
    if (props.onUndo) { queue.current = queue.current.then(async () => { try { setDraft(await props.onUndo!()); setSaveState('saved'); } catch { setMessage('Could not undo. Retry after saving.'); } }); return; }
    const before = past.current.pop(); if (!before) return; future.current.push(structuredClone(state.current)); void transact('Undo', () => before, false);
  };
  const redo = () => {
    if (props.onRedo) { queue.current = queue.current.then(async () => { try { setDraft(await props.onRedo!()); setSaveState('saved'); } catch { setMessage('Could not redo. Retry after saving.'); } }); return; }
    const after = future.current.pop(); if (!after) return; past.current.push(structuredClone(state.current)); void transact('Redo', () => after, false);
  };
  const attempt = async (candidate: Clip, label: string, choice?: CollisionChoice, preview?: PendingPlacement) => {
    const draft = candidate.options.some(option => option.actions.some(action => action.trigger.kind === 'firstMap')) && !state.current.firstMapAnchor
      ? { ...state.current, firstMapAnchor: { anchorId: candidate.options.flatMap(option => option.actions).find(action => action.trigger.kind === 'firstMap')!.trigger.kind === 'firstMap'
        ? (candidate.options.flatMap(option => option.actions).find(action => action.trigger.kind === 'firstMap')!.trigger as { kind: 'firstMap'; anchorId: string }).anchorId : 'first-map',
        evidence: { status: 'unknown' as const, reason: 'Declare At maps manually or use a verified route event.' } } } : state.current;
    const result = await placeClip(draft, candidate, props.limits, choice);
    if (result.status === 'collision') { setPending({ clip: candidate, label, collision: result.clips.map(clip => clip.options[0]!.title).join(', '), excluded: excludedByCoverage(candidate), ...preview }); return; }
    if (result.status === 'applied') { setPending(undefined); setPlacement(undefined); await transact(label, () => result.timeline); setSelected(candidate.clipId); setInspector(true); }
  };
  const resize = async (target: Clip, range: Range, mode = target.timingMode) => {
    try {
      const preview = await previewResize(target, range, mode);
      if (!preview.ok) { setMessage(preview.reason); return; }
      if (mode === 'scale_timing' || preview.excluded.length) setPending({ clip: preview.clip, label: 'Resize clip', changes: preview.changes, excluded: preview.excluded });
      else await attempt(preview.clip, 'Resize clip');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not resize this clip.'); }
  };
  const add = async (row: TimelineSourceRow, laneId?: LaneId, range?: Range, replacing?: ClipId, direct = false) => {
    if (row.guideAvailable === false) { setMissingGuide(row); return; }
    try {
      const compatible = state.current.lanes.find(lane => lane.laneId === laneId && lane.type === row.source.fallbackSnapshot.kind)
        ?? state.current.lanes.find(lane => lane.laneId === clip?.laneId && lane.type === row.source.fallbackSnapshot.kind)
        ?? state.current.lanes.find(lane => lane.type === row.source.fallbackSnapshot.kind);
      if (!compatible) { setMessage('Add a compatible lane for this source type.'); return; }
      const prepared = await sourceClip(row.source, compatible.laneId, props.limits, { range: direct ? undefined : range, anchorId: state.current.firstMapAnchor?.anchorId ?? 'first-map' });
      if (direct && range) { await resize(prepared, { start: range.start, endExclusive: Math.min(101, range.start + prepared.range.endExclusive - prepared.range.start) }, 'keep_instruction_timing'); return; }
      setPlacement({ clip: prepared, laneId: compatible.laneId, start: prepared.range.start, end: prepared.range.endExclusive - 1, replacing });
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not add the source.'); }
  };
  const duplicate = async (target: Clip) => {
    try { const range = nextFreeRange(state.current, target.laneId, { start: target.range.endExclusive, endExclusive: Math.min(101, target.range.endExclusive + target.range.endExclusive - target.range.start) });
      if (!range || range.endExclusive - range.start !== target.range.endExclusive - target.range.start) { setMessage('No free range fits this clip.'); return; }
      const cloned = await copyClip(target, props.limits); await resize(cloned, range, 'keep_instruction_timing');
    } catch { setMessage('No free range fits this clip.'); }
  };
  const makeNote = async () => {
    if (!note || !note.first.trim() || [...note.first].length > 160 || [...note.details].length > 10000) { setMessage('First action allows 160 characters; Details allows 10000.'); return; }
    let current = state.current;
    if (!current.lanes.some(lane => lane.type === note.type)) { await transact('Add lane', value => addLane(value, note.type)); current = state.current; }
    const snapshot = { kind: note.type, payload: { schemaVersion: 1 as const, title: note.type === 'notes' ? 'New note' : 'Checklist', stamp: current.stamp,
      instructions: [{ firstAction: note.first, details: note.details, whenReady: '' }] } };
    const hash = await contentHash(snapshot), source = await pinSource({ objectId: parseId('object', crypto.randomUUID()), revisionId: parseId('revision', crypto.randomUUID()), payloadHash: hash, stamp: current.stamp }, snapshot, props.limits);
    const prepared = await sourceClip(source, current.lanes.find(lane => lane.type === note.type)!.laneId, props.limits, { textTriggers: note.manual ? undefined : [{ kind: 'level', level: note.level }] });
    setNote(undefined); setPlacement({ clip: prepared, laneId: prepared.laneId, start: prepared.range.start, end: prepared.range.endExclusive - 1 });
  };
  const beginGesture = (event: React.PointerEvent<HTMLElement>, target: Clip, edge: Gesture['edge']) => {
    if (event.button !== 0) return; event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { clip: structuredClone(target), edge, x: event.clientX, range: target.range, cancelled: false };
    setSelected(target.clipId); setInspector(true);
  };
  const moveGesture = (event: React.PointerEvent<HTMLElement>) => {
    const drag = gesture.current; if (!drag || drag.cancelled) return;
    const delta = (event.clientX - drag.x) / px, width = drag.clip.range.endExclusive - drag.clip.range.start;
    const snap = (value: number) => snapBoundary(value, px, { enabled: state.current.editorMetadata.snap, alt: event.altKey, grid,
      boundaries: boundaries ? state.current.clips.flatMap(clip => [clip.range.start, clip.range.endExclusive]) : [], landmarks: landmarks ? props.landmarks ?? [] : [] });
    drag.range = drag.edge === 'move' ? { start: Math.max(1, Math.min(101 - width, snap(drag.clip.range.start + delta))), endExclusive: 0 }
      : drag.edge === 'start' ? { start: Math.max(1, Math.min(drag.clip.range.endExclusive - 1, snap(drag.clip.range.start + delta))), endExclusive: drag.clip.range.endExclusive }
      : { start: drag.clip.range.start, endExclusive: Math.max(drag.clip.range.start + 1, Math.min(101, snap(drag.clip.range.endExclusive + delta))) };
    if (drag.edge === 'move') drag.range.endExclusive = drag.range.start + width;
    setGhost({ clipId: drag.clip.clipId, range: drag.range });
  };
  const endGesture = async () => {
    const drag = gesture.current; gesture.current = undefined; setGhost(undefined);
    if (!drag || drag.cancelled || JSON.stringify(drag.range) === JSON.stringify(drag.clip.range)) return;
    await resize(drag.clip, drag.range, drag.edge === 'move' ? 'keep_instruction_timing' : drag.clip.timingMode);
  };
  const run = async (manual = false) => {
    await queue.current;
    if (retrySnapshot.current) { setMessage('Unsaved changes'); return; }
    setRunBusy(true);
    try {
      if (!manual) {
        setOmitted([]); setReplaceCurrent(false);
        const position = startPosition(state.current, props.runContext?.start);
        setStartLevel(position.level); setPoints(position.atlasPoints.status === 'known' ? String(position.atlasPoints.value) : '');
      }
      const replacement = manual && replaceCurrent;
      const context = { ...props.runContext, limits: props.limits, omittedClipIds: manual ? omitted : [], competingRun: props.runContext?.competingRun && !replacement,
        ...(manual ? { start: { ...props.runContext?.start, observation: undefined, manual: { level: startLevel, atlasPoints: points === '' ? { status: 'unknown' as const, reason: 'No Atlas baseline selected.' } : { status: 'known' as const, value: Number(points), evidenceId: 'manual-baseline' } } } } : {}) };
      const result = await preflightRun(state.current, context);
      if (result.ready) { await props.onRun(result, replacement); setRunSetup(undefined); setOmitted([]); setReplaceCurrent(false); }
      else { setRunSetup(result); }
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not start Run. Retry after saving.'); }
    finally { setRunBusy(false); }
  };
  const refreshRun = async (next = state.current, omissions = omitted, replace = replaceCurrent) => {
    const result = await preflightRun(next, { ...props.runContext, limits: props.limits, omittedClipIds: omissions, competingRun: props.runContext?.competingRun && !replace });
    setRunSetup(result);
  };
  const root = useRef<HTMLElement>(null);
  useAreaFind(root, () => { setLibrary(true); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[aria-label="Search clips..."]')?.focus()); });
  const keyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.matches('input,textarea,select,[contenteditable="true"]') || target.closest('[role="dialog"]')) return;
    const ctrl = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
    if (ctrl && key === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
    if (ctrl && key === 'y') { event.preventDefault(); redo(); return; }
    if (ctrl && key === 's') { event.preventDefault(); if (event.shiftKey) props.onCopy?.(state.current); else void (props.onSave?.() ?? persist(state.current, 'Save timeline')); return; }
    if (ctrl && event.shiftKey && key === 'r') { event.preventDefault(); void run(); return; }
    if (ctrl && key === 'f') { event.preventDefault(); setLibrary(true); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[aria-label="Search clips..."]')?.focus()); return; }
    if (key === 'escape') { if (gesture.current) { gesture.current.cancelled = true; setGhost(undefined); } else setSelected(undefined); return; }
    if (target.closest('.timeline-ruler')) return;
    const canvasFocus = target.closest('.timeline-viewport');
    if (!canvasFocus) return;
    if (key === 'f') { event.preventDefault(); setZoom(100); if (viewport.current) viewport.current.scrollLeft = 0; return; }
    if (key === '+' || key === '=') { event.preventDefault(); setZoom(value => Math.min(400, value + 25)); return; }
    if (key === '-') { event.preventDefault(); setZoom(value => Math.max(25, value - 25)); return; }
    const focused = target.closest<HTMLElement>('[data-clip-id]'), targetClip = state.current.clips.find(clip => clip.clipId === focused?.dataset.clipId);
    if (ctrl && key === 'v' && clipboard.current) {
      event.preventDefault(); const copied = clipboard.current, compatible = targetClip?.laneId ?? state.current.lanes.find(lane => lane.type === copied.options[0]!.source.fallbackSnapshot.kind)?.laneId;
      if (compatible) void copyClip(copied, props.limits, { laneId: compatible }).then(cloned => setPlacement({ clip: cloned, laneId: compatible, start: targetClip?.range.start ?? preview, end: Math.min(100, (targetClip?.range.start ?? preview) + copied.range.endExclusive - copied.range.start - 1) }));
      return;
    }
    if (!targetClip) return;
    if (ctrl && key === 'c') { event.preventDefault(); clipboard.current = structuredClone(targetClip); return; }
    if (ctrl && key === 'd') { event.preventDefault(); void duplicate(targetClip); return; }
    if (key === 'delete') { event.preventDefault(); void transact('Remove clip', timeline => removeClip(timeline, targetClip.clipId)); setSelected(undefined); return; }
    if (key === 'arrowleft' || key === 'arrowright') {
      event.preventDefault(); const delta = (key === 'arrowleft' ? -1 : 1) * (event.shiftKey && !event.altKey ? 5 : 1);
      const range = event.altKey ? event.shiftKey ? { ...targetClip.range, endExclusive: targetClip.range.endExclusive + delta } : { ...targetClip.range, start: targetClip.range.start + delta }
        : { start: targetClip.range.start + delta, endExclusive: targetClip.range.endExclusive + delta };
      void resize(targetClip, range, event.altKey ? targetClip.timingMode : 'keep_instruction_timing');
    }
  };
  const preview = timeline.editorMetadata.previewLevel;
  return <section ref={root} className="timelines-area timeline-editor" onKeyDown={keyDown}>
    <header className="timeline-header"><div><button className="btn" onClick={props.onBack}>Timelines</button><span> / </span><input className="timeline-title field" aria-label="Rename timeline" value={titleDraft} onChange={event => setTitleDraft(event.target.value)} onBlur={() => void transact('Rename timeline', value => ({ ...value, title: titleDraft }))} /><span>Saved for {knownLabel(timeline.stamp.leagueId)}</span><span role="status">{saveState === 'saved' ? 'Saved on this PC' : saveState === 'saving' ? 'Saving...' : 'Unsaved changes'}</span></div>
      <div>{props.onShare && <button className="btn" onClick={() => props.onShare?.(state.current)}>Share</button>}{props.onPublish && <button className="btn" onClick={() => props.onPublish?.(state.current)}>Publish</button>}<button className="btn primary" onClick={() => void run()} disabled={runBusy}>Run</button></div></header>
    {props.offline && <p role="status">Offline. Local changes are saved on this PC.</p>}
    {message && <div role="alert">{message}<button className="btn" onClick={() => setMessage('')}>Dismiss</button>{saveState === 'failed' && <button className="btn" onClick={() => { const retry = retrySnapshot.current; if (retry) void persist(retry.timeline, retry.label); }}>Retry</button>}</div>}
    <div className="timeline-toolbar"><button className="btn" onClick={undo}>Undo</button><button className="btn" onClick={redo}>Redo</button>
      <label className="timeline-switch"><Switch checked={grid} onChange={value => { void transact('Change Grid', timeline => ({ ...timeline, editorMetadata: { ...timeline.editorMetadata, snap: value } })); }} label="Grid" />Grid</label>
      <label className="timeline-switch"><Switch checked={landmarks} onChange={setLandmarks} label="Landmarks" />Landmarks</label>
      <label className="timeline-switch"><Switch checked={boundaries} onChange={setBoundaries} label="Clip boundaries" />Clip boundaries</label>
      <label className="timeline-switch"><Switch checked={timeline.editorMetadata.showChunks} onChange={value => void transact('Show chunks', timeline => ({ ...timeline, editorMetadata: { ...timeline.editorMetadata, showChunks: value } }))} label="Show chunks" />Show chunks</label>
      <label>Zoom<input aria-label="Zoom" type="range" min={25} max={400} step={25} value={zoom} onChange={event => setZoom(Number(event.target.value))} /></label><span>{zoom}%</span><button className="btn" onClick={() => { setZoom(100); if (viewport.current) viewport.current.scrollLeft = 0; }}>Fit timeline</button>
      <button className="btn" onClick={() => { setLibrary(value => !value); if (!library && window.innerWidth < 1200) setInspector(false); }}>Library</button><button className="btn" onClick={() => { setInspector(value => !value); if (!inspector && window.innerWidth < 1200) setLibrary(false); }}>Inspector</button>
    </div>
    <div className="timeline-workspace" data-inspector={inspector}>
      {library && <ClipLibrary sources={props.sources} onAdd={row => void add(row, undefined, undefined, chooseSourceFor)} onBrowse={props.onBrowse} onNewNote={() => setNote({ type: 'notes', first: '', details: '', level: preview, manual: false })} onClose={() => setLibrary(false)} onAddTimeline={props.timelineSources?.length ? () => setAddLanes(true) : undefined} />}
      <div className="timeline-center">
        <div className="timeline-viewport" ref={viewport} tabIndex={0} aria-label="Timeline lanes" onWheel={event => {
          if (!event.ctrlKey) return; event.preventDefault(); const element = viewport.current; if (!element) return;
          const x = event.clientX - element.getBoundingClientRect().left, previous = zoom, next = Math.max(25, Math.min(400, previous + (event.deltaY < 0 ? 25 : -25)));
          setZoom(next); requestAnimationFrame(() => { element.scrollLeft = (element.scrollLeft + x - 140) * Math.max(12, Math.max(12, (viewportWidth - 140) / 100) * next / 100) / px - x + 140; });
        }}>
          <div className="timeline-sheet" style={{ width: 140 + 100 * px }}>
            <div className="timeline-ruler" role="slider" tabIndex={0} aria-label="Preview Level" aria-valuemin={1} aria-valuemax={100} aria-valuenow={preview}
              onPointerDown={event => { const x = event.clientX - event.currentTarget.getBoundingClientRect().left - 140; setDraft({ ...state.current, editorMetadata: { ...state.current.editorMetadata, previewLevel: Math.max(1, Math.min(100, Math.floor(x / px) + 1)) } }); event.currentTarget.setPointerCapture(event.pointerId); }}
              onPointerMove={event => { if (!event.buttons) return; const x = event.clientX - event.currentTarget.getBoundingClientRect().left - 140; setDraft({ ...state.current, editorMetadata: { ...state.current.editorMetadata, previewLevel: Math.max(1, Math.min(100, Math.floor(x / px) + 1)) } }); }}
              onKeyDown={event => { let level = preview; if (event.key === 'Home') level = 1; if (event.key === 'End') level = 100; if (event.key === 'ArrowRight') level = Math.min(100, preview + 1); if (event.key === 'ArrowLeft') level = Math.max(1, preview - 1); if (event.key === ' ') { event.preventDefault(); setPlaying(value => !value); } if (level !== preview) { event.preventDefault(); setDraft({ ...state.current, editorMetadata: { ...state.current.editorMetadata, previewLevel: level } }); } }}>
              <span className="timeline-lane-header">Level {preview} / Preview</span>{Array.from({ length: 100 }, (_, i) => i + 1).map(level => <span key={level} title={`Level ${level}`} style={{ width: px }} className="timeline-level">{level === 1 || level % 5 === 0 ? level : ''}</span>)}
            </div>
            {landmarks && <div className="timeline-landmarks">{(props.landmarks ?? []).map(mark => <span key={mark.evidenceId} style={{ left: 140 + (mark.level - 1) * px }} title={`${mark.trigger} / ${mark.evidenceId}`}>{mark.approximate ? `Suggested Level ${mark.level}: ` : ''}{mark.label} / {mark.trigger}</span>)}</div>}
            <div className="timeline-lanes"><div className="timeline-preview-line" style={{ left: 140 + (preview - 1) * px }} aria-hidden="true" />
              {[...timeline.lanes].sort((a, b) => a.order - b.order).map(lane => <div key={lane.laneId} className="timeline-lane" data-muted={lane.muted} style={{ height: lane.type === 'build' && showEvents[lane.laneId] ? 160 : 88 }}
                onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }} onDrop={event => {
                  event.preventDefault();
                  const marker = event.dataTransfer.getData('application/x-pom-timeline-action');
                  if (marker) {
                    try { const value = JSON.parse(marker) as { clipId: string; actionId: string }, current = state.current.clips.find(clip => clip.clipId === value.clipId && clip.laneId === lane.laneId);
                      if (!current) throw new Error('Keep this marker in its source lane.');
                      const level = Math.min(100, snapBoundary((event.clientX - event.currentTarget.getBoundingClientRect().left - 140) / px + 1, px, { enabled: timeline.editorMetadata.snap, alt: event.altKey, grid, boundaries: timeline.clips.flatMap(clip => [clip.range.start, clip.range.endExclusive]), landmarks: props.landmarks ?? [] }));
                      void moveLevelMarker(current, parseId('action', value.actionId), level).then(next => {
                        if (excludedByCoverage(next).includes(parseId('action', value.actionId))) setPending({ clip: next, label: 'Move stage marker', excluded: excludedByCoverage(next) });
                        else void replaceClip(next, 'Move stage marker');
                      }).catch(error => setMessage(error instanceof Error ? error.message : 'Could not move this marker.'));
                    } catch { setMessage('Could not move this marker.'); }
                    return;
                  }
                  const row = props.sources.find(row => row.id === event.dataTransfer.getData('application/x-pom-timeline-source'));
                  if (!row) return; if (row.source.fallbackSnapshot.kind !== lane.type) { setMessage(`This source needs a ${laneLabels[row.source.fallbackSnapshot.kind]} lane.`); return; }
                  const start = Math.max(1, Math.min(100, snapBoundary((event.clientX - event.currentTarget.getBoundingClientRect().left - 140) / px + 1, px, { enabled: timeline.editorMetadata.snap, alt: event.altKey, boundaries: timeline.clips.flatMap(clip => [clip.range.start, clip.range.endExclusive]), landmarks: props.landmarks ?? [] })));
                  void add(row, lane.laneId, { start, endExclusive: 101 }, undefined, true);
                }}>
                <div className="timeline-lane-header"><span><Icon name={lane.type === 'build' ? 'tree' : lane.type === 'atlas' ? 'map' : lane.type === 'filter' ? 'filter' : 'note'} label={laneLabels[lane.type]} />{lane.title}</span><button className="icon-btn" aria-label={`More actions for ${lane.title}`} onClick={() => setLaneMenu(lane.laneId)}>⋮</button>
                  {lane.type === 'build' && <button className="btn" aria-expanded={!!showEvents[lane.laneId]} onClick={() => setShowEvents(value => ({ ...value, [lane.laneId]: !value[lane.laneId] }))}>Stages</button>}
                  {lane.type === 'notes' && <button className="btn" onClick={() => setNote({ type: 'notes', first: '', details: '', level: preview, manual: false })}>Add note</button>}
                  {lane.type === 'checklist' && <button className="btn" onClick={() => setNote({ type: 'checklist', first: '', details: '', level: preview, manual: true })}>Add item</button>}
                </div>
                <div className="timeline-lane-grid" style={{ left: 140, backgroundSize: `${px * 5}px 100%`, opacity: grid ? 1 : 0 }} aria-hidden="true" />
                {!lane.clipIds.length && <p className="timeline-lane-empty">{lane.type === 'notes' ? 'Add note' : 'Drag a build, atlas plan or filter here.'}</p>}
                {timeline.clips.filter(clip => clip.laneId === lane.laneId).map(clip => {
                  const option = clip.options.find(option => option.optionId === clip.selectedOptionId) ?? clip.options[0]!, count = excludedByCoverage(clip).length;
                  return <div key={clip.clipId} className="timeline-clip" data-clip-id={clip.clipId} data-selected={selected === clip.clipId} style={{ left: 140 + (clip.range.start - 1) * px, width: (clip.range.endExclusive - clip.range.start) * px }}>
                    <button className="timeline-clip-body" aria-label={`${option.title}, ${rangeLabel(clip.range)}`} onFocus={() => setSelected(clip.clipId)} onClick={() => { setSelected(clip.clipId); setInspector(true); if (window.innerWidth < 1200) setLibrary(false); }}
                      onPointerDown={event => beginGesture(event, clip, 'move')} onPointerMove={moveGesture} onPointerUp={() => void endGesture()} onPointerCancel={() => { gesture.current = undefined; setGhost(undefined); }}>
                      <strong title={option.title}>{option.title}</strong><span title={option.source.ref.revisionId}>Version {option.source.ref.revisionId.slice(0, 8)}{lane.type === 'atlas' ? ` / ${clip.atlasPointRange ? pointRangeLabel(clip.atlasPointRange) : 'All Atlas points'}` : ''}</span>{count > 0 && <span>{count} excluded actions</span>}
                    </button>
                    <button className="timeline-resize start" aria-label={`Resize start of ${option.title}`} onPointerDown={event => beginGesture(event, clip, 'start')} onPointerMove={moveGesture} onPointerUp={() => void endGesture()} onPointerCancel={() => { gesture.current = undefined; setGhost(undefined); }} />
                    <button className="timeline-resize end" aria-label={`Resize end of ${option.title}`} onPointerDown={event => beginGesture(event, clip, 'end')} onPointerMove={moveGesture} onPointerUp={() => void endGesture()} onPointerCancel={() => { gesture.current = undefined; setGhost(undefined); }} />
                    {(lane.type !== 'build' && lane.type !== 'atlas' || lane.type === 'build' && showEvents[lane.laneId]) && <div className="timeline-inner-events">{option.actions.map(action => action.trigger.kind === 'level' ? <button key={action.actionId} className="btn" draggable title={action.instruction.details} onClick={() => { setSelected(clip.clipId); setInspector(true); }}
                      onDragStart={event => { event.dataTransfer.setData('application/x-pom-timeline-action', JSON.stringify({ clipId: clip.clipId, actionId: action.actionId })); event.dataTransfer.effectAllowed = 'move'; }}>{triggerLabel(action.trigger)}</button> : <span key={action.actionId} title={action.instruction.details}>{triggerLabel(action.trigger)}</span>)}</div>}
                  </div>;
                })}
                {timeline.editorMetadata.showChunks && chunks.filter(chunk => chunk.laneId === lane.laneId && chunk.coordinate === 'level').map(chunk => chunk.coordinate === 'level' && <div key={chunk.chunkId} className="timeline-chunk" title={rangeLabel(chunk.window)} style={{ left: 140 + (chunk.coverage.start - 1) * px, width: (chunk.coverage.endExclusive - chunk.coverage.start) * px }} />)}
                {timeline.editorMetadata.showChunks && lane.type === 'atlas' && timeline.clips.filter(clip => clip.laneId === lane.laneId).map(clip => <div key={clip.clipId} className="timeline-atlas-chunks" style={{ left: 140 + (clip.range.start - 1) * px + 20 }}>
                  {chunks.filter(chunk => chunk.clipId === clip.clipId && chunk.coordinate === 'atlasAllocated').map(chunk => chunk.coordinate === 'atlasAllocated' && <span key={chunk.chunkId} className="timeline-atlas-chunk" title={`Allocated points ${chunk.window.fromPoints}-${chunk.window.toPoints}`}>{chunk.window.fromPoints}-{chunk.window.toPoints} pts</span>)}</div>)}
                {ghost && timeline.clips.find(clip => clip.clipId === ghost.clipId)?.laneId === lane.laneId && <div className="timeline-ghost" style={{ left: 140 + (ghost.range.start - 1) * px, width: (ghost.range.endExclusive - ghost.range.start) * px }}>{rangeLabel(ghost.range)}</div>}
              </div>)}
            </div>
            <button className="btn" onClick={() => setAddLaneOpen(true)}>Add lane</button>
          </div>
        </div>
        <div className="timeline-scroll-controls"><button className="btn" onClick={() => viewport.current?.scrollBy({ left: -300 })}>Previous levels</button><span>Preview Level {preview}</span><button className="btn" onClick={() => viewport.current?.scrollBy({ left: 300 })}>Next levels</button></div>
        <p>{clip ? `Selected: ${clip.options[0]!.title} / ${rangeLabel(clip.range)}` : 'Select a clip to edit its timing and instructions.'}</p>
      </div>
      {inspector && <ClipInspector key={clip?.clipId ?? 'empty'} clip={clip} latest={updateVisible} offline={props.offline} onChange={(clip, label) => void replaceClip(clip, label)} onResize={(range, mode) => clip && void resize(clip, range, mode)}
        verifiedZones={props.verifiedZones} firstMapAnchor={timeline.firstMapAnchor?.anchorId}
        onUpdate={() => { if (clip && latest) void previewSourceUpdate(clip, latest, props.limits).then(value => { setUpdateChoices({}); setUpdate(value); }).catch(() => setMessage('Could not preview the source update.')); }}
        onKeep={() => { if (clip && latest) { setKeptUpdates(value => ({ ...value, [clip.clipId]: latest.source.ref.revisionId })); props.onKeepRevision?.(clip.clipId, latest.source.ref.revisionId); } }}
        onChoose={() => { setChooseSourceFor(clip?.clipId); setLibrary(true); setInspector(false); setMessage('Choose a source, then review the replacement.'); }}
        onOpen={() => { if (clip) props.onOpenSource?.(clip.options.find(option => option.optionId === clip.selectedOptionId)?.source ?? clip.options[0]!.source, { clipId: clip.clipId, previewLevel: preview, inspector, scrollLeft: viewport.current?.scrollLeft ?? 0 }); }}
        onDuplicate={() => clip && void duplicate(clip)} onRemove={() => { if (clip) void transact('Remove clip', timeline => removeClip(timeline, clip.clipId)); setSelected(undefined); }} onClose={() => setInspector(false)}
        muted={!!lane?.muted || !!clip?.disabled}
        onMute={() => { if (!clip) return;
          // "Enabled in Run" is the explicit clip.disabled flag, never inferred from exclusions; per-step exclusions are left alone.
          void replaceClip({ ...clip, disabled: !clip.disabled }, 'Enabled in Run'); }} />}
    </div>
    {placement && !pending && <Dialog title={placement.replacing ? 'Choose source' : 'Add clip'} confirmLabel={placement.replacing ? 'Use selected revision' : 'Add clip'} confirmDisabled={placement.start < 1 || placement.end > 100 || placement.start > placement.end || placement.pointFrom !== undefined && placement.pointFrom.trim() === '' || placement.pointTo !== undefined && placement.pointTo.trim() === ''} onCancel={() => setPlacement(undefined)} onConfirm={() => {
      let chosen = placement.clip;
      if (chosen.options[0]!.source.fallbackSnapshot.kind === 'atlas' && (placement.pointFrom !== undefined || placement.pointTo !== undefined)) {
        const span = atlasSourceSpan(chosen), from = Number(placement.pointFrom ?? chosen.atlasPointRange?.start ?? span.from), to = Number(placement.pointTo ?? (chosen.atlasPointRange ? chosen.atlasPointRange.endExclusive - 1 : span.to));
        try { chosen = withAtlasPoints(chosen, from, to); } catch { setMessage('Choose a nonempty Atlas point range.'); return; }
      }
      if (placement.replacing) void copyClip(chosen, props.limits, { clipId: placement.replacing, laneId: placement.laneId }).then(next => previewResize(next, { start: placement.start, endExclusive: placement.end + 1 }, 'keep_instruction_timing')).then(preview => { if (preview.ok) { void attempt(preview.clip, 'Choose source'); setChooseSourceFor(undefined); } });
      else void resize(adoptClip(chosen, placement.laneId), { start: placement.start, endExclusive: placement.end + 1 }, 'keep_instruction_timing');
    }}>
      <div className="timeline-dialog-fields">
      <label>Lane<select value={placement.laneId} onChange={event => setPlacement({ ...placement, laneId: parseId('lane', event.target.value) })}>{timeline.lanes.filter(lane => lane.type === placement.clip.options[0]!.source.fallbackSnapshot.kind).map(lane => <option key={lane.laneId} value={lane.laneId}>{lane.title}</option>)}</select></label>
      <div className="timeline-range-fields"><label>Start level<input type="number" min={1} max={100} value={placement.start} onChange={event => setPlacement({ ...placement, start: Number(event.target.value) })} /></label><label>End level<input type="number" min={1} max={100} value={placement.end} onChange={event => setPlacement({ ...placement, end: Number(event.target.value) })} /></label></div>
      {placement.clip.options[0]!.source.fallbackSnapshot.kind === 'atlas' && (() => { const span = atlasSourceSpan(placement.clip);
        return <><div className="timeline-range-fields"><label>Atlas points from<input type="number" min={0} value={placement.pointFrom ?? String(placement.clip.atlasPointRange?.start ?? span.from)} onChange={event => setPlacement({ ...placement, pointFrom: event.target.value })} /></label>
          <label>Atlas points to<input type="number" min={0} value={placement.pointTo ?? String(placement.clip.atlasPointRange ? placement.clip.atlasPointRange.endExclusive - 1 : span.to)} onChange={event => setPlacement({ ...placement, pointTo: event.target.value })} /></label></div>
          <p>First map, then Atlas points. These are not character levels.</p></>; })()}
      </div>
    </Dialog>}
    {pending && <Dialog title={pending.collision ? `This overlaps ${pending.collision}.` : pending.clip.timingMode === 'scale_timing' ? 'Scale timing' : 'Coverage preview'} confirmLabel={pending.collision ? 'Replace range' : pending.clip.timingMode === 'scale_timing' ? 'Use timing' : 'Use range'} altLabel={pending.collision ? 'Move to next free range' : undefined}
      onCancel={() => { setPending(undefined); setGhost(undefined); }} onConfirm={() => void attempt(pending.clip, pending.label, pending.collision ? 'replace_range' : undefined)} onAlt={() => void attempt(pending.clip, pending.label, 'next_free')}>
      <p>{rangeLabel(pending.clip.range)}</p>{pending.changes?.map(change => <p key={change.actionId}>Level {change.from} → Level {change.to}</p>)}
      {!!pending.excluded.length && <><h3>Excluded actions</h3>{pending.clip.options.flatMap(option => option.actions).filter(action => pending.excluded.includes(action.actionId)).map(action => <p key={action.actionId}>{triggerLabel(action.trigger)}: {action.instruction.firstAction}</p>)}</>}
    </Dialog>}
    {note && <Dialog title={note.type === 'notes' ? 'New note' : 'Add item'} confirmLabel="Add clip" confirmDisabled={!note.first.trim() || [...note.first].length > 160 || [...note.details].length > 10000 || !note.manual && (!Number.isInteger(note.level) || note.level < 1 || note.level > 100)} onCancel={() => setNote(undefined)} onConfirm={() => void makeNote().catch(() => setMessage('Could not add the note. Check its instructions and trigger.'))}>
      <div className="timeline-dialog-fields"><label>First action<input className="field" value={note.first} onChange={event => setNote({ ...note, first: event.target.value })} /></label><label>Details<textarea rows={5} value={note.details} onChange={event => setNote({ ...note, details: event.target.value })} /></label>
      <label>Trigger<select value={note.manual ? 'manual' : 'level'} onChange={event => setNote({ ...note, manual: event.target.value === 'manual' })}><option value="level">Level</option><option value="manual">Manual</option></select></label>{!note.manual && <label>Level<input type="number" min={1} max={100} value={note.level} onChange={event => setNote({ ...note, level: Number(event.target.value) })} /></label>}</div>
    </Dialog>}
    {missingGuide && <Dialog title="No progression guide" confirmLabel="Add as a snapshot" altLabel="Open build" onCancel={() => setMissingGuide(undefined)}
      onConfirm={() => { const row = missingGuide; setMissingGuide(undefined); void add({ ...row, guideAvailable: true }); }}
      onAlt={() => { props.onOpenSource?.(missingGuide.source, { clipId: selected ?? '', previewLevel: preview, inspector, scrollLeft: viewport.current?.scrollLeft ?? 0 }); setMissingGuide(undefined); }}>
      <p>No progression guide. Add as a snapshot or open build to create one.</p>
    </Dialog>}
    {addLaneOpen && <Dialog title="Add lane" confirmLabel={null} onCancel={() => setAddLaneOpen(false)}>{(Object.keys(laneLabels) as LaneType[]).map(type => <button key={type} className="btn" onClick={() => { void transact('Add lane', timeline => addLane(timeline, type)); setAddLaneOpen(false); }}>{laneLabels[type]}</button>)}</Dialog>}
    {laneMenu && <Dialog title={timeline.lanes.find(lane => lane.laneId === laneMenu)?.title ?? 'Lane'} confirmLabel={null} onCancel={() => setLaneMenu(undefined)}>
      <div className="timeline-dialog-fields"><label>Rename<input defaultValue={timeline.lanes.find(lane => lane.laneId === laneMenu)?.title} onBlur={event => void transact('Rename lane', timeline => ({ ...timeline, lanes: timeline.lanes.map(lane => lane.laneId === laneMenu ? { ...lane, title: event.target.value } : lane) }))} /></label>
      <label>Order<select value={timeline.lanes.find(lane => lane.laneId === laneMenu)?.order} onChange={event => void transact('Reorder lane', timeline => reorderLane(timeline, laneMenu, Number(event.target.value)))}>{timeline.lanes.map(lane => <option key={lane.order} value={lane.order}>{lane.order + 1}</option>)}</select></label>
      <button className="btn" onClick={() => { void transact('Mute in Run', timeline => ({ ...timeline, lanes: timeline.lanes.map(lane => lane.laneId === laneMenu ? { ...lane, muted: !lane.muted } : lane) })); setLaneMenu(undefined); }}>Mute in Run</button>
      <button className="btn" onClick={() => { const id = laneMenu; setLaneMenu(undefined); if (timeline.lanes.find(lane => lane.laneId === id)?.clipIds.length) setRemove(id); else void transact('Remove lane', timeline => removeLane(timeline, id)); }}>Remove</button></div>
    </Dialog>}
    {remove && <Dialog title={`Remove lane and ${timeline.lanes.find(lane => lane.laneId === remove)?.clipIds.length ?? 0} clips`} confirmLabel="Remove" onCancel={() => setRemove(undefined)} onConfirm={() => { void transact('Remove lane', timeline => removeLane(timeline, remove)); setRemove(undefined); }} />}
    {update && resolvedUpdate && <Dialog title="Preview update" size="large" confirmLabel="Apply update" confirmDisabled={updateErrors.length > 0} onCancel={() => setUpdate(undefined)} onConfirm={() => { void transact('Apply update', timeline => applySourceUpdate(timeline, { ...update, clip: resolvedUpdate })); setUpdate(undefined); }}>
      <div className="timeline-dialog-fields"><h3>Creator changes</h3>{update.changes.map(change => <p key={change.actionId}>{change.kind}: {change.actionId}</p>)}<h3>Your changes</h3>{update.clip.instructionOverrides.map(row => <p key={row.actionId}>{row.instruction.firstAction}</p>)}<h3>Conflicts</h3>
      {update.conflicts.map(conflict => <label key={`${conflict.actionId}:${conflict.field}`}>{conflict.field}: {conflict.mine} / {conflict.theirs}<select value={updateChoices[`${conflict.actionId}:${conflict.field}`] ?? 'keep_mine'} onChange={event => setUpdateChoices(value => ({ ...value, [`${conflict.actionId}:${conflict.field}`]: event.target.value as 'keep_mine' | 'use_creator' }))}><option value="keep_mine">Keep mine</option><option value="use_creator">Use creator changes</option></select></label>)}
      {updateErrors.map(reason => <p key={reason} role="alert">{reason}</p>)}</div>
    </Dialog>}
    {runSetup && <RunSetup timeline={timeline} result={runSetup.ready ? { ready: false, blockers: [], activeLanes: runSetup.activeLanes, mutedLanes: runSetup.mutedLanes } : runSetup} level={startLevel} points={points} onLevel={setStartLevel} onPoints={setPoints} busy={runBusy} replaceCurrent={replaceCurrent}
      onChoice={(clipId, optionId) => { const target = state.current.clips.find(clip => clip.clipId === clipId); if (target) void replaceClip({ ...target, selectedOptionId: parseId('option', optionId) }, 'Choose alternative').then(() => refreshRun()); }}
      onOmit={id => { const next = [...omitted, id]; setOmitted(next); void refreshRun(state.current, next); }} onRepair={id => { setRunSetup(undefined); setSelected(id); setInspector(true); setLibrary(false); }}
      onReplace={() => { setReplaceCurrent(true); void refreshRun(state.current, omitted, true); }} onCancel={() => setRunSetup(undefined)} onRun={() => void run(true)} />}
    {addLanes && <AddLanesDialog sources={props.timelineSources ?? []} onCancel={() => setAddLanes(false)} onAdd={async (source, laneIds) => {
      const flattened = await flattenTimeline({ source: source.bundle, sourceRevision: source.revision, laneIds, insertionId: crypto.randomUUID(), ancestry: props.revision ? [props.revision] : [], limits: props.limits });
      if (state.current.firstMapAnchor && flattened.firstMapAnchor && state.current.firstMapAnchor.anchorId !== flattened.firstMapAnchor.anchorId) throw new Error('Choose a Timeline with the same First map anchor.');
      await transact('Add lanes', timeline => ({ ...timeline, lanes: [...timeline.lanes, ...flattened.lanes.map((lane, index) => ({ ...lane, order: timeline.lanes.length + index }))], clips: [...timeline.clips, ...flattened.clips], credits: [...timeline.credits, ...flattened.credits], firstMapAnchor: timeline.firstMapAnchor ?? flattened.firstMapAnchor }));
      setAddLanes(false);
    }} />}
  </section>;
}
