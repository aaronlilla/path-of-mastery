// The Export checklist, the status bar and the Advanced diagnostics read one list of warnings, so they show one number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateFilter } from '../src/shared/lootfilter/generate.js';
import { parseBlocks } from '../src/shared/lootfilter/blocks.js';
import { validateFilter, MAX_FILTER_BYTES } from '../src/shared/lootfilter/syntax.js';
import { allWarnings } from '../src/shared/lootfilter/warnings.js';
import { diagnose, diagSummary } from '../src/shared/lootfilter/yourRules.js';
import type { Condition, Rule } from '../src/shared/lootfilter/types.js';
import { NEVERSINK_DIR } from './lootfilterHelpers.js';

const base = readFileSync(join(NEVERSINK_DIR, '2-SEMI-STRICT.filter'), 'utf8');
const rule = (id: string, priority: number, conditions: Condition[], visibility: 'show' | 'hide', extra: Partial<Rule> = {}): Rule => ({ id, name: id, source: 'advanced', enabled: true, priority, targets: [{ conditions }], visibility, ...extra });
const bt = (name: string): Condition => ({ key: 'BaseType', op: '==', values: [name] });
const cnd = (key: string, op: string, v: string): Condition => ({ key, op, values: [v] });

const RULES: Rule[] = [
  rule('loud', 9, [bt('Divine Orb')], 'show', { style: { sound: { kind: 'custom', file: 'Divine.mp3', vol: 200 } } }),
  rule('never', 8, [bt('Chaos Orb'), cnd('ItemLevel', '>=', '90'), cnd('ItemLevel', '<=', '80')], 'show'),
  rule('newer', 7, [bt('Orb of Alchemy')], 'show'),
  rule('older', 6, [bt('Orb of Alchemy')], 'hide'),
  rule('bigstack', 5, [bt('Exalted Orb'), cnd('StackSize', '>=', '5')], 'hide'),
  rule('any', 4, [bt('Exalted Orb')], 'show'),
];

function run(rules: Rule[]) {
  const g = generateFilter({ baseText: base, baseVersion: '8.20.1d', strictness: 2, style: 0, rules, now: new Date('2026-09-30T12:00:00Z') });
  const blocks = parseBlocks(g.text).blocks;
  const v = validateFilter(g.text);
  const warnings = allWarnings({
    blocks,
    text: g.text,
    bytes: g.bytes,
    maxBytes: MAX_FILTER_BYTES,
    exists: () => false,
    ruleName: (id) => rules.find((r) => r.id === id)?.name,
    issues: v.issues,
    needsReview: g.needsReview,
    idle: [],
  });
  return { g, blocks, v, warnings };
}

test('a filter with a missing sound, an unreachable rule, a hidden rule and a partly skipped rule lists all four kinds', () => {
  const { warnings } = run(RULES);
  const kinds = new Set(warnings.map((w) => w.kind));
  for (const k of ['sound', 'unreachable', 'shadowed', 'partial'] as const) assert.ok(kinds.has(k), `${k} is listed (${[...kinds].join(', ')})`);
  assert.equal(new Set(warnings.map((w) => w.id)).size, warnings.length, 'no warning is listed twice');
  const hidden = warnings.filter((w) => w.kind === 'shadowed');
  assert.equal(hidden.length, 1, 'a rule hidden by an earlier rule appears once, not once per check');
  for (const w of warnings.filter((x) => x.kind !== 'sound')) assert.ok(w.ruleId, `${w.kind} has a rule to jump to`);
});

test('the Advanced diagnostics add up to the same number of warnings', () => {
  const { g, blocks, v, warnings } = run(RULES);
  const total = (scope: 'rules' | 'file', lineOf: (n: number) => number | null) =>
    diagSummary(diagnose({ blocks, issues: v.issues, rules: RULES, baseStartLine: g.baseStartLine, bytes: g.bytes, universe: [], lineOf, scope, warnings }));
  const want = `${v.errors} errors · ${warnings.length} warnings`;
  assert.equal(total('file', (n) => n), want);
  // The "your rules" view numbers lines differently and has no line for NeverSink's part: the count is still the same.
  assert.equal(total('rules', (n) => (n < g.baseStartLine ? n : null)), want);
});

test('a filter with no problems lists no warnings', () => {
  const { warnings } = run([rule('fine', 1, [bt('Chaos Orb')], 'show')]);
  assert.deepEqual(warnings.filter((w) => w.kind !== 'sound'), []);
});
