import { useEffect, useState } from 'react';
import { parseId, type Clip, type ClipId, type ClipOption, type Instructions } from '@pom/mastery-contracts';
import { Switch } from '../ui';
import { knownLabel } from '../documents/model.js';
import { atlasSourceSpan, excludedByCoverage, pointRangeLabel, rangeLabel, withAtlasPoints, type Range } from '../../shared/timelines/editor/model.js';
import type { TimelineEditorProps } from './types.js';

export function ClipInspector({ clip, latest, onChange, onResize, onUpdate, onKeep, onChoose, onOpen, onDuplicate, onRemove, onClose, muted, onMute, offline, verifiedZones, firstMapAnchor }: {
  clip?: Clip; latest?: ClipOption; onChange(clip: Clip, label: string): void; onResize(range: Range, mode: Clip['timingMode']): void;
  onUpdate(): void; onKeep(): void; onChoose(): void; onOpen(): void; onDuplicate(): void; onRemove(): void; onClose(): void;
  muted: boolean; onMute(): void; offline?: boolean;
  verifiedZones?: { id: string; label: string; evidenceId: string }[]; firstMapAnchor?: string;
}) {
  const [start, setStart] = useState(clip?.range.start ?? 1), [end, setEnd] = useState((clip?.range.endExclusive ?? 101) - 1), [mode, setMode] = useState<Clip['timingMode']>(clip?.timingMode ?? 'keep_instruction_timing'), [instructionIndex, setInstructionIndex] = useState(0), [error, setError] = useState('');
  const span = clip ? atlasSourceSpan(clip) : { from: 0, to: 0 };
  const pointsFrom = clip?.atlasPointRange?.start ?? span.from, pointsTo = clip?.atlasPointRange ? clip.atlasPointRange.endExclusive - 1 : span.to;
  const [fromText, setFromText] = useState(String(pointsFrom)), [toText, setToText] = useState(String(pointsTo));
  useEffect(() => setFromText(String(pointsFrom)), [clip?.clipId, pointsFrom]);
  useEffect(() => setToText(String(pointsTo)), [clip?.clipId, pointsTo]);
  const commitPoints = () => {
    if (!clip) return;
    const from = Number(fromText), to = Number(toText);
    if (fromText.trim() === '' || toText.trim() === '' || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from > to) { setError('Choose a nonempty Atlas point range.'); return; }
    setError(''); if (from !== pointsFrom || to !== pointsTo) onChange(withAtlasPoints(clip, from, to), 'Change Atlas points');
  };
  const pointKeys = (reset: () => void) => (event: React.KeyboardEvent) => { if (event.key === 'Enter') commitPoints(); if (event.key === 'Escape') { reset(); setError(''); event.stopPropagation(); } };
  const option = clip?.options.find(option => option.optionId === clip.selectedOptionId) ?? clip?.options[0];
  const action = option?.actions[instructionIndex];
  const text = clip?.instructionOverrides.find(row => row.actionId === action?.actionId)?.instruction ?? action?.instruction;
  const [first, setFirst] = useState(text?.firstAction ?? ''), [details, setDetails] = useState(text?.details ?? '');
  useEffect(() => { setStart(clip?.range.start ?? 1); setEnd((clip?.range.endExclusive ?? 101) - 1); setMode(clip?.timingMode ?? 'keep_instruction_timing'); setError(''); }, [clip?.clipId, clip?.range.start, clip?.range.endExclusive, clip?.timingMode]);
  useEffect(() => { setFirst(text?.firstAction ?? ''); setDetails(text?.details ?? ''); }, [text?.firstAction, text?.details, action?.actionId]);
  useEffect(() => setInstructionIndex(0), [clip?.clipId]);
  const saveText = () => {
    if (!clip || !action || !text) return;
    if ([...first].length > 160 || [...details].length > 10000) { setError('First action allows 160 characters; Details allows 10000.'); return; }
    const instruction: Instructions = { ...text, firstAction: first, details };
    if (JSON.stringify(instruction) === JSON.stringify(text)) return;
    setError(''); onChange({ ...clip, instructionOverrides: [...clip.instructionOverrides.filter(row => row.actionId !== action.actionId), { actionId: action.actionId, instruction }] }, 'Edit instructions');
  };
  useEffect(() => {
    if (first === text?.firstAction && details === text?.details) return;
    const timer = window.setTimeout(saveText, 500);
    return () => window.clearTimeout(timer);
  }, [first, details, text?.firstAction, text?.details]);
  const resize = () => {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 100 || start > end) { setError('Choose a nonempty range within Levels 1-100.'); return; }
    setError(''); if (clip && (start !== clip.range.start || end + 1 !== clip.range.endExclusive || mode !== clip.timingMode)) onResize({ start, endExclusive: end + 1 }, mode);
  };
  const setTrigger = (trigger: import('@pom/mastery-contracts').Trigger) => {
    if (!clip || !action) return;
    if (trigger.kind === 'level') {
      const requirement = action.requirements.find(row => row.kind === 'level' && trigger.level < row.minimum);
      if (requirement?.kind === 'level') { setError(`This action requires Level ${requirement.minimum}.`); return; }
      if (!Number.isInteger(trigger.level) || trigger.level < 1 || trigger.level > 100) { setError('Choose a trigger within Levels 1-100.'); return; }
    }
    setError(''); onChange({ ...clip, options: clip.options.map(row => ({ ...row, actions: row.actions.map(row => row.actionId === action.actionId ? { ...row, trigger } : row) })) }, 'Edit trigger');
  };
  return <aside className="timeline-inspector" aria-label="Inspector">
    <header><h2>{option ? `Clip: ${option.title}` : 'Inspector'}</h2><button className="icon-btn" onClick={onClose} aria-label="Close Inspector">×</button></header>
    {!clip || !option ? <p>Select a clip to edit its timing and instructions.</p> : <>
      <label>Name<input className="field" defaultValue={option.title} key={`${clip.clipId}:${option.title}`} onBlur={event => { if (event.target.value.trim() && event.target.value !== option.title) onChange({ ...clip, options: clip.options.map(row => row.optionId === option.optionId ? { ...row, title: event.target.value } : row) }, 'Rename clip'); }} /></label>
      <p>Source {option.source.fallbackSnapshot?.payload.title ?? 'Source missing'} / {knownLabel(option.source.ref.stamp.leagueId)} / Version {option.source.ref.revisionId}</p>
      <p>Source data {knownLabel(option.source.ref.stamp.datasetVersion)}</p>
      <div><button className="btn" onClick={onOpen}>Open source</button><button className="btn" onClick={onChoose}>Choose source</button></div>
      <p>{rangeLabel(clip.range)}</p>
      <div className="timeline-range-fields"><label>Start level<input type="number" min={1} max={100} value={start} onChange={event => setStart(Number(event.target.value))} onBlur={resize} onKeyDown={event => { if (event.key === 'Enter') resize(); if (event.key === 'Escape') { setStart(clip.range.start); event.stopPropagation(); } }} /></label>
        <label>End level<input type="number" min={1} max={100} value={end} onChange={event => setEnd(Number(event.target.value))} onBlur={resize} onKeyDown={event => { if (event.key === 'Enter') resize(); if (event.key === 'Escape') { setEnd(clip.range.endExclusive - 1); event.stopPropagation(); } }} /></label></div>
      <label>Timing<select value={mode} onChange={event => { const value = event.target.value as Clip['timingMode']; setMode(value); onResize({ start, endExclusive: end + 1 }, value); }}><option value="keep_instruction_timing">Keep instruction timing</option><option value="scale_timing">Scale timing</option></select></label>
      <label>Selected alternative<select value={clip.selectedOptionId ?? ''} onChange={event => onChange({ ...clip, selectedOptionId: event.target.value ? parseId('option', event.target.value) : null }, 'Choose alternative')}><option value="">Choose one alternative</option>{clip.options.map(row => <option key={row.optionId} value={row.optionId}>{row.title}</option>)}</select></label>
      <label>Chunks: {clip.chunkOverride.kind === 'auto' ? 'Auto' : ''}<select aria-label="Chunks" value={clip.chunkOverride.kind === 'levels' ? String(clip.chunkOverride.size) : clip.chunkOverride.kind} onChange={event => onChange({ ...clip, chunkOverride: event.target.value === 'auto' ? { kind: 'auto' } : event.target.value === 'atlas' ? { kind: 'atlas', mode: 'per_step', splitAtAllocatedPoints: 10 } : { kind: 'levels', size: Number(event.target.value) as 4 | 6 | 8 | 10 } }, 'Change chunks')}>
        <option value="auto">Auto</option>{option.source.fallbackSnapshot?.kind === 'atlas' ? <option value="atlas">Per step / 10 allocated points</option> : [4, 6, 8, 10].map(size => <option key={size} value={size}>{size} levels</option>)}</select></label>
      {option.actions.length > 0 && <label>Instruction<select value={instructionIndex} onChange={event => setInstructionIndex(Number(event.target.value))}>{option.actions.map((action, index) => <option key={action.actionId} value={index}>{index + 1}: {action.instruction.firstAction}</option>)}</select></label>}
      {action && <p>Trigger: {triggerLabel(action.trigger)}</p>}
      {action && !['filter', 'atlas'].includes(option.source.fallbackSnapshot?.kind) && <>
        <label>Trigger<select value={action.trigger.kind} onChange={event => {
          if (event.target.value === 'level') setTrigger({ kind: 'level', level: clip.range.start });
          if (event.target.value === 'zone' && verifiedZones?.[0]) setTrigger({ kind: 'zone', zoneId: verifiedZones[0].id });
          if (event.target.value === 'firstMap' && firstMapAnchor) setTrigger({ kind: 'firstMap', anchorId: firstMapAnchor });
        }}><option value="level">Level</option><option value="zone" disabled={!verifiedZones?.length}>Zone</option><option value="firstMap" disabled={!firstMapAnchor}>First map</option>{!['level', 'zone', 'firstMap'].includes(action.trigger.kind) && <option value={action.trigger.kind}>{triggerLabel(action.trigger)}</option>}</select></label>
        {action.trigger.kind === 'level' && <label>Level<input type="number" min={1} max={100} defaultValue={action.trigger.level} key={`${action.actionId}:${action.trigger.level}`} onBlur={event => setTrigger({ kind: 'level', level: Number(event.target.value) })} /></label>}
        {action.trigger.kind === 'zone' && <label>Zone<select value={action.trigger.zoneId} onChange={event => setTrigger({ kind: 'zone', zoneId: event.target.value })}>{verifiedZones?.map(zone => <option key={zone.id} value={zone.id}>{zone.label}</option>)}</select></label>}
      </>}
      {option.source.fallbackSnapshot?.kind === 'atlas' && <div className="timeline-range-fields"><label>Atlas points from<input type="number" min={0} value={fromText} onChange={event => setFromText(event.target.value)} onBlur={commitPoints} onKeyDown={pointKeys(() => setFromText(String(pointsFrom)))} /></label><label>Atlas points to<input type="number" min={0} value={toText} onChange={event => setToText(event.target.value)} onBlur={commitPoints} onKeyDown={pointKeys(() => setToText(String(pointsTo)))} /></label><p>{clip.atlasPointRange ? pointRangeLabel(clip.atlasPointRange) : 'Whole Atlas plan'}. These are Atlas points, not character levels.</p></div>}
      {text && <><label>First action<textarea value={first} onChange={event => setFirst(event.target.value)} onBlur={saveText} /></label><label>Details<textarea rows={6} value={details} onChange={event => setDetails(event.target.value)} onBlur={saveText} /></label></>}
      {excludedByCoverage(clip).length > 0 && <div><h3>Excluded actions</h3>{option.actions.filter(action => excludedByCoverage(clip).includes(action.actionId)).map(action => <p key={action.actionId}>{triggerLabel(action.trigger)}: {action.instruction.firstAction}</p>)}</div>}
      <label className="timeline-switch"><Switch checked={!muted} onChange={onMute} label="Enabled in Run" />Enabled in Run</label>
      {latest && <><p>New source revision available</p><button className="btn" onClick={onUpdate} disabled={offline}>Preview update</button><button className="btn" onClick={onKeep}>Keep this version</button></>}
      {error && <p role="alert">{error}</p>}
      <footer><button className="btn" onClick={onDuplicate}>Duplicate</button><button className="btn" onClick={onRemove}>Remove clip</button></footer>
    </>}
  </aside>;
}
export function triggerLabel(trigger: import('@pom/mastery-contracts').Trigger): string {
  switch (trigger.kind) {
    case 'level': return `Level ${trigger.level}`;
    case 'areaLevel': return `AreaLevel ${trigger.level}${trigger.areaId ? ` / ${trigger.areaId}` : ''}`;
    case 'atlasAllocated': return `Allocated points ${trigger.points}`;
    case 'firstMap': return 'First map';
    case 'zone': return `Zone ${trigger.zoneId}`;
    case 'quest': return `Quest ${trigger.questId}`;
    case 'manual': return `Reviewed / ${trigger.ordinal + 1}`;
  }
}
