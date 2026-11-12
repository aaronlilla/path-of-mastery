import type { AccountUser, AuthView, ProviderId, ProviderStatus } from '../../shared/accounts.js';
import { AuthClient, AuthError, parseCallback, type Session } from './authClient.js';
import { newPkce } from './pkce.js';
import type { SessionStore } from './sessionStore.js';

export interface AccountServiceDeps {
  client: AuthClient;
  store: SessionStore;
  /** Opens the system browser. */
  openExternal: (url: string) => Promise<void>;
  now?: () => number;
  /** Which providers the app lets the player use (GitHub is off until the GitHub app is set up). */
  allowed: Record<ProviderId, boolean>;
}

type Listener = (view: { auth: AuthView; error?: string }) => void;

/** The access token is renewed this long before it ends. */
const REFRESH_MARGIN_MS = 60_000;
/** Email links can be sent again after this long (the project allows one a minute). */
export const RESEND_AFTER_MS = 60_000;

/**
 * Sign-in with PKCE, silent sign-in on launch from the stored refresh token, token renewal and sign-out.
 * Holds the only copy of the access token; everything else asks `accessToken()`.
 */
export class AccountService {
  private auth: AuthView = { state: 'signedOut' };
  private error: string | undefined;
  private session: Session | null = null;
  private refreshing: Promise<Session> | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly now: () => number;

  constructor(private readonly d: AccountServiceDeps) {
    this.now = d.now ?? Date.now;
  }

  onChange(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  view(): { auth: AuthView; error?: string } {
    return { auth: this.auth, ...(this.error ? { error: this.error } : {}) };
  }

  get user(): AccountUser | null {
    return this.auth.state === 'signedIn' || this.auth.state === 'restoring' ? this.auth.user : null;
  }

  private set(auth: AuthView, error?: string): void {
    this.auth = auth;
    this.error = error;
    for (const l of this.listeners) l(this.view());
  }

  async providers(): Promise<ProviderStatus[]> {
    let enabled: Record<string, boolean> | null = null;
    try {
      enabled = await this.d.client.enabledProviders();
    } catch {
      enabled = null;
    }
    return (['google', 'discord', 'github'] as const).map((id) => ({ id, allowed: this.d.allowed[id], enabled: enabled ? !!enabled[id] : null }));
  }

  // ---- launch ---------------------------------------------------------------------------------

  /**
   * Silent sign-in: trades the stored refresh token for a fresh session. With no network the player stays signed
   * in as far as the app can tell (their cloud builds just wait); only a refusal from the server signs them out.
   */
  async restore(): Promise<void> {
    const stored = await this.d.store.loadSession();
    if (!stored) return;
    this.set({ state: 'restoring', user: stored.user });
    try {
      await this.renew(stored.refreshToken);
    } catch (e) {
      // A refusal already signed the player out (renew did it). Offline or a server problem: keep their identity and
      // get a token when the network is back, so local use and their cloud builds' queue are untouched.
      if (!(e instanceof AuthError && e.kind === 'rejected')) this.set({ state: 'signedIn', user: stored.user, persistent: this.d.store.persistent });
    }
  }

  private async useSession(s: Session): Promise<void> {
    this.session = s;
    await this.d.store.saveSession({ refreshToken: s.refreshToken, user: s.user });
    this.set({ state: 'signedIn', user: s.user, persistent: this.d.store.persistent });
  }

  // ---- signing in -----------------------------------------------------------------------------

  async signInWithProvider(provider: ProviderId): Promise<void> {
    if (!this.d.allowed[provider]) {
      this.set({ state: 'signedOut' }, 'That sign-in method is not switched on yet.');
      return;
    }
    const pkce = newPkce();
    await this.d.store.savePending({ verifier: pkce.verifier, kind: 'oauth', provider, startedAt: this.now() });
    this.set({ state: 'browser', provider });
    try {
      await this.d.openExternal(this.d.client.oauthUrl(provider, pkce));
    } catch {
      await this.d.store.takePending();
      this.set({ state: 'signedOut' }, 'The browser could not be opened.');
    }
  }

  async signInWithEmail(email: string): Promise<void> {
    const clean = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      this.set({ state: 'signedOut' }, 'That email address does not look right.');
      return;
    }
    const pkce = newPkce();
    try {
      await this.d.client.sendEmailLink(clean, pkce);
    } catch (e) {
      this.set({ state: 'signedOut' }, e instanceof AuthError ? e.message : 'Could not send the email.');
      return;
    }
    await this.d.store.savePending({ verifier: pkce.verifier, kind: 'email', email: clean, startedAt: this.now() });
    this.set({ state: 'emailSent', email: clean, resendAt: this.now() + RESEND_AFTER_MS });
  }

