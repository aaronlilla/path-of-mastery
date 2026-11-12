import type { AiStatus } from '../../../shared/entitlements.js';
import { aiStatusView } from './status.js';
import { useEffect, useState } from 'react';
import { tr } from '../../i18n';
export function AiStatusPanel({ state, onRecovery, onLocal, inApp, className }: { state: AiStatus; onRecovery?(): unknown; onLocal?(): void; inApp?: boolean; className?: string }) {
  const [now, setNow] = useState(Date.now);
  // A check shows "Checking..." for a moment, then the answer, even when the answer comes back the same.
  // Sign in, unlock and the human check open their own screens (no promise back), so they need no checking state.
  const [busy, setBusy] = useState(false);
  const recover = () => {
    const check = onRecovery?.();
    if (!(check instanceof Promise)) return;
    setBusy(true);
    void Promise.all([check.catch(() => undefined), new Promise((r) => setTimeout(r, 700))]).finally(() => setBusy(false));
  };
  useEffect(() => {
    const wait = Date.parse(state.retryAt ?? '') - Date.now();
    if (state.code !== 'RATE_LIMITED' || !Number.isFinite(wait) || wait < 0) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(wait + 1, 2147483647));
    return () => clearTimeout(timer);
  }, [state.code, state.retryAt, now]);
  const view = busy ? { title: tr('gates_ai_AiStatus.checking'), message: '', recovery: null } : aiStatusView(state, Math.max(now, Date.now()), inApp);
  return <section aria-label={tr('gates_ai_AiStatus.ai_status')} aria-live="polite" className={className} data-status={state.status} style={className ? undefined : { padding: 12, overflowWrap: 'anywhere' }}>
    <strong role="status">{view.title}</strong>{view.message && <p>{view.message}</p>}
    {state.status !== 'ready' && state.status !== 'checking' && !busy && <p>{tr('gates_ai_AiStatus.your_input_and_local_changes')}</p>}
    {view.recovery && onRecovery && <button type="button" className="btn gold" onClick={recover}>{view.recovery}</button>}
    {onLocal && <button type="button" className="btn ghost" onClick={onLocal}>{tr('gates_ai_AiStatus.continue_locally')}</button>}
  </section>;
}
