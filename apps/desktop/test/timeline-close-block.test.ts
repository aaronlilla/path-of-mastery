import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timelineCloseBlock } from '../src/renderer/timelines/closeBlock.js';

test('a failed or unwritten Timeline save blocks closing; a saved one clears the block', () => {
  assert.equal(timelineCloseBlock('saved', false), null);
  assert.equal(timelineCloseBlock('failed', false)?.confirmLabel, 'Close anyway');
  assert.ok(timelineCloseBlock('saving', false));
  assert.ok(timelineCloseBlock('saved', true));
});
