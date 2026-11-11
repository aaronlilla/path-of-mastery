import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AccountUser } from '../../shared/accounts.js';
import type { SecureStorage } from '../secureStorage.js';

export interface StoredSession {
  refreshToken: string;
  user: AccountUser;
}

export interface PendingSignIn {
  verifier: string;
  kind: 'email' | 'oauth';
  provider?: string;
  email?: string;
  startedAt: number;
}

/**
 * Keeps the refresh token (and the sign-in verifier that is waiting for its link) on disk, encrypted with the
 * operating system's key store through Electron's safeStorage. With no key store the session lives in memory only and
 * the player signs in again next launch; a token is never written to a plain file and never logged.
 */
export class SessionStore {
  private memSession: StoredSession | null = null;
  private memPending: PendingSignIn | null = null;

  constructor(
    private readonly dir: string,
    private readonly secure: SecureStorage,
  ) {}

  /** True when the session survives a restart. */
  get persistent(): boolean {
    return this.secure.isAvailable();
  }

  private file(name: string): string {
    return join(this.dir, name);
  }

  private async writeSecret(name: string, value: unknown): Promise<void> {
    const path = this.file(name);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, this.secure.encrypt(JSON.stringify(value)));
    await rename(tmp, path);
  }

  private async readSecret<T>(name: string): Promise<T | null> {
    if (!this.secure.isAvailable()) return null;
    try {
      const buf = await readFile(this.file(name));
      return JSON.parse(this.secure.decrypt(buf)) as T;
    } catch {
      return null;
    }
  }

  async saveSession(s: StoredSession): Promise<void> {
    this.memSession = s;
    if (this.secure.isAvailable()) await this.writeSecret('session.bin', s);
  }

  async loadSession(): Promise<StoredSession | null> {
    if (this.memSession) return this.memSession;
    const s = await this.readSecret<StoredSession>('session.bin');
    if (s && typeof s.refreshToken === 'string' && s.user && typeof s.user.id === 'string') {
      this.memSession = s;
      return s;
    }
    return null;
  }

  async clearSession(): Promise<void> {
    this.memSession = null;
    await rm(this.file('session.bin'), { force: true });
  }

  async savePending(p: PendingSignIn): Promise<void> {
    this.memPending = p;
    if (this.secure.isAvailable()) await this.writeSecret('pending.bin', p);
  }

  async takePending(): Promise<PendingSignIn | null> {
    const p = this.memPending ?? (await this.readSecret<PendingSignIn>('pending.bin'));
    this.memPending = null;
    await rm(this.file('pending.bin'), { force: true });
    return p;
  }

  async peekPending(): Promise<PendingSignIn | null> {
    return this.memPending ?? (await this.readSecret<PendingSignIn>('pending.bin'));
  }
}
