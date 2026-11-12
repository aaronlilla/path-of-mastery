import type { AccountUser, ProviderId } from '../../shared/accounts.js';
import { AUTH_REDIRECT, type SupabaseConfig } from './config.js';
import type { Pkce } from './pkce.js';

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface Session {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token stops working. */
  expiresAt: number;
  user: AccountUser;
}

/**
 * `network`: could not reach the server (offline, DNS, timeout). `rejected`: the server answered and said no to this
 * code or refresh token, so the player must sign in again. `limit`: too many emails or tries. `other`: anything else.
 */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'rejected' | 'limit' | 'other',
    readonly status = 0,
    readonly code = '',
  ) {
    super(message);
  }
}

interface RawUser {
  id?: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
}
interface RawSession {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
  user?: RawUser;
}

export function userFromRaw(u: RawUser | undefined): AccountUser {
  if (!u?.id) throw new AuthError('The sign-in answer had no user.', 'other');
  const m = u.user_metadata ?? {};
  const str = (k: string) => (typeof m[k] === 'string' ? (m[k] as string) : '');
  const email = u.email ?? '';
  return {
    id: u.id,
    email,
    name: str('full_name') || str('name') || str('user_name') || str('preferred_username') || email.split('@')[0] || 'Player',
    avatarUrl: str('avatar_url') || str('picture'),
  };
}

export function sessionFromRaw(raw: RawSession, now: number): Session {
  if (!raw.access_token || !raw.refresh_token) throw new AuthError('The sign-in answer had no session.', 'other');
  const expiresAt = typeof raw.expires_at === 'number' ? raw.expires_at * 1000 : now + (raw.expires_in ?? 3600) * 1000;
  return { accessToken: raw.access_token, refreshToken: raw.refresh_token, expiresAt, user: userFromRaw(raw.user) };
}

/** What the sign-in page URL carries back: a code to trade, or an error to show. */
export function parseCallback(url: string): { code: string } | { error: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'pathofmastery:' || u.hostname !== 'auth') return null;
  const hash = new URLSearchParams(u.hash.replace(/^#/, ''));
  const q = u.searchParams;
  const err = q.get('error_description') || hash.get('error_description') || q.get('error') || hash.get('error');
  if (err) return { error: err.replace(/\+/g, ' ') };
  const code = q.get('code');
  if (code) return { code };
  return null;
}

export class AuthClient {
  constructor(
    private readonly cfg: SupabaseConfig,
    private readonly fetchFn: FetchLike,
    private readonly now: () => number = Date.now,
  ) {}

  private async call(path: string, init: { method?: string; body?: unknown; bearer?: string } = {}): Promise<unknown> {
    const headers: Record<string, string> = { apikey: this.cfg.key, 'Content-Type': 'application/json' };
    if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
    let res;
    try {
      res = await this.fetchFn(`${this.cfg.url}/auth/v1${path}`, { method: init.method ?? 'GET', headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
    } catch (e) {
      throw new AuthError('Could not reach the sign-in server. Check your connection and try again.', 'network');
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* not JSON */
    }
    if (res.ok) return json;
    const code = String(json.error_code ?? json.code ?? '');
    const msg = String(json.msg ?? json.message ?? json.error_description ?? json.error ?? `The sign-in server answered ${res.status}.`);
    if (res.status === 429 || code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit') {
      throw new AuthError('Too many sign-in emails were sent. Wait a minute and try again.', 'limit', res.status, code);
    }
    if (res.status >= 500) throw new AuthError('The sign-in server had a problem. Try again in a moment.', 'network', res.status, code);
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404 || res.status === 422) {
      throw new AuthError(friendly(code, msg), 'rejected', res.status, code);
    }
    throw new AuthError(msg, 'other', res.status, code);
  }

  /** Which providers the project has switched on (a public endpoint). */
  async enabledProviders(): Promise<Record<string, boolean>> {
    const j = (await this.call('/settings')) as { external?: Record<string, boolean> };
    return j.external ?? {};
  }

  /** The page the browser opens for Google, Discord or GitHub. The code comes back on AUTH_REDIRECT. */
  oauthUrl(provider: ProviderId, pkce: Pkce): string {
    const q = new URLSearchParams({ provider, redirect_to: AUTH_REDIRECT, code_challenge: pkce.challenge, code_challenge_method: pkce.method });
    return `${this.cfg.url}/auth/v1/authorize?${q.toString()}`;
  }

  /** Sends the email link. The link opens a page that forwards to AUTH_REDIRECT with a code. */
  async sendEmailLink(email: string, pkce: Pkce): Promise<void> {
    await this.call(`/otp?redirect_to=${encodeURIComponent(AUTH_REDIRECT)}`, {
      method: 'POST',
      body: { email, create_user: true, data: {}, code_challenge: pkce.challenge, code_challenge_method: pkce.method },
    });
  }

  async exchangeCode(code: string, verifier: string): Promise<Session> {
    const raw = (await this.call('/token?grant_type=pkce', { method: 'POST', body: { auth_code: code, code_verifier: verifier } })) as RawSession;
    return sessionFromRaw(raw, this.now());
  }

  async refresh(refreshToken: string): Promise<Session> {
    const raw = (await this.call('/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refreshToken } })) as RawSession;
    return sessionFromRaw(raw, this.now());
  }

  /** True only when Supabase Auth says this token's user does not exist (it checks the signature first). Anything else, a
   *  network failure included, is false: the caller keeps the session. */
  async userGone(accessToken: string): Promise<boolean> {
    try {
      await this.call('/user', { bearer: accessToken });
      return false;
    } catch (e) {
      return e instanceof AuthError && e.code === 'user_not_found';
    }
  }

  /** Ends this device's session on the server. Failures are ignored by the caller: the local session is cleared anyway. */
  async signOut(accessToken: string): Promise<void> {
    await this.call('/logout?scope=local', { method: 'POST', bearer: accessToken, body: {} });
  }
}

function friendly(code: string, msg: string): string {
  switch (code) {
    case 'flow_state_not_found':
    case 'flow_state_expired':
    case 'bad_code_verifier':
      return 'That sign-in link has expired or was already used. Start signing in again.';
    case 'refresh_token_not_found':
    case 'refresh_token_already_used':
    case 'session_not_found':
      return 'Your sign-in ended. Sign in again.';
    case 'email_address_invalid':
      return 'That email address does not look right.';
    case 'email_address_not_authorized':
      return 'The email service is not set up to send to this address yet.';
    case 'signup_disabled':
      return 'New accounts are switched off right now.';
    case 'validation_failed':
      return /provider is not enabled/i.test(msg) ? 'That sign-in method is not switched on yet.' : msg;
    default:
      return msg;
  }
}
