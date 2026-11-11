import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConfigCatalog, ConfigOptionDef, ConfigState } from '@pom/protocol';
import { buildCards, changedCount, checkEditValue, isChanged, isSegmented, parseNumberText, sanitizeNumber, stripCodes } from '../src/shared/configLogic.js';
import { compareStats, formatSigned } from '../src/shared/statCompare.js';

const opt = (o: Partial<ConfigOptionDef> & { var?: string; section: string; type: ConfigOptionDef['type']; label: string }): ConfigOptionDef => ({ index: 0, conditions: {}, showAllExcluded: false, ...o });

const catalog: ConfigCatalog = {
  sections: [
    { title: 'Custom Modifiers', col: 1 },
    { title: 'General', col: 1 },
    { title: 'Skill Options', col: 2 },
  ],
  options: [
    opt({ var: 'conditionMoving', section: 'General', type: 'check', label: 'Are you always moving?', conditions: { ifCond: 'Moving' } }),
    opt({ var: 'bandit', section: 'General', type: 'list', label: 'Bandit quest:', list: [{ val: 'None', label: 'Kill all' }, { val: 'Oak', label: 'Help Oak' }], defaultIndex: 1 }),
    opt({ section: 'Skill Options', type: 'label', label: 'Cyclone:' }),
    opt({ var: 'cycloneStages', section: 'Skill Options', type: 'count', label: 'Stages:', conditions: { ifSkill: 'Cyclone' }, showAllExcluded: true }),
    opt({ var: 'x', section: 'Skill Options', type: 'check', label: 'Hidden unless set', hideIfInvalid: true, showAllExcluded: true, conditions: { ifFlag: 'a' } }),
  ],
};

const state = (over: Partial<ConfigState> = {}): ConfigState => ({
  sets: [{ id: 1, title: 'Default', changed: 0 }],
  activeSet: 1,
  values: {},
  placeholders: {},
  defaults: { bandit: 'None', conditionMoving: false },
  shown: { conditionMoving: false, bandit: true, cycloneStages: true, x: false },
  dynamicTooltips: {},
  customMods: [],
  ...over,
});

test('colour codes are stripped', () => {
  assert.equal(stripCodes('Low ^xE05030Life ^7now ^3x'), 'Low Life now x');
});

test('only options whose conditions pass show, and the sub-label follows its option', () => {
  const cards = buildCards(catalog, state(), { q: '', showAll: false, onlyChanged: false });
  const titles = cards.map((c) => c.section.title);
  assert.deepEqual(titles, ['General', 'Skill Options', 'Custom Modifiers']);
  assert.deepEqual(cards[0]!.rows.map((r) => r.opt.var), ['bandit']);
  assert.deepEqual(cards[1]!.rows.map((r) => (r.kind === 'sub' ? 'sub' : r.opt.var)), ['sub', 'cycloneStages']);
});

test('Show All lets an unused option through, but not an excluded one', () => {
  const cards = buildCards(catalog, state({ shown: { conditionMoving: false, bandit: true, cycloneStages: false, x: false } }), { q: '', showAll: true, onlyChanged: false });
  const general = cards.find((c) => c.section.title === 'General')!;
  const moving = general.rows.find((r) => r.kind === 'row' && r.opt.var === 'conditionMoving');
  assert.ok(moving && moving.kind === 'row' && moving.notUsed);
  assert.ok(!cards.some((c) => c.section.title === 'Skill Options'), 'showAllExcluded and hideIfInvalid stay hidden');
});

test('an option set to a non-default value shows as invalid when its conditions fail, unless hideIfInvalid', () => {
  const s = state({ values: { conditionMoving: true, x: true } });
  const cards = buildCards(catalog, s, { q: '', showAll: false, onlyChanged: false });
  const moving = cards[0]!.rows.find((r) => r.kind === 'row' && r.opt.var === 'conditionMoving');
  assert.ok(moving && moving.kind === 'row' && moving.invalid && moving.changed);
  assert.ok(!cards.some((c) => c.section.title === 'Skill Options' && c.rows.some((r) => r.kind === 'row' && r.opt.var === 'x')));
});

test('changed means different from the default, a placeholder counts as the default', () => {
  const b = catalog.options[1]!;
  assert.equal(isChanged(b, state({ values: { bandit: 'None' } })), false);
  assert.equal(isChanged(b, state({ values: { bandit: 'Oak' } })), true);
  const n = catalog.options[3]!;
  assert.equal(isChanged(n, state({ values: { cycloneStages: 0 } })), false);
  assert.equal(isChanged(n, state({ values: { cycloneStages: 0 }, placeholders: { cycloneStages: 5 } })), true);
});

