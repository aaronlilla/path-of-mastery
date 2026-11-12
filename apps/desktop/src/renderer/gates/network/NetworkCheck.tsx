import { useEffect,useRef,useState,type CSSProperties,type ReactNode } from 'react';
import { Dialog } from '../../ui';
import { tr } from '../../i18n';

export type CheckState = 'checking' | 'passed' | 'unavailable' | 'failed' | 'offline' | 'expired' | 'again' | 'sendFailed';
export type NetworkCheckProps = { pendingLabel?: string; state: CheckState; verification: ReactNode;
  accessibleAvailable: boolean; /** The accessible presentation is already showing: no switch button and no "Contact support" line. */ accessibleActive?: boolean; supportUrl?: string; onAccessible(): void; onContinue(): Promise<void>; onLocal(): void; onRetry?(): void };
function safeSupportUrl(value?: string): string | null {
  try { const url = new URL(value ?? ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
// Risk pause banner: below the area bar, never covering the viewport; Keep working locally collapses it to a pill.
const bannerStyle: CSSProperties = { position: 'fixed', top: 46, left: '50%', transform: 'translateX(-50%)', zIndex: 40, width: 'max-content', maxWidth: 'calc(100vw - 32px)',
  display: 'flex', alignItems: 'center', gap: 12, padding: '6px 8px 6px 14px', background: 'var(--surface-2)', border: '1px solid var(--border-strong)',
  borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,.45)', fontSize: 13, overflowWrap: 'anywhere' };
export function NetworkCheckBanner({ onOpen,onLocal }: { onOpen(): void; onLocal(): void }) {
  const [collapsed,setCollapsed] = useState(false);
  return collapsed ? <aside aria-label={tr('gates_network_NetworkCheck.network_status')} style={{ ...bannerStyle, padding: 0, border: 0, background: 'transparent', boxShadow: 'none' }}>
      <button className="btn ghost" type="button" onClick={onOpen}>{tr('gates_network_NetworkCheck.network_features_paused')}</button></aside>
    : <aside aria-label={tr('gates_network_NetworkCheck.network_status')} style={bannerStyle}>
      <span style={{ flex: '1 1 auto', minWidth: 0 }}><strong>{tr('gates_network_NetworkCheck.network_features_paused')}</strong> {tr('gates_network_NetworkCheck.complete_a_quick_check_to')}</span>
      <button className="btn gold" type="button" onClick={onOpen}>{tr('gates_network_NetworkCheck.continue')}</button>
      <button className="btn ghost" type="button" onClick={() => { setCollapsed(true); onLocal(); }}>{tr('gates_network_NetworkCheck.keep_working_locally')}</button></aside>;
}
export function NetworkCheck(props: NetworkCheckProps) {
  const lock = useRef(false); const [busy,setBusy] = useState(false); const [error,setError] = useState('');
  const supportUrl = safeSupportUrl(props.supportUrl);
  // Focus trap : a Tab pressed while the focus is outside the open check (the provider frame loading, or
  // focus left on the page behind) brings it back to the first control of the dialog instead of walking the page behind the scrim.
  useEffect(() => {
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(d => d.querySelector('[data-network-check]'));
      if (!dialog || dialog.contains(document.activeElement)) return;
      const first = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],iframe')].find(n => n.offsetParent !== null);
      if (first) { e.preventDefault(); e.stopPropagation(); first.focus(); }
    };
    document.addEventListener('keydown', onTab, true);
    return () => document.removeEventListener('keydown', onTab, true);
  }, []);
  const status: Record<CheckState,string> = { checking: tr('gates_network_NetworkCheck_2.checking'),passed: tr('gates_network_NetworkCheck.check_passed'),
    unavailable: tr('gates_network_NetworkCheck.the_check_is_unavailable_try'),failed: tr('gates_network_NetworkCheck.could_not_finish_the_check'),
    offline: tr('gates_network_NetworkCheck.connect_to_finish_the_check'), expired: tr('gates_network_NetworkCheck.this_request_expired_try_again'),
    again: tr('gates_network_NetworkCheck.your_check_expired_complete_it'), sendFailed: tr('gates_network_NetworkCheck_2.the_request_did_not_go_through') };
  return <Dialog title={tr('gates_network_NetworkCheck.continue_using_network_features')} size="medium" icon="sync" onCancel={props.onLocal}
    confirmLabel={null} cancelLabel={null}>
    <div data-network-check="" style={{ overflowWrap: 'anywhere' }} onKeyDown={e => {
      // Enter activates only the focused provider/control, never a global final action.
      if (e.key === 'Enter') e.stopPropagation();
      if (e.key === 'Tab') {
        const root = e.currentTarget.closest('.dialog');
        const nodes = [...(root?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea,select,a[href],iframe,[tabindex="0"]') ?? [])].filter(n => n.offsetParent !== null);
        const next = e.shiftKey ? nodes.at(-1) : nodes[0]; const boundary = e.shiftKey ? nodes[0] : nodes.at(-1);
        if (next && document.activeElement === boundary) { e.preventDefault(); e.stopPropagation(); next.focus(); }
      }
    }}>
    <p>{tr('gates_network_NetworkCheck.we_need_a_quick_check')}</p>
    <p>{props.pendingLabel ? tr('gates_network_NetworkCheck.pending_pendinglabel', { pendingLabel: props.pendingLabel }) : tr('gates_network_NetworkCheck.resume_network_features')}</p>
    {props.verification}
    {props.accessibleActive || props.state === 'passed' ? null : props.accessibleAvailable ? <button className="btn ghost" type="button" disabled={busy || !props.verification} onClick={props.onAccessible}>{tr('gates_network_NetworkCheck.use_an_accessible_check')}</button>
      : supportUrl ? <a href={supportUrl} rel="noopener noreferrer">{tr('gates_network_NetworkCheck.contact_support')}</a> : <p>{tr('gates_network_NetworkCheck.contact_support')}</p>}
    <p role="status" aria-live="polite">{error || status[props.state]}</p>
    {props.onRetry && ['failed','unavailable','expired'].includes(props.state) && <button className="btn ghost" type="button" onClick={props.onRetry}>{tr('gates_network_NetworkCheck.retry')}</button>}
    <div className="dialog-foot">
      <button className="btn ghost" type="button" onClick={props.onLocal}>{tr('gates_network_NetworkCheck.keep_working_locally')}</button>
      <button className="btn gold" type="button" disabled={props.state !== 'passed' || busy} onClick={async () => {
        if (lock.current) return; lock.current = true; setBusy(true);
        try { setError(''); await props.onContinue(); } catch { setError(tr('gates_network_NetworkCheck.could_not_resume_this_request')); }
        finally { lock.current = false; setBusy(false); }
      }}>{tr('gates_network_NetworkCheck.continue')}</button>
    </div>
    </div>
  </Dialog>;
}
