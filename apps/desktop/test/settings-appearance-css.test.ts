// Regression: Density sizes the Library rows, Animations off zeroes all motion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = (f: string) => readFileSync(fileURLToPath(new URL(`../../src/renderer/${f}`, import.meta.url)), 'utf8');

test('Library rows are 36px (34 + 2px border) comfortable and 28px (26 + 2px) compact', () => {
  const lib = css('library.css');
  assert.match(lib, /:where\(\.lib\) \.row \{[^}]*height: 34px/);
  assert.match(lib, /data-density-pref="compact"\] \.lib\) \.row \{ height: 26px; \}/);
});

test('Animations off (data-reduced-motion="on") sets every transition and animation to 0s', () => {
  const t = css('design/tokens.css');
  assert.match(t, /html\[data-reduced-motion="on"\] \*[^{]*\{[^}]*transition-duration: 0s !important[^}]*animation-duration: 0s !important/);
});

test('the wheel switches are installed once, at startup', () => {
  const m = readFileSync(fileURLToPath(new URL('../../src/renderer/main.tsx', import.meta.url)), 'utf8');
  assert.equal((m.match(/installControlWheel\(/g) ?? []).length, 1);
  const a = readFileSync(fileURLToPath(new URL('../../src/renderer/appearance.ts', import.meta.url)), 'utf8');
  assert.doesNotMatch(a, /installControlWheel/);
});

test('Escape goes to a dialog that sits on top of an open popup panel', () => {
  const ui = readFileSync(fileURLToPath(new URL('../../src/renderer/ui.tsx', import.meta.url)), 'utf8');
  assert.match(ui, /compareDocumentPosition\(top\) & Node\.DOCUMENT_POSITION_PRECEDING\) return null/);
});

test('Save is refused with a message while the separators are empty or equal', () => {
  const d = readFileSync(fileURLToPath(new URL('../../src/renderer/SettingsDialog.tsx', import.meta.url)), 'utf8');
  assert.match(d, /must be different characters/);
  assert.match(d, /if \(why\) return;[\s\S]{0,300}?onSave\(changed/);
  assert.doesNotMatch(d, /onClick=\{\(\) => onSave\(draft\)\}/);
});

test('a builds folder that cannot be used shows its error in the dialog', () => {
  const d = readFileSync(fileURLToPath(new URL('../../src/renderer/SettingsDialog.tsx', import.meta.url)), 'utf8');
  assert.match(d, /else if \(!r\.ok\) setProblem\(r\.error\)/);
});
