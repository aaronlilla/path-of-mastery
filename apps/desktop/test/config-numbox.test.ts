// Regression: Escape in a number box gives the typed text up instead of committing it, and a typed 0 still reads 0.
// The component needs a DOM, so this pins the two guards in its source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../../src/renderer/ConfigParts.tsx', import.meta.url)), 'utf8');

test('Escape marks the box so the blur that follows does not commit the typed text', () => {
  assert.match(src, /escaped\.current = true;\s*setText\(shown\)/);
  assert.match(src, /if \(escaped\.current\) \{[\s\S]*?return;\s*\}\s*commit\(e\.target\.value\)/);
});

test('a typed 0 on an option whose default is 0 keeps showing 0', () => {
  assert.match(src, /zero \? '0' : ''/);
  assert.match(src, /setZero\(n === 0\)/);
  assert.match(src, /const cur = value \?\? \(zero \? 0 : undefined\)/);
});

test('the config tab leaves Escape to an open dialog', () => {
  const c = readFileSync(fileURLToPath(new URL('../../src/renderer/ConfigTab.tsx', import.meta.url)), 'utf8');
  assert.match(c, /document\.querySelector\('\.dialog'\)\) return;/);
});

test('a new gem takes the Default gem quality of Settings when the build has none', () => {
  const t = readFileSync(fileURLToPath(new URL('../../src/renderer/SkillsTab.tsx', import.meta.url)), 'utf8');
  assert.match(t, /buildDefault \|\| getAppSettings\(\)\.defaultGemQuality/);
  assert.equal((t.match(/quality: newGemQuality\(opts\.defaultGemQuality\)/g) ?? []).length, 2);
});

test('with the engine down the Config tab shows its own "No configuration yet." note', () => {
  const w = readFileSync(fileURLToPath(new URL('../../src/renderer/BuildWorkspace.tsx', import.meta.url)), 'utf8');
  assert.match(w, /\(!problem \|\| p\.tab === 'config'\) && keep\('config'/);
});

test('the config tooltip keeps its "Toggling this option will give you:" header when nothing changes', () => {
  const p = readFileSync(fileURLToPath(new URL('../../src/renderer/ConfigParts.tsx', import.meta.url)), 'utf8');
  assert.match(p, /lines && \(lines\.length > 0 \|\| spec\.compare\)/);
});

test('copying or adding a config set and activating it is one undo step', () => {
  const c = readFileSync(fileURLToPath(new URL('../../src/renderer/ConfigTab.tsx', import.meta.url)), 'utf8');
  assert.match(c, /op: 'activate', id: n\.id, amend: true/);
  const h = readFileSync(fileURLToPath(new URL('../../src/engine-host/main.ts', import.meta.url)), 'utf8');
  assert.match(h, /\(edit as \{ amend\?: boolean \}\)\.amend \? \{ amend: true \} : \{\}/);
});

test('a click on the Export Support switch applies once, so one Ctrl Z reverts it', () => {
  const t = readFileSync(fileURLToPath(new URL('../../src/renderer/ImportExportTab.tsx', import.meta.url)), 'utf8');
  assert.match(t, /closest\('\[role="switch"\]'\)\) setSupport\(!exportSupport\)/);
});
