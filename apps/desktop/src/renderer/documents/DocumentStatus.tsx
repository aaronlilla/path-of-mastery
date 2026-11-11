import { saveLabel, stampLines, syncLabel, type LocalSaveState, type SyncState } from './model.js';
import type { LeagueStamp } from '@pom/mastery-contracts';
import './documents.css';
import { tr } from '../i18n';

export function DocumentStatus({ local, sync, offline, stamp, oldLeague, onRecovery, onConflict, onSync, onCopy }: {
  local: LocalSaveState; sync: SyncState; offline?: boolean; stamp: LeagueStamp; oldLeague?: boolean;
  onRecovery?: () => void; onConflict?: () => void; onSync?: () => void; onCopy?: () => void;
}) {
  const label = saveLabel(local);
  return <div className="mastery-document-status">
    <span role="status">{local.status === 'failed' ? <button type="button" className="btn ghost" onClick={onRecovery}>{label}</button> : label}</span>
    <span>{syncLabel(sync)}</span>{sync === 'conflict' && onConflict && <button type="button" className="btn" onClick={onConflict}>{tr('documents_DocumentStatus.review_conflict')}</button>}
    {sync === 'local' && onSync && <button type="button" className="btn" onClick={onSync}>{tr('documents_DocumentStatus.sync_to_account')}</button>}
    {offline && <span>{local.status === 'saved' ? tr('documents_DocumentStatus.offline_local_changes_are_saved') : tr('documents_DocumentStatus.offline')}</span>}
    {local.status === 'failed' && <span role="alert">{local.safeReason}</span>}
    {stamp.leagueId.status === 'known' && <span title={stampLines(stamp).join('\n')}>{stampLines(stamp)[0]}</span>}
    {oldLeague && onCopy && <button type="button" className="btn" onClick={onCopy}>{tr('documents_DocumentStatus.copy_to_current_league')}</button>}
  </div>;
}
