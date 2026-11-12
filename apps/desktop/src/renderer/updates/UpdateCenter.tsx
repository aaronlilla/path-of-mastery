// The automatic updater's face: the title-bar "Restart to update" pill, one toast with Restart now / Later, the Update
// required modal, and the one-off notices (Updated to x.y.z, the update did not install). Main decides; this only shows.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { UpdateNotice, UpdateStatus } from '../../shared/update.js';
import { saveAllForRestart } from '../closeGuard';
import { Dialog, Icon, useToast } from '../ui';
import { fromMain, tr } from '../i18n';

const IDLE: UpdateStatus = { phase: 'idle', current: '', notes: [], required: false, critical: false };
let current: UpdateStatus = IDLE;
const listeners = new Set<() => void>();
const noticeListeners = new Set<(n: UpdateNotice) => void>();
let pendingNotice: UpdateNotice | null = null;
let started = false;

function setStatus(s: UpdateStatus): void {
  current = s;
  for (const l of listeners) l();
}

function start(): void {
  if (started || !window.pom?.update) return;
  started = true;
  window.pom.update.onStatus(setStatus);
  window.pom.update.onNotice((n) => {
    if (noticeListeners.size) for (const l of noticeListeners) l(n);
    else pendingNotice = n;
  });
  void window.pom.update.get().then((r) => {
    if (!r.ok) return;
    setStatus(r.value.status);
    if (r.value.notice) {
      if (noticeListeners.size) for (const l of noticeListeners) l(r.value.notice);
      else pendingNotice = r.value.notice;
    }
  });
}

export function useUpdateStatus(): UpdateStatus {
  start();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

let restarting = false;
const busyListeners = new Set<(b: boolean) => void>();
const setBusy = (b: boolean) => {
  restarting = b;
  for (const l of busyListeners) l(b);
};
function useRestarting(): boolean {
  const [b, set] = useState(restarting);
  useEffect(() => {
    busyListeners.add(set);
    return () => void busyListeners.delete(set);
  }, []);
  return b;
}

// ---- input freeze while an update is applied ---------------------------------------------------------------------
// From the first save to the restart or the swap nothing may be edited: an edit typed while the policy is checked would
// be on screen but not on disk when the page goes. The app below is made inert (no focus, no typing, no clicks, even
// for text inserted without key events) and a full-window "Applying update" layer explains why.
let freezeLayer: HTMLDivElement | null = null;
const swallow = (e: Event) => { e.preventDefault(); e.stopPropagation(); };

function freeze(on: boolean): void {
  const root = document.getElementById('root') as (HTMLElement & { inert?: boolean }) | null;
  if (on) {
    if (root) root.inert = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (!freezeLayer) {
      freezeLayer = document.createElement('div');
      freezeLayer.setAttribute('role', 'alertdialog');
      freezeLayer.setAttribute('aria-busy', 'true');
      freezeLayer.setAttribute('aria-label', tr('updates_UpdateCenter_2.applying_update'));
      freezeLayer.dataset.testid = 'update-applying';
      freezeLayer.tabIndex = -1;
      freezeLayer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);color:#f3e7c9;font:600 15px Geist,system-ui,sans-serif;cursor:progress';
      freezeLayer.textContent = tr('updates_UpdateCenter_2.applying_update_your_work_is_saved');
      document.body.appendChild(freezeLayer);
    }
    freezeLayer.focus();
    for (const t of ['keydown', 'keypress', 'beforeinput', 'paste', 'drop'] as const) window.addEventListener(t, swallow, true);
  } else {
    if (root) root.inert = false;
    freezeLayer?.remove();
    freezeLayer = null;
    for (const t of ['keydown', 'keypress', 'beforeinput', 'paste', 'drop'] as const) window.removeEventListener(t, swallow, true);
  }
}

