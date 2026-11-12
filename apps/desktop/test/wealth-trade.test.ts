import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TradeStats } from '../src/renderer/items/tradeQuery.js';
import tradeStatsJson from '../src/renderer/items/tradeStats.json' with { type: 'json' };
import { newGggLimiter } from '../src/main/wealth/ggg.js';
import { PriceBook } from '../src/main/wealth/priceBook.js';
import { sampleDataFrom, sampleTradeFetch, type SampleTradeMode } from '../src/main/wealth/sampleTrade.js';
import { HttpTrade, priceInChaos, TradeSearcher, withModStrings } from '../src/main/wealth/trade.js';
import { tradeItemText } from '../src/shared/tradeItemText.js';
import { sellerPrice } from '../src/shared/wealthTrade.js';

const stats = tradeStatsJson as unknown as TradeStats;
const COOKIE = 'c0ffee'.repeat(6);

function rig(mode: SampleTradeMode = 'ok', over?: typeof fetch) {
  const clock = { t: 1_800_000_000_000 };
  const slept: number[] = [];
  const now = () => clock.t;
  const sleep = async (ms: number) => void (slept.push(ms), (clock.t += ms));
  const limiter = newGggLimiter(now, sleep);
  const sample = sampleTradeFetch({ now, ...sampleDataFrom(stats, process.env.POM_ENGINE_DATA), mode });
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetchFn = (over ?? (async (u: string | URL | Request, i?: RequestInit) => {
    seen.push({ url: String(u), headers: { ...(i?.headers as Record<string, string>) } });
    return sample(u, i);
  })) as typeof fetch;
  const book = new PriceBook();
  (book as unknown as { divine: number }).divine = 400;
  const api = new HttpTrade({ cookie: () => COOKIE, userAgent: 'test', limiter, fetchFn });
  const searcher = new TradeSearcher({ api, book, now, sleep, league: () => 'Allflame', hasCookie: () => true });
  return { clock, slept, limiter, sample, seen, searcher, book, api };
}
const Q = { query: { status: { option: 'available' }, filters: { type_filters: { filters: { category: { option: 'accessory.ring' } } } }, stats: [{ type: 'and', filters: [] }] }, sort: { price: 'asc' } };

test('a search and one fetch of 10 listings; the cookie goes only to pathofexile.com', async () => {
  const r = rig();
  const out = await r.searcher.search(Q);
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.equal(out.outcome.listings.length, 10);
  assert.equal(r.seen.length, 2);
  assert.match(r.seen[0]!.url, /^https:\/\/www\.pathofexile\.com\/api\/trade\/search\/Allflame$/);
  assert.match(r.seen[1]!.url, /^https:\/\/www\.pathofexile\.com\/api\/trade\/fetch\/[^?]+\?query=q/);
  assert.ok(r.seen[1]!.url.split('?')[0]!.split('/').pop()!.split(',').length <= 10);
  for (const s of r.seen) assert.equal(s.headers.Cookie, `POESESSID=${COOKIE}`);
  assert.throws(() => new HttpTrade({ cookie: () => COOKIE, userAgent: 't', limiter: r.limiter, baseUrl: 'https://evil.example.com' }), /only be sent to pathofexile\.com/);
});

test('a repeated search inside 5 minutes comes from the cache and sends nothing', async () => {
  const r = rig();
  await r.searcher.search(Q);
  const before = r.seen.length;
  const again = await r.searcher.search(Q);
  assert.ok(again.ok && again.outcome.cached);
  assert.equal(r.seen.length, before);
  r.clock.t += 6 * 60_000;
  const later = await r.searcher.search(Q);
  assert.ok(later.ok && !later.outcome.cached);
  assert.equal(r.seen.length, before + 2);
});

test('requests are spaced by the limiter (2 s apart) and every response teaches the real limits', async () => {
  const r = rig();
  await r.searcher.search(Q);
  await r.searcher.search({ ...Q, sort: { price: 'desc' } });
  assert.ok(r.slept.some((ms) => ms >= 1900), `slept ${JSON.stringify(r.slept)}`);
  assert.deepEqual(r.limiter.limitsFor('trade-search').map((l) => l.max), [8, 15, 60]);
  assert.deepEqual(r.limiter.limitsFor('trade-fetch').map((l) => l.max), [12, 16]);
});

