import { apiFailureSchema, type ApiResult, type ValidationLimits } from '@pom/mastery-contracts';
import { MarketplaceLocalError, validate } from './store.js';

export type Operation = 'item' | 'feed' | 'count' | 'profile' | 'sync' | 'saves' | 'collections' | 'vote' | 'vote-state'
  | 'receipt' | 'run-preference' | 'run-observation' | 'follow' | 'follows' | 'creator-preference' | 'feedback' | 'inbox'
  | 'feedback-message' | 'feedback-state' | 'feedback-replies' | 'report' | 'report-status' | 'posts' | 'analytics'
  // Publication routes; `review` carries its own body.operation.
  | 'publish' | 'publication-status' | 'review';
export interface MarketplaceTransport { request<T>(operation: Operation, body: unknown, account: string | null): Promise<ApiResult<T>> }
export type AccountSession = { accountId: string; accessToken: string };
export class MarketplaceApi implements MarketplaceTransport {
  private readonly origin: string;
  constructor(origin: string, private readonly session: () => AccountSession | null, private readonly limits: ValidationLimits,
    private readonly fetcher: typeof fetch = fetch,
    private readonly admissionHeaders: (operation: Operation, body: unknown, account: string | null) => Promise<Record<string, string>> = async () => ({})) {
    const url = new URL(origin);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
      throw new MarketplaceLocalError('INVALID', 'Marketplace requires HTTPS or a loopback test server.');
    }
    this.origin = url.origin;
  }
  async request<T>(operation: Operation, body: unknown, account: string | null): Promise<ApiResult<T>> {
    const session = account === null ? null : this.session();
    if (account !== null && session?.accountId !== account) throw new MarketplaceLocalError('ACCOUNT_CHANGED', 'Sign in to the original account.');
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > this.limits.maxBytes) throw new MarketplaceLocalError('INVALID', 'Marketplace request is too large.');
    const proof = await this.admissionHeaders(operation, body, account);
    if (account !== null && this.session()?.accountId !== account) throw new MarketplaceLocalError('ACCOUNT_CHANGED', 'The account changed before the request.');
    const response = await this.fetcher(`${this.origin}/api/marketplace/${operation}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { ...proof, 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session.accessToken}` } : {}) }, body: encoded,
    });
    if (account !== null && this.session()?.accountId !== account) throw new MarketplaceLocalError('ACCOUNT_CHANGED', 'The account changed during the request.');
    if (!response.body) throw new Error('Marketplace returned an empty response.');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
        if (size > this.limits.maxBytes) throw new Error('Marketplace response is too large.'); chunks.push(part.value); }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || !('ok' in result)) throw new Error('Marketplace returned an invalid response.');
    if (result.ok === false) return validate(apiFailureSchema, result, this.limits);
    if (result.ok !== true || !('value' in result) || !response.ok) throw new Error('Marketplace returned an invalid result.');
    return { ok: true, value: result.value as T };
  }
}
