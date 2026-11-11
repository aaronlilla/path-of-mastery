import { feedRequestSchema, publicItemPayloadSchema, resolvePublicItemRequestSchema, type ApiResult,
  type FeedRequest, type PublicItemPayload, type ResolvePublicItemRequest } from '@pom/mastery-contracts';
import { hashBytes } from '../documents/blobs.js';
import type { MarketplaceTransport } from './api.js';
import { MarketplaceStore, MarketplaceLocalError, validate } from './store.js';
export type CachedRead<T> = { result: ApiResult<T>; cachedAt: string | null; offline: boolean; failure?: import('@pom/mastery-contracts').ApiFailure };
export type FeedQuery = { query: FeedRequest; limit?: number; creatorId?: string; following?: boolean; verifiedOnly?: boolean; skills?: string[]; lanes?: string[];
  budgets?: string[]; tags?: string[]; hasVideo?: boolean; classes?: string[]; mechanics?: string[] };
type FeedPage = { items: PublicItemPayload[]; nextCursor: string | null; [field: string]: unknown };
export class MarketplaceReads {
  constructor(private readonly store: MarketplaceStore, private readonly api: MarketplaceTransport,
    private readonly account: () => string | null, private readonly now: () => Date = () => new Date()) {}
  private async read<T>(operation: 'item' | 'feed' | 'count' | 'profile', body: unknown, account: string | null,
    parse: (value: unknown) => T, cacheOnly: boolean): Promise<CachedRead<T>> {
    const key = hashBytes(JSON.stringify({ operation, body, account }));
    const bucket = account ? `reads:${account}` : 'public-reads';
    const cached = this.store.get<{ value: T; cachedAt: string }>(bucket, key);
    const offline = (): CachedRead<T> => cached ? { result: { ok: true, value: cached.value }, cachedAt: cached.cachedAt, offline: true }
      : { result: { ok: false, code: 'UNAVAILABLE', message: 'Connect to download this content.' }, cachedAt: null, offline: true };
    if (cacheOnly) return offline();
    let result: ApiResult<unknown>;
    try { result = await this.api.request(operation, body, account); }
    catch (error) {
      if (account && this.account() !== account) throw new MarketplaceLocalError('ACCOUNT_CHANGED', 'The account changed.');
      if (error instanceof MarketplaceLocalError) throw error;
      return offline();
    }
    if (account && this.account() !== account) throw new MarketplaceLocalError('ACCOUNT_CHANGED', 'The account changed.');
    if (!result.ok) {
      if (operation === 'item' && result.code === 'UNAVAILABLE') {
        await this.store.serial(() => this.store.transaction(() => this.store.remove(bucket, key)));
        return { result, cachedAt: null, offline: false };
      }
      return cached ? { ...offline(), failure: result } : { result, cachedAt: null, offline: false };
    }
    const value = parse(result.value), cachedAt = this.now().toISOString();
    await this.store.serial(() => this.store.transaction(() => this.store.put(bucket, key, { value, cachedAt })));
    return { result: { ok: true, value }, cachedAt, offline: false };
  }
  item(input: ResolvePublicItemRequest, cacheOnly = false): Promise<CachedRead<PublicItemPayload>> {
    const body = validate(resolvePublicItemRequestSchema, input, this.store.limits);
    // Signed in, the read names the viewer so its votes carry the viewer's own vote (myVote) with the count.
    return this.read('item', body, this.account(), value => {
      const item = validate(publicItemPayloadSchema, value, this.store.limits);
      if (item.publicId !== body.publicId || body.revision !== undefined && item.publishedRevision.displayRevision !== body.revision) throw new MarketplaceLocalError('INVALID', 'Public item identity does not match its request.');
      return item;
    }, cacheOnly);
  }
  private query(input: FeedQuery): FeedQuery {
    const query = validate(feedRequestSchema, input.query, this.store.limits);
    if (Object.keys(input).some(key => !['query', 'limit', 'creatorId', 'following', 'verifiedOnly', 'skills', 'lanes', 'budgets', 'tags', 'hasVideo', 'classes', 'mechanics'].includes(key))) throw new MarketplaceLocalError('INVALID', 'Unsupported feed filter.');
    return { ...input, query };
  }
  feed(input: FeedQuery, cacheOnly = false): Promise<CachedRead<FeedPage>> {
    const body = this.query(input), account = this.account(); // signed in: votes carry the viewer's own vote (myVote)
    if (body.following && !account) throw new MarketplaceLocalError('ACCOUNT_CHANGED', 'Sign in to view Following.');
    return this.read('feed', body, account, value => {
      const page = value as FeedPage;
      if (!page || !Array.isArray(page.items) || page.items.length > this.store.limits.maxArrayLength
        || page.nextCursor !== null && typeof page.nextCursor !== 'string') throw new MarketplaceLocalError('INVALID', 'Invalid feed page.');
      return { ...page, items: page.items.map(item => validate(publicItemPayloadSchema, item, this.store.limits)) };
    }, cacheOnly);
  }
  count(input: FeedQuery, cacheOnly = false): Promise<CachedRead<{ total: number; timeBasis: string }>> {
    const body = this.query(input), account = body.following ? this.account() : null;
    if (body.following && !account) throw new MarketplaceLocalError('ACCOUNT_CHANGED', 'Sign in to view Following.');
    return this.read('count', body, account, value => {
      const result = value as { total: number; timeBasis: string };
      if (!result || !Number.isSafeInteger(result.total) || result.total < 0 || !Number.isFinite(Date.parse(result.timeBasis))) throw new MarketplaceLocalError('INVALID', 'Invalid feed count.'); return result;
    }, cacheOnly);
  }
}
