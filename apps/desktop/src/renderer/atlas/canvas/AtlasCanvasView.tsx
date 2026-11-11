import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { isRawStatId } from '../../../shared/atlas/statText.js';
import { Dialog, Segmented } from '../../ui.js';
import { AtlasCanvas } from './AtlasCanvas.js';
import { allocationCost, rootComponent } from '../../../shared/atlas/graph.js';
import { canvasRows, dataLabel, inspectNode, rowActionAvailable, overlayFor, type CanvasModel, type NodeFilter, type NodeInspection, type NodeRow, type Overlay, type View } from './model.js';
import type { ArtResolver, NodeArt } from './art.js';
import './canvas.css';
import { fromMain, label, tr } from '../../i18n';

export type CanvasEdit = { scope: CanvasModel['scope']; nodeId: string; kind: 'allocate' | 'remove'; beforeIds: string[]; afterIds: string[]; addedIds: string[]; removedIds: string[] };
export type AtlasCanvasViewProps = {
  model: CanvasModel;
  allocatedIds: readonly string[];
  budget: number;
  sourceLabel: string;
  compatibilityLabel: string;
  onEdit?: (edit: CanvasEdit) => void;
  readOnlyReason?: string;
  overlay?: Overlay | null;
  onDiscardPreview?: () => void;
  art?: ArtResolver;
  view?: View;
  onViewChange?: (view: View) => void;
  onCanvasCommand?: (command: 'history' | 'optimizer' | 'stats' | 'maps' | 'scarabs' | 'notes' | 'next-step' | 'previous-step') => void;
  stepMembership?: Record<string, { stepId: string; label: string }[]>;
  /** Smart pathing: clicks mark nodes instead of allocating them; right-click clears. */
  smart?: { marks: ReadonlyMap<string, 'want' | 'avoid'>; onClick: (nodeId: string) => void; onClear: (nodeId: string) => void };
  onSelectStep?: (stepId: string, nodeId: string) => void;
};
function Art({ art, name }: { art: NodeArt | null; name: string }) {
  return art ? <span className="atlas-node-art" role="img" aria-label={name} style={{ backgroundImage: `url(${JSON.stringify(art.url)})`,
    backgroundSize: `${art.width / art.w * 32}px ${art.height / art.h * 32}px`, backgroundPosition: `${-art.x / art.w * 32}px ${-art.y / art.h * 32}px` }} />
    : <span className="atlas-node-art atlas-node-art-missing" role="img" aria-label={tr('atlas_canvas_AtlasCanvasView.artwork_unavailable_for_name', { name })} />;
}
const amount = (value: { status: 'known'; value: number } | { status: 'unknown' }) => value.status === 'known' ? String(value.value) : tr('atlas_canvas_AtlasCanvasView_2.unverified');
const points = (value: { status: 'known'; value: number } | { status: 'unknown' }) => `${amount(value)} ${value.status === 'known' && value.value === 1 ? 'point' : 'points'}`;

type ListCtl = { current: { setFocused: (id: string) => void; setHover: (id: string | null) => void; selectResult: (id: string) => void; activate: (id: string) => void;
  focusRow: (index: number, step: number) => void; button: (id: string, el: HTMLButtonElement | null) => void } };
