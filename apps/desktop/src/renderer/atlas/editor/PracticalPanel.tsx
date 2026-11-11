import { useEffect, useMemo, useRef, useState } from 'react';
import { dataLabel } from '../canvas/model.js';
import { statLabel } from '../../../shared/atlas/statText.js';
import type { AtlasPlan, AtlasStep, CatalogEntry, StepId } from '@pom/mastery-contracts';
import { Dialog, Segmented } from '../../ui.js';
import { ItemArt } from '../../documents/ItemCard.js';
import { statTotals, summarizeStats } from '../../../shared/atlas/stats.js';
import type { AtlasGraph } from '../../../shared/atlas/graph.js';
import { pointSummary, practicalTabs, rowPrice, type Edit, type PracticalTab } from './presenter.js';
import type { AssetRef } from '@pom/mastery-contracts';
import { tr, inLanguage } from '../../i18n';

export type EditorArt = (asset: AssetRef | null, id: string) => string | undefined;
export function GameName({ name, asset, id, art }: { name: string; asset: AssetRef | null; id: string; art?: EditorArt }) {
  return <span className="atlas-game-name"><ItemArt art={{ name, src: art?.(asset, id) }} /><span title={name}>{name}</span></span>;
}
export function NumberField({ label, value, onChange, disabled, min = 0 }: { label: string; value: number; onChange: (value: number) => void; disabled?: boolean; min?: number }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const valid = draft !== '' && Number.isSafeInteger(Number(draft)) && Number(draft) >= min;
  return <label className="atlas-field">{label}<input className="field" type="number" min={min} step="1" aria-invalid={!valid || undefined} value={draft} disabled={disabled}
    onChange={e => { setDraft(e.target.value); if (e.target.value !== '' && Number.isSafeInteger(Number(e.target.value)) && Number(e.target.value) >= min) onChange(Number(e.target.value)); }} />
    {!valid && <small role="alert">{tr('atlas_editor_PracticalPanel.enter_a_nonnegative_whole_number')}</small>}</label>;
}
export function PracticalPanel({ plan, step, graph, catalogs, tab, onTab, edit, flush, readOnly, art, scroll, onScroll, onHighlight, maximumLabel }: {
  plan: AtlasPlan; step: AtlasStep; graph?: AtlasGraph; catalogs: { maps: CatalogEntry[]; scarabs: CatalogEntry[] };
  tab: PracticalTab; onTab: (tab: PracticalTab) => void; edit: (edit: Edit, text?: boolean) => void; flush: () => void;
  readOnly: boolean; art?: EditorArt; scroll: number; onScroll: (value: number) => void; onHighlight: (ids: string[]) => void; maximumLabel: string;
}) {
  const [picker, setPicker] = useState<'maps' | 'scarabs' | null>(null), [query, setQuery] = useState(''), [pickTier, setPickTier] = useState('');
  const [scope, setScope] = useState<StepId | 'plan'>(step.stepId), [mode, setMode] = useState<'Strategy' | 'Run instructions'>('Strategy');
  const [statQuery, setStatQuery] = useState(''), [pins, setPins] = useState<string[]>([]);
  const [rowQuery, setRowQuery] = useState('');
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { if (body.current) body.current.scrollTop = scroll; }, [step.stepId, tab]);
  useEffect(() => { if (scope !== 'plan') setScope(step.stepId); }, [step.stepId]);
  const stats = useMemo(() => graph ? summarizeStats(graph, step.allocatedIds) : null, [graph, step.allocatedIds]);
  const totals = useMemo(() => graph ? statTotals(graph, step.allocatedIds) : [], [graph, step.allocatedIds]);
  const points = pointSummary(graph, step);
  const notes = scope === 'plan' ? plan : step;
  const notesEdit = (data: Pick<Extract<Edit, { kind: 'notes' }>, 'strategy' | 'instructions'>) => edit({ kind: 'notes', scope, ...data }, true);
  return <aside className="atlas-practical" aria-label={tr('atlas_editor_PracticalPanel.practical_fields')} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { const search = e.currentTarget.querySelector<HTMLInputElement>('input[data-panel-search]'); if (search) { e.preventDefault(); e.stopPropagation(); search.focus(); search.select(); } } }}>
    <div className="atlas-point-count" title={maximumLabel}><strong>{points.spent.status === 'known' ? points.spent.value : tr('atlas_editor_PracticalPanel.unknown')} {tr('atlas_editor_PracticalPanel.budget_points', { budget: points.budget })}</strong>{points.over !== null && points.over > 0 && <span className="atlas-warning">{tr('atlas_editor_PracticalPanel.over_over', { over: points.over })}</span>}</div>
    <NumberField label={tr('atlas_editor_PracticalPanel.budget')} value={step.pointBudget} disabled={readOnly} onChange={value => edit({ kind: 'step', stepId: step.stepId, field: 'pointBudget', value })} /><small style={{ overflowWrap: 'anywhere' }}>{maximumLabel}</small>
    <Segmented ariaLabel={tr('atlas_editor_PracticalPanel.practical_fields')} value={tab} onChange={onTab} options={practicalTabs.map(value => ({ value, label: inLanguage('h_atlasA_L', value) }))} />
    <div ref={body} className="atlas-panel-scroll" onScroll={e => onScroll(e.currentTarget.scrollTop)}>
      {tab === 'Stats' && <><label className="atlas-field">{tr('atlas_editor_PracticalPanel.search_stats')}<input data-panel-search className="field" placeholder={tr('atlas_editor_PracticalPanel.search_stats_2')} value={statQuery} onChange={e => setStatQuery(e.target.value)} /></label>
        {!stats || !stats.additive.length && !stats.separate.length ? <p>{tr('atlas_editor_PracticalPanel.no_allocated_stats')}</p> : <>
          {stats.additive.filter(row => row.sourceTexts.some(t => t.toLowerCase().includes(statQuery.toLowerCase()))).map(row => {
            const key = `${row.statId}:${row.effectSchemaHash}`;
            return <div className="atlas-stat-row" key={key}><button type="button" className="atlas-stat-inspect" onClick={() => onHighlight(row.nodeIds)}>{statLabel(row.sourceTexts)}: {row.value.status === 'known' ? row.value.value : tr('atlas_editor_PracticalPanel.unknown')}</button>
              <button type="button" className="btn" aria-pressed={pins.includes(key)} disabled={!pins.includes(key) && pins.length >= 2} onClick={() => setPins(old => old.includes(key) ? old.filter(k => k !== key) : [...old, key])}>{tr('atlas_editor_PracticalPanel.pin')}</button>
              <details><summary>{tr('atlas_editor_PracticalPanel.sources')}</summary>{row.nodeIds.map(id => <GameName key={id} id={id} name={graph!.nodes.get(id)!.name} asset={graph!.nodes.get(id)!.asset} art={art} />)}</details></div>;
          })}
          {totals.filter(row => row.text.toLowerCase().includes(statQuery.toLowerCase())).map(row => <div className="atlas-stat-row" key={row.key}><button type="button" className="atlas-stat-inspect" title={tr('atlas_editor_PracticalPanel.show_these_nodes_on_the')} onClick={() => onHighlight(row.nodeIds)}>{row.text}</button>
            {(row.count > 1 || row.conditional) && <small>{[row.count > 1 ? (row.summed ? tr('atlas_editor_PracticalPanel_2.nodes', { count: row.count }) : `x${row.count}`) : '', row.conditional ? tr('atlas_editor_PracticalPanel_2.conditional') : ''].filter(Boolean).join(', ')}</small>}</div>)}
        </>}
      </>}
      {(tab === 'Maps' || tab === 'Scarabs') && (() => {
        const list = tab === 'Maps' ? 'maps' : 'scarabs';
        return <><button type="button" className="btn" disabled={readOnly} onClick={() => { setQuery(''); setPickTier(''); setPicker(list); }}>{tr('atlas_editor_PracticalPanel.add')} {list === 'maps' ? tr('atlas_editor_PracticalPanel.map') : tr('atlas_editor_PracticalPanel.scarab')}</button><label className="atlas-field">{tr('atlas_editor_PracticalPanel.search_list', { list })}<input data-panel-search className="field" placeholder={tr('atlas_editor_PracticalPanel.search_list_2', { list })} value={rowQuery} onChange={e => setRowQuery(e.target.value)} /></label>
          {!step[list].length && <p>{list === 'maps' ? tr('atlas_editor_PracticalPanel.no_maps_selected') : tr('atlas_editor_PracticalPanel.no_scarabs_selected')}</p>}
          {step[list].map((row, index) => {
            const catalog = catalogs[list].find(c => c.catalogId === row.catalogId);
            if (!(catalog?.name ?? row.catalogId).toLowerCase().includes(rowQuery.toLowerCase())) return null;
            return <div key={`${row.catalogId}:${index}`} className="atlas-practical-row" tabIndex={0} draggable={!readOnly && list === 'maps'}
              onDragStart={e => e.dataTransfer.setData('application/x-atlas-map', String(index))} onDragOver={e => { if (list === 'maps') e.preventDefault(); }}
              onDrop={e => { e.preventDefault(); const from = Number(e.dataTransfer.getData('application/x-atlas-map')); if (!readOnly && list === 'maps' && Number.isInteger(from)) edit({ kind: 'moveMap', stepId: step.stepId, from, to: index }); }}
              onKeyDown={e => { if (list === 'maps' && e.ctrlKey && e.shiftKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); const to = index + (e.key === 'ArrowUp' ? -1 : 1); if (!readOnly && to >= 0 && to < step.maps.length) edit({ kind: 'moveMap', stepId: step.stepId, from: index, to }); } }}>
              <GameName id={row.catalogId} name={catalog?.name ?? tr('atlas_editor_PracticalPanel_2.unverified_item')} asset={catalog?.asset ?? null} art={art} />{!catalog && <code>{row.catalogId}</code>}
              {list === 'scarabs' ? <><div className="atlas-quantity"><button type="button" className="btn" aria-label={tr('atlas_editor_PracticalPanel.decrease_quantity_for_catalogid', { catalogId: catalog?.name ?? row.catalogId })} disabled={readOnly || row.quantity === 0} onClick={() => edit({ kind: 'quantity', stepId: step.stepId, catalogId: row.catalogId, quantity: row.quantity - 1 })}>-</button>
                <NumberField label={tr('atlas_editor_PracticalPanel.quantity_per_map')} value={row.quantity} disabled={readOnly} onChange={quantity => edit({ kind: 'quantity', stepId: step.stepId, catalogId: row.catalogId, quantity })} />
                <button type="button" className="btn" aria-label={tr('atlas_editor_PracticalPanel.increase_quantity_for_catalogid', { catalogId: catalog?.name ?? row.catalogId })} disabled={readOnly} onClick={() => edit({ kind: 'quantity', stepId: step.stepId, catalogId: row.catalogId, quantity: row.quantity + 1 })}>+</button></div><small>{tr('atlas_editor_PracticalPanel.quantity_limit_unverified')}</small></>
                : <><small className="atlas-priority">{tr('atlas_editor_PracticalPanel.priority_index', { index: index + 1 })}</small>
                  <div className="atlas-map-fields"><label className="atlas-field">{tr('atlas_editor_PracticalPanel.tier')}<input className="field" type="number" min={1} step="1" placeholder={tr('atlas_editor_PracticalPanel.not_set')} aria-label={tr('atlas_editor_PracticalPanel.tier_for_catalogid', { catalogId: catalog?.name ?? row.catalogId })} value={row.tier ?? ''} disabled={readOnly}
                    onChange={e => { const v = e.target.value; if (v === '') edit({ kind: 'mapField', stepId: step.stepId, index, tier: null }, true); else if (Number.isSafeInteger(Number(v)) && Number(v) >= 1) edit({ kind: 'mapField', stepId: step.stepId, index, tier: Number(v) }, true); }} onBlur={flush} /></label>
                  <label className="atlas-field">{tr('atlas_editor_PracticalPanel.purpose')}<input className="field" maxLength={200} placeholder={tr('atlas_editor_PracticalPanel.what_this_map_is_for')} aria-label={tr('atlas_editor_PracticalPanel.purpose_for_catalogid', { catalogId: catalog?.name ?? row.catalogId })} value={row.purpose ?? ''} disabled={readOnly}
                    onChange={e => edit({ kind: 'mapField', stepId: step.stepId, index, purpose: e.target.value }, true)} onBlur={flush} /></label></div>
                  <div className="atlas-row-actions">{[-1, 1].map(offset => <button type="button" className="btn" key={offset} disabled={readOnly || index + offset < 0 || index + offset >= step.maps.length} onClick={() => edit({ kind: 'moveMap', stepId: step.stepId, from: index, to: index + offset })}>{offset < 0 ? tr('atlas_editor_PracticalPanel.move_up') : tr('atlas_editor_PracticalPanel.move_down')}</button>)}</div></>}
              <p>{rowPrice(row)}</p><button type="button" className="btn" disabled={readOnly} onClick={() => edit({ kind: 'removeRow', stepId: step.stepId, list, index })}>{tr('atlas_editor_PracticalPanel.remove')}</button>
            </div>;
          })}
          <p>{list === 'scarabs' ? tr('atlas_editor_PracticalPanel.quantities_are_per_map') : tr('atlas_editor_PracticalPanel.favourite_slots_unverified')}</p>
        </>;
      })()}
      {tab === 'Notes' && <><Segmented ariaLabel={tr('atlas_editor_PracticalPanel.note_scope')} value={scope === 'plan' ? 'Whole plan' : 'This step'} onChange={v => setScope(v === 'Whole plan' ? 'plan' : step.stepId)} options={['This step', 'Whole plan'].map(value => ({ value, label: inLanguage('h_atlasA_L', value) }))} />
        <Segmented ariaLabel={tr('atlas_editor_PracticalPanel.note_mode')} value={mode} onChange={setMode} options={(['Strategy', 'Run instructions'] as const).map(value => ({ value, label: inLanguage('h_atlasA_L', value) }))} />
        {mode === 'Strategy' ? <label className="atlas-field">{tr('atlas_editor_PracticalPanel.strategy')}<textarea className="field" placeholder={tr('atlas_editor_PracticalPanel.write_strategy_notes')} value={notes.strategy} disabled={readOnly} onChange={e => notesEdit({ strategy: e.target.value })} onBlur={flush} /></label>
          : <>{(['firstAction', 'details', 'whenReady'] as const).map(field => <label className="atlas-field" key={field}>{{ firstAction: tr('atlas_editor_PracticalPanel.first_action'), details: tr('atlas_editor_PracticalPanel_2.details'), whenReady: tr('atlas_editor_PracticalPanel.when_ready') }[field]}
            <textarea className="field" maxLength={field === 'firstAction' ? 160 : field === 'details' ? 10000 : undefined} value={notes.instructions[field]} disabled={readOnly} onChange={e => notesEdit({ instructions: { [field]: e.target.value } })} onBlur={flush} />
            <small>{[...notes.instructions[field]].length}{field === 'firstAction' ? ' / 160' : field === 'details' ? ' / 10000' : ''}</small></label>)}</>}
        <small>{notes.strategy.trim() ? notes.strategy.trim().split(/\s+/).length : 0} {tr('atlas_editor_PracticalPanel.words')}</small>
      </>}
    </div>
    {picker && <Dialog title={picker === 'maps' ? tr('atlas_editor_PracticalPanel.add_map') : tr('atlas_editor_PracticalPanel.add_scarab')} onCancel={() => setPicker(null)} confirmLabel={null}>
      <label className="atlas-field">{tr('atlas_editor_PracticalPanel.search_picker', { picker })}<input className="field" placeholder={tr('atlas_editor_PracticalPanel.search_picker_2', { picker })} value={query} onChange={e => setQuery(e.target.value)} /></label>
      {picker === 'maps' && <label className="atlas-field">{tr('atlas_editor_PracticalPanel.tier_optional')}<input className="field" type="number" min={1} step="1" placeholder={tr('atlas_editor_PracticalPanel.not_set')} value={pickTier} onChange={e => setPickTier(e.target.value)} /></label>}
      {!catalogs[picker].length && <p>{tr('atlas_editor_PracticalPanel.catalog_unavailable_imported_rows_ar')}</p>}
      {catalogs[picker].filter(c => c.name.toLowerCase().includes(query.toLowerCase())).map(c => <button className="atlas-picker-row" type="button" key={c.catalogId} onClick={() => { edit({ kind: 'row', stepId: step.stepId, list: picker, catalog: c, ...(picker === 'maps' && pickTier !== '' && Number.isSafeInteger(Number(pickTier)) && Number(pickTier) >= 1 ? { tier: Number(pickTier) } : {}) }); setPicker(null); }}><GameName name={c.name} id={c.catalogId} asset={c.asset} art={art} /><small>{dataLabel(plan.dataset.datasetId)}</small><span>{tr('atlas_editor_PracticalPanel.add')}</span></button>)}
    </Dialog>}
  </aside>;
}
