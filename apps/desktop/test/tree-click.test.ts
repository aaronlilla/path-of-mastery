import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDrag, nodeClickPlan } from '../src/renderer/tree/treeClick.js';

const mastery = { isMastery: true, hasEffects: true, chooser: true };

test('a left click on an unallocated mastery opens the effect chooser', () => {
  assert.equal(nodeClickPlan({ ...mastery, alloc: false }), 'chooser');
});

test('a left click on an allocated mastery removes it and opens no chooser (original: DeallocNode)', () => {
  assert.equal(nodeClickPlan({ ...mastery, alloc: true }), 'toggle');
});

test('a mastery without effects, or a host without a chooser, toggles', () => {
  assert.equal(nodeClickPlan({ ...mastery, alloc: false, hasEffects: false }), 'toggle');
  assert.equal(nodeClickPlan({ ...mastery, alloc: false, chooser: false }), 'toggle');
  assert.equal(nodeClickPlan({ isMastery: false, hasEffects: false, chooser: true, alloc: false }), 'toggle');
});

test('a click with a few pixels of hand movement stays a click; past 5 pixels on one axis it pans (original: PassiveTreeView:Draw)', () => {
  assert.equal(isDrag(3, 2), false); // |dx| + |dy| = 5 panned before, so the click was lost
  assert.equal(isDrag(5, -5), false);
  assert.equal(isDrag(-4, 4), false);
  assert.equal(isDrag(6, 0), true);
  assert.equal(isDrag(0, -6), true);
});
