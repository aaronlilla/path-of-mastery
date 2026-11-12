// Release review (Claude, low): a failed save left "Save failed" in the sidebar after Back + Don't Save, and the same build
// showed it again when reopened. Opening or closing a build now clears the status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSaveReducer, saveStatusLabel, type BuildSave } from '../src/renderer/saveStatus.js';

test('Save failed, Back, Don\'t Save, reopen the same build: the sidebar no longer says Save failed', () => {
  let s: BuildSave = null;
  s = buildSaveReducer(s, { kind: 'saving', id: 'a.xml' });
  s = buildSaveReducer(s, { kind: 'failed', id: 'a.xml' });
  assert.equal(saveStatusLabel(s, 'a.xml', true, false), 'Save failed');
  s = buildSaveReducer(s, { kind: 'open-changed' }); // Back + Don't Save closes the build
  s = buildSaveReducer(s, { kind: 'open-changed' }); // reopening it
  assert.equal(saveStatusLabel(s, 'a.xml', false, false), 'Saved on this PC');
});
