import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hiddenValuableDrops, nearestTier, recentDrops, type DropSession } from '../src/shared/lootfilter/drops.js';

// Recorded-shape sessions: what Wealth keeps in SessionView.gained.
const sessions: DropSession[] = [
  { start: 100, gained: [{ name: 'Chaos Orb', qty: 12 }, { name: 'Scroll of Wisdom', qty: 30 }] },
  { start: 300, gained: [{ name: 'Divine Orb', qty: 1 }, { name: 'Mageblood', qty: 1, transfer: true }, { name: 'Orb of Annulment', qty: 2 }] },
  { start: 200, gained: [{ name: 'Vaal Orb', qty: 3 }] },
];

test('recent drops are newest session first and leave out trades', () => {
  assert.deepEqual(recentDrops(sessions).map((d) => d.name), ['Divine Orb', 'Orb of Annulment', 'Vaal Orb', 'Chaos Orb', 'Scroll of Wisdom']);
});

test('recent drops stop at 50 stacks', () => {
  const big: DropSession[] = [{ start: 1, gained: Array.from({ length: 80 }, (_, i) => ({ name: `Item ${i}`, qty: 1 })) }];
  const d = recentDrops(big);
  assert.equal(d.length, 50);
  assert.equal(d[49]!.name, 'Item 49');
  assert.deepEqual(recentDrops([]), []);
});

const table: Record<string, { visible: boolean; price: number | null }> = {
  'Divine Orb': { visible: true, price: 200 },
  'Orb of Annulment': { visible: false, price: 30 },
  'Vaal Orb': { visible: false, price: 2 },
  'Chaos Orb': { visible: false, price: 1 },
  'Scroll of Wisdom': { visible: false, price: null },
};

test('hidden drops worth 2 chaos or more become one suggestion, dearest first', () => {
  const s = hiddenValuableDrops(recentDrops(sessions), (n) => table[n] ?? null)!;
  assert.deepEqual(s.names, ['Orb of Annulment', 'Vaal Orb']);
  assert.equal(s.question, 'Show 2 items?');
  assert.match(s.line, /Orb of Annulment and Vaal Orb dropped in your last 5 loot stacks/);
  assert.equal(s.id, 'drops:show:Orb of Annulment,Vaal Orb');
});

test('nothing hidden and valuable gives no suggestion; unknown items are ignored', () => {
  assert.equal(hiddenValuableDrops(recentDrops(sessions), () => ({ visible: true, price: 500 })), null);
  assert.equal(hiddenValuableDrops(recentDrops(sessions), () => null), null);
  assert.equal(hiddenValuableDrops([], () => ({ visible: false, price: 500 })), null);
});

test('a single item reads in the singular and many are cut to ten', () => {
  const one = hiddenValuableDrops([{ name: 'A', qty: 1, at: 1 }], () => ({ visible: false, price: 9 }))!;
  assert.equal(one.question, 'Show this item?');
  const many = hiddenValuableDrops(Array.from({ length: 20 }, (_, i) => ({ name: `N${i}`, qty: 1, at: 1 })), () => ({ visible: false, price: 9 }))!;
  assert.equal(many.names.length, 10);
});

test('the look comes from the tier with the nearest price', () => {
  const tiers = [{ tier: 'S', median: 100 }, { tier: 'A', median: 10 }, { tier: 'B', median: 1 }];
  assert.equal(nearestTier(tiers, 30), 'A');
  assert.equal(nearestTier(tiers, 400), 'S');
  assert.equal(nearestTier(tiers, 0.5), 'B');
  assert.equal(nearestTier([], 5), null);
});
