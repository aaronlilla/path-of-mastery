import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { Segmented } from '../../ui.js';
import type { EditorArt } from '../editor/PracticalPanel.js';
import type { ArtResolver } from '../canvas/art.js';
import { buildAiSummary, type AtlasAiPort } from '../../../shared/atlas/suggestions/ai.js';
import { createPlan } from '../../../shared/atlas/plan.js';
import type { Mark } from '../../../shared/atlas/suggestions/choices.js';
import type { OptimizerController } from './controller.js';
import { MechanicName } from './OptimizerPanel.js';
import { ResultActions, ResultPreview } from './ResultPreview.js';
import { tr, inLanguage } from '../../i18n';

export type WizardProps = {
  controller: OptimizerController; ai: AtlasAiPort | null; aiAccess: boolean; signedIn: boolean; online: boolean; art?: EditorArt; nodeArt?: ArtResolver;
  onUnlock: () => void; onSignIn: () => void; onFreeOptimizer: () => void; onClose: () => void; onDone: (message: string) => void;
  /** Controlled result panel: when the host passes these, it also draws the Apply bar (pinned to the side column's
   * bottom), so the wizard does not render one inline. */
  result?: boolean; onResult?: (open: boolean) => void;
};
type Stage = 'Early' | 'Mid' | 'Late' | 'All three';
const MARKS: Mark[] = ['neutral', 'want', 'avoid'];
const MARK_LABEL = { neutral: () => tr('atlas_optimizer_PlanWithAi_2.neutral'), want: () => tr('atlas_optimizer_PlanWithAi_2.want'), avoid: () => tr('atlas_optimizer_PlanWithAi_2.avoid') } as const;