/**
 * Restart now / Apply now / Save and restart now, in this order: input is frozen; every open document is saved through
 * its own save path (a failed save stops here: that screen showed its Save failed dialog); the update is judged once more
 * against the policy (it may have been paused or blocked); everything is saved again in case anything changed meanwhile;
 * then main restarts or swaps the interface. Any refusal unfreezes and says why; nothing quits and no work is lost.
 */
export async function restartToUpdate(onError: (text: string) => void): Promise<boolean> {
  if (restarting) return false;
  setBusy(true);
  freeze(true);
  let done = false;
  try {
    if (!(await saveAllForRestart())) return false;
    const gate = await window.pom.update.prepareApply();
    if (!gate.ok) return onError(tr('updates_UpdateCenter.could_not_apply_the_update', { error: gate.error })), false;
    if (!gate.value.ok) return onError(fromMain('ml_io_update', gate.value.reason)), false;
    if (!(await saveAllForRestart())) return false;
    const r = await window.pom.update.restart();
    if (!r.ok) return onError(tr('updates_UpdateCenter.could_not_restart_error', { error: r.error })), false;
    if (!r.value.ok) return onError(fromMain('ml_io_update', r.value.reason)), false;
    done = true;
    return true;
  } finally {
    if (!done) {
      freeze(false);
      setBusy(false);
    } else {
      // The app is quitting or the page is being replaced. If neither happens (a quit was cancelled), give the window back.
      window.setTimeout(() => { freeze(false); setBusy(false); }, 60_000);
    }
  }
}

const v = (s: string | undefined) => (s && /^\d/.test(s) ? `v${s}` : s ?? '');

/** The persistent title-bar pill: shows while a verified update waits for a restart. */
export function UpdatePill() {
  const s = useUpdateStatus();
  const busy = useRestarting();
  const toast = useToast();
  if (s.phase !== 'ready' || s.required) return null;
  const ui = s.kind === 'interface';
  return (
    <button
      type="button"
      className="sync-pill update-pill tb-nodrag"
      data-testid="update-pill"
      title={ui ? tr('updates_UpdateCenter.interface_update_version_is_ready', { version: v(s.version) }) : tr('updates_UpdateCenter.path_of_mastery_version_is', { version: v(s.version) })}
      aria-label={ui ? tr('updates_UpdateCenter.apply_update') : tr('updates_UpdateCenter.restart_to_update')}
      disabled={busy}
      style={{ color: 'var(--gold-text)', borderColor: 'rgba(var(--accent-rgb),.35)', background: 'rgba(var(--accent-rgb),.10)' }}
      onClick={() => void restartToUpdate((text) => toast({ text, kind: 'error' }))}
    >
      <Icon name={busy ? 'loader' : 'refresh'} size={13} spin={busy} />
      <span className="lbl">{ui ? tr('updates_UpdateCenter.apply_update') : tr('updates_UpdateCenter.restart_to_update')}</span>
    </button>
  );
}

/** Mounted once at the app root: the restart toast, the Update required modal and the notices. */
export function UpdateCenter() {
  const s = useUpdateStatus();
  const toast = useToast();
  const toasted = useRef<string | null>(null);

  useEffect(() => {
    const show = (n: UpdateNotice) => {
      if (n.kind === 'installFailed') toast({ text: tr('updates_UpdateCenter.the_update_to_version_did', { version: v(n.version), current: v(current.current) }), kind: 'error', ttl: 12000 });
      else toast({ text: tr('updates_UpdateCenter.updated_to_version', { version: v(n.version) }), kind: 'ok', ttl: 10000 });
    };
    noticeListeners.add(show);
    if (pendingNotice) {
      show(pendingNotice);
      pendingNotice = null;
    }
    return () => void noticeListeners.delete(show);
  }, [toast]);

  // One toast per release that becomes ready (the pill stays after it is dismissed); it goes when nothing is waiting any more.
  useEffect(() => {
    if (s.phase !== 'ready' || s.required || !s.version) {
      if (toasted.current) toast({ key: 'update-ready', text: '' });
      toasted.current = null;
      return;
    }
    const key = `${s.kind}:${s.version}`;
    if (toasted.current === key) return;
    toasted.current = key;
    const ui = s.kind === 'interface';
    toast({
      key: 'update-ready',
      text: ui
        ? tr('updates_UpdateCenter.an_interface_update_version_is', { version: v(s.version) })
        : tr('updates_UpdateCenter.path_of_mastery_version_is_2', { version: v(s.version) }),
      kind: 'info',
      sticky: true,
      action2: { label: tr('updates_UpdateCenter.later'), run: () => undefined },
      action: { label: ui ? tr('updates_UpdateCenter.apply_now') : tr('updates_UpdateCenter.restart_now'), run: () => void restartToUpdate((text) => toast({ text, kind: 'error' })) },
    });
  }, [s.phase, s.required, s.version, s.kind, toast]);

  return s.required && (s.phase === 'downloading' || s.phase === 'ready') ? <UpdateRequiredDialog s={s} /> : null;
}

