import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountService } from '../src/main/accounts/accountService.js';
import { AuthClient, AuthError, parseCallback, type FetchLike } from '../src/main/accounts/authClient.js';
import { challengeOf, newPkce } from '../src/main/accounts/pkce.js';
import { SessionStore } from '../src/main/accounts/sessionStore.js';
import type { SecureStorage } from '../src/main/secureStorage.js';
import { parseDeepLink } from '../src/main/deepLink.js';
import { createHash } from 'node:crypto';

const CFG = { url: 'https://example.supabase.co', key: 'test-anon-key' };

/** A secure store that "encrypts" by reversing and tagging, so a test can tell plain text from cipher text. */
const fakeSecure = (available = true): SecureStorage => ({
  isAvailable: () => available,
  encrypt: (t) => Buffer.from('ENC:' + [...t].reverse().join('')),
  decrypt: (b) => {
    const s = b.toString();
    if (!s.startsWith('ENC:')) throw new Error('not encrypted');
    return [...s.slice(4)].reverse().join('');
  },
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
function fakeServer(handler: (c: Call) => { status?: number; json?: unknown } | 'network') {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const c: Call = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    const r = handler(c);
    if (r === 'network') throw new TypeError('fetch failed');
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => (r.json === undefined ? '' : JSON.stringify(r.json)) };
  };
  return { calls, fetchFn };
}

const SESSION = (n: number) => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  expires_in: 3600,
  user: { id: 'u1', email: 'kaelen@example.com', user_metadata: { full_name: 'Kaelen Voss', avatar_url: 'https://x/a.png' } },
});

