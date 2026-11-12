import { useEffect, useState } from 'react';
import type { DeletedCloudBuild } from '../../shared/accounts.js';
import { formatWhen } from '../format';
import { Dialog, Icon, useToast } from '../ui';
import { Avatar } from './Avatar';
import { useAcct, useAcctCall } from './useAccount';
import { tr } from '../i18n';

/** Account settings: who is signed in, what syncs, and sign out. */
export function AccountDialog({ localOnly, onClose }: { localOnly: number; onClose: () => void }) {
  const a = useAcct();
  const call = useAcctCall();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState<DeletedCloudBuild[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);
  const signedIn = a.view?.auth.state === 'signedIn';
  // Deleted builds stay in the cloud for 90 days. Looked up when the dialog opens, and again after a restore.
  const load = () => void a.api.deletedBuilds().then((r) => r.ok && setDeleted(r.value));
  useEffect(() => {
    if (signedIn) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);
  const auth = a.view?.auth;
  const user = auth && (auth.state === 'signedIn' || auth.state === 'restoring') ? auth.user : null;
  if (!user) return null;
  return (
    <Dialog size="small" icon="user" title={tr('accounts_AccountDialog.account')} subtitle={tr('accounts_AccountDialog.signed_in_on_device', { device: a.view?.deviceName ?? '' })} cancelLabel={tr('accounts_AccountDialog.close')} confirmLabel={tr('accounts_AccountDialog.sign_out')} confirmIcon="log-out" onCancel={onClose} onConfirm={() => void call(a.api.signOut()).then(onClose)}>
      <div className="acct-dlg">
        <div className="who">
          <Avatar user={user} size={48} />
          <span className="tx">
            <span className="nm">{user.name}</span>
            <span className="em">{user.email}</span>
          </span>
        </div>
        <div className="kv"><span>{tr('accounts_AccountDialog.n_cloud_m_local_only', { cloud: a.sync?.cloudCount ?? 0, local: localOnly })}</span></div>
        {localOnly > 0 && (
          <button
            type="button"
            className="btn"
            data-lg="control"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const n = await call(a.api.enrollAll());
              setBusy(false);
              if (n !== undefined) toast({ text: n ? tr('accounts_AccountDialog.syncing_count_builds_to_the', { count: n }) : tr('accounts_AccountDialog.everything_is_already_in_the'), kind: 'ok' });
            }}
          >
            <Icon name="cloud" size={16} />
            {tr('accounts_AccountDialog.sync_all_local_builds')}
          </button>
        )}
        {deleted.length > 0 && (
          <div className="acct-del" role="group" aria-label={tr('accounts_AccountDialog.deleted_from_the_cloud')}>
            <span className="eyebrow">{tr('accounts_AccountDialog.deleted_from_the_cloud_kept')}</span>
            <div className="list">
              {deleted.map((b) => (
                <div key={b.cloudId} className="row">
                  <span className="tx">
                    <span className="n">{b.name}</span>
                    <span className="m">{[b.ascendClassName || b.className, b.level ? tr('accounts_AccountDialog_2.lv', { level: b.level }) : '', tr('accounts_AccountDialog_2.deleted', { deletedAt: formatWhen(b.deletedAt) })].filter(Boolean).join(' · ')}</span>
                  </span>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={restoring !== null}
                    onClick={async () => {
                      setRestoring(b.cloudId);
                      const ok = await call(a.api.restoreDeleted(b.cloudId));
                      setRestoring(null);
                      if (ok === true) toast({ text: tr('accounts_AccountDialog.restored_name_it_is_back', { name: b.name }), kind: 'ok' });
                      else if (ok === false) toast({ text: tr('accounts_AccountDialog.name_could_not_be_restored', { name: b.name }), kind: 'error' });
                      load();
                    }}
                  >
                    <Icon name="refresh" size={14} />
                    {restoring === b.cloudId ? tr('accounts_AccountDialog.restoring') : tr('accounts_AccountDialog.restore')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        <span className="hint">{tr('accounts_AccountDialog.signing_out_keeps_every_build')}</span>
      </div>
    </Dialog>
  );
}
