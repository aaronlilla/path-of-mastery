import { useRef, useState } from 'react';
import { Dialog, Select } from '../../ui';
import { FEEDBACK_ROUTE_LABEL, REPORT_REASONS, DETAILS_MAX, receiptCopy, receiptView, reportBody, submitGate, validateReport, errorCopy, targetKey, emptyReportDraft, type ReportDraft, type ReportReceipt, type ReportTarget } from './presenter';
import type { ModerationPort } from './port';
import './moderation.css';

const drafts = new Map<string, ReportDraft>(); // kept until the target changes
export function ReportDialog({ target, port, onClose }: { target: ReportTarget; port: ModerationPort; onClose: () => void }) {
  const key = targetKey(target);
  const [draft, setDraftState] = useState<ReportDraft>(() => drafts.get(key) ?? emptyReportDraft());
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [receipt, setReceipt] = useState<ReportReceipt | null>(null);
  const idem = useRef(crypto.randomUUID()); // retry after an unknown outcome reuses the key
  const setDraft = (d: ReportDraft) => { drafts.set(key, d); setDraftState(d); };
  const { errors } = validateReport(draft), touched = draft.reason !== '';
  const gate = submitGate(draft, { signedIn: port.signedIn(), online: port.online(), busy });
  const name = target.kind === 'item' ? target.title : target.name;
  async function submit() {
    if (!gate.canSubmit) return;
    setBusy(true); setError('');
    if (gate.action === 'sign_in') { await port.signIn(); setBusy(false); return; } // explicit Submit after return
    const r = await port.report(reportBody(target, draft, idem.current));
    setBusy(false);
    if (!r.ok) { setError(errorCopy(r.code)); return; }
    drafts.delete(key); setReceipt(receiptView(r.value));
  }
  if (receipt) return <Dialog title={target.kind === 'item' ? 'Report item' : 'Report creator'} cancelLabel="Close" confirmLabel={null} onCancel={onClose}>
    <p role="status">{receiptCopy(receipt)}</p><p className="mod-muted">Reports go to moderators, not the public feed.</p></Dialog>;
  return <div onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } }}>
    <Dialog title={target.kind === 'item' ? 'Report item' : 'Report creator'} cancelLabel="Cancel" confirmLabel={gate.action === 'sign_in' ? 'Continue with Discord' : 'Submit report'}
      confirmDisabled={!gate.canSubmit} confirmBusy={busy} onCancel={onClose} onConfirm={() => void submit()}
      note={gate.hint || error ? <span role="alert">{error || gate.hint}</span> : undefined}>
      <div className="mod-form">
        <div className="mod-muted">Target: {name}{target.kind === 'item' ? ` / Version ${target.revisionLabel}` : ''}</div>
        <label className="mod-field">Reason
          <Select ariaLabel="Reason" width="100%" value={draft.reason || ('' as never)}
            options={[...REPORT_REASONS, ]} onChange={(v) => setDraft({ ...draft, reason: v })} />
          {!draft.reason && <span className="mod-hint">Pick a reason.</span>}
        </label>
        {target.kind === 'item' && <button type="button" className="btn ghost" onClick={() => port.gotoFeedback({ postId: target.postId, revisionId: target.revisionId })}>{FEEDBACK_ROUTE_LABEL}</button>}
        <label className="mod-field">Details
          <textarea value={draft.details} maxLength={DETAILS_MAX + 100} rows={4} onChange={(e) => setDraft({ ...draft, details: e.target.value })} />
          {touched && errors.details && <span className="mod-err">{errors.details}</span>}
        </label>
        <label className="mod-field">Evidence link (optional)
          <input value={draft.evidence} inputMode="url" onChange={(e) => setDraft({ ...draft, evidence: e.target.value })} />
          {errors.evidence && <span className="mod-err">{errors.evidence}</span>}
        </label>
        <p className="mod-muted">Reports go to moderators, not the public feed.</p>
      </div>
    </Dialog></div>;
}
