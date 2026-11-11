import { useEffect, useRef, useState } from 'react';
import type { ProviderId, ProviderStatus } from '../../shared/accounts.js';
import { crest256 } from '../art';
import { Icon, useToast } from '../ui';
import { acctText, useAcct } from './useAccount';
import { tr } from '../i18n';

const GOOGLE = (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" style={{ flex: 'none' }}>
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);
const DISCORD = (
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" style={{ flex: 'none' }}>
    <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" fill="#5865F2" />
  </svg>
);
const GITHUB = (
  <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true" style={{ flex: 'none' }}>
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" fill="currentColor" />
  </svg>
);

/**
 * The live project has only Discord switched on (Google and GitHub are off, and e-mail needs SMTP, which is not set up). While
 * this is true the dialog offers Discord alone; set it to false to bring back the Google, GitHub and e-mail rows.
 */
const DISCORD_ONLY = true;

const PROVIDERS: { id: ProviderId; label: string; icon: JSX.Element }[] = [
  { id: 'google', label: tr('accounts_SignInDialog.continue_with_google'), icon: GOOGLE },
  { id: 'discord', label: tr('accounts_SignInDialog.continue_with_discord'), icon: DISCORD },
  { id: 'github', label: tr('accounts_SignInDialog.continue_with_github'), icon: GITHUB },
];

