/** What the Trader asks the main process for: the trade site's searches, read with the player's cookie when there is one. */
import type { CurrencyRates } from './tradeRates.js';

export interface TraderListing {
  id: string;
  /** "~b/o" is an instant buyout, "~price" a listing the seller has to answer. */
  priceType: string;
  amount: number | null;
  currency: string | null;
  whisper: string;
  account: string;
  online: boolean;
  indexed: string;
  /** The item as the game copies it (upstream reads this). */
  text: string;
}

export type TraderFailure = { ok: false; kind: 'rate-limited' | 'expired' | 'bad-query' | 'down' | 'bad-url'; message: string; retryAfterSec?: number };

export type TraderSearch =
  | {
      ok: true;
      queryId: string;
      total: number;
      listings: TraderListing[];
      /** The query as it was sent (a pasted link's search with its sort changed), for the exact search of one result. */
      query: unknown;
    }
  | TraderFailure;

export interface TraderSearchInput {
  realm: string;
  league: string;
  query: unknown;
  /** Pages of 10 results to read, 1 to 10. */
  pages: number;
}

export interface TraderUrlInput {
  url: string;
  pages: number;
}

export interface TraderApi {
  /** Whether a session cookie is saved (Wealth keeps it). Searches work without one at the public site's lower limits. */
  auth(): Promise<{ authenticated: boolean }>;
  search(i: TraderSearchInput): Promise<TraderSearch>;
  /** The search behind a pasted trade link, sorted the way upstream sorts it. */
  fromUrl(i: TraderUrlInput): Promise<TraderSearch>;
  /** What each currency is worth in divine orbs, per league; null when the exchange could not be read. */
  rates(realm: string): Promise<{ ok: true; rates: CurrencyRates } | { ok: false; message: string }>;
}
