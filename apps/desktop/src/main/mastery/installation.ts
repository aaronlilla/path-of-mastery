// App channel registration: registers this installation's public signing key to the signed-in account at
// POST /api/app/installations, signed by that same key (proof of possession). The site then accepts claims signed by
// this key for this account until the account page revokes the installation. A revoked installation is retired on
// disk, so the next launch makes a new installation id and key and registers again (it shows up on the account page).
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

export type RegisterResult = 'registered' | 'signed-out' | 'revoked' | 'failed';
export type RegistrarDeps = {
  origin: string; allowLoopback: boolean; installation: string; publicKey: string; label: string;
  sign(route: string, body: unknown, account: string): Record<string, string>;
  accountId(): string | null; accessToken(): Promise<string | null>;
  /** Called once when the site says this installation was revoked. */
  onRevoked?(): Promise<void> | void;
  fetch?: typeof fetch;
};

export function createInstallationRegistrar(d: RegistrarDeps) {
  const base = new URL(d.origin);
  const allowed = base.protocol === 'https:' || (d.allowLoopback && base.protocol === 'http:' && base.hostname === '127.0.0.1');
  let registeredFor: string | null = null; let inflight: Promise<RegisterResult> | null = null; let revoked = false;
  async function run(): Promise<RegisterResult> {
    const account = d.accountId(); if (!account) return 'signed-out';
    if (registeredFor === account) return 'registered';
    if (!allowed || revoked) return revoked ? 'revoked' : 'failed';
    const token = await d.accessToken().catch(() => null); if (!token || d.accountId() !== account) return 'signed-out';
    const body = { action: 'register', installation: d.installation, publicKey: d.publicKey, label: d.label };
    try {
      const res = await (d.fetch ?? fetch)(new URL('/api/app/installations', base), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-pom-installation': d.installation, ...d.sign('app/installations', body, account) },
        body: JSON.stringify(body),
      });
      const result = await res.json().catch(() => null) as { ok?: boolean; code?: string } | null;
      if (result?.ok === true) { registeredFor = account; return 'registered'; }
      if (result?.code === 'CONNECTION_REVOKED' || result?.code === 'REVISION_CONFLICT') { revoked = true; await d.onRevoked?.(); return 'revoked'; }
      return 'failed';
    } catch { return 'failed'; }
  }
  return {
    /** Registers for the current account (once per account per run; concurrent calls share one request). */
    register(): Promise<RegisterResult> { return inflight ??= run().finally(() => { inflight = null; }); },
    /** The account changed: register again for the new one. */
    reset(): void { registeredFor = null; },
  };
}

/** Retires the on-disk identity (installation id + key); the next launch makes fresh ones. */
export async function retireInstallationIdentity(dir: string): Promise<void> {
  await rm(join(dir, 'installation.txt'), { force: true }); await rm(join(dir, 'app-key.bin'), { force: true });
}

export const installationLabel = (platform = process.platform): string =>
  `${platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux'} desktop app`;
