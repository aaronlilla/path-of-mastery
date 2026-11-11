import type { PairedClient, RevisionRef } from '@pom/mastery-contracts';
import { AiDenied, type AiAccess, type AiActor, type AiScope, type AiStatus } from './gate.js';

/**
 * AI access in a build without the hosted backend: nothing is checked with a server. The panel's own assistant may work
 * on a build as long as the stored revision is still the one it was started on. There is no hosted model, and outside
 * clients cannot pair (pairing is recorded by the hosted service).
 */
export class LocalAiAccess implements AiAccess {
  readonly state: AiStatus = { status: 'ready' };
  constructor(private readonly current: (target: RevisionRef) => Promise<boolean>) {}
  private async still(target: RevisionRef): Promise<void> {
    if (!(await this.current(target))) throw new AiDenied('REVISION_CONFLICT');
  }
  verify(_actor: AiActor, target: RevisionRef): Promise<void> { return this.still(target); }
  check(_actor: AiActor, target: RevisionRef): Promise<void> { return this.still(target); }
  async run<T>(_actor: AiActor, _scope: AiScope, target: RevisionRef, _input: unknown, operation: () => Promise<T>): Promise<T> {
    await this.still(target);
    const value = await operation();
    await this.still(target);
    return value;
  }
  model(): Promise<unknown> { return Promise.resolve(null); }
  pair(): Promise<PairedClient | { status: 'pending'; expiresAt: string }> { return Promise.reject(new AiDenied('AI_ACCESS_REQUIRED')); }
  revoke(): Promise<void> { return Promise.resolve(); }
  invalidate(): void {}
  reset(): void {}
  onChange(): () => void { return () => undefined; }
}
