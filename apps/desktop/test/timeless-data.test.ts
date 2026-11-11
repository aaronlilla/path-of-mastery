import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jewelItemText, parseRows, pickNode, rowsToText, setRowWeights, sliderValuesOf, tradeRange, tradeUrl, weightsOf, weightText } from '../src/renderer/timeless/timelessData.js';

test('weight rows split on commas and white space, one row per line', () => {
  assert.deepEqual(parseRows('a_node, 1, 0.5, 0\r\n\r\nb_node 2   0 required\n'), [
    ['a_node', '1', '0.5', '0'],
    ['b_node', '2', '0', 'required'],
  ]);
  assert.equal(rowsToText(parseRows('a, 1,0,0')), 'a, 1, 0, 0');
});

test('moving a slider rewrites only the row of the selected node', () => {
  const text = 'a, 1, 0, 0\nb, 2, 1, 5';
  const next = setRowWeights(text, 'b', weightsOf({ w1: 3.14159, w2: 0, min: 500 }));
  assert.equal(next, 'a, 1, 0, 0\nb, 3.142, 0, required');
  assert.equal(setRowWeights(text, 'missing', ['1', '1', '0']), text);
});

test('picking a node loads an existing row or appends a new one', () => {
  const text = 'a, 1, 0, 0';
  const known = pickNode(text, 'a', ['9', '9', '9']);
  assert.equal(known.text, text);
  assert.deepEqual(known.existing, ['a', '1', '0', '0']);
  const added = pickNode(text, 'c', ['1', '0.5', '0']);
  assert.equal(added.text, 'a, 1, 0, 0\nc, 1, 0.5, 0');
  assert.equal(pickNode('', 'c', ['1', '1', '0']).text, 'c, 1, 1, 0');
});

test('slider values read back from a row, "required" meaning the top of the range', () => {
  assert.deepEqual(sliderValuesOf(['n', '2.5', 'required', 'required']), { w1: 2.5, w2: 10, min: 500 });
  assert.deepEqual(sliderValuesOf(['n', '99', '-3', '40']), { w1: 10, w2: 0, min: 40 });
  assert.equal(weightText(0.30000000000000004), '0.3');
});

test('the jewel item carries the seed, the roll label and the chosen conqueror', () => {
  const row = { seed: 2844, totalText: '71', socketLabel: null };
  const gv = jewelItemText({ jewelType: 1, conqueror: 3, devotion1: 1, devotion2: 1 }, row, 'Marauder').text;
  assert.match(gv, /^Glorious Vanity \[2844; 71; Marauder\]\nTimeless Jewel\n/);
  assert.match(gv, /Selected Variant: 2\n/);
  assert.match(gv, /\{variant:2\}Bathed in the blood of 2844 sacrificed in the name of Xibaqua/);
  const any = jewelItemText({ jewelType: 5, conqueror: 1, devotion1: 1, devotion2: 1 }, { ...row, socketLabel: '# Iron Will: 6230' }, '').text;
  assert.match(any, /^Elegant Hubris \[2844; 71; # Iron Will: 6230\]/);
  assert.match(any, /Selected Variant: 1\n/);
});

test('Militant Faith picks two different devotion modifiers and keeps them for the same row', () => {
  const row = { seed: 2000, totalText: '70', socketLabel: null };
  const first = jewelItemText({ jewelType: 4, conqueror: 2, devotion1: 1, devotion2: 1 }, row, 'x');
  assert.ok(first.alt && first.alt.a !== first.alt.b);
  const again = jewelItemText({ jewelType: 4, conqueror: 2, devotion1: 1, devotion2: 1 }, row, 'x', first.alt);
  assert.equal(again.text, first.text);
  const chosen = jewelItemText({ jewelType: 4, conqueror: 2, devotion1: 7, devotion2: 9 }, row, 'x');
  assert.match(chosen.text, /Selected Alt Variant: 9\nSelected Alt Variant Two: 11\n/);
});

test('trade link: one filter per seed and conqueror, devotion modifiers as a second group', () => {
  const url = tradeUrl({ jewelType: 4, conqueror: 1, devotion1: 2, devotion2: 1, seeds: [2000, 2001], tradeType: 0, realm: 'PC', league: 'Standard' });
  assert.ok(url.startsWith('https://www.pathofexile.com/trade/search/Standard/?q='));
  const q = JSON.parse(decodeURIComponent(url.split('?q=')[1]!));
  assert.equal(q.query.stats[0].filters.length, 6);
  assert.deepEqual(q.query.stats[1], { filters: [{ id: 'explicit.stat_2566390555' }], type: 'and' });
  assert.equal(q.query.status.option, 'securable');
  const xbox = tradeUrl({ jewelType: 1, conqueror: 2, devotion1: 1, devotion2: 1, seeds: [5], tradeType: 4, realm: 'Xbox', league: 'Standard' });
  assert.ok(xbox.includes('/search/xbox/Standard/'));
});

test('trade rows: the selected row on, then the next batch, or a shift-click range', () => {
  assert.deepEqual(tradeRange({ count: 100, sel: 1, highlight: null, more: false, conqueror: 1, last: null }), { start: 1, end: 4, seedCount: 4 });
  assert.deepEqual(tradeRange({ count: 100, sel: 1, highlight: null, more: false, conqueror: 1, last: [1, 4] }), { start: 5, end: 8, seedCount: 4 });
  assert.deepEqual(tradeRange({ count: 100, sel: 10, highlight: 4, more: false, conqueror: 2, last: null }), { start: 4, end: 10, seedCount: 7 });
  assert.equal(tradeRange({ count: 4, sel: 1, highlight: null, more: false, conqueror: 1, last: [1, 4] }), null);
});
