// A price reads the same on every screen: from one Divine Orb up in div, below it in chaos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPrice } from '../src/renderer/lootfilter/format.js';

const DIV = 367.65;

test('the Divine Orb itself reads 1.0 div, not 368c, even when its price is a hair under the rate', () => {
  assert.equal(formatPrice(367.6, DIV), '1.0 div');
  assert.equal(formatPrice(DIV, DIV), '1.0 div');
  assert.equal(formatPrice(368, DIV), '1.0 div', "Valdo's Puzzle Box, also about one Divine");
});

test('chaos below one Divine, div from one Divine up, as the prototype writes them', () => {
  assert.equal(formatPrice(160, DIV), '160c');
  assert.equal(formatPrice(0.4, DIV), '0.4c');
  assert.equal(formatPrice(0.05, DIV), '<0.1c');
  assert.equal(formatPrice(6.7 * DIV, DIV), '6.7 div');
  assert.equal(formatPrice(19 * DIV, DIV), '19 div');
  assert.equal(formatPrice(888 * DIV, DIV), '888 div');
  assert.equal(formatPrice(1_000_000, 0), '1,000,000c', 'no Divine rate, so chaos');
});

test('the Divine unit setting shows tenths of a Divine in div', () => {
  assert.equal(formatPrice(60, DIV, 'Divine'), '0.2 div');
  assert.equal(formatPrice(20, DIV, 'Divine'), '20c', 'under a tenth of a Divine stays in chaos');
});
