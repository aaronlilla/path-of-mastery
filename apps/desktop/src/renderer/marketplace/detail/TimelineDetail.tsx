import { useMemo, useState } from 'react';
import type { Clip, PublicItemPayload } from '@pom/mastery-contracts';
import { Segmented } from '../../ui.js';
import { laneLabels, rangeLabel, pointRangeLabel } from '../../../shared/timelines/editor/model.js';
import { runDisabledReason, sortedLanes } from '../presenter.js';
import type { MarketplaceProps } from '../services.js';
import type { DetailActions } from './DetailView.js';
import { Description, Finished, GameData, VersionsPanel } from './shared.js';

type Doc = Extract<PublicItemPayload['document'], { kind: 'timeline' }>;
const LEVELS = 100;
export function TimelineDetail({ item, document, props, actions, onSelectRevision }: { item: PublicItemPayload; document: Doc; props: MarketplaceProps; actions: DetailActions; onSelectRevision: (r: number) => void }) {
  const bundle = document.payload, t = bundle.timeline, lanes = sortedLanes(item);
  const [section, setSection] = useState('timeline'), [selected, setSelected] = useState<string | null>(null), [level, setLevel] = useState(t.editorMetadata.previewLevel || 1);
  const clipsOf = (laneId: string) => t.clips.filter(c => c.laneId === laneId).sort((a, b) => a.range.start - b.range.start);
  const clip = t.clips.find(c => c.clipId === selected) ?? null;
  const active = useMemo(() => t.clips.filter(c => c.range.start <= level && level < c.range.endExclusive), [t.clips, level]);
  const included = lanes.map(l => laneLabels[l.type]).filter((v, i, a) => a.indexOf(v) === i).join(' / ');
  const reason = runDisabledReason(item);
  const optionOf = (c: Clip) => c.options.find(o => o.optionId === c.selectedOptionId) ?? c.options[0];
  const pos = (n: number) => `${((n - 1) / LEVELS) * 100}%`;
  const summary = (c: Clip) => { const o = optionOf(c); return o ? `${o.title}: ${o.actions.length} actions, ${c.range.start}-${c.range.endExclusive - 1}${c.atlasPointRange ? ` (${pointRangeLabel(c.atlasPointRange)})` : ''}` : 'No source'; };
  return <div className="mp-detail-body">
    <Segmented ariaLabel="Timeline sections" value={section} onChange={setSection} options={[{ value: 'timeline', label: 'Timeline' }, { value: 'versions', label: 'Versions' }]} />
    {section === 'versions' && <VersionsPanel item={item} onSelect={onSelectRevision} />}
    {section === 'timeline' && <>
      <p className="mp-note">Included: {included || 'Nothing'}</p>
      <div className="mp-lanes" role="group" aria-label="Timeline lanes, read only">
        <div className="mp-ruler" role="slider" tabIndex={0} aria-label="Preview level" aria-valuemin={1} aria-valuemax={LEVELS} aria-valuenow={level} aria-valuetext={`Level ${level}`}
          onKeyDown={e => { if (e.key === 'ArrowRight') { e.preventDefault(); setLevel(Math.min(LEVELS, level + 1)); } if (e.key === 'ArrowLeft') { e.preventDefault(); setLevel(Math.max(1, level - 1)); } if (e.key === 'Home') setLevel(1); if (e.key === 'End') setLevel(LEVELS); }}
          onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setLevel(Math.max(1, Math.min(LEVELS, Math.round(1 + ((e.clientX - r.left) / r.width) * (LEVELS - 1))))); }}>
          {[1, 20, 40, 60, 80, 100].map(n => <span key={n} className="mp-tick" style={{ left: pos(n) }}>{n}</span>)}
          <span className="mp-playhead" style={{ left: pos(level) }} />
        </div>
        {lanes.map(l => <div className="mp-lane" key={l.laneId}><span className="mp-lane-name" title={l.title}>{laneLabels[l.type]}</span>
          <div className="mp-lane-track">{clipsOf(l.laneId).map(c => <button type="button" key={c.clipId} className="mp-clip" data-lane={l.type} aria-pressed={selected === c.clipId} style={{ left: pos(c.range.start), width: `${((c.range.endExclusive - c.range.start) / LEVELS) * 100}%` }}
            title={summary(c)} onClick={() => setSelected(selected === c.clipId ? null : c.clipId)}><span>{optionOf(c)?.title ?? 'Clip'}</span></button>)}</div></div>)}
        {!lanes.length && <p className="mp-note">Creator did not include any lanes.</p>}
      </div>
      <p className="mp-note" role="status">At level {level}: {active.length ? active.map(c => optionOf(c)?.title ?? 'Clip').join(', ') : 'nothing scheduled'}.</p>
      <div className="mp-panel" aria-live="polite"><h3>Selected clip</h3>{clip ? <><p><strong>{optionOf(clip)?.title}</strong> / {rangeLabel(clip.range)}{clip.atlasPointRange ? ` / ${pointRangeLabel(clip.atlasPointRange)}` : ''}</p>
        {clip.options.length > 1 && <p className="mp-note">{clip.options.length} choices. {t.lanes.length ? 'The person running it picks one.' : ''}</p>}
        <ol className="mp-guide">{(optionOf(clip)?.actions ?? []).slice(0, 8).map(a => <li key={a.actionId}><p>{a.instruction.firstAction}</p></li>)}</ol></> : <p className="mp-note">Select a clip to read it. Nothing here can be dragged or changed.</p>}</div>
      <div className="mp-panel"><h3>Included sources</h3>{bundle.dependencies.length ? <ul>{bundle.dependencies.map(d => {
        const credit = bundle.credits.find(c => c.source.revisionId === d.ref.revisionId); const s = d.snapshot;
        return <li key={d.ref.revisionId}><strong>{s.payload.title}</strong> <small>{s.kind} / bundled snapshot{credit ? ` / ${credit.status === 'original_removed' ? 'Original removed' : `by ${credit.creatorName}`}` : ''}</small></li>; })}</ul> : <p className="mp-note">Creator did not include any sources.</p>}</div>
      <div className="mp-grid2"><Description item={item} props={props} /><div className="mp-panel"><h3>Before you run</h3>{reason ? <p role="status">{reason}</p> : <p className="mp-note">Running reads these instructions only. Your active Build stays as it is.</p>}<Finished item={item} /></div><GameData item={item} /></div>
    </>}
    {actions.note && <p className="mp-note" role="status">{actions.note}</p>}
  </div>;
}