function UpdateRequiredDialog({ s }: { s: UpdateStatus }) {
  const busy = useRestarting();
  const toast = useToast();
  const ready = s.phase === 'ready';
  const pct = s.progress && s.progress.total > 0 ? Math.min(100, Math.round((s.progress.received / s.progress.total) * 100)) : null;
  return (
    <Dialog
      size="large"
      width={640}
      icon={s.critical ? 'error' : 'warning'}
      title={tr('updates_UpdateCenter.update_required')}
      subtitle={s.critical ? tr('updates_UpdateCenter.this_update_fixes_a_security') : tr('updates_UpdateCenter.this_version_current_is_no', { current: v(s.current), version: v(s.version) })}
      hideClose
      focusConfirm
      cancelLabel={null}
      altLabel={tr('updates_UpdateCenter.quit')}
      altIcon="power"
      onAlt={() => void window.pom.update.quit()}
      confirmLabel={ready ? (s.kind === 'interface' ? tr('updates_UpdateCenter.save_and_apply_now') : tr('updates_UpdateCenter.save_and_restart_now')) : pct === null ? tr('updates_UpdateCenter.downloading') : tr('updates_UpdateCenter.downloading_pct', { pct })}
      confirmIcon="refresh"
      confirmBusy={busy || !ready}
      confirmDisabled={busy || !ready}
      // Escape and the backdrop do nothing: the update must be answered.
      onCancel={() => undefined}
      onConfirm={() => void restartToUpdate((text) => toast({ text, kind: 'error' }))}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-screen-label="Dialog / Update required" data-testid="update-required">
        {s.notes.length > 0 && (
          <div style={{ borderRadius: 12, background: 'rgba(var(--shadow-rgb),calc(.3*var(--shadow-k)))', border: '1px solid rgba(var(--line-rgb),.07)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflow: 'auto' }}>
            <span style={{ color: 'var(--gold-text)', font: "600 13px 'Geist Mono'" }}>{v(s.version)}</span>
            {s.notes.map((n, i) => (
              <div key={i} style={{ color: 'var(--text-3)', lineHeight: 1.5 }}>{n}</div>
            ))}
          </div>
        )}
        {!ready && (
          <div role="progressbar" aria-label={tr('updates_UpdateCenter.download_progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} style={{ height: 6, borderRadius: 3, background: 'rgba(var(--line-rgb),.1)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct ?? 5}%`, background: 'var(--gold-text)', transition: 'width .3s' }} />
          </div>
        )}
        {s.error && <div role="alert" style={{ color: 'var(--negative-text)', lineHeight: 1.5 }}>{tr('updates_UpdateCenter.the_download_did_not_finish', { error: s.error })}</div>}
        <div style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {ready ? tr('updates_UpdateCenter.your_open_builds_plans_timelines') : tr('updates_UpdateCenter.the_app_stays_as_it')}
        </div>
      </div>
    </Dialog>
  );
}
