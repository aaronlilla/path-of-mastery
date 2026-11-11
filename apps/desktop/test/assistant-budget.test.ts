import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetChaos } from '../src/main/assistant/profile.js';

test('budgetChaos reads the player budget in their own words', () => {
  assert.equal(budgetChaos('~30 div', 200), 6000);
  assert.equal(budgetChaos('about two divines', 150), 300);
  assert.equal(budgetChaos('~2 div', 150), 300);
  assert.equal(budgetChaos('500c', 150), 500);
  assert.equal(budgetChaos('300 chaos', 150), 300);
  assert.equal(budgetChaos('almost no currency', 150), 0);
  assert.equal(budgetChaos('almost nothing', 150), 0);
  assert.equal(budgetChaos('a lot', 150), null);
  assert.equal(budgetChaos(undefined, 150), null);
  assert.equal(budgetChaos('5 div', 0), null);
});
