import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askedPoints } from '../src/main/assistant/service.js';

test('a points ask names its count: "Spend 3 passive points" spends 3, no number spends all (undefined)', () => {
  assert.equal(askedPoints('Spend 3 passive points on more life'), 3);
  assert.equal(askedPoints('put 5 points into damage'), 5);
  assert.equal(askedPoints('Spend my passive points on life'), undefined);
  assert.equal(askedPoints('spend all 24 points on life'), 24 > 20 ? undefined : 24);
});
