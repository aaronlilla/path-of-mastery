import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog } from '../ui';
import { historyRows, stampLines, type HistoryModel, type HistorySelection } from './model.js';
import './documents.css';
import { tr, fromMain } from '../i18n';

export function HistoryDialog({ model, onClose, onPreview, onReturn, onRestore, onUndo, onRedo, preview, busy, safeError }: {
  model: HistoryModel; onClose: () => void; onPreview: (row: HistorySelection) => void; onReturn: () => void;
  onRestore: (row: HistorySelection) => void; onUndo?: () => void; onRedo?: () => void;
  preview?: ReactNode; busy?: boolean; safeError?: string;
}) {
  const rows = historyRows(model);
  const [selected, setSelected] = useState<HistorySelection | null>(null);
  const [scroll, setScroll] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const latestReturn = useRef(onReturn);
  latestReturn.current = onReturn;
  useEffect(() => () => latestReturn.current(), []);
  const current = selected?.revision.revisionId === model.current.revisionId;
  const first = Math.max(0, Math.floor(scroll / 72) - 2);
  const visible = rows.slice(first, first + 12);
  const choose = (row: HistorySelection) => { setSelected(row); onPreview(row); };
  const returnCurrent = () => { setSelected(null); onReturn(); };
  return <Dialog title={model.kind === 'edit' ? tr('documents_HistoryDialog.edit_history') : tr('documents_HistoryDialog.account_version_history')} size="large" onCancel={onClose}
    confirmLabel={tr('documents_HistoryDialog.restore_this_revision')} confirmDisabled={busy || !selected || current} confirmBusy={busy}
    onConfirm={() => { if (selected) onRestore(selected); }} note={tr('documents_HistoryDialog.restoring_creates_a_new_revision')}>
    {model.kind === 'edit' && <div className="mastery-history-controls"><button type="button" className="btn" disabled={busy || !!selected || !model.canUndo || !onUndo} onClick={onUndo}>{tr('documents_HistoryDialog.undo')}</button><button type="button" className="btn" disabled={busy || !!selected || !model.canRedo || !onRedo} onClick={onRedo}>{tr('documents_HistoryDialog.redo')}</button><span>{tr('documents_HistoryDialog.active_branch_activebranch', { activeBranch: model.activeBranch })}</span></div>}
    <p>{tr('documents_HistoryDialog.current_revision')} <code>{model.current.revisionId}</code></p>
    {rows.length === 0 && <p>{model.kind === 'edit' ? tr('documents_HistoryDialog.no_edit_history_is_available') : tr('documents_HistoryDialog.no_account_versions_are_available')}</p>}
    <div ref={list} className="mastery-history-list" role="listbox" aria-label={model.kind === 'edit' ? tr('documents_HistoryDialog.edit_transactions') : tr('documents_HistoryDialog.account_versions')} tabIndex={0}
      onScroll={(e) => setScroll(e.currentTarget.scrollTop)} onKeyDown={(e) => {
        const i = selected ? rows.findIndex((r) => r.revision.revisionId === selected.revision.revisionId && r.transactionId === selected.transactionId) : -1;
        const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : e.key === 'ArrowUp' ? Math.max(0, i - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : null;
        if (next == null || !rows[next]) return;
        e.preventDefault(); choose(rows[next]!); list.current?.scrollTo({ top: next * 72 }); list.current?.focus();
      }}>
      <div style={{ height: first * 72 }} />
      {visible.map((row, i) => <button type="button" className="mastery-history-row" key={row.transactionId ?? row.revision.revisionId}
        role="option" aria-posinset={first + i + 1} aria-setsize={rows.length} aria-selected={selected?.revision.revisionId === row.revision.revisionId && selected.transactionId === row.transactionId} onClick={() => choose(row)} title={`${fromMain('ml_mastery_text', row.label)}\n${stampLines(row.revision.stamp).join('\n')}`}>
        <span>{fromMain('ml_mastery_text', row.label)}</span><span>{row.createdAt}</span>
        {row.branch && <span>{row.branch === (model.kind === 'edit' ? model.activeBranch : null) ? tr('documents_HistoryDialog.active_branch') : tr('documents_HistoryDialog.other_branches_branch', { branch: row.branch })}</span>}
      </button>)}
      <div style={{ height: Math.max(0, rows.length - first - visible.length) * 72 }} />
    </div>
    {selected && <div className="mastery-history-preview"><p>{tr('documents_HistoryDialog.preview_only_your_current_plan')}</p><p>{stampLines(selected.revision.stamp)[0]}</p>{preview}<button type="button" className="btn" onClick={returnCurrent}>{tr('documents_HistoryDialog.return_to_current')}</button></div>}
    {safeError && <p role="alert">{safeError}</p>}
  </Dialog>;
}
