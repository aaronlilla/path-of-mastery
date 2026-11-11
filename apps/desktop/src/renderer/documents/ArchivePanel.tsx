import { useEffect, useState, type ReactNode } from 'react';
import { Dialog, useToast } from '../ui';
import { validName } from './model.js';
import './documents.css';
import { tr } from '../i18n';

export interface ArchiveRow { id: string; title: string; /** What the item is stamped with, e.g. "Tree 3.28". */ stamp: string }

/**
 * The Archive of one area: its old-league items, and "Copy to {current}" then "Create copy".
 * One dialog with two views so Escape and focus have a single owner. `onCopy` returns an error text, or null when the copy was made.
 */
/**
 * While an Archive is open no area shortcut may act on what is behind it (Delete in Builds, H in the Loot Filter editor...). Keys that start
 * outside the dialog stop at the window, and keys from inside it stop at #root, after React has given them to the dialog, so no
 * document or window listener of any area sees them. Escape still closes (the Dialog's own listener runs first, in the capture phase).
 */
function useBlockAreaKeys() {
  useEffect(() => {
    const outside = (e: KeyboardEvent) => { if (!(e.target as Element | null)?.closest?.('[role="dialog"]')) e.stopPropagation(); };
    const inside = (e: Event) => e.stopPropagation();
    const root = document.getElementById('root');
    window.addEventListener('keydown', outside, true);
    root?.addEventListener('keydown', inside);
    return () => { window.removeEventListener('keydown', outside, true); root?.removeEventListener('keydown', inside); };
  }, []);
}

export function ArchivePanel({ area, current, rows, emptyText, note, onCopy, onClose }: {
  area: string; current: string; rows: ArchiveRow[]; emptyText: string; note?: ReactNode;
  onCopy?: (row: ArchiveRow, name: string) => Promise<string | null>; onClose: () => void;
}) {
  useBlockAreaKeys();
  const toast = useToast();
  const [copying, setCopying] = useState<ArchiveRow | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (copying) {
    const create = async () => {
      setBusy(true); setError('');
      const err = await onCopy!(copying, name.trim());
      setBusy(false);
      if (err) return setError(err);
      toast({ text: tr('documents_ArchivePanel.copied_as_trim_stamped_current', { name: name.trim(), current }), kind: 'ok' });
      onClose();
    };
    return <Dialog title={tr('documents_ArchivePanel.copy_to_current', { current })} confirmLabel={tr('documents_ArchivePanel.create_copy')} cancelLabel={tr('documents_ArchivePanel.back')} confirmDisabled={busy || !validName(name)} confirmBusy={busy}
      onCancel={() => { setCopying(null); setError(''); }} onConfirm={() => void create()}>
      <label className="mastery-field">{tr('documents_ArchivePanel.name')}<input className="field" value={name} data-autofocus onChange={(e) => setName(e.target.value)} /></label>
      <p>{tr('documents_ArchivePanel.source_stamp', { stamp: copying.stamp })}</p><p>{tr('documents_ArchivePanel.target_current', { current })}</p>
      {error && <p role="alert">{error}</p>}
    </Dialog>;
  }
  return <Dialog title={tr('documents_ArchivePanel.archive_area', { area })} subtitle={tr('documents_ArchivePanel.items_saved_for_a_league', { current })} confirmLabel={null} cancelLabel={tr('documents_ArchivePanel.close')} onCancel={onClose}>
    {rows.length === 0 && <p className="mastery-archive-empty">{emptyText}</p>}
    {rows.map((row) => <div className="mastery-trash-row mastery-archive-row" key={row.id}>
      <div><strong>{row.title}</strong><p>{tr('documents_ArchivePanel.saved_for_stamp', { stamp: row.stamp })}</p></div>
      {onCopy && <button type="button" className="btn" onClick={() => { setCopying(row); setName(`${row.title} - ${current}`); }}>{tr('documents_ArchivePanel.copy_to_current', { current })}</button>}
    </div>)}
    {note && <p className="mastery-safe-note">{note}</p>}
  </Dialog>;
}