test('a 429 waits out Retry-After, retries, and backs off the stash policies too', async () => {
  const r = rig();
  let calls = 0;
  const flaky = (async (u: string | URL | Request, i?: RequestInit) => {
    calls++;
    if (calls === 1) return new Response('slow', { status: 429, headers: { 'retry-after': '45' } });
    return r.sample(u, i);
  }) as typeof fetch;
  const r2 = rig('ok', flaky);
  const out = await r2.searcher.search(Q);
  assert.ok(out.ok, JSON.stringify(out));
  assert.ok(r2.slept.some((ms) => ms === 45_000), `slept ${JSON.stringify(r2.slept)}`);
  // The restriction is on the address: the stash policy was blocked by the same 429.
  assert.equal(calls >= 3, true);
});

test('a long 429 is not waited out inline: it fails visibly and every policy, the stash included, is blocked for Retry-After', async () => {
  const long = (async () => new Response('slow', { status: 429, headers: { 'retry-after': '600' } })) as typeof fetch;
  const r = rig('ok', long);
  const out = await r.searcher.search(Q);
  assert.ok(!out.ok && out.kind === 'rate-limited' && out.retryAfterSec === 600);
  assert.equal(r.slept.includes(600_000), false);
  assert.ok(r.limiter.waitTime('stash') >= 590_000, `stash waits ${r.limiter.waitTime('stash')}`);
  assert.ok(r.limiter.waitTime('trade-fetch') >= 590_000);
});

test('while the trade site asks us to wait, the status says so with a resume time', async () => {
  const r = rig('rate-limited');
  const seen: string[] = [];
  (r.searcher as unknown as { o: { onStatus?: (s: { phase: string }) => void } }).o.onStatus = (s) => seen.push(s.phase);
  const out = await r.searcher.search(Q);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.kind, 'rate-limited');
  assert.ok(seen.includes('waiting'));
  assert.equal(r.searcher.status().phase, 'waiting');
  assert.ok((r.searcher.status().resumesAt ?? 0) > r.clock.t - 1);
});

test('a 403 is never retried and the cookie text never appears in the error', async () => {
  const r = rig('expired');
  const out = await r.searcher.search(Q);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.kind, 'expired');
  assert.equal(r.sample.log.length, 1, 'one request, no retry');
  assert.equal(JSON.stringify(out).includes(COOKIE), false);
  assert.equal(r.searcher.status().phase, 'expired');
  assert.equal(r.searcher.status().message.includes(COOKIE), false);
});

test('a down trade site is reported and not hammered; an empty search is an empty result', async () => {
  const d = rig('down');
  const out = await d.searcher.search(Q);
  assert.ok(!out.ok && out.kind === 'down');
  assert.equal(d.sample.log.length, 1);
  const e = rig('empty');
  const none = await e.searcher.search(Q);
  assert.ok(none.ok && none.outcome.listings.length === 0 && none.outcome.total === 0);
  assert.equal(e.sample.log.length, 1, 'no fetch for zero ids');
});

test('no cookie means no request', async () => {
  const r = rig();
  (r.searcher as unknown as { o: { hasCookie: () => boolean } }).o.hasCookie = () => false;
  const out = await r.searcher.search(Q);
  assert.ok(!out.ok && out.kind === 'no-cookie');
  assert.equal(r.seen.length, 0);
});

test('listing prices convert with the price book and an unknown currency is unpriced, never zero', () => {
  const book = new PriceBook();
  (book as unknown as { divine: number }).divine = 400;
  assert.equal(priceInChaos(book, { amount: 30, currency: 'chaos' }), 30);
  assert.equal(priceInChaos(book, { amount: 2.5, currency: 'divine' }), 1000);
  assert.equal(priceInChaos(book, { amount: 3, currency: 'exalted' }), null);
  assert.equal(priceInChaos(book, { amount: 3, currency: 'weird-orb' }), null);
  assert.equal(priceInChaos(book, null), null);
  assert.equal(sellerPrice({ amount: 4, currency: 'divine' }), '4 divine');
});

