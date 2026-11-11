import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseIdentical, notBetterThanWorn } from '../src/main/wealth/upgrades.js';
import type { TradeItem, UpgradeCandidate } from '../src/shared/wealthTrade.js';

const worn = { name: 'Black Zenith', base: 'Spiked Gloves', text: ['Rarity: UNIQUE', 'Black Zenith', 'Spiked Gloves', '+60 to maximum Life', '+30% to Fire Resistance', 'Adds 10 to 20 Physical Damage'].join('\n') };
const listing = (mods: string[], over: Partial<TradeItem> = {}): TradeItem => ({ name: 'Black Zenith', typeLine: 'Spiked Gloves', baseType: 'Spiked Gloves', frameType: 3, explicitMods: mods, ...over });

test("a listing with the worn item's name and base and no better roll is not an upgrade", () => {
  assert.equal(notBetterThanWorn(worn, listing(['+60 to maximum Life', '+30% to Fire Resistance'])), true, 'same rolls');
  assert.equal(notBetterThanWorn(worn, listing(['+55 to maximum Life', 'Adds 9 to 20 Physical Damage'])), true, 'worse rolls');
  assert.equal(notBetterThanWorn(worn, listing(['+61 to maximum Life'])), false, 'one roll higher');
  assert.equal(notBetterThanWorn(worn, listing(['+60 to maximum Life', '+10% to Cold Resistance'])), false, 'a modifier the worn item lacks');
  assert.equal(notBetterThanWorn(worn, listing(['+60 to maximum Life'], { name: 'Other Gloves' })), false, 'another item');
});

test('identical listings collapse into one row with a count, the cheapest kept', () => {
  const cand = (id: string, chaos: number, mods: string[]): UpgradeCandidate =>
    ({ key: id, slot: 'Gloves', listing: { id, item: listing(mods), price: null, chaos } as unknown as UpgradeCandidate['listing'], itemText: '', main: null, ehp: null, others: [], priceChaos: chaos, score: null, held: null, overBudget: null, sold: false });
  const out = collapseIdentical([cand('a', 50, ['+70 to maximum Life']), cand('b', 30, ['+70 to maximum Life']), cand('c', 10, ['+80 to maximum Life'])]);
  assert.equal(out.length, 2);
  const two = out.find((x) => x.copies === 2)!;
  assert.equal(two.key, 'b', 'the cheaper of the two identical listings');
  assert.equal(out.find((x) => x.key === 'c')!.copies, undefined);
});
