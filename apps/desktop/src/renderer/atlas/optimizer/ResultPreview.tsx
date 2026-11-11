import { useState, useSyncExternalStore } from 'react';
import type { ArtResolver } from '../canvas/art.js';
import { changed, summaryLine, type Proposal } from '../../../shared/atlas/suggestions/proposal.js';
import { applySummary, summaryText } from '../../../shared/atlas/suggestions/summary.js';
import { PortalMenu } from '../../ui.js';
import type { OptimizerController } from './controller.js';
import { tr, inLanguage } from '../../i18n';

type Tab = 'Nodes' | 'Stats' | 'Targets';
type Props = { controller: OptimizerController; nodeArt?: ArtResolver; proposal?: Proposal | null; onChangeBudget: () => void; onBack: () => void; onApplied?: (summary: string) => void; extraActions?: boolean };

/** The preview is a ghost over the saved tree on the main canvas (AtlasArea draws it). Nothing here writes until
 * Apply. `ResultPreview` is the explanation at the top of the side column; `ResultActions` is the Apply bar the side column
 * keeps pinned to its bottom edge, so Apply is always on screen however far the column scrolls. */
export function ResultPreview({ controller: c, proposal }: Props) {
  const s = useSyncExternalStore(c.subscribe, c.snapshot, c.snapshot);
  const p = proposal ?? s.proposal, v = c.view();
  const [tab, setTab] = useState<Tab>('Nodes');
  if (!p || !v) return s.status === 'preparing' || s.status === 'running' ? <p role="status">{tr('atlas_optimizer_ResultPreview.checking')}</p> : null;
  const rule = proposal != null, stale = !rule && s.stale;
  const { added, removed } = changed(p.baseAllocatedIds, p.afterIds), identical = !added.length && !removed.length;
  const sum = applySummary(v.graph, p, s.choices.budget);
  const line = identical ? tr('atlas_optimizer_ResultPreview.your_tree_already_matches_these') : summaryLine(p.results);
  // Display names: the nameless start node (its export name is its id) reads Start, never a raw node id.
  // An id the tree data does not have (kept by an import with "Keep unknown") reads Unavailable node.
  const names = (ids: string[]) => ids.map(id => { if (!v.graph.nodes.has(id)) return tr('atlas_optimizer_ResultPreview.unavailable_node'); const n = v.graph.nodes.get(id)?.name?.trim(); return n && n !== id && !/^\d+$/.test(n) ? n : id === v.graph.rootId || v.graph.adjacent.get(id)?.includes(v.graph.rootId) ? tr('atlas_optimizer_ResultPreview_2.start') : tr('atlas_optimizer_ResultPreview.atlas_passive'); });
  const list = (label: string, ids: string[]) => ids.length > 0 && <details className="opt-names"><summary>{label} {ids.length}</summary><ul>{names(ids).map((n, i) => <li key={ids[i]}>{n}</li>)}</ul></details>;
  return <section className="opt-result" aria-label={tr('atlas_optimizer_ResultPreview.preview')} data-stale={stale || undefined}>
    <p className="opt-banner" role="status"><strong>{tr('atlas_optimizer_ResultPreview.preview_only')}</strong> / {stale ? tr('atlas_optimizer_ResultPreview.out_of_date') : p.certainty}{s.checking && !rule ? tr('atlas_optimizer_ResultPreview.updating') : ''}<small> {tr('atlas_optimizer_ResultPreview.shown_on_the_tree')}</small></p>
    <p className="opt-points"><strong>{tr('atlas_optimizer_ResultPreview.total_budget_points', { total: sum.total ?? '?', budget: sum.budget })}</strong>{sum.left !== null && <span className="opt-left"> {sum.left < 0 ? tr('atlas_optimizer_ResultPreview.left_over_budget', { left: -sum.left }) : tr('atlas_optimizer_ResultPreview.left_left', { left: sum.left })}</span>}</p>
    <p className="opt-summary">{identical ? tr('atlas_optimizer_ResultPreview.no_changes') : summaryText(sum)}</p>
    {sum.unspent && <p className="opt-unspent">{sum.unspent}</p>}
    {p.results.length > 0 && <ol className="opt-results">{p.results.map(r => <li key={r.targetId} data-tone={r.tone} title={r.tooltip}>
      <span className="opt-rank">{r.priority || '-'}</span> <span className="opt-name">{r.name}</span> <span className="opt-chip" data-tone={r.tone}>{r.label}</span>
      {r.detail && <small>{r.detail}</small>}</li>)}</ol>}
    {p.note && <small>{p.note}</small>}
    <div role="tablist" className="opt-tabs">{(['Nodes', 'Stats', 'Targets'] as Tab[]).map(t => <button key={t} type="button" role="tab" className="btn" aria-selected={tab === t} onClick={() => setTab(t)}>{inLanguage('h_atlasA_L', t)}</button>)}</div>
    <div className="opt-tabbody" role="tabpanel">
      {tab === 'Nodes' && <>{list(tr('atlas_optimizer_ResultPreview_2.added'), added)}{list(tr('atlas_optimizer_ResultPreview_2.removed'), removed)}{identical && <p>{tr('atlas_optimizer_ResultPreview.no_changes')}</p>}</>}
      {tab === 'Stats' && <p>{tr('atlas_optimizer_ResultPreview.open_stats_in_the_plan', { cost: p.contract.cost })}</p>}
      {tab === 'Targets' && (p.results.length ? p.results.map(r => <p key={r.targetId}><strong>{r.name}</strong>: {r.targetNodeIds.length ? names(r.targetNodeIds).join(', ') : tr('atlas_optimizer_ResultPreview.no_target_ids')}{r.tone !== 'reached' ? ` (${r.label})` : ''}</p>) : <p>{tr('atlas_optimizer_ResultPreview.this_path_has_one_target')}</p>)}
    </div>
    {p.incidental.map(i => <p key={i.name} className="opt-note">{tr('atlas_optimizer_ResultPreview.incidental_travel_through_name_count', { count: i.nodeIds.length, name: i.name })}. <details><summary>{tr('atlas_optimizer_ResultPreview.details')}</summary>{names(i.nodeIds).join(', ')}</details></p>)}
    {line && <p role="status">{line}</p>}
    {!p.qualified && <p className="opt-note">{tr('atlas_optimizer_ResultPreview.tree_data_is_unverified_so')}</p>}
  </section>;
}

