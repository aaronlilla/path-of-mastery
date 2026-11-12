// An imported unique carries rolled values ("50% increased ..."); the overlay's edits are written against the catalogue's
// ranges ("(40-60)% ..."). The edit must still land, and keep the roll (clamped to the new range).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyUniqueEdits } from '../src/shared/preview.js';

const edit = { old: '(40-60)% increased Global Critical Strike Chance', new: '(70-90)% increased Global Critical Strike Chance' };

test('a rolled line is matched whatever its numbers are, and keeps its roll when the new range holds it', () => {
  assert.equal(applyUniqueEdits('Name\n80% increased Global Critical Strike Chance\n+10 to Dexterity', [edit]), 'Name\n80% increased Global Critical Strike Chance\n+10 to Dexterity');
});

test('a roll outside the new range is clamped to it', () => {
  assert.equal(applyUniqueEdits('Name\n50% increased Global Critical Strike Chance', [edit]), 'Name\n70% increased Global Critical Strike Chance');
});

test('a line with a range tag keeps its tag and takes the new range', () => {
  assert.equal(applyUniqueEdits('Name\n{range:0.5}(40-60)% increased Global Critical Strike Chance', [edit]), 'Name\n{range:0.5}(70-90)% increased Global Critical Strike Chance');
});
