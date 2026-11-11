import { Dialog } from '../ui';
import type { ClipId, Timeline } from '@pom/mastery-contracts';
import type { PreflightResult } from '../../shared/timelines/editor/preflight.js';
export function RunSetup({ timeline, result, level, points, onLevel, onPoints, onChoice, onOmit, onRepair, onRun, onCancel, onKeepCurrent, busy, replaceCurrent, onReplace }: {
  timeline: Timeline; result: Extract<PreflightResult, { ready: false }>; level: number; points: string;
  onLevel(value: number): void; onPoints(value: string): void; onChoice(clipId: ClipId, optionId: string): void;
  onOmit(clipId: ClipId): void; onRepair(clipId: ClipId): void; onRun(): void; onCancel(): void;
  onKeepCurrent?(): void; busy: boolean; replaceCurrent: boolean; onReplace(): void;
}) {
  const unresolved = result.blockers.filter(blocker => blocker.kind !== 'competing' || !replaceCurrent);
  const validPosition = Number.isInteger(level) && level >= 1 && level <= 100 && (points === '' || Number.isSafeInteger(Number(points)) && Number(points) >= 0);
  return <div onKeyDownCapture={event => { if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); event.stopPropagation(); } }}>
    <Dialog title="Resolve Run setup" subtitle={`Timeline ${timeline.title}`} size="large" confirmLabel="Run" confirmDisabled={busy || unresolved.length > 0 || !validPosition} confirmBusy={busy} onConfirm={onRun} onCancel={onCancel}>
      <div className="timeline-dialog-fields"><p>{result.activeLanes} active lanes / {result.mutedLanes} muted lanes</p><h3>Needs attention</h3>
      {result.blockers.map((blocker, index) => {
        const clip = 'clipId' in blocker ? timeline.clips.find(clip => clip.clipId === blocker.clipId) : undefined;
        return <div className="timeline-blocker" key={index}><p>{clip?.options[0]?.title}{clip ? ': ' : ''}{blocker.message}</p>
          {blocker.kind === 'alternative' && clip && <label>Choose one alternative<select value={clip.selectedOptionId ?? ''} onChange={event => onChoice(clip.clipId, event.target.value)}><option value="">Choose one alternative</option>{clip.options.map(option => <option key={option.optionId} value={option.optionId}>{option.title}</option>)}</select></label>}
          {(blocker.kind === 'source' || blocker.kind === 'compatibility') && <><button className="btn" onClick={() => onRepair(blocker.clipId)}>Choose source</button><button className="btn" onClick={() => onOmit(blocker.clipId)}>Omit</button></>}
          {blocker.kind === 'empty' && <button className="btn" onClick={onCancel}>Add a clip</button>}
          {blocker.kind === 'competing' && <><button className="btn" onClick={onKeepCurrent ?? onCancel}>Keep current run</button><button className="btn" aria-pressed={replaceCurrent} onClick={onReplace}>Replace with this timeline</button></>}
        </div>;
      })}
      <label>Start at Level<input type="number" min={1} max={100} value={level} onChange={event => onLevel(Number(event.target.value))} /></label>
      <label>Atlas points<input type="number" min={0} placeholder="Unknown" value={points} onChange={event => onPoints(event.target.value)} /></label></div>
    </Dialog>
  </div>;
}
