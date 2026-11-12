import { createHash, randomBytes } from 'node:crypto';

/** PKCE (RFC 7636): a random verifier kept on this computer, and its SHA-256 challenge sent with the sign-in request. */
export interface Pkce {
  verifier: string;
  challenge: string;
  method: 's256';
}

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function challengeOf(verifier: string): string {
  return b64url(createHash('sha256').update(verifier, 'ascii').digest());
}

export function newPkce(): Pkce {
  // 64 random bytes give an 86 character verifier (the RFC allows 43 to 128).
  const verifier = b64url(randomBytes(64));
  return { verifier, challenge: challengeOf(verifier), method: 's256' };
}
