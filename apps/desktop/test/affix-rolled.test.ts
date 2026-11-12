import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rolledByRow, stacksSliders } from '../src/renderer/items/affixMath.js';

test('a hybrid affix takes its lines and empty rows take none', () => {
  assert.deepEqual(rolledByRow(['+86 to maximum Life', '+41 to Armour', '+26 to maximum Life', '+33% to Fire Resistance'], [1, 0, 2, 1]), ['+86 to maximum Life', '', '+41 to Armour / +26 to maximum Life', '+33% to Fire Resistance']);
});

test('every modifier gets its own roll slider only on a Unique with the setting on (the original does not stack them for any other rarity)', () => {
  assert.equal(stacksSliders(true, 'UNIQUE'), true);
  for (const r of ['NORMAL', 'MAGIC', 'RARE', 'RELIC', undefined]) assert.equal(stacksSliders(true, r), false, String(r));
  assert.equal(stacksSliders(false, 'UNIQUE'), false);
});
