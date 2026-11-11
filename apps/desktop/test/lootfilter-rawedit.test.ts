import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Rule } from '../src/shared/lootfilter/types.js';
import { isEditable, rulesToText, textToRules } from '../src/renderer/lootfilter/advanced/raw/convert.js';

const tierStyle = () => undefined;
const guided: Rule = { id: 'g1', name: 'Make stand out: Scroll of Wisdom', source: 'guided', enabled: true, priority: 3, visibility: 'show', style: { fs: 45 }, targets: [{ conditions: [{ key: 'BaseType', op: '==', values: ['Scroll of Wisdom'] }] }], guided: { sel: [{ t: 'item', name: 'Scroll of Wisdom' }], exc: [], act: 'standout' }, why: 'You asked.' };
const adv: Rule = { id: 'a1', name: 'Keep 4 or more links', source: 'advanced', enabled: true, priority: 2, visibility: 'show', style: { fs: 32 }, targets: [{ conditions: [{ key: 'LinkedSockets', op: '>=', values: ['4'] }] }] };
const tier: Rule = { id: 't1', name: 'Quieter B tier', source: 'advanced', enabled: true, priority: 1, style: { sound: null }, targets: [{ tag: { type: 'currency', tier: 't3annul' } }] };
const off: Rule = { ...adv, id: 'o1', name: 'Switched off', enabled: false };
const rules = [guided, adv, tier, off];
let n = 0;
const ctx = (existing: Rule[]) => ({ newId: (p: string) => `${p}${++n}`, existing, baseAbove: Math.max(0, ...existing.filter((r) => !isEditable(r)).map((r) => r.priority)), tierStyle });

test('the text holds every rule that can be plain blocks, Guided ones included, and leaves the others out', () => {
  const t = rulesToText(rules, tierStyle, 'My filter', 'Kaelen');
  assert.ok(t.startsWith('# Your rules · My filter\n# Build: Kaelen\n'));
  assert.ok(t.includes('Show # Make stand out: Scroll of Wisdom'));
  assert.ok(t.includes('Show # Keep 4 or more links'));
  assert.ok(!t.includes('Quieter B tier'), 'a tier restyle writes no block of its own');
  assert.ok(!t.includes('Switched off'), 'a rule that is off is not in the text');
  assert.ok(t.indexOf('Make stand out') < t.indexOf('Keep 4 or more'), 'highest priority first');
});

test('saving the text unchanged keeps every rule whole, and an edit keeps only that block as a new rule', () => {
  const t = rulesToText(rules, tierStyle, 'My filter');
  const same = textToRules(t, ctx(rules));
  assert.ok(same.ok);
  const g = same.rules.find((r) => r.id === 'g1')!;
  assert.equal(g.source, 'guided', 'a Guided rule the text did not touch stays a Guided rule');
  assert.ok(g.guided, 'and can still be reopened in Guided');
  assert.equal(g.why, 'You asked.');

  const edited = t.replace('SetFontSize 32', 'SetFontSize 40') + '\nShow # Test rule\n\tBaseType == "Chaos Orb"\n\tSetFontSize 40\n';
  const r = textToRules(edited, ctx(rules));
  assert.ok(r.ok);
  assert.equal(r.rules.length, 3);
  assert.equal(r.rules.find((x) => x.id === 'g1')!.source, 'guided', 'the untouched Guided rule is still whole');
  const links = r.rules.find((x) => x.name === 'Keep 4 or more links')!;
  assert.equal(links.id, 'a1', 'an edited block keeps its rule id');
  assert.equal(links.style?.fs, 40);
  const fresh = r.rules.find((x) => x.name === 'Test rule')!;
  assert.equal(fresh.source, 'advanced');
  assert.ok(fresh.priority < links.priority, 'new blocks sit below the ones above them in the text');
});

test('text the game would refuse is not saved, and the answer names the line', () => {
  const t = rulesToText(rules, tierStyle, 'My filter') + '\nShow # Bad\n\tBaseType == "Chaos Orb"\n\tFoo bar\n';
  const r = textToRules(t, ctx(rules));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0]!.message, /Foo/);
    assert.equal(t.split('\n')[r.errors[0]!.line - 1], '\tFoo bar');
  }
});
