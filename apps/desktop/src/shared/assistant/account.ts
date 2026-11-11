import type { AiStatus } from '../entitlements.js';
import { PROVIDER_LABEL, type ProviderId, type ProviderState, type ProviderStatus, type TurnError } from './types.js';

/** The label of every button that signs in to Claude or ChatGPT. The Path of Mastery account's button says "Sign in to Path of Mastery". */
export const signInLabel = (id: ProviderId): string => `Sign in with ${PROVIDER_LABEL[id]}`;

/** What `claude auth status` calls the plan ("max", "pro", "team") as words for the menu ("Max plan"); undefined when it says nothing usable. */
export function planLabel(subscription: unknown): string | undefined {
  if (typeof subscription !== 'string' || !/^[a-z][a-z _-]{1,19}$/i.test(subscription.trim())) return undefined;
  const w = subscription.trim().replace(/[_-]+/g, ' ');
  return `${w[0]!.toUpperCase()}${w.slice(1).toLowerCase()} plan`;
}

/** The first two lines of the account menu: "Claude · Max plan", then the email. A line the program did not give is left out. */
export function accountLines(st: Pick<ProviderStatus, 'id' | 'plan' | 'account'>): string[] {
  return [`${PROVIDER_LABEL[st.id]}${st.plan ? ` · ${st.plan}` : ''}`, ...(st.account ? [st.account] : [])];
}

/** The provider whose sign-in is waiting after `p` signs out: only `p`'s own wait ends, the other provider's stays. */
export const clearSignIn = (waiting: ProviderId | null, p: ProviderId): ProviderId | null => (waiting === p ? null : waiting);

/** True when keyboard focus has nowhere (nothing, or the page body): the moment a card button may take it. */
export const focusLost = (active: unknown, body: unknown): boolean => !active || active === body;

/** What the error box under a failed answer offers: signing in again when the program says it is signed out (Retry cannot fix that), Retry otherwise. */
export function errorAction(error: TurnError, provider: ProviderId): { kind: 'signIn'; label: string } | { kind: 'retry' } {
  return error.code === 'loggedOut' ? { kind: 'signIn', label: signInLabel(provider) } : { kind: 'retry' };
}

/**
 * What the thread screen shows about the current provider. "Ready" is the gate's word for the Path of Mastery check, so it is hidden
 * while the provider itself is not ready. `card` is true when the provider's own sign-in card sits under the thread: it holds the
 * one sign-in button, so an error box above it adds none.
 */
export function providerChrome(gate: AiStatus | null | undefined, provider: ProviderState | undefined, busy = false): { gate: AiStatus | null | undefined; card: boolean } {
  const notReady = provider !== undefined && provider !== 'ready';
  // While a question runs the composer stays: it holds Stop.
  return { gate: notReady && gate?.status === 'ready' ? null : gate, card: notReady && gate?.status !== 'denied' && !busy };
}