  /** Leaves the "check your email" or "waiting for the browser" screens without signing in. */
  async cancelSignIn(): Promise<void> {
    await this.d.store.takePending();
    if (this.auth.state === 'emailSent' || this.auth.state === 'browser') this.set({ state: 'signedOut' });
  }

  /** The link in the email, or the provider's page, brought the player back with `pathofmastery://auth/callback?...`. */
  async handleCallback(url: string): Promise<void> {
    const cb = parseCallback(url);
    if (!cb) return;
    const pending = await this.d.store.takePending();
    if ('error' in cb) {
      this.set({ state: 'signedOut' }, friendlyCallbackError(cb.error));
      return;
    }
    if (!pending) {
      this.set(this.auth.state === 'signedIn' ? this.auth : { state: 'signedOut' }, 'That sign-in link was not started on this computer. Start signing in here and use the new link.');
      return;
    }
    try {
      await this.useSession(await this.d.client.exchangeCode(cb.code, pending.verifier));
    } catch (e) {
      this.set({ state: 'signedOut' }, e instanceof AuthError ? e.message : 'Sign-in did not finish.');
    }
  }

  // ---- using the session ----------------------------------------------------------------------

  /** A working access token, renewed when it is close to ending. Throws AuthError when the player is not signed in. */
  async accessToken(): Promise<string> {
    let s = this.session;
    if (!s) {
      const stored = await this.d.store.loadSession();
      if (!stored) throw new AuthError('Not signed in.', 'rejected');
      s = await this.renew(stored.refreshToken);
    } else if (s.expiresAt - this.now() < REFRESH_MARGIN_MS) {
      s = await this.renew(s.refreshToken);
    }
    return s.accessToken;
  }

  private renew(refreshToken: string): Promise<Session> {
    this.refreshing ??= (async () => {
      try {
        const s = await this.d.client.refresh(refreshToken);
        await this.useSession(s);
        return s;
      } catch (e) {
        if (e instanceof AuthError && e.kind === 'rejected') {
          await this.d.store.clearSession();
          this.session = null;
          this.set({ state: 'signedOut' }, 'Your sign-in ended. Sign in again to sync your builds.');
        }
        throw e;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /**
   * The account was deleted somewhere else (the website, another PC): Supabase Auth says this session's user no longer exists.
   * Then this PC signs out locally and says why. Builds on the PC are not touched. Returns whether it signed out.
   */
  async signOutIfGone(): Promise<boolean> {
    if (!this.session) return false;
    const token = await this.accessToken().catch(() => null); // a refused refresh already signs out (renew)
    if (!token || !this.session) return false;
    if (!(await this.d.client.userGone(token))) return false;
    await this.signOut();
    this.set({ state: 'signedOut' }, 'This account no longer exists, so this PC is signed out. Your builds stay on this PC.');
    return true;
  }

  async signOut(): Promise<void> {
    const token = this.session?.accessToken;
    this.session = null;
    await this.d.store.clearSession();
    await this.d.store.takePending();
    this.set({ state: 'signedOut' });
    if (token) {
      try {
        await this.d.client.signOut(token);
      } catch {
        /* The device is signed out either way. */
      }
    }
  }
}

function friendlyCallbackError(raw: string): string {
  if (/access_denied|denied/i.test(raw)) return 'Sign-in was cancelled.';
  if (/expired|invalid/i.test(raw)) return 'That sign-in link has expired or was already used. Start signing in again.';
  return raw;
}
