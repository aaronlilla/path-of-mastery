import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PriceBook, priceItem, type GggItem } from '../src/main/wealth/priceBook.js';
import { lineIdOf } from '../src/main/wealth/service.js';
import { ownedOf, type MarketRow, type StashRow } from '../src/shared/wealth.js';

function book(): PriceBook {
  const b = new PriceBook();
  b.addItems('SkillGem', {
    lines: [
      { id: 1, name: 'Cyclone', variant: '20/20', chaosValue: 65, gemLevel: 20, gemQuality: 20, sparkLine: { data: [] } },
      { id: 2, name: 'Cyclone', variant: '21/20c', chaosValue: 5200, gemLevel: 21, gemQuality: 20, corrupted: true, sparkLine: { data: [] } },
    ],
  }, 1);
  return b;
}

const gem = (lvl: number, q: number, corrupted: boolean): GggItem => ({ typeLine: 'Cyclone', frameType: 4, corrupted, properties: [{ name: 'Level', values: [[String(lvl), 0]] }, { name: 'Quality', values: [[`+${q}%`, 1]] }] });

function rowOf(b: PriceBook, it: GggItem): StashRow {
  const p = priceItem(b, it);
  return { key: p.key, name: p.name, ...(p.variant ? { variant: p.variant } : {}), lineId: p.line ? lineIdOf(p.line) : null, cat: p.cat, qty: 1, unit: p.unit, hi: p.hi, priced: p.kind, tabIds: ['t'], spark: [], art: p.art, maxStack: 1, source: 'poe.ninja', priceAt: 1 };
}

test('two Cyclones at different level, quality and corruption are two stash rows, each labelled', () => {
  const b = book();
  const a = rowOf(b, gem(20, 20, false));
  const c = rowOf(b, gem(21, 20, true));
  assert.notEqual(a.key, c.key);
  assert.equal(a.variant, '20/20');
  assert.equal(c.variant, '21/20 corrupted');
  assert.equal(a.unit, 65);
  assert.equal(c.unit, 5200);
});

test('Market counts only the stash rows priced from its own line; the other versions are reported apart', () => {
  const b = book();
  const rows = [rowOf(b, gem(20, 20, false)), rowOf(b, gem(21, 20, true))];
  const market: MarketRow = { key: 'gem|Cyclone|Level 20 · 20% quality', lineId: lineIdOf(b.lines('Cyclone')[0]!), name: 'Cyclone', cat: 'gem', chaos: 65, spark: [], art: 'Cyclone' };
  const h = ownedOf(rows, market);
  assert.equal(h.qty, 1, 'the corrupted level 21 gem is not the level 20 gem');
  assert.equal(h.value, 65);
  assert.deepEqual(h.others, { qty: 1, value: 5200, kinds: 1 });
});

import { compareSession } from '../src/shared/wealth.js';

test('a session is compared with a strategy on net per hour, cost per map, items per map and maps per hour', () => {
  const session = { minutes: 90, perHour: 600, cost: 300, mapsUsed: 30, gained: [{ key: 'a', name: 'A', cat: 'cur' as const, qty: 120, value: 1, art: 'A' }, { key: 'b', name: 'B', cat: 'cur' as const, qty: 60, value: 1, art: 'B', transfer: true }] };
  const st = { net: 900, costPerMap: 8, mapsPerHour: 25, lootRows: [{ name: 'A', perMap: 3, perHour: 75, art: 'A' }, { name: 'B', perMap: 1.5, perHour: 37, art: 'B' }] };
  const [net, cost, items, mph] = compareSession(session, st);
  assert.deepEqual([net!.yours, net!.diff], [600, -300]);
  assert.equal(cost!.yours, 10, '300 chaos over 30 maps');
  assert.equal(cost!.diff, 2);
  assert.equal(items!.yours, 4, '120 items over 30 maps; the transfer is not gained');
  assert.equal(items!.expected, 4.5);
  assert.ok(Math.abs(mph!.yours! - 20) < 1e-9, '30 maps in 1.5 hours');
  const none = compareSession({ ...session, mapsUsed: 0 }, st);
  assert.deepEqual(none.slice(1).map((x) => x.yours), [null, null, null], 'no maps counted: no per-map figure is invented');
});
