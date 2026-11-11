import { useEffect, useMemo, useRef, useState } from 'react';
import { statLabel } from '../../../shared/atlas/statText.js';
import type { AtlasPlan, AtlasStep, StepId } from '@pom/mastery-contracts';
import { Dialog, Segmented, Select, Switch } from '../../ui.js';
import { AtlasCanvasView } from '../canvas/AtlasCanvasView.js';
import type { ArtResolver } from '../canvas/art.js';
import { sameCoordinates, stepIds, stepTitle, transition } from './presenter.js';
import { GameName, type EditorArt } from './PracticalPanel.js';
import type { EditorRecord } from './session.js';
import type { View } from '../canvas/model.js';
import { tr, inLanguage } from '../../i18n';

type Delta = ReturnType<typeof transition>;
function DeltaRows({ delta, tab, left, right, art }: { delta: Delta; tab: string; left: EditorRecord; right: EditorRecord; art?: EditorArt }) {
  const a = left.canvas?.graph, b = right.canvas?.graph;
  const [filter, setFilter] = useState('All');
  if (delta.empty) return <p>{tr('atlas_editor_Analysis.no_differences')}</p>;
  return <div className="atlas-delta-table">
    {delta.differentGraph && <p>{tr('atlas_editor_Analysis.different_tree_data_length_nodes', { count: delta.unmatchedIds.length })}</p>}
    {(tab === 'Nodes' || tab === 'Tree') && <><Segmented ariaLabel={tr('atlas_editor_Analysis.node_differences')} value={filter} onChange={setFilter} options={['All', 'Added', 'Removed', 'Unchanged'].map(value => ({ value, label: inLanguage('h_atlasA_L', value) }))} />{(['removedIds', 'addedIds', 'unchangedIds'] as const).filter(kind => filter === 'All' || filter === { removedIds: 'Removed', addedIds: 'Added', unchangedIds: 'Unchanged' }[kind]).map(kind => <section key={kind}><h3>{inLanguage('h_atlasA_L', { removedIds: 'Removed', addedIds: 'Added', unchangedIds: 'Unchanged' }[kind])}</h3>
      {delta[kind].map(id => { const node = (kind === 'removedIds' ? a : b)?.nodes.get(id), model = (kind === 'removedIds' ? left : right).canvas;
        // The model names the nameless start node "Start" (the export gives it its id as a name).
        const name = model?.nodes[model.denseById.get(id) ?? -1]?.name ?? node?.name ?? tr('atlas_editor_Analysis.node_id_is_unavailable_in', { id });
        return <div key={id}><GameName id={id} name={name} asset={node?.asset ?? null} art={art} />{!node && <code>{id}</code>}</div>; })}</section>)}</>}
    {tab === 'Stats' && <>{delta.stats.map(row => <div key={row.statId}><span>{statLabel(row.before[0]?.sourceTexts ?? row.after[0]?.sourceTexts ?? [], row.statId)}</span><span>{row.before[0]?.value.status === 'known' ? row.before[0].value.value : tr('atlas_editor_Analysis.unknown')} → {row.after[0]?.value.status === 'known' ? row.after[0].value.value : tr('atlas_editor_Analysis.unknown')}</span><strong>{row.status === 'not_comparable' ? tr('atlas_editor_Analysis.not_comparable_2') : row.delta}</strong></div>)}
      {[...delta.separateStats.before, ...delta.separateStats.after].map((row, index) => <p key={index}>{statLabel([row.stat.sourceText])}{tr('atlas_editor_Analysis.not_comparable')}</p>)}</>}
    {(tab === 'Maps' || tab === 'Scarabs') && delta.practical.filter(row => tab === 'Maps' ? row.kind !== 'scarabs' : row.kind === 'scarabs').map(row => {
      const catalog = [...left.view.data?.catalogs[row.kind === 'scarabs' ? 'scarabs' : 'maps'] ?? [], ...right.view.data?.catalogs[row.kind === 'scarabs' ? 'scarabs' : 'maps'] ?? []].find(c => c.catalogId === row.catalogId);
      return <div key={`${row.kind}:${row.catalogId}`}><GameName name={catalog?.name ?? tr('atlas_editor_Analysis_2.unverified_item')} asset={catalog?.asset ?? null} id={row.catalogId} art={art} /><code>{row.catalogId}</code><span>{row.before.map(r => r.quantity).join(', ') || tr('atlas_editor_Analysis.none')} → {row.after.map(r => r.quantity).join(', ') || tr('atlas_editor_Analysis.none')}</span><pre>{JSON.stringify(row.before)} → {JSON.stringify(row.after)}</pre></div>;
    })}
    {tab === 'Notes' && delta.fields.filter(row => ['strategy', 'instructions'].includes(row.field)).map(row => <div className="atlas-note-delta" key={row.field}><h3>{row.field === 'strategy' ? tr('atlas_editor_Analysis.strategy') : tr('atlas_editor_Analysis.run_instructions')}</h3><pre>- {typeof row.before === 'string' ? row.before : JSON.stringify(row.before, null, 2)}</pre><pre>+ {typeof row.after === 'string' ? row.after : JSON.stringify(row.after, null, 2)}</pre></div>)}
  </div>;
}
const stepOptions = (plan: AtlasPlan) => stepIds(plan).map(value => ({ value, label: stepTitle(plan.stepsById[value]!.title) }));
function ReadTree({ record, step, overlay, view, onViewChange, art }: { record: EditorRecord; step: AtlasStep; overlay?: Delta['overlay']; view?: View; onViewChange?: (view: View) => void; art?: ArtResolver }) {
  return record.canvas ? <AtlasCanvasView model={record.canvas} allocatedIds={step.allocatedIds} budget={step.pointBudget} sourceLabel={record.view.document.payload.dataset.datasetId} compatibilityLabel={record.view.data?.statusText ?? tr('atlas_editor_Analysis.live_compatibility_unverified')}
    readOnlyReason={tr('atlas_editor_Analysis.read_only_preview')} overlay={overlay} view={view} onViewChange={onViewChange} art={art} /> : <p>{tr('atlas_editor_Analysis.tree_data_is_unavailable_the')}</p>;
}
export function StepDiff({ record, plan, selected, close, copy, send, art, nodeArt }: { record: EditorRecord; plan: AtlasPlan; selected: StepId; close: () => void; copy: (text: string) => Promise<boolean>; send?: (delta: Delta) => void; art?: EditorArt; nodeArt?: ArtResolver }) {
  const sequence = plan.sequencePositions.map(p => p.kind === 'step' ? p.stepId : p.defaultStepId), current = sequence.findIndex(id => id === selected);
  const [from, setFrom] = useState<StepId>(sequence[Math.max(0, current - 1)] ?? stepIds(plan)[0]!), [to, setTo] = useState(selected);
  const [tab, setTab] = useState('Nodes'), [fallback, setFallback] = useState('');
  const delta = record.canvas ? transition(plan.stepsById[from]!, plan.stepsById[to]!, record.canvas.graph, record.canvas.graph, plan.dataset.datasetId) : null;
  return <Dialog title={tr('atlas_editor_Analysis.diff')} size="large" width={1120} onCancel={close} cancelLabel={tr('atlas_editor_Analysis.close')} confirmLabel={null}>
    <div className="atlas-row-actions"><Select ariaLabel={tr('atlas_editor_Analysis.from')} value={from} options={stepOptions(plan)} onChange={setFrom} /><Select ariaLabel={tr('atlas_editor_Analysis.to')} value={to} options={stepOptions(plan)} onChange={setTo} /><button type="button" className="btn" onClick={() => { setFrom(to); setTo(from); }}>{tr('atlas_editor_Analysis.swap')}</button></div>
    {delta ? <><div className="atlas-analysis-grid"><ReadTree record={record} step={plan.stepsById[to]!} overlay={delta.overlay} art={nodeArt} /><section><p>{tr('atlas_editor_Analysis.add_length_remove_length2_net', { count: delta.addedIds.length, count2: delta.removedIds.length, value: delta.addedIds.length - delta.removedIds.length })}</p><Segmented ariaLabel={tr('atlas_editor_Analysis.difference_fields')} value={tab} onChange={setTab} options={['Nodes', 'Stats', 'Maps', 'Scarabs', 'Notes'].map(value => ({ value, label: inLanguage('h_atlasA_L', value) }))} /><DeltaRows delta={delta} tab={tab} left={record} right={record} art={art} /></section></div>
      <div className="atlas-row-actions"><button type="button" className="btn" disabled={delta.empty} onClick={async () => { if (!await copy(delta.text)) setFallback(delta.text); }}>{tr('atlas_editor_Analysis.copy_transition_instructions')}</button>{send && <button type="button" className="btn" onClick={() => send(delta)}>{tr('atlas_editor_Analysis.send_to_timeline')}</button>}</div></> : <p>{tr('atlas_editor_Analysis.tree_data_is_unavailable_the')}</p>}
    {fallback && <label className="atlas-field">{tr('atlas_editor_Analysis.copy_transition_instructions')}<textarea className="field" readOnly value={fallback} onFocus={e => e.currentTarget.select()} /></label>}
  </Dialog>;
}
export function ComparePlans({ origin, initialRight, selected, records, read, open, add, close, art, nodeArt }: { origin: EditorRecord; initialRight?: EditorRecord; selected?: StepId; records: EditorRecord[]; read: (record: EditorRecord) => Promise<EditorRecord>; open: (id: EditorRecord['source']['objectId']) => void; add: (step: AtlasStep, source: EditorRecord) => void | Promise<void>; close: () => void; art?: EditorArt; nodeArt?: ArtResolver }) {
  const [left, setLeft] = useState(origin), [right, setRight] = useState<EditorRecord | null>(initialRight ?? null);
  const [leftStep, setLeftStep] = useState(selected ?? stepIds(origin.view.document.payload)[0]!), [rightStep, setRightStep] = useState<StepId | ''>(initialRight ? stepIds(initialRight.view.document.payload)[0]! : '');
  const [tab, setTab] = useState('Tree'), [side, setSide] = useState<'Left' | 'Right'>('Left'), [link, setLink] = useState(true);
  const [viewport, setViewport] = useState<View | undefined>(), [review, setReview] = useState(false), [busy, setBusy] = useState<'Left' | 'Right' | null>(null), [error, setError] = useState('');
  const generation = useRef({ Left: 0, Right: 0 });
  const failedRead = useRef<{ id: string; which: 'Left' | 'Right' } | null>(null);
  useEffect(() => () => { generation.current.Left++; generation.current.Right++; }, []);
  const equivalent = sameCoordinates(left.canvas?.scope, right?.canvas?.scope);
  useEffect(() => setLink(equivalent), [equivalent]);
  const delta = useMemo(() => left.canvas && right?.canvas && rightStep ? transition(left.view.document.payload.stepsById[leftStep]!, right.view.document.payload.stepsById[rightStep]!, left.canvas.graph, right.canvas.graph, right.view.document.payload.dataset.datasetId) : null, [left, right, leftStep, rightStep]);
  const choose = async (id: string, which: 'Left' | 'Right') => {
    if (!id && which === 'Right') { generation.current.Right++; setRight(null); setRightStep(''); setBusy(null); return; }
    const item = records.find(r => r.source.objectId === id); if (!item) return;
    const request = ++generation.current[which];
    setBusy(which); setError('');
    try { const result = await read(item); if (request !== generation.current[which]) return; const ids = stepIds(result.view.document.payload), index = stepIds(left.view.document.payload).indexOf(leftStep);
      if (which === 'Left') { setLeft(result); setLeftStep(ids[0]!); } else { setRight(result); setRightStep(ids[index] ?? ids[0]!); }
    } catch { if (request === generation.current[which]) { failedRead.current = { id, which }; setError(tr('atlas_editor_Analysis.could_not_load_atlas_plan')); } } finally { if (request === generation.current[which]) setBusy(null); }
  };
  return <Dialog title={tr('atlas_editor_Analysis.compare_atlas_plans')} size="large" width={1280} onCancel={close} cancelLabel={tr('atlas_editor_Analysis.close')} confirmLabel={null}>
    <div className="atlas-compare-pickers"><Select ariaLabel={tr('atlas_editor_Analysis.left_plan')} value={left.source.objectId} options={records.map(r => ({ value: r.source.objectId, label: r.view.document.payload.title }))} onChange={id => void choose(id, 'Left')} /><Select ariaLabel={tr('atlas_editor_Analysis.left_step')} value={leftStep} options={stepOptions(left.view.document.payload)} onChange={setLeftStep} />
      <span className="atlas-switch-label"><Switch checked={link && equivalent} disabled={!equivalent} label={tr('atlas_editor_Analysis.link_viewports')} onChange={setLink} /><span aria-hidden="true">{tr('atlas_editor_Analysis.link_viewports')}</span></span>
      <Select ariaLabel={tr('atlas_editor_Analysis.right_plan')} value={right?.source.objectId ?? ''} options={[{ value: '', label: tr('atlas_editor_Analysis.choose_a_plan') }, ...records.map(r => ({ value: r.source.objectId, label: r.view.document.payload.title }))]} onChange={id => void choose(id, 'Right')} />
      {right && <Select ariaLabel={tr('atlas_editor_Analysis.right_step')} value={rightStep} options={stepOptions(right.view.document.payload)} onChange={setRightStep} />}</div>
    {!equivalent && right && <p>{tr('atlas_editor_Analysis.different_tree_coordinates_link_view')}</p>}
    <div className="atlas-compare-side"><Segmented ariaLabel={tr('atlas_editor_Analysis.compare_canvas')} value={side} onChange={setSide} options={(['Left', 'Right'] as const).map(value => ({ value, label: inLanguage('h_atlasA_L', value) }))} /></div>
    <div className="atlas-compare-trees" data-side={side}><section className="atlas-compare-left"><h3>{tr('atlas_editor_Analysis.left')}</h3><p>{tr('atlas_editor_Analysis.saved_for')} {left.view.document.payload.stamp.leagueId.status === 'known' ? left.view.document.payload.stamp.leagueId.value : tr('atlas_editor_Analysis.unknown')}</p><ReadTree record={left} step={left.view.document.payload.stepsById[leftStep]!} view={link ? viewport : undefined} onViewChange={link ? setViewport : undefined} art={nodeArt} /></section>
      <section className="atlas-compare-right"><h3>{tr('atlas_editor_Analysis.right')}</h3>{right && rightStep ? <><p>{tr('atlas_editor_Analysis.saved_for')} {right.view.document.payload.stamp.leagueId.status === 'known' ? right.view.document.payload.stamp.leagueId.value : tr('atlas_editor_Analysis.unknown')}</p><ReadTree record={right} step={right.view.document.payload.stepsById[rightStep]!} view={link ? viewport : undefined} onViewChange={link ? setViewport : undefined} art={nodeArt} /></> : <p>{tr('atlas_editor_Analysis.choose_a_plan')}</p>}</section></div>
    {busy && <p role="status">{tr('atlas_editor_Analysis.updating_busy', { busy })}</p>}{error && <p role="alert">{error}<button type="button" className="btn" onClick={() => { const failed = failedRead.current; if (failed) void choose(failed.id, failed.which); }}>{tr('atlas_editor_Analysis.retry')}</button></p>}
    <Segmented ariaLabel={tr('atlas_editor_Analysis.compare_fields')} value={tab} onChange={setTab} options={['Tree', 'Stats', 'Maps', 'Scarabs', 'Notes'].map(value => ({ value, label: inLanguage('h_atlasA_L', value) }))} />
    {delta && right && <DeltaRows delta={delta} tab={tab} left={left} right={right} art={art} />}
    <div className="atlas-row-actions"><button type="button" className="btn" onClick={() => open(left.source.objectId)}>{tr('atlas_editor_Analysis.open_left_plan')}</button><button type="button" className="btn" disabled={!right} onClick={() => { if (right) open(right.source.objectId); }}>{tr('atlas_editor_Analysis.open_right_plan')}</button>
      <button type="button" className="btn" disabled={!right || !rightStep} onClick={() => { if (!right || !rightStep) return; setLeft(right); setRight(left); setLeftStep(rightStep); setRightStep(leftStep); }}>{tr('atlas_editor_Analysis.swap')}</button>
      <button type="button" className="btn" disabled={!right || left.ownership !== 'owned' || !rightStep} onClick={() => setReview(true)}>{tr('atlas_editor_Analysis.copy_as_new_step')}</button></div>
    {left.ownership !== 'owned' && <p>{tr('atlas_editor_Analysis.edit_a_copy_to_change')}</p>}
    {review && right && rightStep && <Dialog title={tr('atlas_editor_Analysis.copy_as_new_step')} onCancel={() => setReview(false)} confirmLabel={tr('atlas_editor_Analysis.add_step')} onConfirm={async () => { try { await add(right.view.document.payload.stepsById[rightStep]!, left); close(); } catch { setError(tr('atlas_editor_Analysis.could_not_add_step_retry')); } }}>
      <p>{tr('atlas_editor_Analysis.add_title_to_title2_the', { title: right.view.document.payload.stepsById[rightStep]!.title, title2: left.view.document.payload.title })}</p>
      {right.view.document.payload.dataset.contentHash !== left.view.document.payload.dataset.contentHash && <p>{tr('atlas_editor_Analysis.different_tree_data_imported_ids')}</p>}
    </Dialog>}
  </Dialog>;
}
