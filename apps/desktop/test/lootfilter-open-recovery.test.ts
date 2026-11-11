// Regression: "Open recovery file" ran the general importer, so a rule pack picked by mistake was appended to
// the open filter before the app said "That is not a recovery file." Now nothing is imported unless the file is a recovery file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRecovery } from '../src/renderer/lootfilter/recovery.js';

test('a rule pack through Open recovery file imports nothing and shows the error', async () => {
  const imported: string[] = [];
  const toasts: { text: string; kind: string }[] = [];
  // Stands in for importAny: a rule pack would be appended to the open filter, which is the state change under test.
  const importAny = async (name: string) => { imported.push(name); return { kind: 'pack', message: 'Added 1 rule.' }; };
  const pack = JSON.stringify({ pomrules: 1, name: 'My rules', rules: [{ id: 'r1' }] });
  await openRecovery({ name: 'my.pomrules', text: pack }, importAny, (t) => toasts.push(t));
  assert.deepEqual(imported, [], 'importAny was not called');
  assert.deepEqual(toasts, [{ text: 'That is not a recovery file.', kind: 'error' }]);
});

test('a real recovery file still goes through the importer', async () => {
  const toasts: { text: string; kind: string }[] = [];
  const setup = { strictness: 2, style: 0 };
  const recovery = JSON.stringify({ version: 1, activeId: 'f1', filters: [{ id: 'f1', name: 'Mine', rules: [], setup }] });
  await openRecovery({ name: 'r.json', text: recovery }, async () => ({ kind: 'recovery', message: 'Opened.' }), (t) => toasts.push(t));
  assert.deepEqual(toasts, [{ text: 'Opened.', kind: 'ok' }]);
});
