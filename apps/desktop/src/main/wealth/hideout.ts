/**
 * "Travel to Hideout" for a listing, the same request the trade site's button sends (see HttpTrade.travel).
 * The game client must be running and logged in for the travel to happen; the site's own answer says when it is not.
 *
 * Fallback: when the listing has no hideout token, or the request fails, the listing's whisper is copied instead.
 * Nothing is retried; GGG restricts clients that send many requests after a 4xx.
 */
import type { TradeListing, TravelResult } from '../../shared/wealthTrade.js';
import type { TradeApi } from './trade.js';

export interface TravelDeps {
  api: TradeApi;
  now: () => number;
  /** Puts text on the clipboard. */
  copy: (text: string) => void;
}

/** The exp claim (epoch seconds) of the site's token, or null when it cannot be read. */
export function tokenExpiry(token: string): number | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const exp = (JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp : null;
  } catch {
    return null;
  }
}

export async function travelToHideout(d: TravelDeps, listing: TradeListing, cont = false): Promise<TravelResult> {
  const who = listing.seller || 'the seller';
  const fallback = (why: string): TravelResult => {
    if (listing.whisper) {
      d.copy(listing.whisper);
      return { ok: false, copied: true, text: `${why} Whisper copied. Paste it in the game.` };
    }
    return { ok: false, text: why };
  };
  if (!listing.hideoutToken || !d.api.travel) return fallback('This listing has no hideout travel.');

  let token = listing.hideoutToken;
  const exp = tokenExpiry(token);
  if (exp !== null && exp * 1000 <= d.now() + 3000) {
    // The token ran out while the alert sat there: fetch the listing again for a new one (one request, no loop).
    let fresh: string | undefined;
    if (listing.queryId) {
      try {
        fresh = (await d.api.fetch([listing.id], listing.queryId)).find((r) => r.id === listing.id)?.listing?.hideout_token;
      } catch {
        fresh = undefined;
      }
    }
    if (!fresh) return fallback('The hideout link expired and the listing could not be refreshed.');
    token = fresh;
  }

  const r = await d.api.travel(token, cont);
  switch (r.kind) {
    case 'ok':
      return { ok: true, text: `Travelling to ${who}'s hideout.` };
    case 'in-demand':
      return { ok: false, inDemand: true, text: 'Item is in demand. Click again to teleport anyway.' };
    case 'rate-limited':
      return fallback(`The trade site asked us to wait ${r.sec} seconds.`);
    case 'down':
      return fallback(r.message);
    case 'refused':
      // Code 1 is what the site's own page treats as "token no longer valid".
      return fallback(r.code === 1 ? 'The hideout link expired or the seller is gone.' : r.status === 401 || r.status === 403 ? `The trade site refused (${r.message}). Check the account connection.` : r.message);
  }
}
