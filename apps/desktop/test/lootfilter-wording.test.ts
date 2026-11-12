// One wording for the price age and for what a strictness level hides, on every screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hidesText, priceAge, strictnessCaption } from '../src/renderer/lootfilter/hidesText.js';

const NOW = 1_000_000_000_000;

test('the price age has one wording', () => {
  assert.equal(priceAge(NOW, NOW), 'just now');
  assert.equal(priceAge(NOW - 30_000, NOW), 'just now');
  assert.equal(priceAge(NOW - 60_000, NOW), '1 min ago');
  assert.equal(priceAge(NOW - 59 * 60_000, NOW), '59 min ago');
  assert.equal(priceAge(NOW - 3 * 3600_000, NOW), '3 h ago');
  assert.equal(priceAge(NOW - 72 * 3600_000, NOW), '3 days ago');
  assert.equal(priceAge(NOW + 5000, NOW), 'just now', 'a clock a little ahead is not a negative age');
});

test('what a strictness level hides reads the same everywhere, including the first level', () => {
  assert.equal(hidesText(27, 2722), 'Hides 27 of 2,722 item types');
  assert.equal(hidesText(0, 2722), 'Hides 0 of 2,722 item types');
});

test('a strictness tile caption is never empty: before the counts arrive it is a hidden stand-in in the final wording', () => {
  const h = { hidden: [27, 400, 900, 1500, 2000], total: 2722 } as unknown as Parameters<typeof strictnessCaption>[0];
  assert.deepEqual(strictnessCaption(h, 1), { text: 'Hides 400 of 2,722 item types', ready: true });
  const wait = strictnessCaption(null, 1);
  assert.equal(wait.ready, false);
  assert.match(wait.text, /^Hides [\d,]+ of [\d,]+ item types$/, 'same shape as the final text, so the tile keeps its size');
});

test('a Hide rule says how many item types it hides', async () => {
  const { hidesCount } = await import('../src/renderer/lootfilter/hidesText.js');
  assert.equal(hidesCount(1), 'Hides 1 item type');
  assert.equal(hidesCount(1234), 'Hides 1,234 item types');
});

test('every Build filter preview row carries its count, even a zero', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/renderer/lootfilter/buildfilter/PreviewColumns.tsx', import.meta.url), 'utf8');
  assert.match(src, /<span className="bf-n">\{r\.count\}<\/span>/);
  assert.doesNotMatch(src, /r\.count > 0 &&/);
});

test('Buy similar starts each modifier a little under the item roll', async () => {
  const { relaxedMin } = await import('../src/renderer/items/tradeQuery.js');
  assert.equal(relaxedMin(87.5), 78.7);
  assert.equal(relaxedMin(2), 1);
  assert.equal(relaxedMin(100), 90);
  assert.equal(relaxedMin(1), 1);
});
