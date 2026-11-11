import { useEffect, useRef, useState } from 'react';
import { dataLabel } from '../canvas/model.js';
import type { AtlasPlan, StepId } from '@pom/mastery-contracts';
import { Dialog, Segmented, Select } from '../../ui.js';
import { NumberField } from './PracticalPanel.js';
import { stepIds, stepTitle, type Edit } from './presenter.js';
import { tr, inLanguage } from '../../i18n';

export function StepManager({ plan, selected, edit, select, id, readOnly, close, undo, redo }: { plan: AtlasPlan; selected: StepId; edit: (e: Edit, text?: boolean) => void; select: (id: StepId) => void; id: () => StepId; readOnly: boolean; close: () => void; undo: () => void; redo: () => void }) {
  const [mode, setMode] = useState<'Sequence' | 'Alternatives at selected position'>('Sequence');
  const [preset, setPreset] = useState<'Single step' | 'Early / Mid / Late' | 'By points' | ''>('');
  const [replace, setReplace] = useState(false), [targets, setTargets] = useState(['', '', '']);
  const [chosen, setChosen] = useState<StepId[]>([]), [groupReview, setGroupReview] = useState(false);
  // Shared undo: Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z anywhere in this dialog, including its title bar and empty
  // space (focus then sits on the dialog itself, outside the list), but not while typing in a field and not in a nested dialog.
  const body = useRef<HTMLDivElement>(null), history = useRef({ undo, redo, readOnly });
  history.current = { undo, redo, readOnly };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dialog = body.current?.closest('[role="dialog"]'), target = e.target as HTMLElement | null;
      if (!dialog || !target || !dialog.contains(target) || e.defaultPrevented || history.current.readOnly) return;
      if (!(e.ctrlKey || e.metaKey) || !['z', 'y'].includes(e.key.toLowerCase())) return;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable) return;
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey || e.key.toLowerCase() === 'y') history.current.redo(); else history.current.undo();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const validTargets = targets.every((v, i) => v !== '' && Number.isSafeInteger(Number(v)) && Number(v) >= 0 && (i === 0 || Number(v) > Number(targets[i - 1])));
  const move = (positionId: string, offset: number) => {
    const order = plan.sequencePositions.map(p => p.positionId), from = order.indexOf(positionId), to = from + offset;
    if (to < 0 || to >= order.length) return;
    order.splice(from, 1); order.splice(to, 0, positionId); edit({ kind: 'reorder', positionIds: order });
  };
  return <Dialog title={tr('atlas_editor_StepManager.steps')} size="large" confirmLabel={tr('atlas_editor_StepManager.done')} cancelLabel={null} onCancel={close} onConfirm={close}>
    <div ref={body}>
    <Segmented ariaLabel={tr('atlas_editor_StepManager_2.step_structure')} value={mode} onChange={value => { if (value !== 'Sequence' && chosen.length > 1) setGroupReview(true); else setMode(value); }} options={(['Sequence', 'Alternatives at selected position'] as const).map(value => ({ value, label: value === 'Sequence' ? tr('atlas_editor_StepManager.sequence') : inLanguage('h_atlasA_L', value) }))} />
    <p>{tr('atlas_editor_StepManager.source_data_datasetid', { datasetId: dataLabel(plan.dataset.datasetId) })}</p>
    {plan.sequencePositions.map((position, index) => {
      const ids = position.kind === 'step' ? [position.stepId] : position.optionStepIds;
      if (mode !== 'Sequence' && !ids.includes(selected)) return null;
      return <fieldset className="atlas-step-group" key={position.positionId} draggable={!readOnly}
        onDragStart={e => e.dataTransfer.setData('application/x-atlas-position', position.positionId)} onDragOver={e => e.preventDefault()} onDrop={e => {
          e.preventDefault(); const source = e.dataTransfer.getData('application/x-atlas-position'), order = plan.sequencePositions.map(p => p.positionId);
          if (readOnly || !order.includes(source)) return; order.splice(order.indexOf(source), 1); order.splice(index, 0, source); edit({ kind: 'reorder', positionIds: order });
        }}><legend>{index + 1}{position.kind === 'alternatives' ? tr('atlas_editor_StepManager.choose_one') : ''}</legend>
        {ids.map(stepId => { const step = plan.stepsById[stepId]!; return <div className="atlas-managed-step" key={stepId} onKeyDown={e => {
          const text = e.target instanceof HTMLInputElement;
          if (!readOnly && e.ctrlKey && e.shiftKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); move(position.positionId, e.key === 'ArrowUp' ? -1 : 1); }
          if (!readOnly && !text && e.key === 'Delete') { e.preventDefault(); edit({ kind: 'remove', stepId }); }
          if (e.key === 'F2') { e.preventDefault(); e.currentTarget.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.focus(); }
        }}>
          {position.kind === 'alternatives' && <label><input type="radio" name={`default-${position.positionId}`} aria-label={tr('atlas_editor_StepManager.use_title_in_run', { title: step.title })} disabled={readOnly} checked={position.defaultStepId === stepId} onChange={() => edit({ kind: 'default', positionId: position.positionId, stepId })} />{tr('atlas_editor_StepManager.use_in_run')}</label>}
          {position.kind === 'step' && <label><input type="checkbox" aria-label={tr('atlas_editor_StepManager.select_title_for_alternatives', { title: step.title })} disabled={readOnly} checked={chosen.includes(stepId)} onChange={e => setChosen(old => e.target.checked ? [...old, stepId] : old.filter(id => id !== stepId))} />{tr('atlas_editor_StepManager.choose')}</label>}
          <label className="atlas-field">{tr('atlas_editor_StepManager.name')}<input className="field" aria-label={tr('atlas_editor_StepManager.name')} value={step.title} disabled={readOnly} onFocus={() => select(stepId)} onChange={e => edit({ kind: 'step', stepId, field: 'title', value: e.target.value }, true)} /></label>
          <NumberField label={tr('atlas_editor_StepManager.point_target')} value={step.pointTarget} disabled={readOnly} onChange={value => edit({ kind: 'step', stepId, field: 'pointTarget', value })} />
          <div className="atlas-row-actions"><button type="button" className="btn" disabled={readOnly} onClick={() => edit({ kind: 'add', sourceId: stepId, newId: id() })}>{tr('atlas_editor_StepManager.duplicate')}</button>
            <button type="button" className="btn" disabled={readOnly || stepIds(plan).length === 1} title={stepIds(plan).length === 1 ? tr('atlas_editor_StepManager.a_plan_needs_one_step') : undefined} onClick={() => edit({ kind: 'remove', stepId })}>{tr('atlas_editor_StepManager.remove')}</button></div>
        </div>; })}
        <div className="atlas-row-actions"><button type="button" className="btn" disabled={readOnly || index === 0} onClick={() => move(position.positionId, -1)}>{tr('atlas_editor_StepManager.move_up')}</button><button type="button" className="btn" disabled={readOnly || index === plan.sequencePositions.length - 1} onClick={() => move(position.positionId, 1)}>{tr('atlas_editor_StepManager.move_down')}</button>
          <button type="button" className="btn" disabled={readOnly} onClick={() => edit({ kind: 'alternative', sourceId: ids.includes(selected) ? selected : ids[0]!, newId: id(), groupId: `alternatives:${id()}` })}>{tr('atlas_editor_StepManager.add_alternative')}</button></div>
        {position.kind === 'alternatives' && <p>{tr('atlas_editor_StepManager.run_default_title', { title: stepTitle(plan.stepsById[position.defaultStepId]!.title) })}</p>}
      </fieldset>;
    })}
    <div className="atlas-row-actions"><button type="button" className="btn" disabled={readOnly} onClick={() => edit({ kind: 'add', sourceId: selected, newId: id() })}>{tr('atlas_editor_StepManager.add_step')}</button>
      <Select ariaLabel={tr('atlas_editor_StepManager.preset')} value={preset} options={[{ value: '', label: tr('atlas_editor_StepManager.preset') }, ...(['Single step', 'Early / Mid / Late', 'By points'] as const).map(value => ({ value, label: inLanguage('h_atlasA_L', value) }))]} onChange={v => { setReplace(false); setPreset(v); }} /></div>
    <p>{tr('atlas_editor_StepManager.changes_are_saved_as_you')}</p>
    {groupReview && <Dialog title={tr('atlas_editor_StepManager.alternatives_at_selected_position')} onCancel={() => setGroupReview(false)} confirmLabel={tr('atlas_editor_StepManager.choose')} onConfirm={() => { edit({ kind: 'group', stepIds: chosen, defaultStepId: chosen.includes(selected) ? selected : chosen[0]!, groupId: `alternatives:${id()}` }); setChosen([]); setGroupReview(false); setMode('Alternatives at selected position'); }}>
      <p>{tr('atlas_editor_StepManager.move_length_sequence_steps_into', { count: chosen.length })}</p><ul>{chosen.map(id => <li key={id}>{stepTitle(plan.stepsById[id]?.title ?? '')}</li>)}</ul>
    </Dialog>}
    {preset && <Dialog title={tr('atlas_editor_StepManager.preset')} onCancel={() => setPreset('')} confirmLabel={tr('atlas_editor_StepManager.apply_preset')} confirmDisabled={readOnly || preset !== 'Single step' && !validTargets} onConfirm={() => {
      const names = preset === 'Single step' ? [tr('atlas_editor_StepManager_2.step_1')] : preset === 'Early / Mid / Late' ? [tr('atlas_editor_StepManager_2.early'), tr('atlas_editor_StepManager_2.mid'), tr('atlas_editor_StepManager_2.late')] : targets.map(value => tr('atlas_editor_StepManager.value_points', { value }));
      edit({ kind: 'preset', names, ids: names.map(() => id()), targets: preset !== 'Single step' ? targets.map(Number) : undefined, replace }); setPreset('');
    }}>
      {preset !== 'Single step' ? targets.map((value, index) => <label className="atlas-field" key={index}>{tr('atlas_editor_StepManager.point_target_index', { index: index + 1 })}<input className="field" type="number" min="0" value={value} onChange={e => setTargets(old => old.map((v, i) => i === index ? e.target.value : v))} /></label>) : <p>{inLanguage('h_atlasA_L', preset)}</p>}
      <Segmented ariaLabel={tr('atlas_editor_StepManager.preset_destination')} value={replace ? 'Replace' : 'Append'} onChange={v => setReplace(v === 'Replace')} options={['Append', 'Replace'].map(value => ({ value, label: inLanguage('h_atlasA_L', value) }))} />
      {replace && <p>{tr('atlas_editor_StepManager.replace_removes_length_steps_you', { count: stepIds(plan).length })}</p>}
      {preset !== 'Single step' && !validTargets && <p>{tr('atlas_editor_StepManager.enter_three_increasing_point_targets')}</p>}
      <p>{tr('atlas_editor_StepManager.creates_empty_structure_point_target')}</p>
    </Dialog>}
    </div>
  </Dialog>;
}