/** Sign-in: Google, Discord, GitHub, an email link, or carry on without an account. Closes by itself once signed in. */
export function SignInDialog({ onClose }: { onClose: () => void }) {
  const a = useAcct();
  const toast = useToast();
  const auth = a.view?.auth ?? { state: 'signedOut' as const };
  const [email, setEmail] = useState('');
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const emailRef = useRef<HTMLInputElement>(null);
  const wasSignedIn = useRef(auth?.state === 'signedIn');

  useEffect(() => {
    void a.api.providers().then((r) => r.ok && setProviders(r.value));
  }, [a.api]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    if (auth?.state === 'signedIn' && !wasSignedIn.current) {
      toast({ text: tr('accounts_SignInDialog.signed_in_as_email', { email: auth.user.name || auth.user.email }), kind: 'ok' });
      onClose();
    }
    wasSignedIn.current = auth?.state === 'signedIn';
  }, [auth, onClose, toast]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', k, true);
    return () => document.removeEventListener('keydown', k, true);
  }, [onClose]);

  const error = a.view?.error;
  const [mailErr, setMailErr] = useState('');
  const sendEmail = async () => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email.trim())) {
      setMailErr(tr('accounts_SignInDialog.that_does_not_look_like'));
      return;
    }
    setMailErr('');
    setBusy(true);
    await a.api.signInEmail(email);
    setBusy(false);
  };
  const state = auth?.state;
  const resendIn = auth?.state === 'emailSent' ? Math.max(0, Math.ceil((auth.resendAt - now) / 1000)) : 0;

  return (
    <>
      <div className="acct-scrim" onClick={onClose} />
      <div className="acct-signin" data-lg="pop" role="dialog" aria-modal="true" aria-label={tr('accounts_SignInDialog.sign_in_to_path_of')} data-state={state}>
        <img className="crest" src={crest256} alt={tr('accounts_SignInDialog.path_of_mastery')} />
        {state === 'emailSent' ? (
          <>
            <span className="h">{tr('accounts_SignInDialog.check_your_email')}</span>
            <span className="p">
              {tr('accounts_SignInDialog.we_sent_a_sign_in')} <b>{auth.email}</b>{tr('accounts_SignInDialog.open_it_on_this_computer')}
            </span>
            <div className="stack">
              <button type="button" className="btn gold" onClick={() => void window.pom.app.openExternal('mailto:')}>
                <Icon name="mail" size={16} />
                {tr('accounts_SignInDialog.open_mail_app')}
              </button>
              <div className="wait">
                <span className="spin" />
                {tr('accounts_SignInDialog.waiting_for_you_to_click', { value: ' ' })}
                {resendIn > 0 ? (
                  tr('accounts_SignInDialog.resend_in_resendin_s', { resendIn })
                ) : (
                  <button type="button" className="link" onClick={() => void a.api.signInEmail(auth.email)}>
                    {tr('accounts_SignInDialog.resend_the_email')}
                  </button>
                )}
              </div>
              <button type="button" className="btn ghost" onClick={() => void a.api.cancelSignIn()}>
                <Icon name="mail" size={16} />
                {tr('accounts_SignInDialog.use_a_different_email')}
              </button>
            </div>
          </>
        ) : state === 'browser' ? (
          <>
            <span className="h">{tr('accounts_SignInDialog.continue_in_your_browser')}</span>
            <span className="p">{tr('accounts_SignInDialog.finish_signing_in_with_slice', { value: auth.provider[0]!.toUpperCase() + auth.provider.slice(1) })}</span>
            <div className="stack">
              <div className="wait">
                <span className="spin" />
                {tr('accounts_SignInDialog.waiting_for_the_browser')}
              </div>
              <button type="button" className="btn ghost" onClick={() => void a.api.cancelSignIn()}>
                <Icon name="arrow-left" size={16} />
                {tr('accounts_SignInDialog.choose_another_way')}
              </button>
            </div>
          </>
        ) : (
          <>
            <span className="h">{tr('accounts_SignInDialog.sign_in_to_path_of')}</span>
            <span className="p">{tr('accounts_SignInDialog.sync_builds_across_machines_and')}</span>
            <div className="providers">
              {PROVIDERS.filter((p) => !DISCORD_ONLY || p.id === 'discord').map((p) => {
                const st = providers?.find((x) => x.id === p.id);
                const off = !!st && (!st.allowed || st.enabled === false);
                const why = !st ? '' : !st.allowed ? tr('accounts_SignInDialog.not_available_yet') : st.enabled === false ? tr('accounts_SignInDialog.not_switched_on_yet') : '';
                return (
                  <button key={p.id} type="button" className="prov" disabled={off} title={off ? tr('accounts_SignInDialog.replace_sign_in_is_tolowercase', { label: p.label.replace('Continue with ', ''), why: why.toLowerCase() }) : undefined} onClick={() => void a.api.signInProvider(p.id)}>
                    {p.icon}
                    <span className="t">{p.label}</span>
                    {off && <span className="soon">{why}</span>}
                  </button>
                );
              })}
            </div>
            {!DISCORD_ONLY && <div className="or"><span />{tr('accounts_SignInDialog.or')}<span /></div>}
            {!DISCORD_ONLY && (
            <form
              className="mail"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void sendEmail();
              }}
            >
              <label className="field" data-lg="tile">
                <input ref={emailRef} type="email" inputMode="email" autoComplete="email" spellCheck={false} placeholder={tr('accounts_SignInDialog.you_example_com')} aria-label={tr('accounts_SignInDialog.email_address')} value={email} onChange={(e) => { setEmail(e.target.value); if (mailErr) setMailErr(''); }} aria-invalid={mailErr ? true : undefined} />
              </label>
              <button type="submit" className="btn" data-lg="control" disabled={busy}>
                {busy ? <span className="spin" /> : <Icon name="mail" size={16} />}
                {tr('accounts_SignInDialog.email_me_a_link')}
              </button>
            </form>
            )}
            {(mailErr || error) && <div className="err" role="alert">{acctText(mailErr || error || '')}</div>}
          </>
        )}
        <div className="rule" />
        <button type="button" className="link-btn" onClick={onClose}>
          <Icon name="arrow-right" size={16} />
          {tr('accounts_SignInDialog.continue_without_an_account')}
        </button>
        <span className="foot">{tr('accounts_SignInDialog.once_signed_in_the_app')}</span>
      </div>
    </>
  );
}
