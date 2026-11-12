import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoUiScale } from '../src/shared/uiScale.js';

test('the UI stays at 1x up to a 1920-wide window', () => {
  assert.equal(autoUiScale(800, 600), 1);
  assert.equal(autoUiScale(1280, 800), 1);
  assert.equal(autoUiScale(1920, 1040), 1);
});

test('above 1920 wide the UI grows with the window, capped at 2x', () => {
  assert.equal(autoUiScale(2560, 1400), 1.33);
  assert.equal(autoUiScale(3840, 2100), 2);
  assert.equal(autoUiScale(5120, 2880), 2);
});

test('a wide but short window is limited by its height', () => {
  assert.equal(autoUiScale(2560, 1100), 1.1);
  assert.equal(autoUiScale(3840, 900), 1);
});