test('search and only-changed filter rows', () => {
  const s = state({ values: { bandit: 'Oak' } });
  assert.equal(buildCards(catalog, s, { q: 'oak', showAll: false, onlyChanged: false }).length, 1);
  assert.equal(buildCards(catalog, s, { q: 'zzz', showAll: false, onlyChanged: false }).length, 0);
  const oc = buildCards(catalog, s, { q: '', showAll: false, onlyChanged: true });
  assert.deepEqual(oc.map((c) => c.section.title), ['General']);
  assert.equal(buildCards(catalog, s, { q: 'cyclone', showAll: false, onlyChanged: false }).length, 1);
});

test('the Custom Modifiers card shows even with no rows, unless a filter hides it', () => {
  const cards = buildCards({ ...catalog, sections: catalog.sections }, state(), { q: '', showAll: false, onlyChanged: false });
  assert.ok(cards.some((c) => c.custom));
  assert.ok(!buildCards(catalog, state(), { q: '', showAll: false, onlyChanged: true }).some((c) => c.custom));
});

test('number text is sanitised per type and parsed', () => {
  assert.equal(sanitizeNumber('count', '-12a3'), '123');
  assert.equal(sanitizeNumber('integer', '-12a3'), '-123');
  assert.equal(sanitizeNumber('float', '1.2.3'), '1.23');
  assert.equal(parseNumberText(''), null);
  assert.equal(parseNumberText('  '), null);
  assert.equal(parseNumberText('-4'), -4);
  assert.equal(parseNumberText('-'), undefined);
});

test('a switch set to its default stores nothing', () => {
  const m = catalog.options[0]!;
  assert.equal(checkEditValue(m, state(), false), null);
  assert.equal(checkEditValue(m, state(), true), true);
});

test('short lists are segmented, long ones are dropdowns', () => {
  assert.equal(isSegmented(catalog.options[1]!), true);
  assert.equal(isSegmented(opt({ var: 'l', section: 'General', type: 'list', label: 'L', list: [{ val: 1, label: 'a'.repeat(20) }, { val: 2, label: 'b'.repeat(20) }] })), false);
  const four = [1, 2, 3, 4].map((v) => ({ val: v, label: 'x' }));
  assert.equal(isSegmented(opt({ var: 'f', section: 'General', type: 'list', label: 'F', list: four })), false, 'four entries are a dropdown');
  assert.equal(isSegmented(opt({ var: 'f', section: 'General', type: 'list', label: 'F', list: four.slice(0, 3) })), true);
  const pen = ['None', 'Act 5 (-30%)', 'Act 10 (-60%)'].map((label, val) => ({ val, label }));
  assert.equal(isSegmented(opt({ var: 'f', section: 'General', type: 'list', label: 'F', list: pen })), false, 'three longer entries are a dropdown');
  const tier = ['Red', 'Yellow', 'White'].map((label, val) => ({ val, label }));
  assert.equal(isSegmented(opt({ var: 'f', section: 'General', type: 'list', label: 'F', list: tier })), true, 'three one-word entries stay segmented');
});

test('changedCount counts inputs and enabled custom groups', () => {
  const s = state({ values: { bandit: 'Oak', conditionMoving: false }, customMods: [{ title: 'a', enabled: true, text: '10% increased damage', lineOk: [true] }, { title: 'b', enabled: false, text: 'x', lineOk: [false] }] });
  assert.equal(changedCount(catalog, s), 2);
});

test('stat comparison lines use the stat format, sign and colour rule', () => {
  assert.equal(formatSigned('d', 1234.7), '+1,234');
  assert.equal(formatSigned('.1f', 12.5), '+12.5');
  assert.equal(formatSigned('.2f', 3), '+3');
  assert.equal(formatSigned('.2f%%', -1.5), '-1.5%');
  assert.equal(formatSigned('.2fs', 0.25), '+0.25s');
  const meta = [
    { id: 'TotalDPS', label: 'Hit DPS', fmt: '.1f', compPercent: true },
    { id: 'WarcryCastTime', label: 'Cast Time', fmt: '.2fs', lowerIsBetter: true },
    { id: 'CritMultiplier', label: 'Crit Multiplier', fmt: 'd%%', pc: true },
  ];
  const lines = compareStats(
    [
      { statId: 'TotalDPS', label: '', before: 1000, after: 1100 },
      { statId: 'WarcryCastTime', label: '', before: 1, after: 0.8 },
      { statId: 'CritMultiplier', label: '', before: 1.5, after: 1.5 },
      { statId: 'Unlisted', label: '', before: 1, after: 2 },
    ],
    meta,
  );
  assert.equal(lines.length, 2);
  // A change below 0.001 is rounding noise, not a line.
  assert.equal(compareStats([{ statId: 'TotalDPS', label: '', before: 1000, after: 1000.0005 }], meta).length, 0);
  assert.deepEqual(lines[0], { value: '+100', label: 'Hit DPS', positive: true, percent: ' (+10.0%)' });
  assert.deepEqual(lines[1], { value: '-0.2s', label: 'Cast Time', positive: true });
});
