import { useState } from 'react';
import type { FrozenSource, LaneId, Timeline } from '@pom/mastery-contracts';
import { Dialog, Switch } from '../ui';
import { ItemArt } from '../documents/ItemCard';
import { knownLabel } from '../documents/model.js';
import { sendDefaults, type CollisionChoice, type Range } from '../../shared/timelines/editor/index.js';

export function SendToTimeline({ source, destinations, suggestedRange, preferences, onPreferences, onAdd, onNew, onCancel, error, collision }: {
  source: FrozenSource; destinations: { id: string; timeline: Timeline; lastUsed: number; activeLeague: boolean }[];
  suggestedRange: Range; preferences?: { recentId?: string; openAfterAdding?: boolean };
  onPreferences(value: { recentId?: string; openAfterAdding: boolean }): void;
  onAdd(value: { timelineId: string | null; newTitle: string; laneId: LaneId | null; range: Range; openAfterAdding: boolean; choice?: CollisionChoice }): Promise<void>;
  onNew?(): void; onCancel(): void; error?: string; collision?: string;
}) {
  const defaults = sendDefaults(destinations, source, preferences);
  const [id, setId] = useState(defaults.timelineId ?? ''), [laneId, setLaneId] = useState(defaults.laneId ?? ''), [creating, setCreating] = useState(defaults.createNew),
    [title, setTitle] = useState('Untitled timeline'), [start, setStart] = useState(suggestedRange.start), [end, setEnd] = useState(suggestedRange.endExclusive - 1),
    [open, setOpen] = useState(defaults.openAfterAdding), [choice, setChoice] = useState<CollisionChoice>(), [busy, setBusy] = useState(false), [failure, setFailure] = useState('');
  const destination = destinations.find(row => row.id === id), compatible = destination?.timeline.lanes.filter(lane => lane.type === source.fallbackSnapshot.kind) ?? [];
  const valid = start >= 1 && end <= 100 && start <= end && Number.isInteger(start) && Number.isInteger(end) && (creating ? !!title.trim() : compatible.some(lane => lane.laneId === laneId)) && (!collision || !!choice);
  const submit = async () => { setBusy(true); setFailure(''); try {
    await onAdd({ timelineId: creating ? null : id, newTitle: title, laneId: creating ? null : laneId as LaneId, range: { start, endExclusive: end + 1 }, openAfterAdding: open, choice });
    onPreferences({ recentId: creating ? undefined : id, openAfterAdding: open });
  } catch { setFailure('Could not add the clip. Retry after saving the source.'); } finally { setBusy(false); } };
  return <Dialog title="Send to timeline" size="large" confirmLabel="Add clip" confirmDisabled={!valid || busy} confirmBusy={busy} onConfirm={() => void submit()} onCancel={onCancel}>
    <div className="timeline-dialog-fields"><span className="timeline-source-title"><ItemArt art={{ name: source.fallbackSnapshot.payload.title }} />{source.fallbackSnapshot.payload.title}</span>
    <p>{source.fallbackSnapshot.kind} / {knownLabel(source.ref.stamp.leagueId)} / Version {source.ref.revisionId}</p>
    <label>Timeline<select disabled={creating} value={id} onChange={event => { const value = event.target.value; setId(value); setLaneId(destinations.find(row => row.id === value)?.timeline.lanes.find(lane => lane.type === source.fallbackSnapshot.kind)?.laneId ?? ''); }}>
      <option value="">Choose timeline</option>{destinations.map(row => <option key={row.id} value={row.id} disabled={!row.timeline.lanes.some(lane => lane.type === source.fallbackSnapshot.kind)}>{row.timeline.title}{row.activeLeague ? '' : ' / Archived'}</option>)}</select></label>
    <button className="btn" onClick={() => { setCreating(true); onNew?.(); }}>New timeline</button>
    {creating && <><label>Name<input className="field" value={title} onChange={event => setTitle(event.target.value)} /></label>{destinations.length > 0 && <button className="btn" onClick={() => setCreating(false)}>Choose timeline</button>}</>}
    <label>Lane<select disabled={creating} value={laneId} onChange={event => setLaneId(event.target.value)}><option value="">{creating ? source.fallbackSnapshot.kind : 'Choose lane'}</option>{destination?.timeline.lanes.map(lane => <option key={lane.laneId} value={lane.laneId} disabled={lane.type !== source.fallbackSnapshot.kind}>{lane.title}{lane.type !== source.fallbackSnapshot.kind ? ' / Incompatible source type' : ''}</option>)}</select></label>
    <div className="timeline-range-fields"><label>Start level<input type="number" min={1} max={100} value={start} onChange={event => setStart(Number(event.target.value))} /></label><label>End level<input type="number" min={1} max={100} value={end} onChange={event => setEnd(Number(event.target.value))} /></label></div>
    {source.fallbackSnapshot.kind === 'atlas' && <p>First map / Allocated points</p>}
    {source.fallbackSnapshot.kind === 'filter' && <p>AreaLevel triggers stay unchanged.</p>}
    {source.ref.stamp.leagueId.status === 'known' && destination?.timeline.stamp.leagueId.status === 'known' && source.ref.stamp.leagueId.value !== destination.timeline.stamp.leagueId.value && <p>This clip keeps {source.ref.stamp.leagueId.value} data.</p>}
    <label className="timeline-switch"><Switch checked={open} onChange={setOpen} label="Open timeline after adding" />Open timeline after adding</label>
    {collision && <div role="alert"><p>This overlaps {collision}.</p><button className="btn" aria-pressed={choice === 'replace_range'} onClick={() => setChoice('replace_range')}>Replace range</button><button className="btn" aria-pressed={choice === 'next_free'} onClick={() => setChoice('next_free')}>Move to next free range</button></div>}
    {(error || failure) && <p role="alert">{error || failure}</p>}</div>
  </Dialog>;
}
