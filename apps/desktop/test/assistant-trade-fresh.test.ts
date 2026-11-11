import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wealthTradeSource } from '../src/main/assistant/wealthTrade.js';
import { TOOLS } from '../src/main/assistant/tools.js';
import { isFreshListing } from '../src/shared/wealthTrade.js';
import { tradeIdLink } from '../src/main/wealth/trade.js';
import { checkedPlain } from '../src/shared/assistant/refs.js';

// Regression: the answer offered a ring listed 62 days ago by an offline seller, with no trade link.
const NOW = Date.now();
const iso = (ageMin: number) => new Date(NOW - ageMin * 60000).toISOString();
const listing = (id: string, ageMin: number, online: boolean) => ({
  id, indexed: iso(ageMin), price: { amount: 1, currency: 'chaos' }, chaos: 1, seller: 's', online, whisper: '',
  item: { name: 'Victory Coil', typeLine: 'Ruby Ring', baseType: 'Ruby Ring', frameType: 3, ilvl: 79, explicitMods: ['+96 to maximum Life'] },
});
const LINK = 'https://www.pathofexile.com/trade/search/Mirage/abc123';

function fakeWealth(listings: ReturnType<typeof listing>[]) {
  const seen: { body?: any } = {};
  const w = {
    whenReady: async () => undefined,
    book: { divine: 400 },
    premium: {
      async search(body: unknown) {
        seen.body = body;
        return { ok: true, outcome: { queryId: 'abc123', total: listings.length, at: NOW, cached: false, link: LINK, listings } };
      },
    },
  };
  return { w: w as never, seen };
}

test('trade search asks the site for online sellers listed within a week, and drops stale or offline listings', async () => {
  const { w, seen } = fakeWealth([listing('fresh', 90, true), listing('old', 62 * 24 * 60, false), listing('offline', 30, false), listing('stale-online', 20 * 24 * 60, true)]);
  const r = await wealthTradeSource(w).search({ type: 'Ruby Ring', category: 'accessory.ring' });
  assert.ok(r.ok);
  assert.equal(seen.body.query.status.option, 'online');
  assert.equal(seen.body.query.filters.trade_filters.filters.indexed.option, '1week');
  assert.equal(seen.body.query.filters.type_filters.filters.category.option, 'accessory.ring');
  assert.deepEqual(r.ok && r.listings.map((l) => [l.ageMinutes, l.online]), [[90, true]]);
  assert.equal(r.ok && r.link, LINK);
});

test('isFreshListing: online and within a week only', () => {
  assert.equal(isFreshListing({ online: true, indexed: iso(60) }, NOW), true);
  assert.equal(isFreshListing({ online: false, indexed: iso(60) }, NOW), false);
  assert.equal(isFreshListing({ online: true, indexed: iso(62 * 24 * 60) }, NOW), false);
  assert.equal(isFreshListing({ online: true, indexed: 'nonsense' }, NOW), false);
});

test('the saved-search link is short and a placeholder can show it', () => {
  assert.equal(tradeIdLink('Mirage', 'abc123'), LINK);
  assert.equal(tradeIdLink('Settlers of Kalguur', 'Zx9'), 'https://www.pathofexile.com/trade/search/Settlers+of+Kalguur/Zx9');
  const out = { link: LINK, candidates: [{ ageMinutes: 90, online: true }] };
  assert.equal(checkedPlain('Open it here: {{r1:link}} (listed {{r1:candidates[0].ageMinutes}} minutes ago)', { r1: { tool: 'upgradeCandidates', data: out } }), `Open it here: ${LINK} (listed 90 minutes ago)`);
});

test('upgradeCandidates returns the trade-site link', async () => {
  const trade = {
    async search() { return { ok: false as const, kind: 'x', message: 'x' }; },
    async upgrades() {
      return { ok: true as const, slot: 'Ring 1', equipped: 'Old Ring', rankStat: 'FullDPS', rankNow: 100, total: 1, checked: 1, rule: 'Ring 1: cheapest first', link: LINK, chaosPerDivine: 400, candidates: [] };
    },
  };
  const ctx = { trade, engine: { send: async () => ({ buildXml: '<x/>' }) }, open: () => ({ buildId: 'b', name: 'n', buildKey: 'k' }) } as never;
  const out = (await TOOLS.find((t) => t.name === 'upgradeCandidates')!.run({ slot: 'Ring 1' }, ctx)) as { link: string };
  assert.equal(out.link, LINK);
});
