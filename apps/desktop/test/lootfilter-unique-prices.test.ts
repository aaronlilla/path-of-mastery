// Prices shown for a unique base must be what a player would recognise: Headhunter for a Leather Belt, Mageblood for a Heavy Belt.
// The lines below are shaped like poe.ninja's (Foulborn copies, rolled variants, lines with one listing, relics).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldUniqueLines, type StashLine } from '../src/main/lootfilter/prices.js';

const L = (name: string, baseType: string, chaosValue: number, listingCount: number, extra: Partial<StashLine> = {}): StashLine => ({ name, baseType, chaosValue, listingCount, ...extra });

const LINES: StashLine[] = [
  L('Headhunter', 'Leather Belt', 5000, 496),
  L('Foulborn Headhunter', 'Leather Belt', 4_008_130, 1, { variant: 'Culling Strike, Minimap Icons' }),
  L('Foulborn Headhunter', 'Leather Belt', 226_312, 14, { variant: 'Culling Strike' }),
  L('Replica Headhunter', 'Leather Belt', 330, 128),
  L('Mageblood', 'Heavy Belt', 503_525, 31, { variant: '5 Flasks' }),
  L('Mageblood', 'Heavy Belt', 69_578, 618, { variant: '4 Flasks' }),
  L('Mageblood', 'Heavy Belt', 34_789, 138, { variant: '3 Flasks' }),
  L('Foulborn Mageblood', 'Heavy Belt', 801_626, 7, { variant: '5 Flasks' }),
  L('Relic Thing', 'Heavy Belt', 9_000_000, 40, { icon: 'x/y/relic.png' }),
  L('Linked Thing', 'Heavy Belt', 8_000_000, 40, { links: 6 }),
  L('One Listing Belt', 'Heavy Belt', 7_000_000, 1),
];

test('the price of a base comes from the common variant of the dearest plain unique', () => {
  const { byBase, byName, baseName } = foldUniqueLines(LINES);
  assert.equal(baseName.get('Heavy Belt'), 'Mageblood', 'the chip says which unique sets the base price');
  assert.equal(baseName.get('Leather Belt'), 'Headhunter');
  assert.equal(byBase.get('Leather Belt'), 5000, 'Headhunter, not a Foulborn copy or a one-listing line');
  assert.equal(byBase.get('Heavy Belt'), 69_578, 'Mageblood with 4 flasks (618 listings), not the 5 flask line (31) or Foulborn');
  assert.equal(byName.get('Mageblood'), 69_578);
  assert.equal(byName.get('Foulborn Mageblood'), 801_626, 'a Foulborn unique keeps its own price under its own name');
  assert.equal(byName.get('One Listing Belt'), 7_000_000, 'a thin line is still shown under its own name');
  assert.ok(!byName.has('Linked Thing'));
});

test('a base with only Foulborn, relic or thin lines gets no base price', () => {
  const { byBase } = foldUniqueLines([L('Foulborn X', 'Jade Amulet', 100, 50), L('Y', 'Jade Amulet', 100, 2), L('Relic Z', 'Jade Amulet', 100, 50, { icon: 'relic' })]);
  assert.equal(byBase.has('Jade Amulet'), false);
});
