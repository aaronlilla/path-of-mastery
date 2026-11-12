import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickItemArt } from '../src/renderer/compare/itemArtPick.js';

const idx = new Set(['uniques:Breathstealer', "uniques:Replica Dragonfang's Flight", 'bases:Hydrascale Gauntlets', 'bases:Quicksilver Flask', 'bases:Divine Life Flask', 'bases:Imperial Staff']);
const has = (c: string, n: string) => idx.has(`${c}:${n}`);
const bases = ['Hydrascale Gauntlets', 'Quicksilver Flask', 'Divine Life Flask', 'Imperial Staff'];

test('a unique with a typed suffix still finds its own art', () => {
  assert.deepEqual(pickItemArt({ rarity: 'UNIQUE', name: "Replica Dragonfang's Flight - faster", base: 'Onyx Amulet' }, has, bases), { name: "Replica Dragonfang's Flight", category: 'uniques' });
});
test('a retitled unique falls back to its base', () => {
  assert.deepEqual(pickItemArt({ rarity: 'UNIQUE', name: 'Breathstealer +frenzy', base: 'Hydrascale Gauntlets' }, has, bases), { name: 'Breathstealer', category: 'uniques' });
  assert.deepEqual(pickItemArt({ rarity: 'UNIQUE', name: 'My Gloves', base: 'Hydrascale Gauntlets' }, has, bases), { name: 'Hydrascale Gauntlets', category: 'bases' });
});
test('a magic flask finds its base inside the affixed name', () => {
  const m = { rarity: 'MAGIC', name: 'Perpetual Quicksilver Flask of Variegation', base: 'Perpetual Quicksilver Flask of Variegation' };
  assert.deepEqual(pickItemArt(m, has, bases), { name: 'Quicksilver Flask', category: 'bases' });
  assert.deepEqual(pickItemArt({ rarity: 'MAGIC', name: 'Ebullient Divine Life Flask of Alleviation', base: 'x' }, has, bases), { name: 'Divine Life Flask', category: 'bases' });
});
test('rare items use their base', () => {
  assert.deepEqual(pickItemArt({ rarity: 'RARE', name: 'inspiration 7L', base: 'Imperial Staff' }, has, bases), { name: 'Imperial Staff', category: 'bases' });
});
