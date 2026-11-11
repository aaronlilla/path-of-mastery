// A retry after a dangling placeholder is told what the result holds, so it can point at a real entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditText, checkedText, danglingHint, type ResultStore } from '../src/shared/assistant/refs.js';
import { TOOLS, type ToolContext } from '../src/main/assistant/tools.js';
import { ProposalStore } from '../src/main/assistant/proposals.js';
import { sampleDataFrom, sampleTradeFetch } from '../src/main/wealth/sampleTrade.js';
import { wealthTradeSource } from '../src/main/assistant/wealthTrade.js';
import tradeStatsJson from '../src/renderer/items/tradeStats.json' with { type: 'json' };

const tradeStats = tradeStatsJson as unknown as Record<string, Record<string, string>>;

test('{{ref:rkkm78:path}} (the prompt word copied in) reads rkkm78, not a dash', () => {
  const store: ResultStore = { rkkm78: { tool: 'getStats', data: { stats: [{ id: 'Mana', shown: '689' }] } } };
  const text = 'You have {{ref:rkkm78:stats[Mana].shown}} mana.';
  assert.deepEqual(checkedText(text, store).filter((s) => s.t !== 'text').map((s) => s.text), ['689']);
  assert.deepEqual(auditText(text, (r) => store[r]).dangling, []);
  // a bare {{ref:link}} still names a result called "ref", which does not exist
  assert.deepEqual(auditText('{{ref:link}}', (r) => store[r]).dangling, ['{{ref:link}}']);
});

test('searchTrade mods named without a number ("to maximum Life") are searched as trade stats', async () => {
  let seen: { text: string }[] = [];
  const ctx = { engine: {} as never, open: () => null, proposals: new ProposalStore(), tree: {} as never, origin: 'panel',
    trade: { search: async (q: { mods?: { text: string }[] }) => { seen = q.mods ?? []; return { ok: true, total: 0, at: Date.now(), cached: false, chaosPerDivine: 1, listings: [], unmatchedMods: [], link: 'x' }; } } } as unknown as ToolContext;
  await TOOLS.find((t) => t.name === 'searchTrade')!.run({ category: 'armour.gloves', mods: [{ text: 'to maximum Life', min: 60 }, { text: 'increased Movement Speed' }, { text: '+40 to Cold Resistance' }] }, ctx);
  assert.deepEqual(seen.map((m) => m.text), ['+# to maximum Life', '#% increased Movement Speed', '+40 to Cold Resistance']);
});

test('danglingHint names the ids a list has when the asked entry is missing', () => {
  const store: ResultStore = { rtvt41: { tool: 'getBuildSummary', data: { headlineStats: [{ id: 'Life', shown: '9,051' }, { id: 'TotalEHP', shown: '120k' }] } } };
  const get = (r: string) => store[r];
  assert.match(danglingHint('{{rtvt41:headlineStats[EnergyShield].shown}}', get), /headlineStats has no entry EnergyShield; it has Life, TotalEHP/);
  assert.match(danglingHint('{{rtvt41:headline.shown}}', get), /the result has no headline; it has headlineStats/);
  assert.match(danglingHint('{{rtvt41:headlineStats[Life]}}', get), /pick one of id, shown/);
  assert.match(danglingHint('{{nope:x}}', get), /not a tool result/);
});

test('sample trade site: a rare weapon search lists the worn base with its implicit, its other mods and common rolls', async () => {
  const data = sampleDataFrom(tradeStats, process.env.POM_ENGINE_DATA);
  const worn = { name: 'Glyph Hunger', typeLine: 'Despot Axe', baseType: 'Despot Axe', frameType: 2, identified: true, icon: '',
    implicitMods: ['Implicit line kept'], explicitMods: ['Adds 30 to 60 Physical Damage', '25% increased Attack Speed', '+40 to Strength'] };
  const life = tradeStats.explicit!['+# to maximum Life']!;
  const body = { query: { filters: { type_filters: { filters: { category: { option: 'weapon.twoaxe' } } } }, stats: [{ type: 'and', filters: [{ id: life, value: { min: 50 } }] }] } };
  type Fetched = { result: { item: { baseType: string; implicitMods?: string[]; explicitMods: string[] } }[] };
  const listings = async (f: ReturnType<typeof sampleTradeFetch>, n: number) => {
    const s = (await (await f('https://www.pathofexile.com/api/trade/search/Allflame', { method: 'POST', body: JSON.stringify(body) })).json()) as { id: string; result: string[] };
    return ((await (await f(`https://www.pathofexile.com/api/trade/fetch/${s.result.slice(0, n).join(',')}?query=${s.id}`)).json()) as Fetched).result.map((x) => x.item);
  };
  for (const item of await listings(sampleTradeFetch({ now: () => 1_800_000_000_000, ...data, worn: () => [worn] }), 5)) {
    assert.equal(item.baseType, 'Despot Axe');
    assert.deepEqual(item.implicitMods, ['Implicit line kept']);
    assert.ok(item.explicitMods.some((m) => /Physical Damage/.test(m)) && item.explicitMods.some((m) => /Attack Speed/.test(m)), item.explicitMods.join(' / '));
    assert.ok(item.explicitMods.length >= 4, item.explicitMods.join(' / '));
  }
  // without worn items (the wealth unit tests) a listing stays a random base with only the searched mods
  assert.ok((await listings(sampleTradeFetch({ now: () => 1_800_000_000_000, ...data }), 1))[0]!.explicitMods.length <= 1);
});

test('a trade search on an empty price book (Wealth never opened) still gives the divine rate, without waiting for the whole book', async () => {
  const book = { divine: 0, size: 0 };
  const w = {
    whenReady: async () => undefined,
    book,
    // the currency category lands first; the other categories take seconds more
    refreshPrices: () => new Promise<void>((done) => { setTimeout(() => { book.divine = 400; book.size = 1; }, 50); setTimeout(done, 3000); }),
    premium: { search: async () => ({ ok: true, outcome: { total: 0, at: Date.now(), cached: false, link: 'x', listings: [] } }) },
  };
  const t0 = Date.now();
  const r = await wealthTradeSource(w as never).search({ type: 'Wrapped Mitts' });
  assert.equal(r.ok && r.chaosPerDivine, 400);
  assert.ok(Date.now() - t0 < 1500, `waited ${Date.now() - t0} ms`);
});
