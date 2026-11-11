/**
 * Dev switch (POM_TRADER_REPLAY=<folder>): the Trader answers from responses recorded from the public trade site instead
 * of calling it, so every step (search, fetch, saved search, currency rates) can be walked without a session cookie or the
 * network. The folder holds search.json, fetch.json, static.json and cx.json as recorded.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawListing } from './trade.js';
import type { TraderTradeApi } from './traderService.js';

export class ReplayTradeApi implements TraderTradeApi {
  private readonly search_: { id: string; total?: number; result: string[] };
  private readonly fetch_: { result: RawListing[] };

  constructor(private readonly dir: string) {
    this.search_ = JSON.parse(readFileSync(join(dir, 'search.json'), 'utf8')) as ReplayTradeApi['search_'];
    this.fetch_ = JSON.parse(readFileSync(join(dir, 'fetch.json'), 'utf8')) as ReplayTradeApi['fetch_'];
  }

  async search(_league: string, _query: unknown): Promise<{ id: string; total: number; ids: string[] }> {
    // 23 results: three pages, so paging is visible.
    const ids = Array.from({ length: 23 }, (_, i) => `replay${i}`);
    return { id: this.search_.id, total: ids.length, ids };
  }

  async fetch(ids: string[]): Promise<RawListing[]> {
    return ids.map((id, i) => {
      const src = this.fetch_.result[i % this.fetch_.result.length]!;
      const n = Number(id.replace(/\D/g, '')) || 0;
      return { ...src, id, listing: { ...src.listing, price: { type: i % 3 === 0 ? '~price' : '~b/o', amount: 1 + n, currency: n % 4 === 0 ? 'divine' : 'chaos' } } };
    });
  }

  async savedQuery(): Promise<{ query: Record<string, unknown>; sort: Record<string, string> }> {
    return { query: { status: { option: 'online' }, stats: [{ type: 'and', filters: [] }] }, sort: { price: 'asc' } };
  }

  /** The recorded static data and currency exchange, in place of the two public requests. */
  fetchFn = (async (url: string | URL | Request) => {
    const u = String(url);
    const file = u.includes('/trade/data/static') ? 'static.json' : 'cx.json';
    const body = readFileSync(join(this.dir, file), 'utf8');
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
