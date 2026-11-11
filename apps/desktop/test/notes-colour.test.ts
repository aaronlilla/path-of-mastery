// Regression: colour runs are closed with ^7 when written, as upstream's own colour buttons do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNotes, serializeNotes } from '../src/shared/notesColour.js';

test('a coloured run at the end of the notes is closed with ^7', () => {
  assert.equal(serializeNotes([{ text: 'hello', code: '^x8888FF' }], true), '^x8888FFhello^7');
});

test('a colour followed by default text is closed once, not twice', () => {
  assert.equal(serializeNotes([{ text: 'a', code: '^xB97123' }, { text: 'b', code: null }], true), '^xB97123a^7b');
});

test('plain notes get no code, and reading then writing is stable', () => {
  assert.equal(serializeNotes([{ text: 'x', code: '^x8888FF' }]), '^x8888FFx', 'default stays exact for round trips');
  assert.equal(serializeNotes([{ text: 'plain', code: null }], true), 'plain');
  const once = serializeNotes(parseNotes('^x8888FFhello^7'), true);
  assert.equal(once, '^x8888FFhello^7');
  assert.equal(serializeNotes(parseNotes(once), true), once);
});
