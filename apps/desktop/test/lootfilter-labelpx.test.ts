// One mapping from the filter's font size to the pixels a label is drawn at, used by every chip in the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gameLabelPx } from '../src/shared/lootfilter/styles.js';

test('size 45 draws at 35 px, 32 at 25 px, and sizes under 18 draw as 18 (14 px)', () => {
  assert.equal(gameLabelPx(45), 35);
  assert.equal(gameLabelPx(32), 25);
  assert.equal(gameLabelPx(18), 14);
  assert.equal(gameLabelPx(1), 14);
  assert.equal(gameLabelPx(99), 35);
  assert.equal(gameLabelPx(undefined), 25, 'no size set means the game default of 32');
});

test('every step the player can make is a visible step', () => {
  const px = new Set<number>();
  for (let fs = 18; fs <= 45; fs += 3) px.add(gameLabelPx(fs));
  assert.ok(px.size >= 8, `${px.size} distinct sizes between 18 and 45`);
});
