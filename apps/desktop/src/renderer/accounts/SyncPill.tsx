import { useRef, useState } from 'react';
import type { SyncState, SyncView } from '../../shared/accounts.js';
import { Icon, useDismiss } from '../ui';
import { acctText, useAcct, useAcctCall } from './useAccount';
import { tr } from '../i18n';

interface Look {
  icon: string;
  colour: string;
  label: string;
  head: (v: SyncView | null) => string;
  badge: string;
}

const LOOK: Record<SyncState, Look> = {
  local: { icon: 'cloud-off', colour: 'var(--text-muted)', label: tr('accounts_SyncPill.local'), head: () => tr('accounts_SyncPill.builds_are_saved_on_this'), badge: 'rgba(var(--line-rgb),.08)' },
  synced: { icon: 'cloud-check', colour: 'var(--sync-ok)', label: tr('accounts_SyncPill.synced'), head: () => tr('accounts_SyncPill.all_builds_synced'), badge: 'rgba(79,220,124,.12)' },
  syncing: { icon: 'refresh', colour: 'var(--text-3)', label: tr('accounts_SyncPill.syncing'), head: (v) => (v && v.pending.length ? tr('accounts_SyncPill.syncing_count_builds', { count: v.pending.length }) : tr('accounts_SyncPill.checking_for_changes')), badge: 'rgba(var(--line-rgb),.08)' },
  conflict: { icon: 'warning', colour: 'var(--warning-text)', label: tr('accounts_SyncPill.n1_conflict'), head: (v) => (v?.conflicts.length ?? 1) === 1 ? tr('h_rA_acct.needs_you_one', { n: 1 }) : tr('h_rA_acct.needs_you_many', { n: v?.conflicts.length }), badge: 'rgba(255,153,34,.12)' },
  offline: { icon: 'cloud-off', colour: 'var(--text-muted)', label: tr('accounts_SyncPill.offline'), head: () => tr('accounts_SyncPill.you_are_offline'), badge: 'rgba(var(--line-rgb),.08)' },
  error: { icon: 'warning', colour: 'var(--warning-text)', label: tr('accounts_SyncPill.sync_paused'), head: () => tr('accounts_SyncPill.sync_ran_into_a_problem'), badge: 'rgba(255,153,34,.12)' },
};

export function syncLabel(state: SyncState, conflicts: number): string {
  return state === 'conflict' ? tr('accounts_SyncPill.count_conflicts', { count: conflicts }) : LOOK[state].label;
}

/** The title bar's sync pill and its popover. Signed out it says Local; signed in it follows the sync. */
export function SyncPill({ onRevealBuilds, onResolve, hidden }: { onRevealBuilds: () => void; onResolve: (localId: string) => void; hidden?: boolean }) {
  const a = useAcct();
  const call = useAcctCall();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useDismiss(wrap, open, () => setOpen(false));
  const sync = a.sync;
  const state: SyncState = a.signedIn ? sync?.state ?? 'synced' : 'local';
  const look = LOOK[state];
  const label = syncLabel(state, sync?.conflicts.length ?? 0);
  const head = look.head(sync);
  const meta = a.signedIn ? acctText(sync?.meta ?? '') : tr('accounts_SyncPill.sign_in_to_keep_them');
  const pendingHead = state === 'offline' ? tr('accounts_SyncPill_2.waiting_to_upload') : tr('accounts_SyncPill_2.uploading');
  return (
    <div ref={wrap} style={{ position: 'relative', display: hidden ? 'none' : undefined }}>
      <button
        type="button"
        className="sync-pill"
        data-state={state}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={head}
        title={head}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={look.icon} size={12} spin={state === 'syncing'} style={{ color: look.colour }} />
        <span className="lbl">{label}</span>
      </button>
      <span role="status" aria-live="polite" className="acct-sr">{head}</span>
      {open && (
        <div className="sync-pop" data-lg="pop" data-solid="" role="dialog" aria-label={tr('accounts_SyncPill.sync_status')}>
          <div className="acct-sy-head">
            <span className="badge" style={{ background: look.badge, color: look.colour }}>
              <Icon name={look.icon} size={16} spin={state === 'syncing'} />
            </span>
            <span className="tx">
              <span className="h">{head}</span>
              <span className="m">{meta}</span>
            </span>
          </div>
          {a.signedIn && sync && sync.pending.length > 0 && (
            <div className="acct-sy-list">
              <span className="eyebrow">{pendingHead}</span>
              {sync.pending.map((p) => (
                <div key={p.localId} className="row">
                  <span className="n">{p.name}</span>
                  <span className="w">{acctText(p.what)}</span>
                </div>
              ))}
            </div>
          )}
          {a.signedIn && sync && sync.conflicts.map((c) => (
            <div key={c.localId} className="acct-sy-conflict">
              <span className="tx">
                <span className="n">{c.name}</span>
                <span className="m">{tr('accounts_SyncPill.edited_on_this_pc_and', { deviceName: acctText(c.theirs.deviceName) })}</span>
              </span>
              <button type="button" className="btn gold sm" onClick={() => { setOpen(false); onResolve(c.localId); }}>
                <Icon name="compare" size={14} />
                {tr('accounts_SyncPill.resolve')}
              </button>
            </div>
          ))}
          {state === 'error' && sync?.detail && <div className="acct-sy-note">{acctText(sync.detail)}</div>}
          <div className="acct-sy-foot">
            {a.signedIn ? (
              <button type="button" className="btn ghost sm" disabled={state === 'syncing'} onClick={() => void call(a.api.syncNow())}>
                <Icon name="refresh" size={14} />
                {tr('accounts_SyncPill.sync_now')}
              </button>
            ) : (
              <>
                <button type="button" className="btn gold sm" onClick={() => { setOpen(false); a.openSignIn(); }}>
                  <Icon name="log-in" size={14} />
                  {tr('accounts_SyncPill.sign_in')}
                </button>
                <button type="button" className="btn ghost sm" onClick={() => { setOpen(false); onRevealBuilds(); }}>
                  <Icon name="folder-open" size={14} />
                  {tr('accounts_SyncPill.open_builds_folder')}
                </button>
              </>
            )}
            <span className="sp" />
            {a.signedIn && <span className="hint">{tr('accounts_SyncPill.versions_kept_90_days')}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
