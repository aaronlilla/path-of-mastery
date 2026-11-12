import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search, type SearchDoc } from '../src/renderer/search/searchIndex.js';
import { answerFor, readNumber } from '../src/renderer/search/answers.js';

const stat = (title: string, meta: string): SearchDoc => ({ kind: 'Stat', title, meta, run: () => undefined });
const DOCS: SearchDoc[] = [
  stat('Fire Res.', '80% (+12%)'),
  stat('Cold Res.', '78%'),
  stat('Lightning Res.', '64%'),
  stat('Chaos Res.', '-52%'),
  stat('Freeze Avoidance', '100%'),
  stat('Poison Avoidance', '0%'),
  stat('Life', '4,639'),
];
const card = (q: string) => {
  const l = search(q, DOCS).locked;
  return l ? answerFor(l.id, l.title, l.where, q, DOCS) : null;
};

test('a res question gets the build own resistance numbers, capped and low told apart', () => {
  const a = card('am I res capped?')!;
  assert.equal(a.title, 'Resistances');
  assert.deepEqual(a.rows.map((r) => [r.label, r.value, r.tone]), [['Fire', '80% (+12%)', 'ok'], ['Cold', '78%', 'ok'], ['Lightning', '64%', 'low'], ['Chaos', '-52%', 'low']]);
});

test('the row the question names comes first and is marked', () => {
  const a = card('chaos res')!;
  assert.equal(a.rows[0]!.label, 'Chaos');
  assert.equal(a.rows[0]!.focus, true);
});

test('a row the build has no number for is left out, never invented', () => {
  const a = card('what can freeze me')!;
  assert.deepEqual(a.rows.map((r) => r.label), ['Freeze avoidance', 'Poison avoidance']);
});

test('weak points lists only the gaps', () => {
  const a = card('weak points')!;
  assert.deepEqual(a.rows.map((r) => r.label).sort(), ['Chaos', 'Lightning', 'Poison avoidance']);
});

test('no card when the build has none of the numbers', () => {
  assert.equal(card('movement speed'), null);
});

test('number readings', () => {
  assert.equal(readNumber('pct', '0%').tone, 'none');
  assert.equal(readNumber('pct', 'Immune').tone, 'ok');
  assert.equal(readNumber('pct', '41%').tone, 'part');
  assert.equal(readNumber('res', '75%').tone, 'ok');
  assert.equal(readNumber('plain', '12').status, '');
});
