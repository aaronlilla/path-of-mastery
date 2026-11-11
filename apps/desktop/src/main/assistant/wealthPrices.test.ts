import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniqueDivines } from './wealthPrices.js';
test('unique prices: 1-divine is 1.0, variants keep their own price', () => {
const all = [
  { name: 'Mageblood', variant: '4 Flasks', chaos: 453.3, divineValue: 1, type: 'UniqueAccessory' },
  { name: 'Mageblood', variant: '5 Flasks', chaos: 4533, divineValue: 10, type: 'UniqueAccessory' },
];
const r = uniqueDivines({ book: { size: 2, divine: 451.6, all: () => all } })!;
assert.equal(r['Mageblood'], 1);
assert.equal(r['Mageblood|4 Flasks'], 1);
assert.equal(r['Mageblood|5 Flasks'], 10);

});
test('unique prices: one thin cheap listing does not set the price', () => {
  const all = [
    { name: 'Ring', chaos: 10, divineValue: 0.05, type: 'UniqueAccessory', listings: 1 },
    { name: 'Ring', chaos: 400, divineValue: 2, type: 'UniqueAccessory', listings: 40 },
  ];
  assert.equal(uniqueDivines({ book: { size: 2, divine: 200, all: () => all } })!['Ring'], 2);
});
