import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AreaVisit } from '../src/shared/lootfilter/ipcTypes.js';
import { summarize } from '../src/shared/lootfilter/play.js';
import { levelSuggestion, visibilityChanges } from '../src/shared/lootfilter/adapt.js';

const area = (level: number, i: number): AreaVisit => ({ at: 1_000 + i, id: `MapWorlds${i}`, name: `Map ${i}`, level });
const areas = (levels: number[]) => summarize(levels.map(area));

test('mapping area levels on a loose level suggest raising strictness, and say what they are based on', () => {
  const s = levelSuggestion(areas([68, 70, 72, 70, 74, 68]), 60, 1)!;
  assert.equal(s.basis, 'areas');
  assert.equal(s.toStrictness, 2);
  assert.equal(s.line, 'Your last 6 areas were level 68 to 74, so you are mapping.');
  assert.equal(s.question, 'Raise strictness to Semi-Strict?');
  assert.equal(s.done, 'Raised strictness to Semi-Strict at area level 70');
});

test('leveling area levels on a strict level suggest lowering it', () => {
  const s = levelSuggestion(areas([30, 33, 35, 36, 40, 41, 44]), 90, 4)!;
  assert.equal(s.toStrictness, 1);
  assert.equal(s.question, 'Lower strictness to Regular?');
});

test('with no game log the build level decides, and the suggestion says so', () => {
  const s = levelSuggestion(areas([]), 84, 0)!;
  assert.equal(s.basis, 'build');
  assert.equal(s.line, 'Your build is level 84, so you are mapping.');
  assert.equal(levelSuggestion(areas([]), 40, 0), null, 'level 40 on Soft is fine');
  assert.equal(levelSuggestion(areas([]), null, 0), null, 'no log and no build: nothing to go on');
});

test('areas win over the build level, and a few areas are not enough', () => {
  assert.equal(levelSuggestion(areas([30, 31, 32, 33, 34]), 90, 1), null, 'five leveling areas on Regular: no change');
  assert.equal(levelSuggestion(areas([70, 71]), 90, 1)?.basis, 'build', 'two areas are too few, so the build is used');
});

test('visibility changes between two levels come from the counted masks', () => {
  const h = { version: 'x', total: 3, hidden: [0, 0, 1, 1, 1, 1, 1], mask: { 'Orb of Alchemy': 0b0000100, 'Scroll of Wisdom': 0b1111111, 'Chaos Orb': 0 } };
  assert.deepEqual(visibilityChanges(h, 1, 2), { hidden: ['Orb of Alchemy'], shown: [] });
  assert.deepEqual(visibilityChanges(h, 2, 1), { hidden: [], shown: ['Orb of Alchemy'] });
  assert.deepEqual(visibilityChanges(null, 1, 2), { hidden: [], shown: [] });
});
