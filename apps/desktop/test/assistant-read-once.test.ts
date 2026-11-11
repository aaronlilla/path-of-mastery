import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadOnce } from '../src/main/assistant/readOnce.js';

test('a repeat read in one answer gets a short note, until the build changes', () => {
  const r = new ReadOnce();
  r.note('t1', 'getItems', {}, 'rk1');
  assert.match(String(r.repeat('t1', 'getItems', {})?.note), /already hold this getItems result.*rk1/);
  assert.equal(r.repeat('t1', 'getItems', { slot: 'Ring 1' }), null, 'other arguments are another read');
  assert.equal(r.repeat('t2', 'getItems', {}), null, 'another answer reads again');
  r.changed();
  assert.equal(r.repeat('t1', 'getItems', {}), null, 'the build changed');
});

test('only read tools are held back', () => {
  const r = new ReadOnce();
  r.note('t1', 'proposeEdit', {});
  assert.equal(r.repeat('t1', 'proposeEdit', {}), null);
});
