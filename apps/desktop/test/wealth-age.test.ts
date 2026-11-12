import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtAgo, fmtOld } from '../src/shared/wealth.js';

const MIN = 60_000;
const H = 60 * MIN;

test('an age reads correctly at every size', () => {
  assert.equal(fmtAgo(0), 'just now');
  assert.equal(fmtAgo(20_000), 'just now');
  assert.equal(fmtAgo(MIN), '1 min ago');
  assert.equal(fmtAgo(45 * MIN), '45 min ago');
  assert.equal(fmtAgo(2 * H), '2 h ago');
  assert.equal(fmtAgo(23 * H), '23 h ago');
  assert.equal(fmtAgo(30 * H), 'yesterday');
  assert.equal(fmtAgo(3 * 24 * H), '3 d ago');
});

test('"old" ages never say "just now old"', () => {
  assert.equal(fmtOld(0), 'fetched just now');
  assert.equal(fmtOld(4 * MIN), '4 min old');
  assert.equal(fmtOld(30 * H), 'a day old');
  assert.equal(fmtOld(3 * 24 * H), '3 d old');
});

test('the price-failure banner shows while stale prices stay on screen', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/renderer/wealth/WealthApp.tsx', import.meta.url), 'utf8');
  assert.match(src, /showPriceNote && w\.prices\.failed && !w\.prices\.loading\) items\.push/);
  assert.doesNotMatch(src, /!w\.prices\.ok \|\| w\.prices\.lines === 0\)\) items\.push/);
});

test('connecting to a different league fetches that league\'s prices at once', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/main/wealth/service.ts', import.meta.url), 'utf8');
  assert.match(src, /const leagueChanged = !!this\.st\.league && this\.st\.league !== league;/);
  assert.match(src, /if \(leagueChanged\) \{[\s\S]*?void this\.refreshPrices\(\);/);
});

test('breakdown percentages always add up to 100', async () => {
  const { sharesOf } = await import('../src/shared/wealth.js');
  for (const v of [[1, 1, 1], [33.4, 33.3, 33.3], [5, 3, 2, 1], [70, 20, 10], [0.2, 99.8]]) assert.equal(sharesOf(v).reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(sharesOf([0, 0]), [0, 0]);
});
