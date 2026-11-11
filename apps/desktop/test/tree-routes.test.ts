import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headerStage } from '../src/shared/treeUi.js';

test('the build header steps by its own width as the design does', () => {
  assert.equal(headerStage(1844), 0);
  assert.equal(headerStage(1490), 0);
  assert.equal(headerStage(1489), 1);
  assert.equal(headerStage(1345), 1);
  assert.equal(headerStage(1212), 2);
  assert.equal(headerStage(1110), 2);
  assert.equal(headerStage(1109), 3);
  assert.equal(headerStage(600), 3);
  assert.equal(headerStage(599), 4);
});
