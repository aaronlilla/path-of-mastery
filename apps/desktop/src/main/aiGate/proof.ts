import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson, hashJson } from './gate.js';

type Claim = { version: 1; actorId: string; installation: string; route: string; bodyHash: string; nonce: string; expiresAt: number };
export function createAppSigner(privateKey?: KeyObject) {
  const pair = privateKey ? null : generateKeyPairSync('ed25519');
  const key = privateKey ?? pair!.privateKey;
  return {
    publicKey: createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString(),
    headers(route: string, body: unknown, actorId: string, installation: string, expiresAt: number): Record<string, string> {
      const claim: Claim = { version: 1, actorId, installation, route, bodyHash: hashJson(body), nonce: randomBytes(32).toString('base64url'), expiresAt };
      const bytes = Buffer.from(canonicalJson(claim));
      return { 'x-pom-app-claim': bytes.toString('base64url'), 'x-pom-app-signature': sign(null, bytes, key).toString('base64url') };
    },
  };
}

// Server composition supplies an account-bound registered key and an atomic replay store.
export function createAppChannelVerifier(d: {
  publicKey(actorId: string, installation: string): Promise<string | KeyObject | null>;
  claimNonce(actorId: string, installation: string, nonce: string, expiresAt: number): Promise<boolean>;
  maxLifetimeMs: number; now?: () => number;
}) {
  const admitted = new WeakMap<Request, string>();
  return async (request: Request, actorId: string, body: unknown): Promise<boolean> => {
    try {
      const encoded = request.headers.get('x-pom-app-claim') ?? '';
      const signature = request.headers.get('x-pom-app-signature') ?? '';
      if (encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
      const bytes = Buffer.from(encoded, 'base64url'); const claim = JSON.parse(bytes.toString('utf8')) as Claim;
      const now = (d.now ?? Date.now)();
      if (Object.keys(claim).sort().join(',') !== 'actorId,bodyHash,expiresAt,installation,nonce,route,version'
        || claim.version !== 1 || claim.actorId !== actorId || claim.installation !== request.headers.get('x-pom-installation')
        || !/^[a-f0-9]{64}$/.test(claim.installation) || !/^[A-Za-z0-9_-]{43}$/.test(claim.nonce)
        || request.method !== 'POST' || new URL(request.url).pathname !== `/api/ai/${claim.route}`
        || !['session', 'authorize', 'request', 'pair', 'revoke'].includes(claim.route)
        || claim.bodyHash !== hashJson(body) || !Number.isSafeInteger(claim.expiresAt)
        || claim.expiresAt <= now || claim.expiresAt > now + d.maxLifetimeMs) return false;
      const key = await d.publicKey(actorId, claim.installation);
      if (!key || !verify(null, bytes, key, Buffer.from(signature, 'base64url'))) return false;
      const fingerprint = hashJson({ encoded, signature });
      if (admitted.get(request) === fingerprint) return true;
      if (!await d.claimNonce(actorId, claim.installation, claim.nonce, claim.expiresAt)) return false;
      admitted.set(request, fingerprint); return true;
    } catch { return false; }
  };
}
