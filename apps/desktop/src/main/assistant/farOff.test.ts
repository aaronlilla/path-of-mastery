import { test } from 'node:test';
import assert from 'node:assert/strict';
import { farOffLine, replanText } from './solve.js';

test('a solve update never gets the max-hit facts line, a player ask does', async () => {
  const { asksMaxHit } = await import('./playerSense.js');
  const t = replanText(1, { reason: 'stalled', leads: [{ name: 'A', values: [{ name: 'DPS', value: 400000, need: 3000000 }], limiting: 'Fire maximum hit at least 1/20 of EHP' }] });
  assert.equal(asksMaxHit(t), false);
  assert.equal(asksMaxHit('what is my fire max hit?'), true);
});

test('a best under a fifth of the ask says the ratio; a near miss says nothing', () => {
  assert.match(farOffLine([{ name: 'DPS', value: 400000, need: 3000000 }]), /DPS 400k of 3M: 13%, 7\.5x short/);
  assert.equal(farOffLine([{ name: 'DPS', value: 2000000, need: 3000000 }]), '');
  const t = replanText(1, { reason: 'stalled', leads: [{ name: 'A', values: [{ name: 'DPS', value: 400000, need: 3000000 }] }] });
  assert.match(t, /Far off/);
});
