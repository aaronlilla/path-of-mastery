import { useEffect, useState } from 'react';
import { Dialog } from '../ui';
import { useAcct } from './useAccount';
import { tr } from '../i18n';

// The account menu opens this dialog; the dialog itself is mounted once in the title bar, so closing the menu does not close it.
const listeners = new Set<(open: boolean) => void>();
export function openDeleteAccount(): void {
  for (const l of listeners) l(true);
}

const DELETED = [
  tr('accounts_DeleteAccountDialog.your_account_and_its_discord'),
  tr('accounts_DeleteAccountDialog.synced_builds_and_their_history'),
  tr('accounts_DeleteAccountDialog.marketplace_posts_unpublished_and_de'),
  tr('accounts_DeleteAccountDialog.your_own_votes_saves_collections'),
  tr('accounts_DeleteAccountDialog.community_builds_wealth_sessions_bul'),
  tr('accounts_DeleteAccountDialog.registered_app_installations_ai_conn'),
  tr('accounts_DeleteAccountDialog.notify_me_emails_and_feedback'),
];

/** "Delete account…": the same confirm as the site's Account page (type DELETE), then the site route deletes everything and this PC signs out. */
export function DeleteAccountDialog() {
  const a = useAcct();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    const l = (v: boolean) => { setOpen(v); setTyped(''); setError(null); setBusy(false); setDone(false); setTried(false); };
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  if (!open) return null;
  const close = () => {
    if (busy) return;
    // Closed after a failed try: the attempt is over and this account's sync comes back.
    if (tried && !done) void a.api.cancelDeleteAccount();
    setOpen(false);
  };

  if (done) {
    return (
      <Dialog size="small" icon="user" title={tr('accounts_DeleteAccountDialog.your_account_is_deleted')} subtitle={tr('accounts_DeleteAccountDialog.this_pc_is_signed_out')} cancelLabel={null} confirmLabel={tr('accounts_DeleteAccountDialog.close')} onCancel={close} onConfirm={close}>
        <div className="acct-dlg" data-account-deleted>
          <span>{tr('accounts_DeleteAccountDialog.everything_we_held_for_your')}</span>
          <span className="hint">{tr('accounts_DeleteAccountDialog.your_builds_on_this_pc')}</span>
        </div>
      </Dialog>
    );
  }

  const ready = typed.trim() === 'DELETE';
  const run = async () => {
    if (!ready || busy) return;
    setBusy(true); setError(null); setTried(true);
    const r = await a.api.deleteAccount();
    setBusy(false);
    if (r.ok) setDone(true);
    else setError(r.error);
  };
  return (
    <Dialog
      size="medium"
      tone="danger"
      icon="danger"
      title={tr('accounts_DeleteAccountDialog.delete_your_account')}
      subtitle={tr('accounts_DeleteAccountDialog.this_deletes_immediately_and_for')}
      confirmLabel={busy ? tr('accounts_DeleteAccountDialog.deleting') : tr('accounts_DeleteAccountDialog.delete_account')}
      confirmIcon="trash"
      confirmDisabled={!ready || busy}
      confirmBusy={busy}
      onCancel={close}
      onConfirm={() => void run()}
    >
      <div className="acct-dlg">
        <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4, fontSize: 13, color: 'var(--text-2)' }}>
          {DELETED.map((t) => <li key={t}>{t}</li>)}
        </ul>
        <span className="hint">{tr('accounts_DeleteAccountDialog.builds_saved_on_this_pc')}</span>
        <label className="field-label">
          <span className="lbl">{tr('accounts_DeleteAccountDialog.type_delete_to_confirm')}</span>
          <input className="input" data-autofocus value={typed} disabled={busy} onChange={(e) => setTyped(e.target.value)} spellCheck={false} autoComplete="off" aria-label={tr('accounts_DeleteAccountDialog.type_delete_to_confirm')} />
        </label>
        <div role="alert" className={'field-msg' + (error ? ' bad' : '')} style={{ minHeight: 18 }}>{error ?? (busy ? tr('accounts_DeleteAccountDialog.deleting_your_account_keep_the') : '')}</div>
      </div>
    </Dialog>
  );
}
