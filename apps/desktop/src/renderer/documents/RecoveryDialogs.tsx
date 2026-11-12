import { useEffect, useRef, useState } from 'react';
import { Dialog, topPopup } from '../ui';
import { DEFAULT_CONFLICT_CHOICE, stampLines, type ConflictChoice, type VersionPreview } from './model.js';
import './documents.css';
import { tr } from '../i18n';

function Version({ value, label, onPreview }: { value: VersionPreview; label: string; onPreview: () => void }) {
  return <section className="mastery-version"><h3>{label}</h3><p>{value.title}</p><p>{value.timestamp}</p><p>{value.summary}</p><p>{stampLines(value.revision.stamp)[0]}</p><code>{value.revision.revisionId}</code><button type="button" className="btn" onClick={onPreview}>{tr('documents_RecoveryDialogs.preview')} {label.toLowerCase() === 'this pc' ? tr('documents_RecoveryDialogs.this_pc_2') : tr('documents_RecoveryDialogs.account_2')}</button></section>;
}
export function ConflictDialog({ local, account, cachedAccount, canResolve = true, blockedReason, busy, safeError, onClose, onPreview, onResolve }: {
  local: VersionPreview; account: VersionPreview; cachedAccount?: boolean; canResolve?: boolean; blockedReason?: string;
  busy?: boolean; safeError?: string; onClose: () => void; onPreview: (version: 'this_pc' | 'account') => void;
  onResolve: (choice: ConflictChoice) => void;
}) {
  const [choice, setChoice] = useState<ConflictChoice>(DEFAULT_CONFLICT_CHOICE);
  const label = { keep_both: tr('documents_RecoveryDialogs.keep_both'), this_pc: tr('documents_RecoveryDialogs.use_this_pc'), account: tr('documents_RecoveryDialogs.use_account') }[choice];
  return <Dialog title={tr('documents_RecoveryDialogs.two_versions_changed')} size="large" confirmLabel={label} confirmDisabled={busy || !canResolve} confirmBusy={busy} onCancel={onClose} onConfirm={() => onResolve(choice)} note={tr('documents_RecoveryDialogs.the_other_version_remains_in')}>
    <div className="mastery-version-grid"><Version value={local} label={tr('documents_RecoveryDialogs.this_pc')} onPreview={() => onPreview('this_pc')} /><Version value={account} label={tr('documents_RecoveryDialogs.account')} onPreview={() => onPreview('account')} /></div>
    {cachedAccount && <p>{tr('documents_RecoveryDialogs.cached_account_version_from_timestam', { timestamp: account.timestamp })}</p>}
    <fieldset className="mastery-choice"><legend>{tr('documents_RecoveryDialogs.keep_versions')}</legend>{(['keep_both', 'this_pc', 'account'] as const).map((v) => <label key={v}><input type="radio" name="conflict-choice" checked={choice === v} onChange={() => setChoice(v)} />{{ keep_both: tr('documents_RecoveryDialogs.keep_both'), this_pc: tr('documents_RecoveryDialogs.use_this_pc'), account: tr('documents_RecoveryDialogs.use_account') }[v]}</label>)}</fieldset>
    {!canResolve && <p>{blockedReason ?? tr('documents_RecoveryDialogs.connect_and_sign_in_to')}</p>}{safeError && <p role="alert">{safeError}</p>}
  </Dialog>;
}
export function RecoveryDialog({ draft, safeReason, busy, safeError, onClose, onPreview, onExport, onRetry }: {
  draft: VersionPreview; safeReason: string; busy?: boolean; safeError?: string;
  onClose: () => void; onPreview: () => void; onExport: () => void; onRetry: () => void;
}) {
  const retry = useRef({ busy, onRetry });
  const content = useRef<HTMLDivElement>(null);
  retry.current = { busy, onRetry };
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      const dialog = content.current?.closest('[role="dialog"]');
      const top = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].at(-1);
      if (!dialog || top !== dialog || topPopup() || e.defaultPrevented || e.isComposing || e.repeat || e.altKey || e.shiftKey || e.key.toLowerCase() !== 's' || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault(); e.stopImmediatePropagation(); if (!retry.current.busy) retry.current.onRetry();
    };
    document.addEventListener('keydown', keydown, true);
    return () => document.removeEventListener('keydown', keydown, true);
  }, []);
  return <Dialog title={tr('documents_RecoveryDialogs.save_failed')} confirmLabel={tr('documents_RecoveryDialogs.retry_save')} altLabel={tr('documents_RecoveryDialogs.export_recovery_file')} confirmDisabled={busy} altDisabled={busy} confirmBusy={busy} onCancel={onClose} onConfirm={onRetry} onAlt={onExport}>
    <div ref={content}><p role="alert">{safeReason}</p><Version value={draft} label={tr('documents_RecoveryDialogs.this_pc')} onPreview={onPreview} /><p>{tr('documents_RecoveryDialogs.your_latest_changes_are_not')}</p>{safeError && <p role="alert">{safeError}</p>}</div>
  </Dialog>;
}
export function UnsavedCloseDialog({ busy, safeError, onKeepOpen, onExport, onDiscard }: {
  busy?: boolean; safeError?: string; onKeepOpen: () => void; onExport: () => void; onDiscard: () => void;
}) {
  return <Dialog title={tr('documents_RecoveryDialogs.your_latest_changes_are_not')} cancelLabel={tr('documents_RecoveryDialogs.keep_app_open')} confirmLabel={tr('documents_RecoveryDialogs.close_without_latest_changes')} altLabel={tr('documents_RecoveryDialogs.export_recovery_file')} tone="danger" confirmDisabled={busy} altDisabled={busy} onCancel={onKeepOpen} onConfirm={onDiscard} onAlt={onExport}>
    <p>{tr('documents_RecoveryDialogs.export_a_recovery_file_before')}</p>{safeError && <p role="alert">{safeError}</p>}
  </Dialog>;
}
