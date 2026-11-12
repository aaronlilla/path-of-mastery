// One metric word. The panel (a React file node can't load here) is read as text; the tool text is the real schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SolveGoalSchema } from '../src/main/assistant/solve.js';

const panel = readFileSync(fileURLToPath(new URL('../../src/renderer/assistant/SolvePanel.tsx', import.meta.url)), 'utf8');

test('default metric is dps, full is Full DPS, tool text names both', () => {
  assert.match(panel, /targets: \[\s*\{ name: 'DPS', metric: 'dps'/);
  assert.match(panel, /\{ value: 'dps', label: tr\('h_c_Solve\.dps_single'\) \}/);
  assert.match(panel, /\{ value: 'full', label: label\('Full DPS'\) \}/);
  assert.doesNotMatch(panel, /\{ value: 'combined'/);
  const text = SolveGoalSchema.shape.targets.unwrap().element.shape.metric.description ?? '';
  assert.match(text, /dps \(default/);
  assert.match(text, /full \(Full DPS/);
});