// One list row. Memoized so that loading the list in chunks only renders the new rows, not every row again each time.
const NodeListRow = memo(function NodeListRow({ row, index, pressed, disabled, art, ctl }: { row: NodeRow; index: number; pressed: boolean; disabled: boolean; art: NodeArt | null; ctl: ListCtl }) {
  const c = () => ctl.current;
  return <li data-node-id={row.nodeId}>
    <button type="button" className="atlas-node-row" aria-pressed={pressed} ref={button => c().button(row.nodeId, button)}
      onFocus={event => { if (event.currentTarget.matches(':focus-visible')) c().setFocused(row.nodeId); }} onMouseEnter={() => c().setHover(row.nodeId)} onMouseLeave={() => c().setHover(null)} onClick={() => c().selectResult(row.nodeId)}
      onKeyDown={event => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === ' ') { event.preventDefault(); c().activate(row.nodeId); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); c().focusRow(index, event.key === 'ArrowDown' ? 1 : -1); }
      }}>
      <Art art={art} name={row.name} /><span><strong>{row.name}</strong><small>{row.isRoot ? tr('atlas_canvas_AtlasCanvasView.start') : row.allocated ? tr('atlas_canvas_AtlasCanvasView.allocated') : label(row.type)} · {points(row.cost)}</small>
                {row.repair && <small>{tr('atlas_canvas_AtlasCanvasView.needs_repair')}</small>}{!row.position && <small>{tr('atlas_canvas_AtlasCanvasView.geometry_unverified')}</small>}{row.delta && <small className={`atlas-delta-${row.delta}`}>{row.delta === 'added' ? tr('atlas_canvas_AtlasCanvasView.added') : row.delta === 'removed' ? tr('atlas_canvas_AtlasCanvasView.removed') : tr('atlas_canvas_AtlasCanvasView_2.unchanged')}</small>}</span>
    </button>
    {!row.isRoot && <button type="button" className="btn" disabled={disabled} onFocus={event => { if (event.currentTarget.matches(':focus-visible')) c().setFocused(row.nodeId); }} onClick={() => c().activate(row.nodeId)}>{row.allocated ? tr('atlas_canvas_AtlasCanvasView.unallocate') : tr('atlas_canvas_AtlasCanvasView.allocate_path')}</button>}
  </li>;
});

