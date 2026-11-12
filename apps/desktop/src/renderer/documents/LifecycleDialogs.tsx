import { useState } from 'react';
import type { CopyProvenance, LeagueStamp, ObjectId, RevisionRef } from '@pom/mastery-contracts';
import { Dialog } from '../ui';
import { copyModeAllowed, defaultCopyMode, knownLabel, stampLines, validName, type Compatibility } from './model.js';
import './documents.css';
import { tr } from '../i18n';

export function NameDialog({ mode, name, busy, safeError, onClose, onSubmit }: {
  mode: 'rename' | 'duplicate' | 'folder'; name: string; busy?: boolean; safeError?: string; onClose: () => void; onSubmit: (name: string) => void;
}) {
  const [value, setValue] = useState(name);
  const label = mode === 'rename' ? tr('documents_LifecycleDialogs_2.rename') : mode === 'duplicate' ? tr('documents_LifecycleDialogs_2.duplicate') : tr('documents_LifecycleDialogs.new_folder');
  return <Dialog title={label} onCancel={onClose} confirmLabel={label} confirmDisabled={busy || !validName(value)} confirmBusy={busy} onConfirm={() => onSubmit(value.trim())}>
    <label className="mastery-field">{tr('documents_LifecycleDialogs.name')}<input className="field" value={value} data-autofocus onChange={(e) => setValue(e.target.value)} /></label>
    {!validName(value) && <p className="mastery-safe-note">{tr('documents_LifecycleDialogs.enter_a_name_up_to')}</p>}
    {safeError && <p role="alert">{safeError}</p>}
  </Dialog>;
}
export function DeleteDialog({ item, busy, safeError, onClose, onDelete }: {
  item: { objectId: ObjectId; title: string }; busy?: boolean; safeError?: string; onClose: () => void; onDelete: (id: ObjectId) => void;
}) {
  return <Dialog title={tr('documents_LifecycleDialogs.delete_title', { title: item.title })} tone="danger" confirmLabel={tr('documents_LifecycleDialogs.delete')} confirmBusy={busy} confirmDisabled={busy} onCancel={onClose} onConfirm={() => onDelete(item.objectId)}>
    <p>{tr('documents_LifecycleDialogs.you_can_restore_it_from')}</p>{safeError && <p role="alert">{safeError}</p>}
  </Dialog>;
}
export function MoveDialog({ folders, current, busy, safeError, onClose, onMove }: {
  folders: { id: string; title: string }[]; current: string | null; busy?: boolean; safeError?: string; onClose: () => void; onMove: (id: string | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(current);
  const exists = selected === null || folders.some((f) => f.id === selected);
  return <Dialog title={tr('documents_LifecycleDialogs.move_to_folder')} confirmLabel={tr('documents_LifecycleDialogs.move')} confirmDisabled={busy || !exists} confirmBusy={busy} onCancel={onClose} onConfirm={() => onMove(selected)}>
    <label className="mastery-field">{tr('documents_LifecycleDialogs.search_folders')}<input className="field" placeholder={tr('documents_LifecycleDialogs.search_folders_2')} value={query} onChange={(e) => setQuery(e.target.value)} /></label>
    <div className="mastery-folder-list" role="group" aria-label={tr('documents_LifecycleDialogs.folders')}>
      {[{ id: null, title: tr('documents_LifecycleDialogs.root') }, ...folders].filter((f) => f.title.toLowerCase().includes(query.toLowerCase())).map((f) => <label key={f.id ?? 'root'}><input type="radio" name="folder" checked={selected === f.id} onChange={() => setSelected(f.id)} />{f.title}</label>)}
    </div>{!exists && <p>{tr('documents_LifecycleDialogs.the_selected_folder_is_unavailable')}</p>}{safeError && <p role="alert">{safeError}</p>}
  </Dialog>;
}
export function TrashView({ items, onRestore, busyId, safeError }: {
  items: { objectId: ObjectId; title: string; deletedAt: string; stamp: LeagueStamp }[];
  onRestore: (id: ObjectId) => void; busyId?: ObjectId; safeError?: string;
}) {
  return <section className="mastery-trash" aria-label={tr('documents_LifecycleDialogs.recently_deleted')}><h2>{tr('documents_LifecycleDialogs.recently_deleted')}</h2>
    {items.length === 0 && <p>{tr('documents_LifecycleDialogs.no_recently_deleted_items')}</p>}
    {items.map((item) => <div className="mastery-trash-row" key={item.objectId}><div><strong>{item.title}</strong><p>{tr('documents_LifecycleDialogs.deleted_deletedat', { deletedAt: item.deletedAt })}</p><p>{stampLines(item.stamp)[0]}</p></div><button type="button" className="btn" disabled={!!busyId} onClick={() => onRestore(item.objectId)}>{busyId === item.objectId ? tr('documents_LifecycleDialogs.restoring') : tr('documents_LifecycleDialogs.restore')}</button></div>)}
    {safeError && <p role="alert">{safeError}</p>}
  </section>;
}
export function CopyLeagueDialog({ title, source, target, compatibility, busy, safeError, onClose, onCopy }: {
  title: string; source: RevisionRef; target: LeagueStamp; compatibility: Compatibility;
  busy?: boolean; safeError?: string; onClose: () => void;
  onCopy: (request: { title: string; target: LeagueStamp; provenance: CopyProvenance }) => void;
}) {
  const initial = defaultCopyMode(compatibility);
  const [mode, setMode] = useState(initial);
  const [options, setOptions] = useState(initial === 'source_data');
  const [name, setName] = useState(`${title} - ${knownLabel(target.leagueId)}`);
  return <Dialog title={tr('documents_LifecycleDialogs.copy_to_leagueid', { leagueId: knownLabel(target.leagueId) })} confirmLabel={tr('documents_LifecycleDialogs.create_copy')} confirmDisabled={busy || !validName(name) || !copyModeAllowed(compatibility, mode)} confirmBusy={busy} onCancel={onClose}
    onConfirm={() => onCopy({ title: name.trim(), target, provenance: { source, dataMode: mode } })}>
    <label className="mastery-field">{tr('documents_LifecycleDialogs.name')}<input className="field" value={name} onChange={(e) => setName(e.target.value)} /></label>
    <p>{tr('documents_LifecycleDialogs.source_leagueid_datasetversion', { leagueId: knownLabel(source.stamp.leagueId), datasetVersion: knownLabel(source.stamp.datasetVersion) })}</p><p>{tr('documents_LifecycleDialogs.target_leagueid_datasetversion', { leagueId: knownLabel(target.leagueId), datasetVersion: knownLabel(target.datasetVersion) })}</p>
    <p>{tr('documents_LifecycleDialogs.matched_matched_ids_missing_length', { matched: knownLabel(compatibility.matched), count: compatibility.missing.length, changed: knownLabel(compatibility.changed) })}</p>
    {compatibility.changed.status === 'unknown' && <p>{tr('documents_LifecycleDialogs.effect_comparison_unavailable')}</p>}
    {!options && <button type="button" className="btn ghost" onClick={() => setOptions(true)}>{tr('documents_LifecycleDialogs.show_data_options')}</button>}
    {options && <><div className="seg" data-lg="tile" role="group" aria-label={tr('documents_LifecycleDialogs.tree_data')}>
      <button type="button" aria-pressed={mode === 'source_data'} onClick={() => setMode('source_data')}>{tr('documents_LifecycleDialogs.keep_source_tree_data')}</button>
      <button type="button" aria-pressed={mode === 'target_data'} disabled={!copyModeAllowed(compatibility, 'target_data')} onClick={() => setMode('target_data')}>{tr('documents_LifecycleDialogs.use_target_tree_data')}</button>
    </div>
      {!compatibility.targetAvailable && <p>{tr('documents_LifecycleDialogs.target_data_is_not_available')}</p>}
      {compatibility.targetAvailable && !copyModeAllowed(compatibility, 'target_data') && <p>{tr('documents_LifecycleDialogs.resolve_missing_ids_and_verify')}</p>}
      {[...new Set([...compatibility.missing, ...compatibility.unresolved])].map((id) => <p key={id}>{tr('documents_LifecycleDialogs.unresolved_id')} <code>{id}</code></p>)}</>}
    {mode === 'source_data' && <p>{tr('documents_LifecycleDialogs.source_data_datasetversion_live_comp', { datasetVersion: knownLabel(source.stamp.datasetVersion) })}</p>}
    {safeError && <p role="alert">{safeError}</p>}
  </Dialog>;
}