test('a trade item becomes the item text the original writes', () => {
  const t = tradeItemText({
    id: 'abc', name: 'Doom Loop', typeLine: 'Vermillion Ring', frameType: 2, ilvl: 84,
    properties: [{ name: 'Quality', values: [['+20%', 1]] }],
    requirements: [{ name: 'Level', values: [['60', 0]] }],
    influences: { shaper: true },
    implicitMods: ['+25 to maximum Life'], explicitMods: ['+89 to maximum Life', '+44% to Fire Resistance'], craftedMods: ['+12% to Cold Resistance'],
    corrupted: true,
  })!;
  assert.deepEqual(t.text.split('\n'), ['Rarity: RARE', 'Doom Loop', 'Vermillion Ring', 'Unique ID: abc', 'Shaper Item', 'Item Level: 84', 'Quality: 20', 'LevelReq: 60', 'Implicits: 1', '+25 to maximum Life', '+89 to maximum Life', '+44% to Fire Resistance', '{crafted}+12% to Cold Resistance', 'Corrupted']);
  assert.equal(tradeItemText({ name: '', typeLine: 'x', frameType: 99 }), null);
});

test('the assistant searchTrade tool maps modifier text to trade stat ids, returns referenced numbers, and surfaces a refused cookie as plain words', async () => {
  const { TOOLS } = await import('../src/main/assistant/tools.js');
  const { statIdFor } = await import('../src/main/assistant/wealthTrade.js');
  assert.match(statIdFor('+89 to maximum Life') ?? '', /^explicit\.stat_/);
  assert.equal(statIdFor('this is not a modifier'), undefined);
  const tool = TOOLS.find((t) => t.name === 'searchTrade')!;
  let asked: unknown;
  const trade = {
    async search(q: unknown) {
      asked = q;
      return { ok: true as const, total: 12, at: Date.now(), cached: false, chaosPerDivine: 400, listings: [{ name: 'Doom Loop', base: 'Vermillion Ring', rarity: 'Rare', ilvl: 84, mods: ['+89 to maximum Life'], asked: '4 divine', chaos: 1600, divine: 4, ageMinutes: 6, online: true }], unmatchedMods: [], link: 'https://www.pathofexile.com/trade/search/Allflame?q=x' };
    },
    async upgrades() {
      return { ok: false as const, kind: 'expired', message: 'x' };
    },
  };
  const out = (await tool.run({ type: 'Vermillion Ring', mods: [{ text: '+89 to maximum Life', min: 80 }] }, { trade } as never)) as { listings: { divine: number }[]; total: number };
  assert.equal(out.total, 12);
  assert.equal(out.listings[0]!.divine, 4);
  assert.deepEqual((asked as { mods: unknown[] }).mods, [{ text: '+89 to maximum Life', min: 80 }]);
  const up = TOOLS.find((t) => t.name === 'upgradeCandidates')!;
  const ctx = { trade, engine: { send: async () => ({ buildXml: '<x/>' }) }, open: () => ({ buildId: 'b', name: 'n', buildKey: 'k' }) } as never;
  await assert.rejects(() => up.run({ slot: 'Ring 1' }, ctx), /reconnect in Wealth/);
  await assert.rejects(() => tool.run({}, { trade } as never), /at least a name/);
});

test('a listing whose modifiers come as objects is read as lines of text', () => {
  const raw = {
    id: 'a1',
    item: {
      name: 'Void Battery',
      typeLine: 'Prophecy Wand',
      frameType: 3,
      implicitMods: [{ description: '40% increased Spell Damage', domain: 'implicit', hash: 'x', mods: [] }],
      explicitMods: ['11% increased Cast Speed', { description: '50% reduced Spell Damage' }, { nothing: true }],
    },
  } as unknown as Parameters<typeof withModStrings>[0];
  const out = withModStrings(raw);
  assert.deepEqual(out.item?.implicitMods, ['40% increased Spell Damage']);
  assert.deepEqual(out.item?.explicitMods, ['11% increased Cast Speed', '50% reduced Spell Damage']);
  assert.equal(withModStrings({ id: 'b' }).item, undefined);
});
