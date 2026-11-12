import type { FailureCode } from '@pom/mastery-contracts';
export type AiStatus = { status: 'off' | 'checking' | 'ready' | 'denied'; code?: FailureCode; retryAt?: string };
/** What the window needs to know about AI access. Plain data only. */
export interface EntitlementView {
  /** AI features are open to signed-in players; the hosted service checks each request. */
  signedIn: boolean;
  ai?: AiStatus;
}

/** The line the locked panels show when signed out. */
export const SIGN_IN_PITCH = 'Sign in to use the AI features.';
