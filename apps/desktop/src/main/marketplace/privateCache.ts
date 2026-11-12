import { feedbackRequestSchema, publishedRevisionRefSchema, type FeedbackRequest } from '@pom/mastery-contracts';
import { MarketplaceStore, MarketplaceLocalError, validate } from './store.js';
import type { MarketplaceTransport } from './api.js';
import { MarketplaceOutbox } from './outbox.js';

export type FeedbackDraft = { request: FeedbackRequest; allowReplies: boolean; bundleId: string | null };
export type PrivateThread = { threadId: string; role: 'runner' | 'creator'; publishedRevision: FeedbackRequest['publishedRevision'];
  allowReplies: boolean; text: string; messages: { messageId: string; role: 'runner' | 'creator'; text: string; sentAt: string }[];
  [field: string]: unknown };
export class PrivateMessageCache {
  private generation = 0;
  constructor(private readonly store: MarketplaceStore, private readonly api: MarketplaceTransport, private readonly outbox: MarketplaceOutbox) {}
  accountChanged(): void { this.generation++; }
  async saveDraft(id: string, draft: FeedbackDraft): Promise<void> {
    const request = validate(feedbackRequestSchema, draft.request, this.store.limits);
    if (request.text.length > 2000 || typeof draft.allowReplies !== 'boolean') throw new MarketplaceLocalError('INVALID', 'Invalid feedback draft.');
    const bucket = `drafts:${this.outbox.currentAccount() ?? 'local'}`;
    await this.store.serial(() => this.store.transaction(() => this.store.put(bucket, id, { ...draft, request })));
  }
  drafts(): FeedbackDraft[] { return this.store.list(`drafts:${this.outbox.currentAccount() ?? 'local'}`); }
  threads(): PrivateThread[] { const account = this.outbox.currentAccount(); return account ? this.store.list(`inbox:${account}`) : []; }
  async refresh(view: 'received' | 'sent' | 'unread' | 'resolved', threadId?: string): Promise<void> {
    const account = this.outbox.currentAccount(), generation = this.generation, session = this.outbox.sessionGeneration();
    if (!account) throw new MarketplaceLocalError('ACCOUNT_CHANGED', 'Sign in to read private messages.');
    const result = await this.api.request<{ items: PrivateThread[] }>('inbox', { view, ...(threadId ? { threadId } : {}) }, account);
    if (account !== this.outbox.currentAccount() || generation !== this.generation || session !== this.outbox.sessionGeneration()) throw new MarketplaceLocalError('ACCOUNT_CHANGED', 'The account changed while loading messages.');
    if (!result.ok) {
      if (threadId && result.code === 'UNAVAILABLE') await this.store.serial(() => this.store.transaction(() => this.store.remove(`inbox:${account}`, threadId)));
      throw new Error(result.message);
    }
    if (!Array.isArray(result.value.items) || Buffer.byteLength(JSON.stringify(result.value)) > this.store.limits.maxBytes) throw new MarketplaceLocalError('INVALID', 'Invalid private inbox response.');
    for (const item of result.value.items) {
      validate(publishedRevisionRefSchema, item.publishedRevision, this.store.limits);
      if (typeof item.threadId !== 'string' || !['runner', 'creator'].includes(item.role) || typeof item.allowReplies !== 'boolean'
        || typeof item.text !== 'string' || item.text.length > 2000 || !Array.isArray(item.messages)) throw new MarketplaceLocalError('INVALID', 'Invalid private thread.');
      if (item.messages.some(message => !message || typeof message.text !== 'string' || message.text.length > 2000 || !['creator', 'runner'].includes(message.role))) throw new MarketplaceLocalError('INVALID', 'Invalid private message.');
    }
    await this.store.serial(() => this.store.transaction(() => {
      if (account !== this.outbox.currentAccount() || generation !== this.generation || session !== this.outbox.sessionGeneration()) throw new MarketplaceLocalError('ACCOUNT_CHANGED', 'The account changed.');
      for (const item of result.value.items) this.store.put(`inbox:${account}`, item.threadId, item);
    }));
  }
}
