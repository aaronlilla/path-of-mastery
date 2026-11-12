import { useEffect, useMemo, useState } from 'react';
import type { AtlasStep, PublicItemPayload, StepId } from '@pom/mastery-contracts';
import { Dialog, Segmented, Select } from '../../ui.js';
import { AtlasCanvasView } from '../../atlas/canvas/AtlasCanvasView.js';
import { overlayFor } from '../../atlas/canvas/index.js';
import { PracticalPanel } from '../../atlas/editor/PracticalPanel.js';
import type { PracticalTab } from '../../atlas/editor/presenter.js';
import { leagueName } from '../presenter.js';
import type { AtlasDetailData, MarketplaceProps } from '../services.js';
import type { DetailActions } from './DetailView.js';
import { Description, Finished, GameData, VersionsPanel } from './shared.js';

type Doc = Extract<PublicItemPayload['document'], { kind: 'atlas' }>;
type DataState = { status: 'loading' | 'ready' | 'error' | 'unavailable'; data?: AtlasDetailData };
export function AtlasDetail({ item, document, props, actions, onSelectRevision }: { item: PublicItemPayload; document: Doc; props: MarketplaceProps; actions: DetailActions; onSelectRevision: (r: number) => void }) {
  const plan = document.payload, positions = plan.sequencePositions;
  const [index, setIndex] = useState(0), [choices, setChoices] = useState<Record<string, StepId>>({}), [diff, setDiff] = useState(false), [replay, setReplay] = useState(false);
  const [attempt, setAttempt] = useState(0), [tab, setTab] = useState<PracticalTab>('Maps'), [scroll, setScroll] = useState(0), [data, setData] = useState<DataState>({ status: 'loading' }), [section, setSection] = useState('plan'), [highlight, setHighlight] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    if (!props.services.atlasData) { setData({ status: 'unavailable' }); return; }
    setData({ status: 'loading' });
    props.services.atlasData(plan.dataset).then(d => { if (live) setData({ status: 'ready', data: d }); }, () => { if (live) setData({ status: 'error' }); });
    return () => { live = false; };
  }, [plan.dataset.contentHash, attempt]);
  const stepOf = (i: number): AtlasStep | undefined => {
    const p = positions[i]; if (!p) return undefined;
    return plan.stepsById[p.kind === 'step' ? p.stepId : choices[p.positionId] ?? p.defaultStepId];
  };
  const position = positions[index], step = stepOf(index), previous = index > 0 ? stepOf(index - 1) : undefined;
  const view = data.data;
  const overlay = useMemo(() => diff && step ? overlayFor(previous?.allocatedIds ?? [], step.allocatedIds, 'diff') : null, [diff, step, previous]);
  const changed = useMemo(() => {
    if (!step) return { added: [] as string[], removed: [] as string[] };
    const before = new Set(previous?.allocatedIds ?? []), after = new Set(step.allocatedIds);
    return { added: step.allocatedIds.filter(id => !before.has(id)), removed: [...before].filter(id => !after.has(id)) };
  }, [step, previous]);
  const nodeName = (id: string) => view?.graph?.nodes.get(id)?.name ?? id;
  if (!position || !step) return <div className="mp-detail-body"><p className="mp-empty">Creator did not include any steps.</p><Description item={item} props={props} /></div>;
  const alternatives = position.kind === 'alternatives' ? position : null;
  return <div className="mp-detail-body">
    <Segmented ariaLabel="Atlas sections" value={section} onChange={setSection} options={[{ value: 'plan', label: 'Plan' }, { value: 'versions', label: 'Versions' }]} />
    {section === 'versions' && <VersionsPanel item={item} onSelect={onSelectRevision} />}
    {section === 'plan' && <>
      <div className="mp-stepbar" role="group" aria-label="Steps">
        <div className="mp-steps" tabIndex={0} aria-label="Steps, scrolls sideways">{positions.map((p, i) => <button type="button" key={p.positionId} className="btn" aria-pressed={i === index} onClick={() => setIndex(i)}>
          {(plan.stepsById[p.kind === 'step' ? p.stepId : choices[p.positionId] ?? p.defaultStepId])?.title ?? `Step ${i + 1}`}</button>)}</div>
        {alternatives && <Select ariaLabel="Choose alternative" width={220} value={choices[alternatives.positionId] ?? alternatives.defaultStepId}
          options={alternatives.optionStepIds.map(id => ({ value: id, label: `${plan.stepsById[id]?.title ?? id}${id === alternatives.defaultStepId ? ' (creator default)' : ''}` }))} onChange={v => setChoices({ ...choices, [alternatives.positionId]: v })} />}
        <button type="button" className="btn" aria-pressed={diff} disabled={index === 0} title={index === 0 ? 'The first step has nothing before it.' : undefined} onClick={() => setDiff(!diff)}>Diff</button>
        <button type="button" className="btn" onClick={() => setReplay(true)}>Replay edits</button>
      </div>
      {alternatives && <p className="mp-note">Previewing one choice. You pick the one you want when you add it to a timeline.</p>}
      <div className="mp-atlas-grid">
        <div className="mp-atlas-tree">
          <p className="mp-points" aria-label="Points used of the creator's budget">{step.allocatedIds.length} / {step.pointBudget} points</p>
          {data.status === 'loading' && <p role="status" className="mp-note">Loading the tree...</p>}
          {data.status === 'error' && <p role="alert">Could not load the tree. <button type="button" className="btn" onClick={() => setAttempt(n => n + 1)}>Retry</button></p>}
          {data.status === 'unavailable' && <p className="mp-note">The tree data for this plan is not on this PC. Notes, maps and scarabs are shown.</p>}
          {view?.model && <AtlasCanvasView model={view.model} allocatedIds={step.allocatedIds} budget={step.pointBudget} sourceLabel={`Saved for ${leagueName(plan.stamp)} / ${plan.dataset.datasetId}`} compatibilityLabel="Live compatibility unverified"
            readOnlyReason="Open a local copy to edit." overlay={overlay} art={undefined} />}
          {view && !view.model && <p className="mp-note">The tree layout for this plan is not available. Allocated nodes are listed below.</p>}
          {diff && <div className="mp-diff" aria-label="Changes from the previous step"><strong>{changed.added.length} added, {changed.removed.length} removed</strong>
            <ul>{changed.added.map(id => <li key={id}>Added: {nodeName(id)}</li>)}{changed.removed.map(id => <li key={id}>Removed: {nodeName(id)}</li>)}</ul></div>}
          {(!view?.model) && <details open><summary>{step.allocatedIds.length} allocated nodes</summary><ul className="mp-scroll-list">{step.allocatedIds.map(id => <li key={id}>{nodeName(id)}</li>)}</ul></details>}
          {highlight.length > 0 && <p className="mp-note">Stat sources: {highlight.map(nodeName).join(', ')}</p>}
        </div>
        <div className="mp-atlas-panel">
          {!step.maps.length && !step.scarabs.length && <p className="mp-note">Maps and scarabs: Not specified by creator.</p>}
          <PracticalPanel plan={plan} step={step} graph={view?.graph ?? undefined} catalogs={view?.catalogs ?? { maps: [], scarabs: [] }} tab={tab} onTab={setTab} edit={() => undefined} flush={() => undefined} readOnly
            art={undefined} scroll={scroll} onScroll={setScroll} onHighlight={setHighlight} maximumLabel="Read only. Budget is the creator's." />
        </div>
      </div>
      <div className="mp-grid2"><Description item={item} props={props} /><div className="mp-panel"><h3>Strategy</h3>{plan.strategy ? <p className="mp-pre">{plan.strategy}</p> : <p className="mp-note">Creator did not include a strategy.</p>}<Finished item={item} /></div><GameData item={item} /></div>
    </>}
    {replay && <Dialog title="Replay edits" size="large" onCancel={() => setReplay(false)} cancelLabel="Close" confirmLabel={null}>
      {item.history?.length ? <ol className="mp-history">{item.history.map(h => <li key={h.revision.revisionId}><strong>{h.label}</strong> <time dateTime={h.createdAt}>{new Date(h.createdAt).toLocaleString()}</time></li>)}</ol>
        : <p>The creator did not include their edit history.</p>}
    </Dialog>}
    {actions.note && <p className="mp-note" role="status">{actions.note}</p>}
  </div>;
}
