import { useState } from 'react';
import { Dialog } from '../../ui.js';
import type { CreatorPort, VerificationState } from './port.js';
import { VERIFY_INTRO, VERIFY_LABEL, errorCopy, proofText, validateVerify, verifyGate, type VerifyDraft } from './presenter.js';
import { useLoad } from './useLoad.js';

/** Opens from the creator profile. Identity only: no fee, no promise of approval, nothing about plan quality. */
export function VerifyDialog({ port, defaultName, defaultLink, onClose }: { port: CreatorPort; defaultName: string; defaultLink: string; onClose(): void }) {
  const [state, , setState] = useLoad<VerificationState>(() => port.verification(), []);
  const [draft, setDraft] = useState<VerifyDraft | null>(null);
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState(''), [err, setErr] = useState('');
  if (state.status === 'loading') return <Dialog title="Apply for creator verification" cancelLabel="Close" confirmLabel={null} onCancel={onClose}><div className="cr-skel" aria-busy="true" /></Dialog>;
  if (state.status === 'error') return <Dialog title="Apply for creator verification" cancelLabel="Close" confirmLabel={null} onCancel={onClose}><p className="cr-err" role="alert">{errorCopy(state.code)}</p></Dialog>;
  const v = state.value;
  const d = draft ?? { publicName: v.publicName || defaultName, profileLink: v.profileLink || defaultLink, explanation: v.explanation, alternative: false };
  const gate = verifyGate({ status: v.status, draft: d, online: port.online(), signedIn: port.signedIn(), busy });
  const errors = validateVerify(d).errors, locked = v.status === 'pending' || v.status === 'verified';
  const run = async (fn: () => Promise<{ ok: true; done: () => void } | { ok: false; code: Parameters<typeof errorCopy>[0] }>) => {
    setBusy(true); setMsg(''); setErr('');
    const r = await fn(); setBusy(false);
    if (r.ok) r.done(); else setErr(errorCopy(r.code));
  };
  return <Dialog title="Apply for creator verification" size="medium" cancelLabel="Close" confirmLabel={v.status === 'verified' ? null : 'Submit request'} confirmDisabled={!gate.canSubmit} confirmBusy={busy}
    altLabel="Save draft" altDisabled={!gate.canSave || locked} onCancel={onClose} onAlt={() => void run(async () => { const r = await port.saveVerificationDraft(d); return r.ok ? { ok: true, done: () => setMsg('Draft saved.') } : r; })}
    onConfirm={() => void run(async () => { const r = await port.submitVerification(d); return r.ok ? { ok: true, done: () => setState({ ...v, status: r.value.status, publicName: d.publicName, profileLink: d.profileLink }) } : r; })}>
    <div className="cr-form">
      <p>{VERIFY_INTRO}</p>
      <label className="cr-field">Public creator name<input className={`input${errors.name ? ' bad' : ''}`} disabled={locked} value={d.publicName} onChange={(e) => setDraft({ ...d, publicName: e.target.value })} />{errors.name && <span className="cr-err">{errors.name}</span>}</label>
      <label className="cr-field">Public profile link<input className={`input${errors.link ? ' bad' : ''}`} disabled={locked} placeholder="https://" value={d.profileLink} onChange={(e) => setDraft({ ...d, profileLink: e.target.value })} />{errors.link && <span className="cr-err">{errors.link}</span>}</label>
      <p>Verification status: <strong>{VERIFY_LABEL[v.status]}</strong></p>
      {v.note && <p className="cr-muted">{v.note}</p>}
      {v.challenge && <div className="cr-panel"><p>{proofText(v.challenge)}</p><button type="button" className="btn" onClick={() => void port.copyText(v.challenge!).then((ok) => setMsg(ok ? 'Copied.' : 'Could not copy.'))}>Copy proof text</button></div>}
      {v.status === 'needs_info' && <button type="button" className="btn" onClick={() => setDraft({ ...d })}>Edit proof</button>}
      {!locked && <>
        <label className="cr-field">Request identity review (optional)<textarea className="input" rows={3} placeholder="Add a public evidence link or a short note" value={d.explanation} onChange={(e) => setDraft({ ...d, explanation: e.target.value, alternative: true })} /></label>
      </>}
      <div className="cr-row"><button type="button" className="btn" disabled={!gate.canCheck} onClick={() => void run(async () => { const r = await port.checkProof(d); return r.ok ? { ok: true, done: () => setMsg(r.value.found ? 'The proof text was found.' : 'The proof text was not found yet.') } : r; })}>Check public proof</button></div>
      {(gate.hint || msg) && <p className="cr-muted" role="status">{msg || gate.hint}</p>}
      {err && <p className="cr-err" role="alert">{err}</p>}
    </div>
  </Dialog>;
}
