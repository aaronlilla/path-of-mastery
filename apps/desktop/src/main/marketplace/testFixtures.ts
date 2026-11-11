import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ApiResult } from '@pom/mastery-contracts';
import { MarketplaceStore } from './store.js';
import { PublicCache, type AssetReader } from './cache.js';
import { MarketplaceOutbox } from './outbox.js';
import { MarketplaceSync } from './sync.js';
import { PrivateMessageCache } from './privateCache.js';
import type { MarketplaceTransport, Operation } from './api.js';
import type { FaultProbe } from '../documents/blobs.js';
export * from '@pom/mastery-contracts/fixtures';
import { limits } from '@pom/mastery-contracts/fixtures';
export const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export class FixtureApi implements MarketplaceTransport {
  calls: { operation: Operation; body: unknown; account: string | null }[] = [];
  run: (operation: Operation, body: unknown, account: string | null) => Promise<ApiResult<unknown>> = async () => ({ ok: false, code: 'UNAVAILABLE', message: 'Fixture unavailable.' });
  async request<T>(operation: Operation, body: unknown, account: string | null): Promise<ApiResult<T>> {
    this.calls.push({ operation, body: structuredClone(body), account }); return await this.run(operation, body, account) as ApiResult<T>;
  }
}
export async function fresh(options: { assets?: AssetReader; probe?: FaultProbe } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'p26-store-'));
  const store = new MarketplaceStore(dir, limits, options.probe); await store.init();
  const api = new FixtureApi(), cache = new PublicCache(store, api, options.assets), outbox = new MarketplaceOutbox(store, api);
  const sync = new MarketplaceSync(store, api, outbox, cache), privateCache = new PrivateMessageCache(store, api, outbox);
  return { dir, store, api, cache, outbox, sync, privateCache, cleanup: async () => { await store.close(); await rm(dir, { recursive: true, force: true }); } };
}
export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
