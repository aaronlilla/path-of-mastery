import { useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { AssetRef } from '@pom/mastery-contracts';
import { GameName, type EditorArt } from '../editor/PracticalPanel.js';
import type { OptimizerController } from './controller.js';
import type { MechanicRow } from '../../../shared/atlas/suggestions/mechanics.js';
import { tr } from '../../i18n';

// view / onView / onWarmCold are kept for callers; the Warm/cold view never existed here, so its toggle is gone.
export type PanelProps = { controller: OptimizerController; art?: EditorArt; online?: boolean; onClose: () => void; onWarmCold?: () => void; view?: 'list' | 'warm'; onView?: (v: 'list' | 'warm') => void };
const SUSTAIN = ['none', 'some', 'more'] as const;
const SUSTAIN_LABEL = { none: () => tr('atlas_optimizer_OptimizerPanel_2.none'), some: () => tr('atlas_optimizer_OptimizerPanel_2.some'), more: () => tr('atlas_optimizer_OptimizerPanel_2.more') } as const;
const useOpt = (c: OptimizerController) => useSyncExternalStore(c.subscribe, c.snapshot, c.snapshot);

/** A mechanic's art is its first notable's icon: the art index is keyed by node id, not by the mechanic's target id. */
export function MechanicName({ m, art }: { m: { targetId: string; name: string; asset: AssetRef | null; notables?: readonly { nodeId: string }[] }; art?: EditorArt }) {
  return <GameName id={m.notables?.[0]?.nodeId ?? m.targetId} name={m.name} asset={m.asset} art={art} />;
}

/** Same choices as the Plan with AI map; this is the checkbox list. */
export function OptimizerPanel({ controller: c, art, onClose }: PanelProps) {
  const s = useOpt(c);
  const [query, setQuery] = useState(''), [targets, setTargets] = useState<MechanicRow | null>(null), [drag, setDrag] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const rows = s.mechanics.filter(m => !query.trim() || m.name.toLowerCase().includes(query.trim().toLowerCase()));
  const byId = new Map(s.mechanics.map(m => [m.targetId, m] as const));
  const nameOf = (id: string) => byId.get(id)?.name ?? (s.sustainNames && id === s.sustainNames.some ? s.sustainNames.some : id);
  const sustainRowName = (id: string) => c.o.sustain && (id === c.o.sustain.some.targetId || id === c.o.sustain.more.targetId)
    ? tr(id === c.o.sustain.more.targetId ? 'h_atlasA_M.sustain_more' : 'h_atlasA_M.sustain_some') : nameOf(id);
  const key = (e: KeyboardEvent, id: string) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); c.move(id, e.key === 'ArrowUp' ? -1 : 1); }
    else if (e.key === 'Delete') { e.preventDefault(); c.setMark(id, 'neutral'); }
  };
  const esc = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); search.current?.focus(); }
    if (e.key === 'Escape') { e.stopPropagation(); if (targets) setTargets(null); else if (s.status === 'running') c.cancel(); else onClose(); }
  };
  if (targets) {
    const chosen = s.choices.custom[targets.targetId] ?? targets.nodeIds;
    return <section className="opt-panel" aria-label={tr('atlas_optimizer_OptimizerPanel.choose_notables')} onKeyDown={esc}>
      <h2>{targets.name}</h2>
      <p className="opt-note">{tr('atlas_optimizer_OptimizerPanel.picking_notables_adds_name_to', { name: targets.name })}</p>
      {targets.notables.map(n => <label className="opt-notable" key={n.nodeId}><input type="checkbox" checked={chosen.includes(n.nodeId)}
        onChange={e => {
          const next = e.target.checked ? [...chosen, n.nodeId] : chosen.filter(x => x !== n.nodeId);
          c.setCustom(targets.targetId, next.length === targets.nodeIds.length ? null : next);
          // A picked notable means the player wants this mechanic: tick it so Find paths can run.
          const mk = c.markOf(targets.targetId);
          if (next.length && mk !== 'want') c.setMark(targets.targetId, 'want'); else if (!next.length && mk === 'want') c.setMark(targets.targetId, 'neutral');
        }} />
        <span className="opt-notable-text"><GameName id={n.nodeId} name={n.name} asset={n.asset} art={art} />{n.lines.length > 0 && <small>{n.lines.join(' / ')}</small>}</span></label>)}
      <div className="atlas-row-actions"><button type="button" className="btn" onClick={() => c.setCustom(targets.targetId, null)}>{tr('atlas_optimizer_OptimizerPanel.all')}</button><button type="button" className="btn gold" onClick={() => setTargets(null)}>{tr('atlas_optimizer_OptimizerPanel.done')}</button></div>
    </section>;
  }
  return <section className="opt-panel" aria-label={tr('atlas_optimizer_OptimizerPanel.optimize_mechanics')} onKeyDown={esc}>
    <header className="opt-head"><h2>{tr('atlas_optimizer_OptimizerPanel.optimize_mechanics')}</h2>
      <button type="button" className="btn ghost" aria-label={tr('atlas_optimizer_OptimizerPanel.close')} onClick={onClose}>{tr('atlas_optimizer_OptimizerPanel.x')}</button></header>
    <input ref={search} className="field" placeholder={tr('atlas_optimizer_OptimizerPanel.search_mechanics')} aria-label={tr('atlas_optimizer_OptimizerPanel.search_mechanics_2')} value={query} onChange={e => setQuery(e.target.value)} />
    {!s.mechanics.length && <p>{tr('atlas_optimizer_OptimizerPanel.no_mechanics_are_listed_in')}</p>}
    {!!s.mechanics.length && !rows.length && <p>{tr('atlas_optimizer_OptimizerPanel.no_mechanics_match_this_search')}</p>}
    <div className="opt-list" role="list">
      {rows.map(m => {
        const mk = c.markOf(m.targetId), custom = s.choices.custom[m.targetId];
        return <div className="opt-row" role="listitem" key={m.targetId}>
          <label className="opt-check"><input type="checkbox" checked={mk === 'want'} onChange={e => c.setMark(m.targetId, e.target.checked ? 'want' : 'neutral')} /><MechanicName m={m} art={art} /></label>
          {mk === 'avoid' && <span className="opt-chip cold">{tr('atlas_optimizer_OptimizerPanel.avoid')}</span>}
          <span className="opt-meta">{m.taxonomy.status === 'known' ? tr('atlas_optimizer_OptimizerPanel.length_notables', { value: custom?.length ?? m.nodeIds.length }) : m.problem ?? tr('atlas_optimizer_OptimizerPanel.targets_unverified')}{custom && tr('atlas_optimizer_OptimizerPanel.custom_targets')}</span>
          {m.nodeIds.length > 0 && <button type="button" className="btn" onClick={() => setTargets(m)}>{tr('atlas_optimizer_OptimizerPanel.choose_notables')}</button>}
        </div>;
      })}
    </div>
    <h3>{tr('atlas_optimizer_OptimizerPanel.priority')}</h3>
    {!s.choices.priority.length && <p>{tr('atlas_optimizer_OptimizerPanel.choose_at_least_one_mechanic')}</p>}
    <ol className="opt-priority">
      {s.choices.priority.map((id, i) => <li key={id} className="opt-row" data-drag={drag === id || undefined} draggable onDragStart={() => setDrag(id)} onDragEnd={() => setDrag(null)}
        onDragOver={e => e.preventDefault()} onDrop={() => { if (drag) c.moveTo(drag, i); setDrag(null); }}>
        <span className="opt-handle" tabIndex={0} role="button" aria-label={tr('atlas_optimizer_OptimizerPanel.reorder_id_press_ctrl_and', { id: sustainRowName(id) })} onKeyDown={e => key(e, id)}>::</span>
        <span className="opt-rank">{i + 1}</span><span className="opt-name" title={sustainRowName(id)}>{sustainRowName(id)}</span>
        {s.rowPlan.unavailable.find(u => u.targetId === id) && <span className="opt-chip warn">{s.rowPlan.unavailable.find(u => u.targetId === id)!.label}</span>}
        <button type="button" className="btn" aria-label={tr('atlas_optimizer_OptimizerPanel.move_id_up', { id: sustainRowName(id) })} disabled={i === 0} onClick={() => c.move(id, -1)}>{tr('atlas_optimizer_OptimizerPanel.up')}</button>
        <button type="button" className="btn" aria-label={tr('atlas_optimizer_OptimizerPanel.move_id_down', { id: sustainRowName(id) })} disabled={i === s.choices.priority.length - 1} onClick={() => c.move(id, 1)}>{tr('atlas_optimizer_OptimizerPanel.down')}</button>
        <button type="button" className="btn" aria-label={tr('atlas_optimizer_OptimizerPanel.remove_id', { id: sustainRowName(id) })} onClick={() => id === c.o.sustain?.some.targetId || id === c.o.sustain?.more.targetId ? c.setSustain('none') : c.setMark(id, 'neutral')}>{tr('atlas_optimizer_OptimizerPanel.remove')}</button>
      </li>)}
    </ol>
    {s.rowPlan.overlaps.map(o => <p key={o.targetId + o.withName} className="opt-note">{tr('atlas_optimizer_OptimizerPanel.targetid_shares_a_notable_with', { targetId: nameOf(o.targetId), withName: o.withName })}</p>)}
    <div className="opt-field"><label htmlFor="opt-sustain">{tr('atlas_optimizer_OptimizerPanel.map_sustain')}</label>
      <input id="opt-sustain" type="range" min={0} max={2} step={1} value={SUSTAIN.indexOf(s.choices.sustain)} disabled={!s.sustainAvailable} aria-valuetext={SUSTAIN_LABEL[s.choices.sustain]()}
        onChange={e => c.setSustain(SUSTAIN[Number(e.target.value)]!)} onKeyDown={e => { if (e.key === 'Home') { e.preventDefault(); c.setSustain('none'); } if (e.key === 'End') { e.preventDefault(); c.setSustain('more'); } }} />
      <span>{SUSTAIN_LABEL[s.choices.sustain]()}</span>{!s.sustainAvailable && <small>{s.sustainReason}</small>}
      {s.sustainAvailable && s.choices.sustain !== 'none' && <small>{c.o.sustain![s.choices.sustain].name}</small>}</div>
    <div className="opt-field"><label htmlFor="opt-budget">{tr('atlas_optimizer_OptimizerPanel.point_budget')}</label>
      <button type="button" className="btn" aria-label={tr('atlas_optimizer_OptimizerPanel.decrease_budget')} onClick={() => c.stepBudget(-1)}>-</button>
      <input id="opt-budget" className="field opt-num" inputMode="numeric" value={s.budgetText} aria-invalid={!!s.budgetError} aria-describedby="opt-budget-err" onChange={e => c.setBudgetText(e.target.value)} />
      <button type="button" className="btn" aria-label={tr('atlas_optimizer_OptimizerPanel.increase_budget')} onClick={() => c.stepBudget(1)}>+</button><small>{tr('atlas_optimizer_OptimizerPanel.maximum_captext', { capText: s.capText })}</small>
      {s.budgetError && <small id="opt-budget-err" role="alert">{s.budgetError}</small>}</div>
    <label className="opt-check"><input type="checkbox" role="switch" checked={s.choices.retainCurrent} onChange={e => c.setRetain(e.target.checked)} />{tr('atlas_optimizer_OptimizerPanel.keep_current_allocations')}</label>
    <p className="opt-note">{tr('atlas_optimizer_OptimizerPanel.finds_connected_paths_proves_shortes')}</p>
    <p className="opt-note">{s.dataLabel}</p>
    {s.checking && <p role="status">{tr('atlas_optimizer_OptimizerPanel.checking')}</p>}
    {s.error && <p role="alert">{s.error}</p>}
    {s.findDisabled && s.findDisabled !== 'Choose at least one mechanic.' && <p role="status">{s.findDisabled}</p>}
    <footer className="atlas-row-actions">{s.status !== 'running' && <button type="button" className="btn" onClick={onClose}>{tr('atlas_optimizer_OptimizerPanel.cancel')}</button>}
      {s.status === 'running' ? <button type="button" className="btn gold" onClick={() => c.cancel()}>{tr('atlas_optimizer_OptimizerPanel.cancel')}</button>
        : <button type="button" className="btn gold" disabled={!!s.findDisabled} title={s.findDisabled ?? undefined} onClick={() => void c.find()}>{tr('atlas_optimizer_OptimizerPanel.find_paths')}</button>}</footer>
  </section>;
}
