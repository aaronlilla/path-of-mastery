import { useState } from 'react';
import type { RevisionRef, TimelineBundle } from '@pom/mastery-contracts';
import { Dialog } from '../ui';
import { rangeLabel } from '../../shared/timelines/editor/model.js';
export function AddLanesDialog({ sources, onAdd, onCancel }: {
  sources: { bundle: TimelineBundle; revision: RevisionRef }[];
  onAdd(source: { bundle: TimelineBundle; revision: RevisionRef }, laneIds: string[]): Promise<void>;
  onCancel(): void;
}) {
  const [index, setIndex] = useState(0), [selected, setSelected] = useState<string[]>(sources[0]?.bundle.timeline.lanes.map(lane => lane.laneId) ?? []), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const source = sources[index];
  return <Dialog title="Add lanes from timeline" size="large" confirmLabel="Add lanes" confirmDisabled={!selected.length || busy} confirmBusy={busy} onCancel={onCancel} onConfirm={() => {
    if (!source) return; setBusy(true); onAdd(source, selected).catch(() => setError('Could not add these lanes. Check their source dependencies and First map anchor.')).finally(() => setBusy(false));
  }}>
    <div className="timeline-dialog-fields"><label>Timeline<select value={index} onChange={event => { const value = Number(event.target.value); setIndex(value); setSelected(sources[value]?.bundle.timeline.lanes.map(lane => lane.laneId) ?? []); }}>{sources.map((row, index) => <option key={row.revision.revisionId} value={index}>{row.bundle.timeline.title}</option>)}</select></label>
    <h3>Included content</h3>{source?.bundle.timeline.lanes.map(lane => <label key={lane.laneId}><input type="checkbox" checked={selected.includes(lane.laneId)} onChange={event => setSelected(value => event.target.checked ? [...value, lane.laneId] : value.filter(id => id !== lane.laneId))} />{lane.title}: {lane.clipIds.length} clips
      {source.bundle.timeline.clips.filter(clip => clip.laneId === lane.laneId).map(clip => <span key={clip.clipId}>{clip.options[0]!.title} / {rangeLabel(clip.range)}</span>)}</label>)}
    {error && <p role="alert">{error}</p>}</div>
  </Dialog>;
}
