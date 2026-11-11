import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateFilter } from '../src/shared/lootfilter/generate.js';
import { parseBlocks } from '../src/shared/lootfilter/blocks.js';
import { evaluateItem } from '../src/shared/lootfilter/evaluate.js';
import { customSounds, preflightIssues } from '../src/shared/lootfilter/preflight.js';
import type { Condition, Rule } from '../src/shared/lootfilter/types.js';
import { NEVERSINK_DIR } from './lootfilterHelpers.js';

const base = readFileSync(join(NEVERSINK_DIR, '2-SEMI-STRICT.filter'), 'utf8');

const rule = (id: string, priority: number, conditions: Condition[], visibility: 'show' | 'hide', extra: Partial<Rule> = {}): Rule => ({
  id,
  name: id,
  source: 'advanced',
  enabled: true,
  priority,
  targets: [{ conditions }],
  visibility,
  ...extra,
});
const bt = (name: string): Condition => ({ key: 'BaseType', op: '==', values: [name] });
const cnd = (key: string, op: string, v: string): Condition => ({ key, op, values: [v] });

function run(rules: Rule[], exists: (f: string) => boolean = () => true) {
  const g = generateFilter({ baseText: base, baseVersion: '8.20.1d', strictness: 2, style: 0, rules, now: new Date('2026-09-30T12:00:00Z') });
  const blocks = parseBlocks(g.text).blocks;
  const issues = preflightIssues({ blocks, text: g.text, exists, ruleName: (id) => rules.find((r) => r.id === id)?.name });
  return { g, blocks, issues };
}

test('a rule that an earlier rule already decides is reported as hidden by it, and the evaluator agrees', () => {
  // The newer rule (priority 2) is written first and shows Chaos Orbs, so the older "hide" never gets to decide.
  const { blocks, issues } = run([rule('newer', 2, [bt('Chaos Orb')], 'show'), rule('older', 1, [bt('Chaos Orb')], 'hide')]);
  const hit = issues.filter((i) => i.kind === 'shadowed');
  assert.equal(hit.length, 1);
  assert.equal(hit[0]!.ruleId, 'older');
  assert.match(hit[0]!.text, /never applies/);
  assert.match(hit[0]!.text, /line \d+/);
  // Referee: the evaluator really decides a Chaos Orb with the earlier block.
  const r = evaluateItem(blocks, { name: 'Chaos Orb', class: 'Stackable Currency', rarity: 'Normal', stackSize: 1 });
  assert.equal(r.decided?.ruleId, 'newer');
});

test('a narrower earlier rule does not hide a broader later one', () => {
  const { blocks, issues } = run([rule('narrow', 2, [bt('Chaos Orb'), cnd('StackSize', '>=', '5')], 'show'), rule('broad', 1, [bt('Chaos Orb')], 'hide')]);
  assert.equal(issues.filter((i) => i.kind === 'shadowed').length, 0);
  // Referee: a single Chaos Orb falls past the narrow rule and is decided by the broad one.
  const r = evaluateItem(blocks, { name: 'Chaos Orb', class: 'Stackable Currency', rarity: 'Normal', stackSize: 1 });
  assert.equal(r.decided?.ruleId, 'broad');
});

test('ranges: a later rule inside an earlier range is hidden, one outside is not', () => {
  const inside = run([rule('wide', 2, [bt('Divine Orb'), cnd('StackSize', '>=', '2')], 'show'), rule('inner', 1, [bt('Divine Orb'), cnd('StackSize', '>=', '4')], 'hide')]);
  assert.equal(inside.issues.filter((i) => i.kind === 'shadowed').length, 1);
  const outside = run([rule('wide', 2, [bt('Divine Orb'), cnd('StackSize', '>=', '4')], 'show'), rule('outer', 1, [bt('Divine Orb'), cnd('StackSize', '>=', '2')], 'hide')]);
  assert.equal(outside.issues.filter((i) => i.kind === 'shadowed').length, 0);
});

test('a rule whose own conditions contradict is reported as unreachable', () => {
  const { issues } = run([rule('never', 1, [bt('Chaos Orb'), cnd('ItemLevel', '>=', '90'), cnd('ItemLevel', '<=', '80')], 'show')]);
  const hit = issues.filter((i) => i.kind === 'unreachable');
  assert.equal(hit.length, 1);
  assert.equal(hit[0]!.ruleId, 'never');
  assert.match(hit[0]!.text, /ItemLevel/);
  assert.equal(run([rule('fine', 1, [bt('Chaos Orb'), cnd('ItemLevel', '>=', '60'), cnd('ItemLevel', '<=', '80')], 'show')]).issues.length, 0);
});

test('two Rarity lines with nothing in common are unreachable; overlapping ones are fine', () => {
  const bad = run([rule('r', 1, [cnd('Rarity', '==', 'Unique'), cnd('Rarity', '<', 'Rare')], 'show')]);
  assert.equal(bad.issues.filter((i) => i.kind === 'unreachable').length, 1);
  const ok = run([rule('r', 1, [cnd('Rarity', '>=', 'Magic'), cnd('Rarity', '<=', 'Rare')], 'show')]);
  assert.equal(ok.issues.length, 0);
});

test('a custom sound that is not in the game folder is reported with the rule that uses it', () => {
  const sound = { kind: 'custom' as const, file: 'Divine.mp3', vol: 200 };
  const rules = [rule('loud', 1, [bt('Divine Orb')], 'show', { style: { sound } })];
  const missing = run(rules, () => false);
  const hit = missing.issues.filter((i) => i.kind === 'sound');
  assert.equal(hit.length, 1);
  assert.equal(hit[0]!.file, 'Divine.mp3');
  assert.equal(hit[0]!.ruleId, 'loud');
  assert.match(hit[0]!.text, /Divine\.mp3 is not in the filter folder/);
  assert.equal(run(rules, (f) => f === 'Divine.mp3').issues.filter((i) => i.kind === 'sound').length, 0);
});

test('customSounds reads both the plain and the optional line, and ignores comments', () => {
  const t = 'Show\n  CustomAlertSound "a.mp3" 150\nShow\n  CustomAlertSoundOptional "b.wav"\n# CustomAlertSound "c.mp3"\n';
  assert.deepEqual(customSounds(t), [{ file: 'a.mp3', line: 2 }, { file: 'b.wav', line: 4 }]);
});

test('NeverSink alone raises none of these warnings', () => {
  const { issues } = run([]);
  assert.equal(issues.length, 0);
});
