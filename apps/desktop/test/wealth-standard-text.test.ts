import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standardPriceText } from '../src/shared/wealth.js';

const sel = { key: 'divine' };

test('a Standard price still being asked shows nothing until the ask is slow, then Checking…', () => {
  assert.equal(standardPriceText(sel, null, false), '');
  assert.equal(standardPriceText(sel, { key: 'other', chaos: 5, divine: 200 }, false), '');
  assert.equal(standardPriceText(sel, null, true), 'Checking…');
});

test('a failed Standard ask keeps showing Not available for the next item while it is asked', () => {
  assert.equal(standardPriceText(sel, { key: 'other', chaos: null, divine: 200, failed: true }, false), 'Not available');
  assert.equal(standardPriceText(sel, { key: 'other', chaos: null, divine: 200 }, false), '');
  assert.equal(standardPriceText(sel, { key: 'other', chaos: 5, divine: 200 }, true), 'Checking…');
});

test('an answered Standard price shows its value, Not available or Not listed', () => {
  assert.equal(standardPriceText(sel, { key: 'divine', chaos: null, divine: 200, failed: true }, false), 'Not available');
  assert.equal(standardPriceText(sel, { key: 'divine', chaos: null, divine: 200 }, false), 'Not listed');
  assert.equal(standardPriceText(sel, { key: 'divine', chaos: 10, divine: 200 }, true), '10c');
});
