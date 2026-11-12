import type { BuildSyncStatus } from '../../shared/accounts.js';
import { Icon } from '../ui';
import { tr } from '../i18n';

/** The sync badge on a cloud build's card: Synced, Syncing…, Offline with the changes waiting, or Conflict with Resolve. */
export function SyncBadge({ status, onResolve, inRow }: { status: BuildSyncStatus; onResolve?: (() => void) | undefined; /** In a list row the badge sits after the name. */ inRow?: boolean }) {
  const s = status.status;
  const look =
    s === 'synced'
      ? { icon: 'cloud-check', text: tr('accounts_SyncBadge.synced'), cls: 'ok' }
      : s === 'syncing'
        ? { icon: 'refresh', text: tr('accounts_SyncBadge.syncing'), cls: 'busy' }
        : s === 'conflict'
          ? { icon: 'warning', text: tr('accounts_SyncBadge.conflict'), cls: 'conflict' }
          : s === 'error'
            ? { icon: 'warning', text: tr('accounts_SyncBadge.sync_paused'), cls: 'busy' }
            : { icon: 'cloud-off', text: tr('accounts_SyncBadge.offline_count_local_changes', { count: status.pending }), cls: 'offline' };
  return (
    <>
      <span className="acct-badge" data-s={look.cls} data-in-row={inRow ? '' : undefined} title={look.text}>
        <Icon name={look.icon} size={12} spin={s === 'syncing'} />
        <span className="t">{look.text}</span>
      </span>
      {s === 'conflict' && onResolve && (
        <button
          type="button"
          className="btn gold sm acct-resolve"
          data-in-row={inRow ? '' : undefined}
          onClick={(e) => {
            e.stopPropagation();
            onResolve();
          }}
        >
          <Icon name="compare" size={14} />
          {tr('accounts_SyncBadge.resolve')}
        </button>
      )}
    </>
  );
}
