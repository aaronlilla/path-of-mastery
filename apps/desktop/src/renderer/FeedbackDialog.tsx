import { useRef, useState } from 'react';
import { feedbackUrl } from '../shared/feedback.js';
import { Dialog, Select } from './ui';
import { tr } from './i18n';

type Kind = 'feedback' | 'bug' | 'idea';
const KINDS: { value: Kind; label: string }[] = [
  { value: 'feedback', label: tr('FeedbackDialog.feedback') },
  { value: 'bug', label: tr('FeedbackDialog.bug') },
  { value: 'idea', label: tr('FeedbackDialog.idea') },
];
const MIN = 5;
const MAX = 4000;

/** Send feedback: a message that goes to the app's maintainer. Works signed out. The version and system are filled in, not asked. */
export function FeedbackDialog({ version, platform, onClose }: { version: string; platform: string; onClose: () => void }) {
  const [kind, setKind] = useState<Kind>('feedback');
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const last = useRef(0);
  const ready = message.trim().length >= MIN;

  const send = async () => {
    if (!ready || busy) return;
    const wait = 10_000 - (Date.now() - last.current);
    if (wait > 0) return setError(tr('FeedbackDialog.wait_wait_seconds_before_sending', { wait: Math.ceil(wait / 1000) }));
    last.current = Date.now();
    setBusy(true);
    setError(null);
    const r = await window.pom.account.feedbackSend({ message: message.trim(), kind, contact: contact.trim(), version, platform });
    setBusy(false);
    if (r.ok) setSent(true);
    else setError(r.error);
  };

  if (sent) {
    return (
      <Dialog icon="info" title={tr('FeedbackDialog.send_feedback')} cancelLabel={null} confirmLabel={tr('FeedbackDialog.close')} onCancel={onClose} onConfirm={onClose}>
        <div role="status" style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>{tr('FeedbackDialog.sent_thank_you')}</div>
      </Dialog>
    );
  }
  return (
    <Dialog
      icon="info"
      title={tr('FeedbackDialog.send_feedback')}
      subtitle={tr('FeedbackDialog.tell_me_what_works_what')}
      confirmLabel={tr('FeedbackDialog.send')}
      confirmIcon="mail"
      confirmDisabled={!ready}
      confirmBusy={busy}
      altLabel={error ? tr('FeedbackDialog.send_by_email_instead') : undefined}
      altIcon="mail"
      onAlt={() => void window.pom.app.openExternal(feedbackUrl(version, platform))}
      onCancel={onClose}
      onConfirm={() => void send()}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label className="field-label">
          <span className="lbl">{tr('FeedbackDialog.kind')}</span>
          <Select value={kind} options={KINDS} onChange={setKind} ariaLabel={tr('FeedbackDialog.kind')} width={160} />
        </label>
        <label className="field-label">
          <span className="lbl">{tr('FeedbackDialog.message')}</span>
          <textarea
            className="input"
            data-autofocus
            value={message}
            onChange={(e) => setMessage(e.target.value.slice(0, MAX))}
            rows={6}
            maxLength={MAX}
            placeholder={tr('FeedbackDialog.what_happened_or_what_would')}
            aria-label={tr('FeedbackDialog.message')}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }}
            style={{ resize: 'vertical', minHeight: 110, height: 'auto', padding: '8px 10px', lineHeight: 1.5 }}
          />
          <span className="field-msg">{!ready ? tr('FeedbackDialog.write_at_least_min_characters', { MIN }) : tr('FeedbackDialog.length_max_ctrl_enter_sends', { count: message.length, MAX })}</span>
        </label>
        <label className="field-label">
          <span className="lbl">{tr('FeedbackDialog.email_only_if_you_want')}</span>
          <input className="input" type="email" value={contact} onChange={(e) => setContact(e.target.value)} maxLength={254} spellCheck={false} aria-label={tr('FeedbackDialog.email')} />
        </label>
        <div role="alert" className={'field-msg' + (error ? ' bad' : '')} style={{ minHeight: 18 }}>{error ?? ''}</div>
      </div>
    </Dialog>
  );
}
