// App channel, desktop side: the installation key signs its own registration and every gated request claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { createAppSigner } from '../src/main/aiGate/proof.js';
import { hashJson } from '../src/main/aiGate/gate.js';
import { createInstallationRegistrar, installationLabel } from '../src/main/mastery/installation.js';

const installation = 'a'.repeat(64);
const decode = (h: Record<string, string>) => ({ bytes: Buffer.from(h['x-pom-app-claim']!, 'base64url'), sig: Buffer.from(h['x-pom-app-signature']!, 'base64url') });

test('signed claim binds account, installation, route, body hash, nonce and expiry, and verifies only with its own key', () => {
  const signer = createAppSigner(); const other = createAppSigner(); const body = { clientId: null, n: 1 };
  const exp = Date.now() + 60_000;
  const a = signer.headers('session', body, 'actor', installation, exp); const b = signer.headers('session', body, 'actor', installation, exp);
  const { bytes, sig } = decode(a); const claim = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(Object.keys(claim).sort(), ['actorId', 'bodyHash', 'expiresAt', 'installation', 'nonce', 'route', 'version']);
  assert.equal(claim.actorId, 'actor'); assert.equal(claim.installation, installation); assert.equal(claim.route, 'session');
  assert.equal(claim.bodyHash, hashJson(body)); assert.equal(claim.expiresAt, exp); assert.match(claim.nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(JSON.parse(decode(b).bytes.toString()).nonce, claim.nonce, 'fresh nonce per request');
  assert.equal(verify(null, bytes, createPublicKey(signer.publicKey), sig), true);
  assert.equal(verify(null, bytes, createPublicKey(other.publicKey), sig), false);
  const tampered = Buffer.from(JSON.stringify({ ...claim, actorId: 'someone-else' }));
  assert.equal(verify(null, tampered, createPublicKey(signer.publicKey), sig), false);
});

test('registrar posts the public key signed by that key, once per account, and retires a revoked installation', async () => {
  const signer = createAppSigner(); let account: string | null = 'acct-1'; const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  let answer: unknown = { ok: true, value: { status: 'registered' } }; let retired = 0;
  const registrar = createInstallationRegistrar({
    origin: 'https://pathofmastery.gg', allowLoopback: false, installation, publicKey: signer.publicKey, label: installationLabel('win32'),
    sign: (route, body, acct) => signer.headers(route, body, acct, installation, Date.now() + 60_000),
    accountId: () => account, accessToken: async () => (account ? `token-${account}` : null), onRevoked: () => { retired++; },
    fetch: (async (url: URL, init: RequestInit) => { calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(answer)); }) as unknown as typeof fetch,
  });
  assert.equal(await registrar.register(), 'registered');
  assert.equal(await registrar.register(), 'registered'); assert.equal(calls.length, 1, 'cached for the same account');
  const c = calls[0]!;
  assert.equal(c.url, 'https://pathofmastery.gg/api/app/installations');
  assert.deepEqual(c.body, { action: 'register', installation, publicKey: signer.publicKey, label: 'Windows desktop app' });
  assert.equal(c.headers.authorization, 'Bearer token-acct-1'); assert.equal(c.headers['x-pom-installation'], installation);
  const { bytes, sig } = decode(c.headers); const claim = JSON.parse(bytes.toString());
  assert.equal(claim.route, 'app/installations'); assert.equal(claim.actorId, 'acct-1'); assert.equal(claim.bodyHash, hashJson(c.body));
  assert.equal(verify(null, bytes, createPublicKey(c.body.publicKey), sig), true, 'proof of possession');
  account = 'acct-2'; answer = { ok: false, code: 'CONNECTION_REVOKED', message: 'x' };
  assert.equal(await registrar.register(), 'revoked'); assert.equal(retired, 1);
  assert.equal(await registrar.register(), 'revoked'); assert.equal(calls.length, 2, 'a revoked installation stops calling'); assert.equal(retired, 1);
  account = null; assert.equal(await registrar.register(), 'signed-out');
});

test('registrar refuses plain http except loopback in development', async () => {
  let n = 0; const signer = createAppSigner();
  const make = (origin: string, allowLoopback: boolean) => createInstallationRegistrar({ origin, allowLoopback, installation, publicKey: signer.publicKey, label: 'x',
    sign: () => ({}), accountId: () => 'a', accessToken: async () => 't', fetch: (async () => { n++; return new Response('{"ok":true}'); }) as unknown as typeof fetch });
  assert.equal(await make('http://evil.example', true).register(), 'failed');
  assert.equal(await make('http://127.0.0.1:4321', false).register(), 'failed');
  assert.equal(n, 0);
  assert.equal(await make('http://127.0.0.1:4321', true).register(), 'registered'); assert.equal(n, 1);
});
