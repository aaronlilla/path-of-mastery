import { SIGN_IN_PITCH } from '../../shared/entitlements.js';
import { Icon } from '../ui';
import { useEntitlement } from './useEntitlement';
import { tr, fromMain } from '../i18n';

/**
 * What a player sees where an AI feature would be while it is off: sign in, or (signed in, not yet verified) wait for
 * the account check. Signed in but not yet verified: it says so, no button.
 */
export function AiAccessLock({ variant = 'panel', what }: { variant?: 'panel' | 'lootfilter'; what?: string }) {
  const ent = useEntitlement();
  const signIn = () => window.dispatchEvent(new Event('pom-sign-in'));
  const line = ent.signedIn ? tr('entitlements_AiAccessLock.connect_to_verify_your_account') : fromMain('ml_mastery_text', SIGN_IN_PITCH);
  const action = ent.signedIn ? null : { label: tr('entitlements_AiAccessLock.sign_in'), run: signIn };
  if (variant === 'lootfilter') {
    return (
      <div role="note" aria-label={tr('entitlements_AiAccessLock.ai_feature')} style={{ padding: '12px 14px', borderRadius: 12, border: '1px dashed rgba(var(--accent-rgb),.4)', background: 'rgba(var(--accent-rgb),.05)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {what && <span style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>{what}</span>}
        <span style={{ color: 'var(--text-strong)', lineHeight: 1.5 }}>{line}</span>
        {action && (
          <div style={{ display: 'flex' }}>
            <button type="button" className="adv-sh-btn sm gold" onClick={action.run}>
              {action.label}
            </button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="state" role="note" aria-label={tr('entitlements_AiAccessLock.ai_feature')}>
      <span className="logo" style={{ background: 'rgba(var(--line-rgb), .06)' }}>
        <Icon name="lock" size={24} />
      </span>
      <h3>{ent.signedIn ? tr('entitlements_AiAccessLock.verifying_your_account') : tr('entitlements_AiAccessLock.sign_in_to_use_ai')}</h3>
      {what && <p>{what}</p>}
      <p>{line}</p>
      {action && (
        <button type="button" className="bigbtn gold" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}
