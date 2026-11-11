import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passiveMax, pointsReadout, treeCardLabel } from '../src/shared/pointsReadout.js';

test('remaining counts and labels', () => {
  const r = pointsReadout({ used: 116, usedMax: 123, asc: 6, ascMax: 8 });
  assert.equal(r.passiveLabel, '116 / 123');
  assert.equal(r.passiveLeft, '7 left');
  assert.equal(r.ascLabel, '6 / 8');
  assert.equal(r.ascLeft, '2 left');
  assert.equal(r.passiveOver, false);
  assert.ok(Math.abs(r.passiveFill - 116 / 123) < 1e-9);
});
test('over the limit', () => {
  const r = pointsReadout({ used: 125, usedMax: 123, asc: 9, ascMax: 8 });
  assert.equal(r.passiveLeft, '2 over');
  assert.equal(r.ascLeft, '1 over');
  assert.ok(r.passiveOver && r.ascOver);
  assert.equal(r.passiveFill, 1);
});
test('exactly full is not over, and no data is dashes', () => {
  const r = pointsReadout({ used: 123, usedMax: 123, asc: 0, ascMax: 8 });
  assert.equal(r.passiveLeft, '0 left');
  assert.equal(r.passiveOver, false);
  assert.equal(pointsReadout(null).passiveLabel, '– / –');
});

test('the passive total is what the character has at its level; an auto level follows the points, so it gives the level 100 total', () => {
  assert.equal(passiveMax(1, 95), 118, 'level 95 with the bandit point: 94 + 23 quest + 1');
  assert.equal(passiveMax(1, 97), 120);
  assert.equal(passiveMax(1, null), 123, 'auto level: the character level is not known');
});

test('a tree card that takes and refunds points says it moves them, not twice the count', () => {
  assert.deepEqual(treeCardLabel(4, 4), { apply: 'Move 4 passive points', applied: 'Moved 4 passive points', undid: 'Undid moving 4 passive points' });
  assert.deepEqual(treeCardLabel(5, 0), { apply: 'Apply 5 passive points', applied: 'Applied 5 passive points', undid: 'Undid 5 passive points' });
  assert.deepEqual(treeCardLabel(0, 1), { apply: 'Refund 1 passive point', applied: 'Refunded 1 passive point', undid: 'Undid refunding 1 passive point' });
  assert.equal(treeCardLabel(5, 3).applied, 'Took 5 passive points, refunded 3');
});
