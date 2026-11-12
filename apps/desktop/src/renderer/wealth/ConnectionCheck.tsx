import { useCallback, useEffect, useState } from 'react';
import type { CallEntry, Diagnostic } from '../../shared/wealthDiag.js';
import { Icon, useToast } from '../ui.js';
import { clock } from './wui.js';
import { label, tr } from '../i18n';
import { item, msg } from './mainText';

export const CONNECTION_EVENT = 'pom-wealth-connection';

/** The connection check: each real call, its status, the rate-limit headers and what the limiter decided. No cookie, no account name. */
export function ConnectionCheck({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<{ calls: CallEntry[]; diagnostics: Diagnostic[]; text: string } | null>(null);
  const load = useCallback(() => void window.pom.wealth.connection().then(setData), []);
  useEffect(() => {
    load();
    const i = window.setInterval(load, 3000);
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    return () => {
      window.clearInterval(i);
      document.removeEventListener('keydown', k);
    };
  }, [load, onClose]);
  const copy = (text: string, what: string) => void navigator.clipboard.writeText(text).then(() => toast({ text: tr('wealth_ConnectionCheck.what_copied', { what }), kind: 'ok' }), () => toast({ text: tr('wealth_ConnectionCheck.could_not_copy_the_tolowercase', { what: what.toLowerCase() }), kind: 'error' }));
  const calls = data ? [...data.calls].reverse() : [];
  return (
    <div className="w-conn-scrim" role="presentation" onClick={onClose}>
      <div className="w-conn w-panel" role="dialog" aria-label={tr('wealth_ConnectionCheck.connection_check')} onClick={(e) => e.stopPropagation()} data-lg="panel">
        <div className="w-eyebrow">
          <span>{tr('wealth_ConnectionCheck.connection_check_2')}</span>
          <span className="w-conn-btns">
            <button type="button" className="w-btn sm alt" disabled={!data} onClick={() => data && copy(data.text, tr('wealth_ConnectionCheck.connection_check'))}>{tr('wealth_ConnectionCheck.copy_all')}</button>
            <button type="button" className="w-x" aria-label={tr('wealth_ConnectionCheck.close')} title={tr('wealth_ConnectionCheck.close')} onClick={onClose}><Icon name="x" size={16} /></button>
          </span>
        </div>
        <div className="w-conn-note">{tr('wealth_ConnectionCheck.every_real_call_the_app')}</div>
        {data && data.diagnostics.length > 0 && (
          <div className="w-conn-diag">
            {data.diagnostics.map((d) => (
              <div key={d.id} className="w-conn-d">
                <b>{tr('wealth_ConnectionCheck.unexpected_answer_at', { value: clock(d.at) })}</b>
                <span>{msg(d.problem)}</span>
                <span className="faint">{tr('wealth_ConnectionCheck.endpoint_http_status_missing_join', { endpoint: d.endpoint, status: d.status, value: d.missing.join(', ') || label('none'), value2: d.found.join(', ') || label('none') })}</span>
                <button type="button" className="w-btn sm" onClick={() => copy(d.text, tr('wealth_ConnectionCheck_2.diagnostic'))}>{tr('wealth_ConnectionCheck.copy_diagnostic')}</button>
              </div>
            ))}
          </div>
        )}
        <div className="w-conn-list">
          {!data && <div className="w-note-line">{tr('wealth_ConnectionCheck.loading')}</div>}
          {data && calls.length === 0 && <div className="w-note-line">{tr('wealth_ConnectionCheck.no_calls_to_pathofexile_com')}</div>}
          {calls.map((c) => (
            <div key={c.id} className="w-conn-row" data-ok={c.outcome === 'ok'}>
              <span className="w-conn-st" data-bad={c.outcome !== 'ok'}>{c.status || '—'}</span>
              <span className="w-conn-main">
                <b>{c.method} {c.endpoint}</b>
                <span>{tr('wealth_ConnectionCheck.at_outcome_ms_ms_policy', { value: clock(c.at), outcome: c.outcome, ms: c.ms, policy: c.policy })}</span>
                <span className="faint">{tr('wealth_ConnectionCheck.limiter_decision_limits_held_limits', { decision: c.limiter.decision, limits: c.limiter.limits || item('not known yet') })}</span>
                <span className="faint">{tr('wealth_ConnectionCheck.headers')} {Object.keys(c.headers).length ? Object.entries(c.headers).map(([k, v]) => `${k}: ${v}`).join(' | ') : tr('wealth_ConnectionCheck.none_seen')}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