export function AtlasCanvasView(props: AtlasCanvasViewProps) {
  const { model, allocatedIds, budget } = props;
  const id = useId(), canvas = useRef<HTMLCanvasElement>(null), renderer = useRef<AtlasCanvas | null>(null);
  const latest = useRef(props); latest.current = props;
  const search = useRef<HTMLInputElement>(null), listButton = useRef<HTMLButtonElement>(null), resultButtons = useRef(new Map<string, HTMLButtonElement>());
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<NodeFilter>('all'), [listOpen, setListOpen] = useState(false);
  const [hover, setHover] = useState<string | null>(null), [focused, setFocused] = useState<string | null>(null), [pinned, setPinned] = useState<string | null>(null);
  const [pending, setPending] = useState<{ nodeId: string; before: string; budget: number; datasetHash: string; graphHash: string } | null>(null);
  const [status, setStatus] = useState<'ready' | 'lost' | 'unavailable'>('ready');
  const [notice, setNotice] = useState('');
  const inspectionId = pending?.nodeId ?? pinned ?? hover ?? focused;
  const inspection = inspectionId ? inspectNode(model, allocatedIds, inspectionId, budget) : null;
  const allRows = useMemo(() => canvasRows(model, allocatedIds, '', 'all', props.overlay), [model, allocatedIds, props.overlay]);
  // One walk from the start, not a path search per row: a row is unavailable exactly when no path to it exists.
  const reachable = useMemo(() => rootComponent(model.graph), [model]);
  const rows = useMemo(() => canvasRows(model, allocatedIds, query, filter, props.overlay), [model, allocatedIds, query, filter, props.overlay]);
  // Opening the list paints the first rows at once and fills in the rest in small chunks, so no single task blocks input.
  const [limit, setLimit] = useState(24);
  useEffect(() => { setLimit(24); }, [listOpen, filter, query]);
  useEffect(() => {
    if (!listOpen || limit >= rows.length) return;
    const t = setTimeout(() => setLimit(value => value + 40), 0);
    return () => clearTimeout(t);
  }, [listOpen, limit, rows.length]);
  const shown = useMemo(() => rows.slice(0, limit), [rows, limit]);
  const matches = useMemo(() => canvasRows(model, allocatedIds, query, 'matches'), [model, allocatedIds, query]);
  const detail = allRows.find(row => row.nodeId === inspectionId);
  const editable = !!props.onEdit && !props.readOnlyReason && !props.overlay;
  const pendingStale = pending && (pending.before !== JSON.stringify(allocatedIds) || pending.budget !== budget ||
    pending.datasetHash !== model.scope.datasetHash || pending.graphHash !== model.scope.graphHash || !editable);
  const unavailableOverlayCount = props.overlay ? allRows.filter(row => !model.graph.nodes.has(row.nodeId) && row.delta !== null).length : 0;
  const ghost = props.smart ? null : !pendingStale && inspection?.kind === 'allocate' ? overlayFor(allocatedIds, inspection.preview.allocatedIds, 'ghost')
    : !pendingStale && inspection?.kind === 'remove' ? overlayFor(allocatedIds, inspection.preview.allocatedIds, 'ghost') : null;
  const overlay = props.overlay ?? ghost;

  useEffect(() => {
    if (!canvas.current) return;
    const instance = new AtlasCanvas(canvas.current, model, {
      hover: setHover,
      activate: nodeId => activateRef.current(nodeId),
      secondary: nodeId => { const smart = latest.current.smart; if (smart) smart.onClear(nodeId); return !!smart; },
      status: setStatus,
      view: view => latest.current.onViewChange?.(view),
    }, props.art, props.view);
    renderer.current = instance;
    return () => { instance.destroy(); renderer.current = null; };
  // Keyed on the hashes, not the object: every save re-reads the plan into an equal model, and a new renderer repaints the tree from blank.
  }, [model.scope.datasetHash, model.scope.graphHash, props.art]);
  useEffect(() => {
    renderer.current?.setState({ allocated: allocatedIds, matches: new Set(matches.map(row => row.nodeId)),
      repair: new Set(allRows.filter(row => row.repair).map(row => row.nodeId)), focused: inspectionId, overlay, marks: props.smart?.marks });
  }, [allocatedIds, matches, allRows, inspectionId, overlay, model, props.smart?.marks]);
  useEffect(() => { if (props.view) renderer.current?.setView(props.view); }, [props.view]);

  const commit = (nodeId: string, preview: NodeInspection) => {
    if (!editable || (preview.kind !== 'allocate' && preview.kind !== 'remove')) return;
    props.onEdit?.({ scope: { ...model.scope }, nodeId, kind: preview.kind, beforeIds: [...allocatedIds], afterIds: [...preview.preview.allocatedIds],
      addedIds: preview.kind === 'allocate' ? [...preview.preview.addedIds] : [], removedIds: preview.kind === 'remove' ? [...preview.preview.removedIds] : [] });
    setPending(null); setHover(null); setPinned(null); setFocused(null); setNotice('');
  };
  const activate = (nodeId: string) => {
    const preview = inspectNode(model, allocatedIds, nodeId, budget);
    if (!editable) { setPinned(nodeId); return; }
    if (props.smart) { if (nodeId !== model.graph.rootId) props.smart.onClick(nodeId); return; }
    if (preview.kind === 'remove' && preview.preview.cascadeIds.length) {
      setPinned(nodeId); setPending({ nodeId, before: JSON.stringify(allocatedIds), budget, ...model.scope });
    } else commit(nodeId, preview);
  };
  const activateRef = useRef(activate); activateRef.current = activate;
  const selectResult = (nodeId: string) => { setFocused(nodeId); setPinned(nodeId); setListOpen(true); renderer.current?.focusNode(nodeId); };
  const listCtl: ListCtl = useRef(null as never);
  listCtl.current = { setFocused, setHover, selectResult, activate: nodeId => activateRef.current(nodeId),
    focusRow: (index, step) => { const next = shown[(index + step + shown.length) % shown.length]; if (next) resultButtons.current.get(next.nodeId)?.focus(); },
    button: (nodeId, el) => { if (el) resultButtons.current.set(nodeId, el); else resultButtons.current.delete(nodeId); } };
  const cycleResult = (direction: number) => {
    if (!matches.length) return;
    const at = matches.findIndex(row => row.nodeId === focused);
    const next = matches[(at + direction + matches.length) % matches.length]!;
    selectResult(next.nodeId);
  };
  const escape = () => {
    if (props.overlay && props.onDiscardPreview) { props.onDiscardPreview(); return; }
    if (pinned || hover || focused) { setPinned(null); setHover(null); setFocused(null); return; }
    if (listOpen) { setListOpen(false); listButton.current?.focus(); }
  };
  const key = (event: KeyboardEvent<HTMLElement>) => {
    const text = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable);
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); search.current?.focus(); search.current?.select(); return; }
    if (text) return;
    if (event.key === 'Escape' && !pending) { event.preventDefault(); escape(); return; }
    if (event.target !== canvas.current) return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'Tab') { event.preventDefault(); props.onCanvasCommand?.(event.shiftKey ? 'previous-step' : 'next-step'); return; }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === ' ' && inspectionId) { event.preventDefault(); activate(inspectionId); return; }
    if (event.key === 'Enter' && inspectionId) { event.preventDefault(); setPinned(inspectionId); return; }
    const command = ({ h: 'history', a: 'optimizer', '1': 'stats', '2': 'maps', '3': 'scarabs', '4': 'notes' } as const)[event.key.toLowerCase() as 'h'];
    if (command) { event.preventDefault(); props.onCanvasCommand?.(command); }
  };
  const artFor = (nodeId: string) => { const node = model.graph.nodes.get(nodeId); return node?.asset ? props.art?.(node.asset, nodeId, model.scope.datasetHash) ?? null : null; };
  const showDetails = (!!detail && (!!pinned || !!pending)) || listOpen;
  const spent = (() => { try { const c = allocationCost(model.graph, allocatedIds); return c.status === 'known' ? c.value : null; } catch { return null; } })();
  const tipNode = !pinned && !pending && hover ? model.nodes[model.denseById.get(hover) ?? -1] : undefined;
  const tipAt = tipNode ? renderer.current?.nodeScreen(tipNode.nodeId) : null;
  const tip = tipNode ? inspection : null;
  // Display names (nameless start node reads Start; the root itself too), never raw node ids: an imported node the
  // chosen tree data does not have reads "Unavailable node" (its id stays in the detail title, which is the repair label).
  const nodeName = (nodeId: string) => nodeId === model.graph.rootId ? tr('atlas_canvas_AtlasCanvasView_2.start') : model.nodes[model.denseById.get(nodeId) ?? -1]?.name ?? tr('atlas_canvas_AtlasCanvasView.unavailable_node');
  // Keep the whole tooltip (its allocation cost line is last) inside the stage: lift it when it would run off the bottom.
  const tipRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = tipRef.current, stage = el?.parentElement; if (!el || !stage) return;
    const max = stage.clientHeight - el.offsetHeight - 8;
    if (parseFloat(el.style.top) > max) el.style.top = `${Math.max(8, max)}px`;
  });
  return <section className="atlas-canvas-view" aria-label={tr('atlas_canvas_AtlasCanvasView.atlas_tree')} onKeyDown={key} onPointerLeave={() => setHover(null)}>
    <div className="atlas-canvas-toolbar">
      <label className="atlas-canvas-search"><span className="atlas-sr">{tr('atlas_canvas_AtlasCanvasView.search_nodes')}</span><input ref={search} className="field" aria-label={tr('atlas_canvas_AtlasCanvasView.search_nodes')} placeholder={tr('atlas_canvas_AtlasCanvasView.search_nodes_2')} value={query}
        onChange={event => { setQuery(event.target.value); setPinned(null); setFocused(null); }} onKeyDown={event => {
          if (event.key === 'Enter' && matches.length) { event.preventDefault(); selectResult(matches[0]!.nodeId); requestAnimationFrame(() => resultButtons.current.get(matches[0]!.nodeId)?.focus()); }
        }} /></label>
      {!!query.trim() && <><button className="btn ghost" type="button" aria-label={tr('atlas_canvas_AtlasCanvasView.previous_search_result')} disabled={!matches.length} onClick={() => cycleResult(-1)}>{tr('atlas_canvas_AtlasCanvasView.previous')}</button>
        <span role="status" className="atlas-canvas-count">{matches.length ? tr('h_atlasA_M.n_of_total', { n: Math.max(0, matches.findIndex(row => row.nodeId === focused)) + 1, total: matches.length }) : tr('atlas_canvas_AtlasCanvasView.no_nodes_match_this_search')}</span>
        <button className="btn ghost" type="button" aria-label={tr('atlas_canvas_AtlasCanvasView.next_search_result')} disabled={!matches.length} onClick={() => cycleResult(1)}>{tr('atlas_canvas_AtlasCanvasView.next')}</button></>}
      <span className="atlas-canvas-tools">
        <button className="btn ghost" type="button" aria-label={tr('atlas_canvas_AtlasCanvasView.zoom_out')} title={tr('atlas_canvas_AtlasCanvasView.zoom_out_2')} onClick={() => renderer.current?.zoom(1 / 1.25)}>−</button>
        <button className="btn ghost" type="button" aria-label={tr('atlas_canvas_AtlasCanvasView.zoom_in')} title={tr('atlas_canvas_AtlasCanvasView.zoom_in_2')} onClick={() => renderer.current?.zoom(1.25)}>+</button>
        <button className="btn ghost" type="button" title={tr('atlas_canvas_AtlasCanvasView.fit_f')} onClick={() => renderer.current?.fit(allocatedIds)}>{tr('atlas_canvas_AtlasCanvasView.fit')}</button>
        <button ref={listButton} className="btn ghost" type="button" aria-expanded={listOpen} aria-controls={`${id}-nodes`} onClick={() => setListOpen(value => !value)}>{tr('atlas_canvas_AtlasCanvasView.nodes_list')}</button>
      </span>
    </div>
    {props.readOnlyReason && <p role="status" className="atlas-canvas-note">{props.readOnlyReason}</p>}
    {model.geometryWarnings.length > 0 && <p role="status" className="atlas-canvas-note">{tr('atlas_canvas_AtlasCanvasView.geometry_unverified_for_length_nodes', { count: model.geometryWarnings.length })}</p>}
    {unavailableOverlayCount > 0 && <p role="status" className="atlas-canvas-note">{tr('atlas_canvas_AtlasCanvasView.different_tree_data_unavailableoverl', { unavailableOverlayCount })}</p>}
    {status !== 'ready' && <p role="status" className="atlas-canvas-note">{tr('atlas_canvas_AtlasCanvasView.tree_display_is_unavailable_nodes')}</p>}
    <div className="atlas-canvas-body">
      <div className="atlas-canvas-stage">
        <canvas ref={canvas} tabIndex={0} aria-label={tr('atlas_canvas_AtlasCanvasView.atlas_canvas_f_fits_plus')} aria-describedby={`${id}-help`} data-webgl-status={status} />
        <div className="atlas-points" data-over={spent !== null && spent > budget ? 'true' : undefined} aria-label={tr('atlas_canvas_AtlasCanvasView.points_used')}><strong>{spent ?? tr('atlas_canvas_AtlasCanvasView.unknown')}</strong> {tr('atlas_canvas_AtlasCanvasView.budget_points', { budget })}</div>
        {overlay && <div className="atlas-canvas-legend" aria-label={tr('atlas_canvas_AtlasCanvasView.tree_overlay_legend')}><strong>{overlay.kind === 'diff' ? tr('atlas_canvas_AtlasCanvasView.diff') : tr('atlas_canvas_AtlasCanvasView.preview_only')}</strong>
          <span className="atlas-delta-added">{tr('atlas_canvas_AtlasCanvasView.added_size', { size: overlay.added.size })}</span><span className="atlas-delta-removed">{tr('atlas_canvas_AtlasCanvasView.removed_size', { size: overlay.removed.size })}</span><span>{tr('atlas_canvas_AtlasCanvasView.unchanged_size', { size: overlay.unchanged.size })}</span></div>}
        <p className="atlas-canvas-source">{dataLabel(props.sourceLabel)} · {fromMain('ml_atlas_status', props.compatibilityLabel)}</p>
        {tipNode && tipAt && <div ref={tipRef} className="atlas-tip" role="tooltip" data-node-id={tipNode.nodeId} data-side={tipAt.x > (canvas.current?.clientWidth ?? 0) - 380 ? 'left' : 'right'} style={tipAt.x > (canvas.current?.clientWidth ?? 0) - 380 ? { right: (canvas.current?.clientWidth ?? 0) - tipAt.x + tipAt.r + 14, top: Math.max(8, tipAt.y - 24) } : { left: tipAt.x + tipAt.r + 14, top: Math.max(8, tipAt.y - 24) }}>
          <div className="atlas-tip-head"><Art art={artFor(tipNode.nodeId)} name={tipNode.name} /><span><strong>{tipNode.name}</strong><small>{tipNode.isRoot ? tr('atlas_canvas_AtlasCanvasView.start') : tipNode.type === 'Type unverified' ? tr('atlas_canvas_AtlasCanvasView.small_passive') : label(tipNode.type)}</small></span></div>
          {tipNode.lines.filter(line => !isRawStatId(line)).slice(0, 8).map((line, index) => <p key={index}>{line}</p>)}
          {props.smart && !tipNode.isRoot && <p className="atlas-tip-action">{({ none: tr('atlas_canvas_AtlasCanvasView.click_to_want_it'), want: tr('atlas_canvas_AtlasCanvasView.wanted_click_to_avoid_it'), avoid: tr('atlas_canvas_AtlasCanvasView.avoided_click_to_clear_it') })[props.smart.marks.get(tipNode.nodeId) ?? 'none']}</p>}
          {!props.smart && tip?.kind === 'allocate' && <p className="atlas-tip-action">{editable ? tr('atlas_canvas_AtlasCanvasView.click_to_allocate') : tr('atlas_canvas_AtlasCanvasView.not_editable_here')} {tr('atlas_canvas_AtlasCanvasView.incrementalcost_points', { incrementalCost: amount(tip.preview.incrementalCost) })}{tip.preview.pathIds.length > 1 ? tr('atlas_canvas_AtlasCanvasView.length_nodes', { count: tip.preview.pathIds.length }) : ''}
            {tip.preview.overBudget.status === 'known' && tip.preview.overBudget.value > 0 ? <span className="atlas-canvas-warning"> {tr('atlas_canvas_AtlasCanvasView.value_over_budget', { value: tip.preview.overBudget.value })}</span> : null}</p>}
          {!props.smart && tip?.kind === 'remove' && <p className="atlas-tip-action atlas-tip-remove">{editable ? tr('atlas_canvas_AtlasCanvasView.click_to_remove') : tr('atlas_canvas_AtlasCanvasView.not_editable_here')} · {tr('atlas_canvas_AtlasCanvasView.count_nodes', { count: tip.preview.removedIds.length })}</p>}
          {tip?.kind === 'unavailable' && <p>{fromMain('ml_atlas_errors', tip.reason)}</p>}
          {!!props.stepMembership?.[tipNode.nodeId]?.length && <p className="atlas-tip-steps">{tr('atlas_canvas_AtlasCanvasView.in')} {props.stepMembership[tipNode.nodeId]!.map(s => s.label).join(', ')}</p>}
        </div>}
      </div>
      {showDetails && <aside className="atlas-canvas-panel" aria-label={listOpen ? tr('atlas_canvas_AtlasCanvasView.nodes') : tr('atlas_canvas_AtlasCanvasView.node_details')}>
        {listOpen && <><div className="atlas-canvas-panel-header"><strong>{tr('atlas_canvas_AtlasCanvasView.nodes')}</strong><button className="btn" type="button" aria-label={tr('atlas_canvas_AtlasCanvasView.close_nodes_list')} onClick={() => { setListOpen(false); setPinned(null); setFocused(null); listButton.current?.focus(); }}>{tr('atlas_canvas_AtlasCanvasView.close')}</button></div>
          <Segmented value={filter} onChange={setFilter} ariaLabel={tr('atlas_canvas_AtlasCanvasView.node_filter')} options={[{ value: 'all', label: tr('atlas_canvas_AtlasCanvasView.all') }, { value: 'allocated', label: tr('atlas_canvas_AtlasCanvasView.allocated') }, { value: 'matches', label: tr('atlas_canvas_AtlasCanvasView.search_matches') }]} />
          <ul id={`${id}-nodes`} className="atlas-node-list" aria-label={tr('atlas_canvas_AtlasCanvasView.atlas_nodes')}>{shown.map((row, index) => <NodeListRow key={row.nodeId} row={row} index={index} pressed={pinned === row.nodeId} disabled={!editable || !rowActionAvailable(model, reachable, allocatedIds, row.nodeId)} art={artFor(row.nodeId)} ctl={listCtl} />)}</ul>{!rows.length && <p>{query.trim() ? tr('atlas_canvas_AtlasCanvasView.no_nodes_match_this_search') : filter === 'allocated' ? tr('atlas_canvas_AtlasCanvasView.no_allocated_nodes') : tr('atlas_canvas_AtlasCanvasView.search_nodes_to_show_matches')}</p>}</>}
        {detail && <div className="atlas-node-detail" aria-label={tr('atlas_canvas_AtlasCanvasView.node_details')}>
          <div className="atlas-node-title"><Art art={artFor(detail.nodeId)} name={detail.name} /><strong>{detail.name}</strong></div>
          {detail.lines.map((line, index) => <p key={index}>{line}</p>)}
          {detail.repair && <p>{tr('atlas_canvas_AtlasCanvasView.needs_repair')}</p>}
          {inspection?.kind === 'allocate' && <><p>{tr('atlas_canvas_AtlasCanvasView.path_adds_incrementalcost_points', { incrementalCost: amount(inspection.preview.incrementalCost) })}</p><p>{tr('atlas_canvas_AtlasCanvasView.total_after_totalcost_budget', { totalCost: amount(inspection.preview.totalCost), budget })}</p>
            {inspection.preview.overBudget.status === 'known' && inspection.preview.overBudget.value > 0 && <p className="atlas-canvas-warning">{tr('atlas_canvas_AtlasCanvasView.value_points_over_your_budget', { value: inspection.preview.overBudget.value })}</p>}
            {inspection.preview.pathBasis === 'topology_only' && <p>{tr('atlas_canvas_AtlasCanvasView.point_costs_unverified_preview_uses')}</p>}
            <p>{tr('atlas_canvas_AtlasCanvasView.path')} {inspection.preview.pathIds.filter(nodeId => nodeId !== model.graph.rootId).map(nodeId => nodeName(nodeId)).join(' → ')}</p></>}
          {inspection?.kind === 'remove' && <p>{tr('atlas_canvas_AtlasCanvasView.remove_length_connected_nodes', { count: inspection.preview.removedIds.length })} {inspection.preview.removedIds.map(nodeId => nodeName(nodeId)).join(', ')}</p>}
          {inspection?.kind === 'unavailable' && <p>{fromMain('ml_atlas_errors', inspection.reason)}</p>}
          {inspection?.kind === 'root' && <p>{tr('atlas_canvas_AtlasCanvasView.start_cost', { cost: points(detail.cost) })}</p>}
          {!!props.stepMembership?.[detail.nodeId]?.length && <p>{tr('atlas_canvas_AtlasCanvasView.in_steps')} {props.stepMembership[detail.nodeId]!.map(step => <button type="button" className="btn" key={step.stepId} disabled={!props.onSelectStep} onClick={() => props.onSelectStep?.(step.stepId, detail.nodeId)}>{step.label}</button>)}</p>}
          <p>{tr('atlas_canvas_AtlasCanvasView.source_sourcelabel', { sourceLabel: dataLabel(props.sourceLabel) })}</p>
          <div className="atlas-canvas-detail-actions"><button type="button" className="btn" onClick={() => setPinned(detail.nodeId)}>{tr('atlas_canvas_AtlasCanvasView.pin')}</button>
            {(inspection?.kind === 'allocate' || inspection?.kind === 'remove') && <button type="button" className="btn" disabled={!editable} onClick={() => activate(detail.nodeId)}>{inspection.kind === 'allocate' ? tr('atlas_canvas_AtlasCanvasView.allocate_path') : tr('atlas_canvas_AtlasCanvasView.unallocate')}</button>}</div>
        </div>}
      </aside>}
    </div>
    <p id={`${id}-help`} className="atlas-canvas-help atlas-sr">{tr('atlas_canvas_AtlasCanvasView.search_ctrl_f_enter_to')}</p>
    {notice && <p role="status">{notice}</p>}
    {pending && <Dialog title={tr('atlas_canvas_AtlasCanvasView.remove_this_path')} confirmLabel={pendingStale ? null : tr('atlas_canvas_AtlasCanvasView.remove')} cancelLabel={tr('atlas_canvas_AtlasCanvasView.cancel')} onCancel={() => { setPending(null); setPinned(null); setHover(null); setFocused(null); }} onConfirm={() => {
      if (pendingStale) { setNotice(tr('atlas_canvas_AtlasCanvasView.the_plan_changed_review_this')); return; }
      commit(pending.nodeId, inspectNode(model, allocatedIds, pending.nodeId, budget));
    }}>
      {pendingStale ? <p>{tr('atlas_canvas_AtlasCanvasView.the_plan_changed_review_this')}</p> : inspection?.kind === 'remove' && <><p>{tr('atlas_canvas_AtlasCanvasView.length_connected_nodes_will_also', { count: inspection.preview.cascadeIds.length })}</p><ul>{inspection.preview.removedIds.map(nodeId => <li key={nodeId}>{nodeName(nodeId)}</li>)}</ul></>}
    </Dialog>}
  </section>;
}