export function ResultActions({ controller: c, proposal, onChangeBudget, onBack, onApplied, extraActions }: Props) {
  const s = useSyncExternalStore(c.subscribe, c.snapshot, c.snapshot);
  const p = proposal ?? s.proposal, v = c.view();
  const [notice, setNotice] = useState(''), [menu, setMenu] = useState(false);
  const [anchor] = useState(() => ({ current: null as HTMLElement | null }));
  if (!p || !v) return null;
  const rule = proposal != null, blocked = rule ? null : s.blocked, stale = !rule && s.stale;
  const { added, removed } = changed(p.baseAllocatedIds, p.afterIds), identical = !added.length && !removed.length;
  const label = p.certainty === 'Shortest' ? tr('atlas_optimizer_ResultPreview.apply_result') : tr('atlas_optimizer_ResultPreview.apply_best_found');
  const sum = applySummary(v.graph, p, s.choices.budget);
  const text = tr('atlas_optimizer_ResultPreview.applied_to_your_tree_sum', { sum: summaryText(sum), unspent: sum.unspent ? ` ${sum.unspent}` : '' });
  const run = async (fn: () => Promise<string | null> | string | null, done?: () => void) => { const err = await fn(); setNotice(err ?? ''); if (!err) done?.(); };
  return <div className="opt-apply-bar" aria-label={tr('atlas_optimizer_ResultPreview.preview_actions')}>
    {(stale || blocked) && <p role="alert">{blocked ?? tr('atlas_optimizer_ResultPreview.the_plan_changed_recalculate_this')}</p>}
    {notice && <p role="alert">{notice}</p>}
    <div className="atlas-row-actions">
      <button type="button" className="btn" onClick={() => { c.discard(); onBack(); }}>{tr('atlas_optimizer_ResultPreview.discard_preview')}</button>
      {!p.results.every(r => r.tone === 'reached') && <button type="button" className="btn" onClick={onChangeBudget}>{tr('atlas_optimizer_ResultPreview.change_budget')}</button>}
      {stale && <button type="button" className="btn" onClick={() => void c.recalculate()}>{tr('atlas_optimizer_ResultPreview.recalculate_preview')}</button>}
      {extraActions !== false && !rule && <>
        <button type="button" className="btn" ref={el => { anchor.current = el; }} aria-haspopup="menu" onClick={() => setMenu(!menu)} disabled={stale || identical}>{tr('atlas_optimizer_ResultPreview.add_as_alternative')}</button>
        <PortalMenu anchor={anchor} open={menu} onClose={() => setMenu(false)} label={tr('atlas_optimizer_ResultPreview.destination')}>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(false); void run(() => c.addDestination('alternative'), () => onApplied?.(tr('atlas_optimizer_ResultPreview.added_the_result_as_an'))); }}>{tr('atlas_optimizer_ResultPreview.add_as_alternative')}</button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(false); void run(() => c.addDestination('next'), () => onApplied?.(tr('atlas_optimizer_ResultPreview.added_the_result_as_the'))); }}>{tr('atlas_optimizer_ResultPreview.add_next_step')}</button>
        </PortalMenu></>}
      <button type="button" className="btn gold" disabled={!!blocked || stale || identical || (!rule && s.checking)} title={blocked ?? undefined}
        onClick={() => void run(() => (rule ? c.applyProposal(p) : c.apply()), () => onApplied?.(text))}>{label}</button>
    </div>
  </div>;
}
