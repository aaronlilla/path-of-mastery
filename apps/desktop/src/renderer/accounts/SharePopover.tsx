import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShareInfo, ShareSettings } from '../../shared/accounts.js';
import { Icon, PortalMenu, Switch, useToast } from '../ui';
import { useAcct } from './useAccount';
import { tr } from '../i18n';

const DEFAULTS: ShareSettings = { access: 'link', includeNotes: true, includeLoadouts: true, allowDuplicate: false };

function ago(ms: number | null, now: number): string {
  if (!ms) return tr('accounts_SharePopover.not_synced_yet');
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return tr('accounts_SharePopover.synced_just_now');
  if (s < 60) return tr('accounts_SharePopover.synced_s_s_ago', { s });
  if (s < 3600) return tr('accounts_SharePopover.synced_v1_min_ago', { value: Math.round(s / 60) });
  return tr('accounts_SharePopover.synced_v1_h_ago', { value: Math.round(s / 3600) });
}

function Opt({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div className="opt" onClick={() => onChange(!checked)}>
      <span onClick={(e) => e.stopPropagation()} style={{ display: "flex" }}>
        <Switch checked={checked} onChange={onChange} label={label} />
      </span>
      <span>{label}</span>
    </div>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The share button's popover: a link to the cloud copy, who can open it, and what the link includes. */
export function SharePopover({ anchor, open, onClose, localId, onCopyCode }: { anchor: React.RefObject<HTMLElement | null>; open: boolean; onClose: () => void; localId: string; onCopyCode: () => void }) {
  const a = useAcct();
  const toast = useToast();
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  /** The build has no link yet: ask before making one (it puts a copy of the build in the cloud library for anyone with the link). */
  const [ask, setAsk] = useState(false);
  const [now, setNow] = useState(Date.now());
  const started = useRef(false);

  const status = a.statusOf(localId);
  const inCloud = !!status;
  const conflict = status?.status === 'conflict';

  /** Copies a link, flashes the button and says so, as Copy build code does. */
  const copyLink = useCallback(
    async (url: string) => {
      const ok = await copyText(url);
      setCopied(ok);
      window.setTimeout(() => setCopied(false), 2500);
      toast(ok ? { text: tr('accounts_SharePopover.share_link_copied'), kind: 'ok' } : { text: tr('accounts_SharePopover.could_not_reach_the_clipboard'), kind: 'error' });
    },
    [toast],
  );

  const make = useCallback(
    async (s: ShareSettings, copy: boolean) => {
      setBusy(true);
      setErr('');
      const r = await a.api.shareSet(localId, s);
      setBusy(false);
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      setInfo(r.value);
      setAsk(false);
      if (copy) await copyLink(r.value.url);
    },
    [a.api, localId, copyLink],
  );

  // Opening the popover finds the build's live link, or makes one and copies it.
  useEffect(() => {
    if (!open) {
      started.current = false;
      setInfo(null);
      setErr('');
      setAsk(false);
      return;
    }
    if (started.current || !a.signedIn || !inCloud || conflict) return;
    started.current = true;
    void (async () => {
      const existing = await a.api.shareGet(localId);
      if (existing.ok && existing.value) {
        setInfo(existing.value);
        await copyLink(existing.value.url);
      } else setAsk(true);
    })();
  }, [open, a.signedIn, inCloud, conflict, a.api, localId, copyLink]);
  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [open]);

  const settings: ShareSettings = info ?? DEFAULTS;
  const change = (patch: Partial<ShareSettings>) => void make({ ...settings, ...patch }, false);
  const stop = async () => {
    setBusy(true);
    const r = await a.api.shareRevoke(localId);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    setInfo(null);
    onClose();
    toast({ text: tr('accounts_SharePopover.stopped_sharing_the_link_no'), kind: 'ok' });
  };
  const syncState = a.sync?.state;
  const syncText = !a.signedIn ? '' : syncState === 'syncing' ? tr('accounts_SharePopover_2.syncing') : syncState === 'offline' ? tr('accounts_SharePopover_2.offline') : ago(a.sync?.lastSyncAt ?? null, now);

  return (
    <PortalMenu anchor={anchor} open={open} onClose={onClose} align="left" role="dialog" label={tr('accounts_SharePopover.share_build')} minWidth={430}>
      <div className="acct-share">
        <div className="head">
          <Icon name="share" size={16} style={{ color: 'var(--gold-label)' }} />
          <span className="h">{tr('accounts_SharePopover.share_build')}</span>
          {a.signedIn && inCloud && (
            <span className="sync">
              <Icon name={syncState === 'offline' ? 'cloud-off' : syncState === 'syncing' ? 'refresh' : 'cloud-check'} size={12} spin={syncState === 'syncing'} style={{ color: 'var(--sync-ok)' }} />
              {syncText}
            </span>
          )}
          <button type="button" className="x" aria-label={tr('accounts_SharePopover.close')} title={tr('accounts_SharePopover.close')} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="body">
          {!a.signedIn ? (
            <div className="gate">
              <span>{tr('accounts_SharePopover.sign_in_to_get_a')}</span>
              <button type="button" className="btn gold" onClick={() => { onClose(); a.openSignIn(); }}>
                <Icon name="log-in" size={16} />
                {tr('accounts_SharePopover.sign_in')}
              </button>
            </div>
          ) : !inCloud ? (
            <div className="gate">
              <span>{tr('accounts_SharePopover.a_link_opens_the_cloud')}</span>
              <button
                type="button"
                className="btn gold"
                disabled={busy}
                onClick={() => {
                  started.current = false;
                  setErr('');
                  setBusy(true);
                  void a.api.enroll(localId).then((r) => {
                    setBusy(false);
                    if (!r.ok) setErr(r.error);
                  });
                }}
              >
                <Icon name="cloud" size={16} />
                {tr('accounts_SharePopover.sync_to_cloud')}
              </button>
              {err && <div className="err" role="alert">{err}</div>}
            </div>
          ) : conflict ? (
            <div className="gate">
              <span>{tr('accounts_SharePopover.this_build_changed_on_two')}</span>
            </div>
          ) : ask && !info ? (
            <div className="gate">
              <span>{tr('accounts_SharePopover.this_makes_a_link_to')}</span>
              <button type="button" className="btn gold" disabled={busy} onClick={() => void make(DEFAULTS, true)}>
                <Icon name="share" size={16} />
                {busy ? tr('accounts_SharePopover.making_your_link') : tr('accounts_SharePopover.make_link_and_copy')}
              </button>
              {err && <div className="err" role="alert">{err}</div>}
            </div>
          ) : (
            <>
              <div className="url">
                <div className="field">
                  <span className="txt">{info?.url ?? (busy ? tr('accounts_SharePopover.making_your_link_2') : '')}</span>
                </div>
                <button
                  type="button"
                  className="btn gold"
                  disabled={!info}
                  onClick={() => info && void copyLink(info.url)}
                >
                  <Icon name={copied ? 'check' : 'copy'} size={13} />
                  {copied ? tr('accounts_SharePopover.copied') : tr('accounts_SharePopover.copy_link')}
                </button>
              </div>
              <div className="who">
                <span>{tr('accounts_SharePopover.who_can_open_it')}</span>
                <div className="seg" data-lg="tile" role="group" aria-label={tr('accounts_SharePopover.who_can_open_it')}>
                  <button type="button" aria-pressed={settings.access === 'link'} onClick={() => change({ access: 'link' })}>{tr('accounts_SharePopover.anyone_with_the_link')}</button>
                  <button type="button" aria-pressed={settings.access === 'private'} onClick={() => change({ access: 'private' })}>{tr('accounts_SharePopover.only_me')}</button>
                </div>
              </div>
              <Opt checked={settings.includeNotes} onChange={(v) => change({ includeNotes: v })} label={tr('accounts_SharePopover.include_notes')} />
              <Opt checked={settings.includeLoadouts} onChange={(v) => change({ includeLoadouts: v })} label={tr('accounts_SharePopover.include_all_loadouts')} />
              <Opt checked={settings.allowDuplicate} onChange={(v) => change({ allowDuplicate: v })} label={tr('accounts_SharePopover.let_viewers_duplicate_into_their')} />
              <p className="note">{tr('accounts_SharePopover.anyone_with_the_link_can')}</p>
              {err && <div className="err" role="alert">{err}</div>}
              <div className="rule" />
              <div className="acts">
                <button type="button" className="btn sm" data-lg="control" onClick={onCopyCode}>
                  <Icon name="copy" size={14} />
                  {tr('accounts_SharePopover.copy_build_code')}
                </button>
                <button type="button" className="btn ghost sm" disabled={!info || info.access !== 'link'} title={tr('accounts_SharePopover.open_the_share_page_in')} onClick={() => info && void window.pom.app.openExternal(info.url)}>
                  <Icon name="external" size={14} />
                  {tr('accounts_SharePopover.open_in_browser')}
                </button>
                <button type="button" className="btn ghost sm danger-text stop" disabled={busy || !info} onClick={() => void stop()}>
                  <Icon name="unlink" size={14} />
                  {tr('accounts_SharePopover.stop_sharing')}
                </button>
              </div>
            </>
          )}
          {!a.signedIn || !inCloud ? (
            <div className="acts">
              <button type="button" className="btn sm" data-lg="control" onClick={onCopyCode}>
                <Icon name="copy" size={14} />
                {tr('accounts_SharePopover.copy_build_code')}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </PortalMenu>
  );
}