/** Choosing is free. The optional explanation is only asked for after the player asks. */
export function PlanWithAi(p: WizardProps) {
  const c = p.controller, s = useSyncExternalStore(c.subscribe, c.snapshot, c.snapshot);
  const [mode, setMode] = useState<'map' | 'list'>('map'), [stage, setStage] = useState<Stage>('Early'), [ask, setAsk] = useState(''), [askOpen, setAskOpen] = useState(false);
  const [answer, setAnswer] = useState<{ text: string; stamp: string } | null>(null), [aiState, setAiState] = useState<'idle' | 'working' | 'failed'>('idle'), [focus, setFocus] = useState(0);
  const [ownResult, setOwnResult] = useState(false), [msg, setMsg] = useState('');
  const hosted = p.onResult !== undefined, result = hosted ? !!p.result : ownResult, setResult = hosted ? p.onResult! : setOwnResult;
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const v = c.view();
  // The free candidate follows the choices; it is local and never saved.
  useEffect(() => { if (s.choices.priority.length && !s.proposal && !s.checking && !s.findDisabled && s.status === 'idle') void c.find(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // No lock markers in Atlas. The gate itself stays server-checked.
  const gate = !p.aiAccess ? (p.signedIn ? 'locked' : 'signin') : !p.online ? 'offline' : null;
  const gateText = gate === 'locked' ? tr('atlas_optimizer_PlanWithAi.connect_to_verify_your_account')
    : gate === 'signin' ? tr('atlas_optimizer_PlanWithAi.sign_in_to_use_ai')
    : gate === 'offline' ? tr('atlas_optimizer_PlanWithAi.connect_to_use_ai_planning') : null;
  const wants = s.choices.priority, avoids = s.choices.avoided;
  const name = (id: string) => s.mechanics.find(m => m.targetId === id)?.name ?? id;
  const key = (e: KeyboardEvent, id: string) => {
    if (e.target instanceof HTMLTextAreaElement) return;
    const k = e.key.toLowerCase();
    if (k === 'a') c.setMark(id, 'avoid'); else if (k === 'n') c.setMark(id, 'neutral'); else if (e.key === ' ') { e.preventDefault(); c.setMark(id, c.markOf(id) === 'want' ? 'neutral' : 'want'); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') setFocus(f => Math.min(s.mechanics.length - 1, f + 1)); else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') setFocus(f => Math.max(0, f - 1));
  };
  const explain = async () => {
    if (!p.ai || !v || !ask.trim()) return;
    abort.current?.abort(); const ctl = abort.current = new AbortController(); setAiState('working');
    try {
      const text = await p.ai.explain(buildAiSummary({ dataset: v.plan.dataset, step: v.step, graph: v.graph, budget: s.choices.budget, mechanics: s.mechanics, priority: s.choices.priority, avoided: s.choices.avoided, question: ask }), ctl.signal);
      if (!ctl.signal.aborted) { setAnswer({ text, stamp: tr('atlas_optimizer_PlanWithAi.tree_data_datasetid_variant_datalabe', { datasetId: v.plan.dataset.datasetId, variant: v.plan.dataset.variant, dataLabel: s.dataLabel }) }); setAiState('idle'); }
    } catch { if (!ctl.signal.aborted) setAiState('failed'); }
  };
  const use = () => {
    const pr = s.proposal; if (!pr || !v) return;
    const next = createPlan(v.plan.dataset, v.plan.stamp, c.o.session.stepId(), s.choices.budget, tr('atlas_optimizer_PlanWithAi_2.copy', { title: v.plan.title }).slice(0, 120));
    const sid = Object.keys(next.stepsById)[0]!;
    next.stepsById[sid]!.allocatedIds = [...pr.afterIds]; next.stepsById[sid]!.title = stage === 'All three' ? 'Early' : stage;
    next.optimizerPreferences = { targetIds: [...s.choices.priority], avoidNodeIds: [], retainCurrent: true, budget: s.choices.budget };
    void c.o.session.create(next, tr('atlas_optimizer_PlanWithAi.created_plan_with_ai')).then(() => p.onDone(tr('atlas_optimizer_PlanWithAi.created_a_new_plan_your')));
  };
  return <section className="opt-panel opt-wizard" aria-label={tr('atlas_optimizer_PlanWithAi.plan_with_ai')}>
    <header className="opt-head"><h2>{tr('atlas_optimizer_PlanWithAi.plan_with_ai_title', { title: v?.plan.title ?? tr('atlas_optimizer_PlanWithAi.plan') })}</h2>
      <button type="button" className="btn ghost" aria-label={tr('atlas_optimizer_PlanWithAi.close')} onClick={() => { abort.current?.abort(); c.cancel(); p.onClose(); }}>{tr('atlas_optimizer_PlanWithAi.x')}</button></header>
    <p>{tr('atlas_optimizer_PlanWithAi.choose_what_you_want_to')}</p>
    {gate && <p className="opt-note" role="note">{gateText}
      
      {gate === 'signin' && <button type="button" className="btn" onClick={p.onSignIn}>{tr('atlas_optimizer_PlanWithAi.sign_in')}</button>}</p>}
    <div className="opt-wiz-grid">
      <div className="opt-night" aria-label={tr('atlas_optimizer_PlanWithAi.night_map')}>
        <div className="atlas-row-actions"><Segmented ariaLabel={tr('atlas_optimizer_PlanWithAi.map_view')} value={mode} onChange={setMode} options={[{ value: 'map', label: tr('atlas_optimizer_PlanWithAi.night_map') }, { value: 'list', label: tr('atlas_optimizer_PlanWithAi.list_view') }]} />
          <small>{tr('atlas_optimizer_PlanWithAi.warm_want_cold_avoid')}</small></div>
        {!s.mechanics.length && <p>{tr('atlas_optimizer_PlanWithAi.no_mechanics_are_listed_in')}</p>}
        <div className={mode === 'map' ? 'opt-islands' : 'opt-islands list'} role="grid" aria-label={tr('atlas_optimizer_PlanWithAi.mechanics')}>
          {s.mechanics.map((m, i) => { const mk = c.markOf(m.targetId); return <div role="row" key={m.targetId}><div role="gridcell" className="opt-island" data-mark={mk} tabIndex={i === focus ? 0 : -1}
            aria-label={`${m.name}: ${MARK_LABEL[mk]()}`} onFocus={() => setFocus(i)} onKeyDown={e => key(e, m.targetId)}
            onClick={() => c.setMark(m.targetId, mk === 'want' ? 'neutral' : 'want')} onContextMenu={e => { e.preventDefault(); c.setMark(m.targetId, mk === 'avoid' ? 'neutral' : 'avoid'); }}>
            <MechanicName m={m} art={p.art} /><span className="opt-chip" data-mark={mk}>{MARK_LABEL[mk]()}</span>
            <span className="opt-mark-buttons">{MARKS.map(x => <button key={x} type="button" className="btn" aria-pressed={mk === x} aria-label={`${MARK_LABEL[x]()} ${m.name}`} onClick={e => { e.stopPropagation(); c.setMark(m.targetId, x); }}>{MARK_LABEL[x]()}</button>)}</span>
          </div></div>; })}
        </div>
      </div>
      <aside className="opt-side">
        <h3>{tr('atlas_optimizer_PlanWithAi.want')}</h3>{!wants.length && <p>{tr('atlas_optimizer_PlanWithAi.choose_a_mechanic_or_a')}</p>}
        <ol className="opt-priority">{wants.map((id, i) => <li key={id} className="opt-row"><span className="opt-rank">{i + 1}</span><span className="opt-name" title={name(id)}>{name(id)}</span>
          <button type="button" className="btn" aria-label={tr('atlas_optimizer_PlanWithAi.move_id_up', { id: name(id) })} disabled={i === 0} onClick={() => c.move(id, -1)}>{tr('atlas_optimizer_PlanWithAi.up')}</button>
          <button type="button" className="btn" aria-label={tr('atlas_optimizer_PlanWithAi.move_id_down', { id: name(id) })} disabled={i === wants.length - 1} onClick={() => c.move(id, 1)}>{tr('atlas_optimizer_PlanWithAi.down')}</button></li>)}</ol>
        <h3>{tr('atlas_optimizer_PlanWithAi.avoid')}</h3><p>{avoids.length ? avoids.map(name).join(', ') : tr('atlas_optimizer_PlanWithAi.none')}</p>
        <label className="opt-field" htmlFor="wiz-budget">{tr('atlas_optimizer_PlanWithAi.budget')} <input id="wiz-budget" className="field opt-num" value={s.budgetText} inputMode="numeric" onChange={e => c.setBudgetText(e.target.value)} /></label>
        {s.budgetError && <small role="alert">{s.budgetError}</small>}
      </aside>
    </div>
    <div className="opt-field"><span>{tr('atlas_optimizer_PlanWithAi.map_sustain')}</span><span>{s.sustainAvailable ? [tr('atlas_optimizer_PlanWithAi_2.none'), tr('atlas_optimizer_PlanWithAi_2.some'), tr('atlas_optimizer_PlanWithAi_2.more')][['none', 'some', 'more'].indexOf(s.choices.sustain)] : tr('atlas_optimizer_PlanWithAi.unavailable')}</span>
      {s.sustainAvailable ? <Segmented ariaLabel={tr('atlas_optimizer_PlanWithAi.map_sustain')} value={s.choices.sustain} onChange={x => c.setSustain(x)} options={[{ value: 'none', label: tr('atlas_optimizer_PlanWithAi.none') }, { value: 'some', label: tr('atlas_optimizer_PlanWithAi.some') }, { value: 'more', label: tr('atlas_optimizer_PlanWithAi.more') }]} /> : <small>{s.sustainReason}</small>}</div>
    <div className="opt-field"><span>{tr('atlas_optimizer_PlanWithAi.stages')}</span><Segmented ariaLabel={tr('atlas_optimizer_PlanWithAi.stages')} value={stage} onChange={setStage} options={(['Early', 'Mid', 'Late', 'All three'] as Stage[]).map(x => ({ value: x, label: inLanguage('h_atlasA_L', x) }))} />
      <small>{stage === 'All three' ? tr('atlas_optimizer_PlanWithAi.stage_point_budgets_are_not') : tr('atlas_optimizer_PlanWithAi_2.point_budget_for_this_stage_is')}</small></div>
    {!result && !s.proposal && s.choices.priority.length === 0 && <p>{tr('atlas_optimizer_PlanWithAi.choose_a_mechanic_or_a')}</p>}
    {s.proposal && !result && <div className="opt-candidate"><p role="status">{s.checking ? tr('atlas_optimizer_PlanWithAi.updating_plan') : tr('atlas_optimizer_PlanWithAi.certainty_cost_budget_points', { certainty: s.proposal.certainty, cost: s.proposal.contract.cost, budget: s.choices.budget })}</p>
      <ul className="opt-results">{s.proposal.results.map(r => <li key={r.targetId} data-tone={r.tone}><span className="opt-name">{r.name}</span> <span className="opt-chip" data-tone={r.tone}>{r.label}</span></li>)}</ul>
      <button type="button" className="btn" onClick={() => setResult(true)}>{tr('atlas_optimizer_PlanWithAi.inspect_preview')}</button></div>}
    {result && <><ResultPreview controller={c} nodeArt={p.nodeArt} onChangeBudget={() => setResult(false)} onBack={() => setResult(false)} extraActions={false} />
      {!hosted && <ResultActions controller={c} onChangeBudget={() => setResult(false)} onBack={() => setResult(false)} extraActions={false} />}</>}
    {s.error && <p role="alert">{s.error}</p>}
    <button type="button" className="btn" aria-expanded={askOpen} onClick={() => setAskOpen(!askOpen)}>{tr('atlas_optimizer_PlanWithAi.ask_about_these_choices')}</button>
    {askOpen && <div className="opt-ask"><textarea className="field" aria-label={tr('atlas_optimizer_PlanWithAi.ask_about_these_choices_2')} rows={2} value={ask} placeholder={tr('atlas_optimizer_PlanWithAi.ask_about_these_choices')} disabled={!!gate} onChange={e => setAsk(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void explain(); } e.stopPropagation(); }} />
      <button type="button" className="btn" disabled={!!gate || !ask.trim() || aiState === 'working'} onClick={() => void explain()}>{tr('atlas_optimizer_PlanWithAi.send')}</button>
      {aiState === 'working' && <><span role="status">{tr('atlas_optimizer_PlanWithAi.updating_plan')}</span><button type="button" className="btn" onClick={() => { abort.current?.abort(); setAiState('idle'); }}>{tr('atlas_optimizer_PlanWithAi.cancel')}</button></>}
      {aiState === 'failed' && <p role="alert">{tr('atlas_optimizer_PlanWithAi.ai_advice_is_unavailable_your')} <button type="button" className="btn" onClick={() => void explain()}>{tr('atlas_optimizer_PlanWithAi.retry')}</button></p>}
      {answer && <div className="opt-answer"><p>{answer.text}</p><small>{answer.stamp}</small><small>{tr('atlas_optimizer_PlanWithAi.this_text_explains_your_choices')}</small></div>}</div>}
    {msg && <p role="status">{msg}</p>}
    <footer className="atlas-row-actions"><button type="button" className="btn" onClick={p.onFreeOptimizer}>{tr('atlas_optimizer_PlanWithAi.use_free_optimizer')}</button>
      <button type="button" className="btn" onClick={() => { abort.current?.abort(); c.cancel(); p.onClose(); }}>{tr('atlas_optimizer_PlanWithAi.not_now')}</button>
      <button type="button" className="btn gold" disabled={!s.proposal || s.stale || s.checking || !!s.blocked && s.proposal.contract.cost > s.choices.budget} onClick={use}>{tr('atlas_optimizer_PlanWithAi.use_this_plan')}</button></footer>
  </section>;
}
