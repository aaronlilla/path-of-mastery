import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guidedWriteButton } from '../src/shared/lootfilter/writeText.js';

test('a quick write keeps the button as it was: same icon, label and key hint', () => {
  // `busy` is the delayed flag, still false during a write that finishes under 200 ms.
  const idle = guidedWriteButton({ busy: false, firstWrite: true, pending: 0 });
  assert.deepEqual(idle, { icon: 'gamepad', label: 'Write to game', kbd: true, quiet: false });
});

test('a slow write shows the spinner and no key hint', () => {
  assert.deepEqual(guidedWriteButton({ busy: true, firstWrite: true, pending: 0 }), { icon: 'spinner', label: 'Writing…', kbd: false, quiet: true });
});

test('labels for pending changes and an up-to-date file', () => {
  assert.deepEqual(guidedWriteButton({ busy: false, firstWrite: false, pending: 3 }), { icon: 'gamepad', label: 'Write 3 changes', kbd: true, quiet: false });
  assert.equal(guidedWriteButton({ busy: false, firstWrite: false, pending: 1 }).label, 'Write 1 change');
  assert.deepEqual(guidedWriteButton({ busy: false, firstWrite: false, pending: 0 }), { icon: 'check', label: 'Written', kbd: false, quiet: true });
});
