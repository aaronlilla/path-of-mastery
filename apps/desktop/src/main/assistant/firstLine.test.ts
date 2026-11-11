import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freeFixLine } from './firstLine.js';

// An answer to "What's next?": the answer said "Fixes first, going in now: gem levels, count:Poisonous Concoction, ..." (a raw fix id)
test('freeFixLine never prints a raw id prefix', () => {
  const line = freeFixLine(['fix:requirement', 'fix:count:Poisonous Concoction', 'fix:resist'])!;
  assert.doesNotMatch(line, /\w+:\w/);
  assert.match(line, /Poisonous Concoction count/);
});