test('PKCE: the challenge is the base64url SHA-256 of the verifier, and every verifier is new', () => {
  const a = newPkce();
  const b = newPkce();
  assert.notEqual(a.verifier, b.verifier);
  assert.ok(a.verifier.length >= 43 && a.verifier.length <= 128);
  assert.match(a.verifier, /^[A-Za-z0-9_-]+$/);
  assert.equal(a.challenge, createHash('sha256').update(a.verifier).digest('base64url'));
  assert.equal(challengeOf('abc'), 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  assert.equal(a.method, 's256');
});

test('the sign-in page URL carries the PKCE challenge and the app redirect, never the verifier', () => {
  const client = new AuthClient(CFG, async () => { throw new Error('no network'); });
  const p = newPkce();
  const u = new URL(client.oauthUrl('discord', p));
  assert.equal(u.origin + u.pathname, 'https://example.supabase.co/auth/v1/authorize');
  assert.equal(u.searchParams.get('provider'), 'discord');
  assert.equal(u.searchParams.get('redirect_to'), 'pathofmastery://auth/callback');
  assert.equal(u.searchParams.get('code_challenge'), p.challenge);
  assert.equal(u.searchParams.get('code_challenge_method'), 's256');
  assert.ok(!u.toString().includes(p.verifier));
});

test('email link: posts the address with the challenge and the app redirect', async () => {
  const srv = fakeServer(() => ({ json: {} }));
  const client = new AuthClient(CFG, srv.fetchFn);
  const p = newPkce();
  await client.sendEmailLink('kaelen@example.com', p);
  const c = srv.calls[0]!;
  assert.equal(c.method, 'POST');
  assert.equal(c.url, 'https://example.supabase.co/auth/v1/otp?redirect_to=pathofmastery%3A%2F%2Fauth%2Fcallback');
  assert.deepEqual(c.body, { email: 'kaelen@example.com', create_user: true, data: {}, code_challenge: p.challenge, code_challenge_method: 's256' });
  assert.equal(c.headers.apikey, CFG.key);
  assert.ok(!JSON.stringify(c.body).includes(p.verifier));
});

test('code exchange and refresh send the documented bodies and read the session', async () => {
  const srv = fakeServer(() => ({ json: SESSION(1) }));
  const client = new AuthClient(CFG, srv.fetchFn, () => 1_000_000);
  const s = await client.exchangeCode('code-1', 'verifier-1');
  assert.equal(srv.calls[0]!.url, 'https://example.supabase.co/auth/v1/token?grant_type=pkce');
  assert.deepEqual(srv.calls[0]!.body, { auth_code: 'code-1', code_verifier: 'verifier-1' });
  assert.equal(s.expiresAt, 1_000_000 + 3600_000);
  assert.deepEqual(s.user, { id: 'u1', email: 'kaelen@example.com', name: 'Kaelen Voss', avatarUrl: 'https://x/a.png' });
  await client.refresh('r');
  assert.equal(srv.calls[1]!.url, 'https://example.supabase.co/auth/v1/token?grant_type=refresh_token');
  assert.deepEqual(srv.calls[1]!.body, { refresh_token: 'r' });
});

test('errors are sorted into network, rejected and limit, with plain messages', async () => {
  const mk = (r: { status?: number; json?: unknown } | 'network') => new AuthClient(CFG, fakeServer(() => r).fetchFn);
  await assert.rejects(mk('network').refresh('x'), (e: AuthError) => e.kind === 'network');
  await assert.rejects(mk({ status: 503, json: {} }).refresh('x'), (e: AuthError) => e.kind === 'network');
  await assert.rejects(mk({ status: 400, json: { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' } }).refresh('x'), (e: AuthError) => e.kind === 'rejected' && /Sign in again/.test(e.message));
  await assert.rejects(mk({ status: 400, json: { error_code: 'flow_state_not_found' } }).exchangeCode('c', 'v'), (e: AuthError) => e.kind === 'rejected' && /expired or was already used/.test(e.message));
  await assert.rejects(mk({ status: 429, json: { error_code: 'over_email_send_rate_limit' } }).sendEmailLink('a@b.co', newPkce()), (e: AuthError) => e.kind === 'limit');
});

test('callback links: a code, an error, or nothing we know', () => {
  assert.deepEqual(parseCallback('pathofmastery://auth/callback?code=abc123'), { code: 'abc123' });
  assert.deepEqual(parseCallback('pathofmastery://auth/callback?error=access_denied&error_description=User+denied+access'), { error: 'User denied access' });
  assert.deepEqual(parseCallback('pathofmastery://auth/callback#error=server_error&error_description=Oops'), { error: 'Oops' });
  assert.equal(parseCallback('pathofmastery://auth/callback'), null);
  assert.equal(parseCallback('https://evil.example/callback?code=1'), null);
  assert.equal(parseCallback('not a url'), null);
});

test('deep links: auth callbacks and share links are routed, junk is not', () => {
  assert.deepEqual(parseDeepLink('pathofmastery://auth/callback?code=x'), { kind: 'authCallback', url: 'pathofmastery://auth/callback?code=x' });
  assert.deepEqual(parseDeepLink('pathofmastery://share/k7Qx2AbCdEfGhIjK'), { kind: 'share', token: 'k7Qx2AbCdEfGhIjK' });
  assert.equal(parseDeepLink('pathofmastery://share/short').kind, 'unknown');
  assert.equal(parseDeepLink('pathofmastery://share/..%2F..%2Fetc').kind, 'unknown');
});

// ---- the session store --------------------------------------------------------------------------

async function tmp(): Promise<{ dir: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'pom-acct-'));
  return { dir, done: () => rm(dir, { recursive: true, force: true }) };
}

test('session store: the refresh token is written encrypted, never as plain text, and comes back after a restart', async () => {
  const { dir, done } = await tmp();
  try {
    const user = { id: 'u1', email: 'k@x.co', name: 'K', avatarUrl: '' };
    await new SessionStore(dir, fakeSecure()).saveSession({ refreshToken: 'SECRET-REFRESH-TOKEN', user });
    for (const f of await readdir(dir)) {
      const raw = await readFile(join(dir, f), 'latin1');
      assert.ok(!raw.includes('SECRET-REFRESH-TOKEN'), `${f} holds the token in plain text`);
    }
    const again = await new SessionStore(dir, fakeSecure()).loadSession();
    assert.equal(again?.refreshToken, 'SECRET-REFRESH-TOKEN');
    await new SessionStore(dir, fakeSecure()).clearSession();
    assert.equal(await new SessionStore(dir, fakeSecure()).loadSession(), null);
  } finally {
    await done();
  }
});

test('session store: with no operating system key store nothing is written and the session lives in memory only', async () => {
  const { dir, done } = await tmp();
  try {
    const s = new SessionStore(dir, fakeSecure(false));
    assert.equal(s.persistent, false);
    await s.saveSession({ refreshToken: 'T', user: { id: 'u', email: '', name: '', avatarUrl: '' } });
    assert.deepEqual(await readdir(dir), []);
    assert.equal((await s.loadSession())?.refreshToken, 'T');
    assert.equal(await new SessionStore(dir, fakeSecure(false)).loadSession(), null, 'a new run starts signed out');
  } finally {
    await done();
  }
});

test('session store: a damaged file is ignored, not trusted', async () => {
  const { dir, done } = await tmp();
  try {
    const s = new SessionStore(dir, fakeSecure());
    await s.saveSession({ refreshToken: 'T', user: { id: 'u', email: '', name: '', avatarUrl: '' } });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'session.bin'), 'plain text, not ours');
    assert.equal(await new SessionStore(dir, fakeSecure()).loadSession(), null);
  } finally {
    await done();
  }
});

// ---- the account service ------------------------------------------------------------------------

function service(handler: Parameters<typeof fakeServer>[0], dir: string, opts: { secure?: SecureStorage; now?: () => number } = {}) {
  const srv = fakeServer(handler);
  const opened: string[] = [];
  const store = new SessionStore(dir, opts.secure ?? fakeSecure());
  const svc = new AccountService({
    client: new AuthClient(CFG, srv.fetchFn, opts.now ?? Date.now),
    store,
    openExternal: async (u) => void opened.push(u),
    allowed: { google: true, discord: true, github: false },
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { svc, srv, opened, store };
}

test('email sign-in: send, wait, open the link, exchange with the stored verifier, signed in', async () => {
  const { dir, done } = await tmp();
  try {
    const { svc, srv } = service((c) => (c.url.includes('/token') ? { json: SESSION(1) } : { json: {} }), dir);
    await svc.signInWithEmail('kaelen@example.com');
    assert.equal(svc.view().auth.state, 'emailSent');
    const challenge = (srv.calls[0]!.body as { code_challenge: string }).code_challenge;
    await svc.handleCallback('pathofmastery://auth/callback?code=the-code');
    assert.equal(svc.view().auth.state, 'signedIn');
    const ex = srv.calls[1]!.body as { auth_code: string; code_verifier: string };
    assert.equal(ex.auth_code, 'the-code');
    assert.equal(challengeOf(ex.code_verifier), challenge, 'the verifier that is sent matches the challenge that was sent');
    assert.equal(svc.user?.name, 'Kaelen Voss');
  } finally {
    await done();
  }
});

test('email sign-in survives an app restart between the email and the click', async () => {
  const { dir, done } = await tmp();
  try {
    const first = service(() => ({ json: {} }), dir);
    await first.svc.signInWithEmail('kaelen@example.com');
    const second = service((c) => (c.url.includes('/token') ? { json: SESSION(1) } : { json: {} }), dir);
    await second.svc.handleCallback('pathofmastery://auth/callback?code=c');
    assert.equal(second.svc.view().auth.state, 'signedIn');
  } finally {
    await done();
  }
});

test('a link that was not started here, or was used twice, says so and signs nobody in', async () => {
  const { dir, done } = await tmp();
  try {
    const { svc } = service((c) => (c.url.includes('/token') ? { status: 400, json: { error_code: 'flow_state_not_found' } } : { json: {} }), dir);
    await svc.handleCallback('pathofmastery://auth/callback?code=stray');
    assert.equal(svc.view().auth.state, 'signedOut');
    assert.match(svc.view().error ?? '', /not started on this computer/);
    await svc.signInWithEmail('a@b.co');
    await svc.handleCallback('pathofmastery://auth/callback?code=used');
    assert.match(svc.view().error ?? '', /expired or was already used/);
    await svc.handleCallback('pathofmastery://auth/callback?error=access_denied');
    assert.equal(svc.view().error, 'Sign-in was cancelled.');
  } finally {
    await done();
  }
});

test('provider sign-in opens the browser on the authorize URL; GitHub is refused while it is off', async () => {
  const { dir, done } = await tmp();
  try {
    const { svc, opened } = service(() => ({ json: {} }), dir);
    await svc.signInWithProvider('google');
    assert.equal(svc.view().auth.state, 'browser');
    assert.match(opened[0]!, /\/auth\/v1\/authorize\?provider=google/);
    await svc.cancelSignIn();
    assert.equal(svc.view().auth.state, 'signedOut');
    await svc.signInWithProvider('github');
    assert.equal(opened.length, 1);
    assert.match(svc.view().error ?? '', /not switched on/);
  } finally {
    await done();
  }
});

test('silent sign-in on launch: the stored refresh token is traded and the new one is stored', async () => {
  const { dir, done } = await tmp();
  try {
    const a = service(() => ({ json: {} }), dir);
    await a.store.saveSession({ refreshToken: 'refresh-0', user: { id: 'u1', email: 'k@x.co', name: 'Kaelen', avatarUrl: '' } });
    const b = service((c) => (c.url.includes('refresh_token') ? { json: SESSION(1) } : { json: {} }), dir);
    await b.svc.restore();
    assert.equal(b.svc.view().auth.state, 'signedIn');
    assert.deepEqual(b.srv.calls[0]!.body, { refresh_token: 'refresh-0' });
    assert.equal((await new SessionStore(dir, fakeSecure()).loadSession())?.refreshToken, 'refresh-1', 'the rotated token replaces the old one');
    assert.equal(await b.svc.accessToken(), 'access-1');
  } finally {
    await done();
  }
});

test('silent sign-in with no network keeps the player signed in; a refusal signs them out with a message', async () => {
  const { dir, done } = await tmp();
  try {
    const seed = service(() => ({ json: {} }), dir);
    await seed.store.saveSession({ refreshToken: 'r0', user: { id: 'u1', email: 'k@x.co', name: 'Kaelen', avatarUrl: '' } });
    const offline = service(() => 'network', dir);
    await offline.svc.restore();
    assert.equal(offline.svc.view().auth.state, 'signedIn');
    assert.equal(offline.svc.user?.name, 'Kaelen');
    const refused = service(() => ({ status: 400, json: { error_code: 'refresh_token_not_found' } }), dir);
    await refused.svc.restore();
    assert.equal(refused.svc.view().auth.state, 'signedOut');
    assert.match(refused.svc.view().error ?? '', /sign-in ended/i);
    assert.equal(await new SessionStore(dir, fakeSecure()).loadSession(), null, 'a dead token is not kept');
  } finally {
    await done();
  }
});

test('no stored session: restore does nothing and local use is untouched', async () => {
  const { dir, done } = await tmp();
  try {
    const { svc, srv } = service(() => ({ json: {} }), dir);
    await svc.restore();
    assert.equal(svc.view().auth.state, 'signedOut');
    assert.equal(srv.calls.length, 0, 'signed out means no network call at launch');
  } finally {
    await done();
  }
});

test('the access token is renewed shortly before it ends, once even when asked many times at once', async () => {
  const { dir, done } = await tmp();
  try {
    let t = 1_000_000;
    let n = 0;
    const { svc, srv } = service((c) => (c.url.includes('/token') ? { json: SESSION(++n) } : { json: {} }), dir, { now: () => t });
    await svc.signInWithEmail('a@b.co');
    await svc.handleCallback('pathofmastery://auth/callback?code=c');
    assert.equal(await svc.accessToken(), 'access-1');
    const before = srv.calls.length;
    assert.equal(await svc.accessToken(), 'access-1', 'a fresh token is reused');
    assert.equal(srv.calls.length, before);
    t += 3600_000 - 30_000; // 30 s left
    const tokens = await Promise.all([svc.accessToken(), svc.accessToken(), svc.accessToken()]);
    assert.deepEqual(tokens, ['access-2', 'access-2', 'access-2']);
    assert.equal(srv.calls.length, before + 1, 'one refresh served all three');
  } finally {
    await done();
  }
});

test('sign out clears the stored session even when the server cannot be reached', async () => {
  const { dir, done } = await tmp();
  try {
    let down = false;
    const { svc } = service((c) => (down ? 'network' : c.url.includes('/token') ? { json: SESSION(1) } : { json: {} }), dir);
    await svc.signInWithEmail('a@b.co');
    await svc.handleCallback('pathofmastery://auth/callback?code=c');
    down = true;
    await svc.signOut();
    assert.equal(svc.view().auth.state, 'signedOut');
    assert.equal(await new SessionStore(dir, fakeSecure()).loadSession(), null);
    await assert.rejects(svc.accessToken());
  } finally {
    await done();
  }
});

test('a bad email address is refused before anything is sent', async () => {
  const { dir, done } = await tmp();
  try {
    const { svc, srv } = service(() => ({ json: {} }), dir);
    await svc.signInWithEmail('not an email');
    assert.equal(srv.calls.length, 0);
    assert.match(svc.view().error ?? '', /does not look right/);
  } finally {
    await done();
  }
});

test('userGone is true only when Supabase Auth says the token user does not exist', async () => {
  const answer = (r: { status?: number; json?: unknown } | 'network') => new AuthClient(CFG, fakeServer(() => r).fetchFn).userGone('token');
  assert.equal(await answer({ status: 403, json: { code: 403, error_code: 'user_not_found', msg: 'User from sub claim in JWT does not exist' } }), true);
  assert.equal(await answer({ status: 200, json: { id: 'x' } }), false, 'the user exists');
  assert.equal(await answer({ status: 401, json: { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' } }), false, 'a bad token is not proof the account is gone');
  assert.equal(await answer({ status: 503, json: {} }), false, 'a server problem is not proof');
  assert.equal(await answer('network'), false, 'no network is not proof');
});
