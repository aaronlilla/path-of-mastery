import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertedSentence } from '../src/shared/treeUi.js';

test('a conversion that keeps everything says so', () => {
  assert.equal(convertedSentence('3.29', { points: 0, ascendancy: 0, pointsBefore: 123 }), 'No passives were removed.');
});

test('a conversion that drops every node names the count and the reason', () => {
  assert.equal(
    convertedSentence('2.6', { points: 123, ascendancy: 8, pointsBefore: 123 }),
    'All 123 passive points and 8 ascendancy nodes were removed: none of those nodes exist in tree version 2.6.',
  );
});

test('a partial drop says how many of the points went', () => {
  assert.equal(
    convertedSentence('3.15', { points: 50, ascendancy: 0, pointsBefore: 123 }),
    '50 of 123 passive points were removed because those nodes do not exist in tree version 3.15.',
  );
  assert.equal(
    convertedSentence('3.10', { points: 1, ascendancy: 1, pointsBefore: 5 }),
    '1 of 5 passive points and 1 ascendancy node were removed because those nodes do not exist in tree version 3.10.',
  );
});

test('an unknown count gives no sentence', () => {
  assert.equal(convertedSentence('3.29', null), '');
});
