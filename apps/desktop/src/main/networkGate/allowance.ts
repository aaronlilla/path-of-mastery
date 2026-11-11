import { verify, type KeyObject } from 'node:crypto';
export type TestAllowance = { version: 1; buildHash: string; purpose: 'hunter' | 'e2e'; expiresAt: string; nonce: string };
export type AllowanceContext = { channel: 'development' | 'test' | 'production'; buildHash: string; publicKey: string | KeyObject; now?: number };
export function verifyTestAllowance(encoded: string | undefined, context: AllowanceContext): boolean {
  if (context.channel === 'production' || !encoded || encoded.length > 4096 || !/^[0-9a-f]{64}$/.test(context.buildHash)) return false;
  try {
    const [payload, signature, extra] = encoded.split('.');
    if (!payload || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload + signature)) return false;
    if (!verify(null, Buffer.from(payload), context.publicKey, Buffer.from(signature, 'base64url'))) return false;
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TestAllowance;
    const now = context.now ?? Date.now(); const expiry = Date.parse(value.expiresAt);
    return Object.keys(value).sort().join(',') === 'buildHash,expiresAt,nonce,purpose,version'
      && value.version === 1 && value.buildHash === context.buildHash && ['hunter','e2e'].includes(value.purpose)
      && typeof value.nonce === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value.nonce)
      && Number.isFinite(expiry) && expiry > now && expiry <= now + 3600000;
  } catch { return false; }
}
