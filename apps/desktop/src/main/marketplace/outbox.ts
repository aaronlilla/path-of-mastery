import { randomUUID } from 'node:crypto';
import { completionReceiptSchema, feedbackRequestSchema, parseId, reportRequestSchema, triggerSchema, voteRequestSchema,
  type ApiFailure, type ApiResult, type CompletionReceipt, type PostId, type VoteRequest } from '@pom/mastery-contracts';
import { MarketplaceLocalError, MarketplaceStore, validate } from './store.js';
import type { MarketplaceTransport, Operation } from './api.js';

export type OutboxState = 'queued' | 'sending' | 'retry' | 'review' | 'unknown' | 'failed' | 'done' | 'cancelled';
export type OutboxEntry = { id: string; account: string; operation: Operation; body: unknown; state: OutboxState;
  key: string; ordinal: number; sent?: true; createdAt: string; retryAt: string | null; result: ApiResult<unknown> | null };
export type RunPreference = { countRuns: boolean; observeRuns: boolean; version: number };
export type VoteState = { direction: -1 | 0 | 1; client_sequence: number; count_at: string | null; last_accepted_at: string | null };
const safeOperations: Operation[] = ['vote', 'saves', 'collections', 'sync', 'receipt', 'run-observation', 'follow', 'creator-preference', 'run-preference'];
const reviewOperations: Operation[] = ['feedback', 'feedback-message', 'feedback-state', 'feedback-replies', 'report'];
const dependencyKeys = (entry: OutboxEntry): string[] => {
  if (entry.operation !== 'saves' && entry.operation !== 'collections') return [];
  const body = entry.body as { saveId?: unknown; collectionId?: unknown };
  return [body.saveId, body.collectionId].filter((id): id is string => typeof id === 'string');
};
const receiptTarget = (body: unknown) => JSON.stringify((body as { receipt: CompletionReceipt }).receipt.publishedRevision);
export class MarketplaceOutbox {
  private account: string | null = null;
  private epoch = 0;
  private draining: Promise<void> | null = null;
  constructor(readonly store: MarketplaceStore, private readonly api: MarketplaceTransport, private readonly now: () => Date = () => new Date()) {}
  currentAccount(): string | null { return this.account; }
  sessionGeneration(): number { return this.epoch; }
  async activate(account: string | null): Promise<void> {
    if (account !== null) parseId('object', account);
    this.account = account; this.epoch++;
    await this.store.serial(() => this.store.transaction(() => {
      for (const entry of this.store.list<OutboxEntry>('outbox')) if (entry.state === 'sending') this.store.put('outbox', entry.id, { ...entry, state: 'unknown' });
    }));
  }
  private requireAccount(): string {
    if (!this.account) throw new MarketplaceLocalError('ACCOUNT_CHANGED', 'Sign in to continue.'); return this.account;
  }
  entries(): OutboxEntry[] { return this.account ? this.store.list<OutboxEntry>('outbox').filter(entry => entry.account === this.account).sort((a, b) => a.ordinal - b.ordinal) : []; }
  preference(): RunPreference | null { return this.account ? this.store.get('preferences', this.account) : null; }
  async setPreference(preference: RunPreference): Promise<void> {
    const account = this.requireAccount();
    if (typeof preference.countRuns !== 'boolean' || typeof preference.observeRuns !== 'boolean' || !Number.isSafeInteger(preference.version) || preference.version < 0) {
      throw new MarketplaceLocalError('INVALID', 'Invalid Run counting preference.');
    }
    await this.store.serial(() => this.store.transaction(() => {
      this.store.put('preferences', account, preference);
      for (const entry of this.store.list<OutboxEntry>('outbox')) {
        if (entry.account === account && ((entry.operation === 'receipt' && !preference.countRuns) || (entry.operation === 'run-observation' && !preference.observeRuns))
          && !['done', 'cancelled'].includes(entry.state)) this.store.put('outbox', entry.id, { ...entry, state: 'cancelled' });
      }
    }));
  }
  async refreshPreference(): Promise<void> {
    const account = this.requireAccount(), epoch = this.epoch;
    const result = await this.api.request<RunPreference>('run-preference', { action: 'read' }, account);
    if (this.account !== account || this.epoch !== epoch) throw new MarketplaceLocalError('ACCOUNT_CHANGED', 'The account changed.');
    if (!result.ok) throw new Error(result.message); await this.setPreference(result.value);
  }
  private insert(account: string, operation: Operation, body: unknown, key: string, state: OutboxState): OutboxEntry {
    if (!key || key.length > 128 || Buffer.byteLength(JSON.stringify(body)) > this.store.limits.maxBytes) throw new MarketplaceLocalError('INVALID', 'Invalid queued request.');
    const prior = this.store.list<OutboxEntry>('outbox').find(entry => entry.account === account && entry.operation === operation && entry.key === key);
    if (prior) {
      if (JSON.stringify(prior.body) !== JSON.stringify(body)) throw new MarketplaceLocalError('CONFLICT', 'The queued request changed.'); return prior;
    }
    const ordinal = (this.store.get<number>('outbox-sequences', account) ?? 0) + 1;
    if (!Number.isSafeInteger(ordinal)) throw new MarketplaceLocalError('INVALID', 'Request sequence is exhausted.');
    this.store.put('outbox-sequences', account, ordinal);
    const entry: OutboxEntry = { id: randomUUID(), account, operation, body: structuredClone(body), key, state, ordinal,
      createdAt: this.now().toISOString(), retryAt: null, result: null };
    this.store.put('outbox', entry.id, entry); return entry;
  }
  async enqueue(operation: Operation, body: unknown, key: string): Promise<OutboxEntry> {
    if (!safeOperations.includes(operation) || ['vote', 'receipt', 'run-observation'].includes(operation)) throw new MarketplaceLocalError('INVALID', 'Use the typed queue operation.');
    const account = this.requireAccount();
    return this.store.serial(() => this.store.transaction(() => this.insert(account, operation, body, key, 'queued')));
  }
  async vote(postId: PostId, direction: VoteRequest['direction']): Promise<OutboxEntry> {
    const account = this.requireAccount(); parseId('post', postId);
    const request = validate(voteRequestSchema, { postId, direction, idempotencyKey: randomUUID() }, this.store.limits);
    return this.store.serial(() => this.store.transaction(() => {
      const sequenceKey = `${account}:${postId}`, previous = this.store.get<number>('vote-sequences', sequenceKey) ?? 0;
      if (!Number.isSafeInteger(previous + 1)) throw new MarketplaceLocalError('INVALID', 'Vote sequence is exhausted.');
      for (const entry of this.store.list<OutboxEntry>('outbox')) {
        if (entry.account === account && entry.operation === 'vote' && ['queued', 'retry'].includes(entry.state)
          && (entry.body as { request: VoteRequest }).request.postId === postId) this.store.put('outbox', entry.id, { ...entry, state: 'cancelled' });
      }
      this.store.put('vote-sequences', sequenceKey, previous + 1);
      return this.insert(account, 'vote', { request, clientSequence: previous + 1 }, request.idempotencyKey, 'queued');
    }));
  }
  async refreshVote(postId: PostId): Promise<VoteState | null> {
    const account = this.requireAccount(), epoch = this.epoch;
    const result = await this.api.request<VoteState | null>('vote-state', { postId }, account);
    if (this.account !== account || this.epoch !== epoch) throw new MarketplaceLocalError('ACCOUNT_CHANGED', 'The account changed.');
    if (!result.ok) throw new Error(result.message);
    const state = result.value;
    if (state && (![-1, 0, 1].includes(state.direction) || !Number.isSafeInteger(state.client_sequence) || state.client_sequence < 0)) throw new MarketplaceLocalError('INVALID', 'Invalid vote state.');
    await this.store.serial(() => this.store.transaction(() => {
      const key = `${account}:${postId}`;
      this.store.put('vote-sequences', key, Math.max(this.store.get<number>('vote-sequences', key) ?? 0, state?.client_sequence ?? 0));
      this.store.put('vote-state', key, state);
    })); return state;
  }
  votePresentation(postId: PostId): { accepted: VoteState | null; intended: VoteRequest['direction'] | null; pending: boolean; error: ApiFailure | null } {
    const account = this.requireAccount();
    const entries = this.entries().filter(entry => entry.operation === 'vote' && entry.state !== 'cancelled' && (entry.body as { request: VoteRequest }).request.postId === postId)
      .sort((a, b) => (b.body as { clientSequence: number }).clientSequence - (a.body as { clientSequence: number }).clientSequence);
    const latest = entries[0]; const active = latest && !['done', 'failed', 'unknown'].includes(latest.state);
    return { accepted: this.store.get('vote-state', `${account}:${postId}`), intended: active ? (latest.body as { request: VoteRequest }).request.direction : null,
      pending: !!active, error: latest?.result && !latest.result.ok ? latest.result : null };
  }
  async receipt(input: CompletionReceipt, bindingAtFinish: string | null, evidence?: unknown): Promise<OutboxEntry | null> {
    // A signed-out finish is never enrolled later by account activation.
    if (!bindingAtFinish || bindingAtFinish !== this.account) return null;
    const receipt = validate(completionReceiptSchema, input, this.store.limits);
    const preference = this.preference(); if (!preference?.countRuns) return null;
    if (receipt.method === 'player_confirmed' && evidence !== undefined) throw new MarketplaceLocalError('INVALID', 'Player confirmation does not include automatic evidence.');
    if (receipt.method === 'final_trigger_observed') {
      const record = evidence as { origin?: unknown; context?: unknown; observations?: unknown } | undefined;
      if (!record || record.origin !== 'live' || record.context !== 'continuous' || !Array.isArray(record.observations)
        || Object.keys(record).some(key => !['origin', 'context', 'observations'].includes(key))) throw new MarketplaceLocalError('INVALID', 'Continuous final-trigger evidence is required.');
      if (!record.observations.length || record.observations.length > this.store.limits.maxArrayLength) throw new MarketplaceLocalError('INVALID', 'Final-trigger observations are required.');
      const checked: { trigger: unknown; observedAt: string }[] = [];
      for (const observation of record.observations) {
        if (!observation || typeof observation !== 'object' || Object.keys(observation).some(key => !['trigger', 'observedAt'].includes(key))) throw new MarketplaceLocalError('INVALID', 'Only minimal trigger observations may leave this PC.');
        const trigger = validate(triggerSchema, (observation as { trigger: unknown }).trigger, this.store.limits);
        const observedAt = (observation as { observedAt?: unknown }).observedAt;
        if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt)) || !observedAt.endsWith('Z')) throw new MarketplaceLocalError('INVALID', 'Invalid observation time.');
        checked.push({ trigger, observedAt });
      }
      if (JSON.stringify(checked[checked.length - 1]!.trigger) !== JSON.stringify(validate(triggerSchema, receipt.finalTrigger, this.store.limits))) {
        throw new MarketplaceLocalError('INVALID', 'The last observation must be the receipt final trigger.');
      }
      evidence = { origin: 'live', context: 'continuous', observations: checked };
    }
    const body = { receipt, preferenceVersion: preference.version, ...(evidence === undefined ? {} : { evidence }) };
    return this.store.serial(() => this.store.transaction(() => {
      const duplicate = this.store.list<OutboxEntry>('outbox').find(entry => entry.account === bindingAtFinish && entry.operation === 'receipt'
        && !['failed', 'cancelled'].includes(entry.state) && receiptTarget(entry.body) === receiptTarget(body));
      return duplicate ?? this.insert(bindingAtFinish, 'receipt', body, receipt.idempotencyKey, 'queued');
    }));
  }
  async draft(operation: Operation, body: unknown, key: string): Promise<OutboxEntry> {
    if (!reviewOperations.includes(operation)) throw new MarketplaceLocalError('INVALID', 'This operation has no reviewed draft.');
    if (operation === 'feedback') validate(feedbackRequestSchema, (body as { request: unknown }).request, this.store.limits);
    if (operation === 'report') validate(reportRequestSchema, (body as { request: unknown }).request, this.store.limits);
    const account = this.requireAccount(); return this.store.serial(() => this.store.transaction(() => this.insert(account, operation, body, key, 'review')));
  }
  async confirm(id: string): Promise<void> {
    const account = this.requireAccount();
    await this.store.serial(() => this.store.transaction(() => {
      const entry = this.store.get<OutboxEntry>('outbox', id);
      if (!entry || entry.account !== account || !['review', 'retry', 'failed'].includes(entry.state)) throw new MarketplaceLocalError('INVALID', 'This request cannot be retried.');
      const latestVote = entry.operation === 'vote' && this.entries().some(other => other.operation === 'vote' && other.state !== 'cancelled'
        && (other.body as { request: VoteRequest }).request.postId === (entry.body as { request: VoteRequest }).request.postId
        && (other.body as { clientSequence: number }).clientSequence > (entry.body as { clientSequence: number }).clientSequence);
      if (latestVote) throw new MarketplaceLocalError('CONFLICT', 'A newer vote replaced this intent.');
      this.store.put('outbox', id, { ...entry, state: 'queued', result: null });
    }));
  }
  async cancel(id: string): Promise<void> {
    const account = this.requireAccount();
    await this.store.serial(() => this.store.transaction(() => { const entry = this.store.get<OutboxEntry>('outbox', id);
      if (!entry || entry.account !== account) throw new MarketplaceLocalError('ACCOUNT_CHANGED', 'This request belongs to another account.');
      if (entry.state === 'sending') throw new MarketplaceLocalError('CONFLICT', 'This request is already in flight.');
      this.store.put('outbox', id, { ...entry, state: 'cancelled' }); }));
  }
  drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.flush().finally(() => { this.draining = null; }); return this.draining;
  }
  private async flush(): Promise<void> {
    const account = this.account, epoch = this.epoch; if (!account) return;
    for (;;) {
      if (this.account !== account || epoch !== this.epoch) return;
      const all = this.entries();
      const entry = all.find(item => item.state === 'queued' && (!item.retryAt || Date.parse(item.retryAt) <= this.now().getTime()) && !this.blocked(item, all));
      if (!entry) return;
      const preference = this.preference();
      if ((entry.operation === 'receipt' || entry.operation === 'run-observation') && (!preference ||
        (entry.body as { preferenceVersion: number }).preferenceVersion !== preference.version ||
        (entry.operation === 'receipt' ? !preference.countRuns : !preference.observeRuns))) { await this.cancel(entry.id); continue; }
      // First send only: a write queued behind an earlier one for the same Save/Collection takes the version that one was accepted at.
      // After that the body is frozen, so a retry or replay repeats the identical request (same idempotency key).
      const sending = await this.store.serial(() => this.store.transaction(() => {
        const fresh = this.store.get<OutboxEntry>('outbox', entry.id)!;
        let body = fresh.body;
        const b = body as { action?: string; saveId?: string; collectionId?: string; expectedRowVersion?: number };
        if (!fresh.sent && ['saves', 'collections'].includes(fresh.operation) && b.action === 'write' && typeof b.expectedRowVersion === 'number') {
          const known = this.store.get<number>('cloud-versions', `${account}:${b.saveId ?? b.collectionId}`);
          if (typeof known === 'number' && known > b.expectedRowVersion) body = { ...b, expectedRowVersion: known };
        }
        const next: OutboxEntry = { ...fresh, body, state: 'sending', sent: true };
        this.store.put('outbox', entry.id, next); return next;
      }));
      let result: ApiResult<unknown>;
      try { result = await this.api.request(sending.operation, sending.body, account); }
      catch {
        await this.store.serial(() => this.store.transaction(() => {
          const current = this.store.get<OutboxEntry>('outbox', entry.id)!;
          if (current.state === 'sending') this.store.put('outbox', entry.id, { ...current, state: 'unknown' });
        })); return;
      }
      const state: OutboxState = result.ok ? 'done' : result.code === 'HUMAN_CHECK_REQUIRED' ? 'review'
        : result.code === 'RATE_LIMITED' ? 'retry' : ['REVISION_CONFLICT', 'ENTITLEMENT_UNAVAILABLE'].includes(result.code) ? 'unknown' : 'failed';
      await this.store.serial(() => this.store.transaction(() => {
        const current = this.store.get<OutboxEntry>('outbox', entry.id)!;
        if (current.state === 'cancelled') return;
        this.store.put('outbox', entry.id, { ...current, state, result, retryAt: !result.ok ? result.retryAt ?? null : null });
        if (result.ok && ['saves', 'collections'].includes(entry.operation)) {
          const body = entry.body as { saveId?: string; collectionId?: string; action: string };
          const version = (result.value as { rowVersion?: number } | null)?.rowVersion;
          if (body.action === 'write' && typeof version === 'number' && Number.isSafeInteger(version) && version > 0) {
            this.store.put('cloud-versions', `${account}:${body.saveId ?? body.collectionId}`, version);
          }
        }
      }));
      if (this.account !== account || epoch !== this.epoch) return;
      if (entry.operation === 'vote' && result.ok) await this.refreshVote((entry.body as { request: VoteRequest }).request.postId);
    }
  }
  /** A dependent mutation (same Save or Collection) never overtakes an earlier one that is not finished. */
  private blocked(entry: OutboxEntry, all: OutboxEntry[]): boolean {
    const mine = dependencyKeys(entry); if (!mine.length) return false;
    return all.some(other => other.ordinal < entry.ordinal && !['done', 'cancelled'].includes(other.state)
      && dependencyKeys(other).some(key => mine.includes(key)));
  }
  async reconcile(id: string): Promise<OutboxState> {
    const account = this.requireAccount(), epoch = this.epoch, entry = this.entries().find(item => item.id === id);
    if (!entry || entry.state !== 'unknown') throw new MarketplaceLocalError('INVALID', 'This request has no unknown outcome.');
    let matched = false;
    if (entry.operation === 'vote') {
      const body = entry.body as { request: VoteRequest; clientSequence: number }, state = await this.refreshVote(body.request.postId);
      matched = !!state && state.client_sequence >= body.clientSequence;
    } else if (entry.operation === 'saves') {
      const body = entry.body as { saveId: string; publishedRevision: unknown; action: string };
      const result = await this.api.request<{ items: { objectId: string; selectedRevision: unknown; rowVersion: number }[] }>('saves', { action: 'read' }, account);
      if (result.ok && Array.isArray(result.value.items)) {
        const row = result.value.items.find(item => item.objectId === body.saveId);
        matched = body.action === 'remove' ? !row : !!row && JSON.stringify(row.selectedRevision) === JSON.stringify(body.publishedRevision);
        if (matched && row) await this.store.serial(() => this.store.transaction(() => this.store.put('cloud-versions', `${account}:${row.objectId}`, row.rowVersion)));
      }
    }
    if (this.account !== account || this.epoch !== epoch) throw new MarketplaceLocalError('ACCOUNT_CHANGED', 'The account changed.');
    if (matched) await this.store.serial(() => this.store.transaction(() => this.store.put('outbox', id, { ...entry, state: 'done' })));
    return matched ? 'done' : 'unknown';
  }
}
