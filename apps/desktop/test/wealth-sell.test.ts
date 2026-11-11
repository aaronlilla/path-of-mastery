import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWindows, WINDOW_SLOTS } from '../src/shared/sell.js';

test('a window holds 60 slots and stacks split by the real max stack size', () => {
  // 2952 chaos at 10 per stack is 296 slots: five windows (60 x 4 + 56).
  const w = planWindows([{ name: 'Chaos Orb', qty: 2952, unit: 1, maxStack: 10 }], 1);
  assert.equal(w.length, 5);
  assert.deepEqual(w.map((x) => x.slots), [60, 60, 60, 60, 56]);
  assert.equal(w.reduce((s, x) => s + x.items.reduce((a, i) => a + i.qty, 0), 0), 2952);
  assert.ok(w.every((x) => x.slots <= WINDOW_SLOTS));
});

test('items that do not stack take a slot each', () => {
  const w = planWindows([{ name: 'Mageblood', qty: 3, unit: 100, maxStack: 1 }], 1);
  assert.equal(w.length, 1);
  assert.equal(w[0]!.slots, 3);
});

test('the most valuable items go in the first window', () => {
  const w = planWindows(
    [
      { name: 'Cheap', qty: 600, unit: 1, maxStack: 10 },
      { name: 'Rich', qty: 5, unit: 5000, maxStack: 1 },
    ],
    1,
  );
  assert.equal(w[0]!.items[0]!.name, 'Rich');
});

test('the price multiplier scales every window and the total', () => {
  const items = [{ name: 'Divine Orb', qty: 13, unit: 400, maxStack: 10 }];
  const a = planWindows(items, 1);
  const b = planWindows(items, 1.5);
  assert.equal(a[0]!.value, 5200);
  assert.equal(b[0]!.value, 7800);
});

test('nothing to sell plans no windows', () => {
  assert.deepEqual(planWindows([], 1), []);
  assert.deepEqual(planWindows([{ name: 'x', qty: 0, unit: 5, maxStack: 1 }], 1), []);
});
