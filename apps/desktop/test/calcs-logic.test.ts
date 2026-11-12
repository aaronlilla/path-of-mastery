import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CalcSkillView, CalcViewSection } from '@pom/protocol';
import { columnTitles, readSpectres, setSpectres, shownSections, breakdownBlocks, formatNumSep, groupsDigits, lookupBreakdown, readCalcsInputs, searchMatch, sectionKind, setCalcsInput, skillControls, textLines } from '../src/shared/calcsLogic.js';

const BUILD = '<PathOfBuilding><Build level="90"/><Calcs><Input name="skill_number" number="2"/><Input name="misc_buffMode" string="COMBAT"/><Section id="Life" subsection="Life" collapsed="false"/></Calcs></PathOfBuilding>';

test('the saved Calcs inputs are read from the build text', () => {
  assert.deepEqual(readCalcsInputs(BUILD), { skillNumber: 2, showMinion: false, buffMode: 'COMBAT' });
  assert.deepEqual(readCalcsInputs('<PathOfBuilding/>'), { skillNumber: 1, showMinion: false, buffMode: 'EFFECTIVE' });
});

test('setting a Calcs input replaces the old one, adds a new one, or creates the element', () => {
  const a = setCalcsInput(BUILD, 'skill_number', { number: 3 });
  assert.equal(readCalcsInputs(a).skillNumber, 3);
  assert.equal((a.match(/name="skill_number"/g) ?? []).length, 1);
  assert.ok(a.includes('<Section id="Life"'), 'sections stay');
  const b = setCalcsInput(BUILD, 'showMinion', { boolean: true });
  assert.equal(readCalcsInputs(b).showMinion, true);
  assert.equal(readCalcsInputs(b).skillNumber, 2);
  const c = setCalcsInput('<PathOfBuilding><Build level="90"/></PathOfBuilding>', 'misc_buffMode', { string: 'BUFFED' });
  assert.equal(readCalcsInputs(c).buffMode, 'BUFFED');
  assert.ok(c.endsWith('</Calcs></PathOfBuilding>'));
  const d = setCalcsInput('<PathOfBuilding><Calcs/></PathOfBuilding>', 'skill_number', { number: 4 });
  assert.equal(readCalcsInputs(d).skillNumber, 4);
});

test('numbers in popup lines get thousands separators, colour codes stay', () => {
  assert.equal(formatNumSep('12196.5 ^8(average damage)'), '12,196.5 ^8(average damage)');
  assert.equal(formatNumSep('= 1234567'), '= 1,234,567');
  assert.equal(formatNumSep('^xE05030Life 4639'), '^xE05030Life 4,639');
  assert.equal(formatNumSep('x 1.08'), 'x 1.08');
  assert.equal(formatNumSep('1234.5', { thousands: true, thousandsSeparator: ' ', decimalSeparator: ',' }), '1 234,5');
  assert.equal(formatNumSep('1234.5', { thousands: false, thousandsSeparator: ',', decimalSeparator: '.' }), '1234.5');
});

test('breakdown lookup reads Namespace.Name inside the namespace table', () => {
  const t = { Life: ['a'], MainHand: { Speed: ['1.25 ^8(base)'] } };
  assert.deepEqual(lookupBreakdown(t, 'MainHand.Speed'), ['1.25 ^8(base)']);
  assert.deepEqual(lookupBreakdown(t, 'Life'), ['a']);
  assert.equal(lookupBreakdown(t, 'Mana'), undefined);
});

test('text lines come from arrays and from objects keyed by number', () => {
  assert.deepEqual(textLines(['a', 'b']), ['a', 'b']);
  assert.deepEqual(textLines({ '2': 'b', '1': 'a', label: 'x', rowList: [] }), ['a', 'b']);
});

test('a rows table keeps its columns and sorts ailment tables by the first column, largest first', () => {
  const tbl = { source: 'x', label: 'Ignite', colList: [{ label: 'Value', key: 'val', right: true }, { label: 'Name', key: 'n' }], rowList: [{ val: 5, n: 'a' }, { val: 20, n: 'b' }] };
  const [b] = breakdownBlocks(tbl, {});
  assert.equal(b?.kind, 'table');
  if (b?.kind !== 'table') return;
  assert.deepEqual(b.rows.map((r) => r.n), ['b', 'a']);
  assert.equal(b.label, 'Ignite');
  const plain = breakdownBlocks({ ...tbl, source: undefined }, {})[0];
  assert.deepEqual(plain?.kind === 'table' ? plain.rows.map((r) => r.n) : [], ['a', 'b']);
});

test('a slots table lists every slot, or only gear when the entry asks for it', () => {
  const tbl = { slots: [{ base: 275, inc: ' x 5.75', more: false, total: '1581.25', source: 'Helmet' }, { base: 978, inc: ' x 5.75', more: false, total: '5623.50', source: 'Body Armour' }, { base: 20, inc: ' x 5.75', more: false, total: '115.00', source: 'Global' }] };
  const items = (slot: string) => (slot === 'Body Armour' ? { name: 'Carcass Jack', rarity: 'RARE', id: 3 } : null);
  const all = breakdownBlocks(tbl, {}, items)[0];
  assert.ok(all?.kind === 'table');
  if (all?.kind === 'table') {
    assert.deepEqual(all.rows.map((r) => r.source), ['Body Armour', 'Helmet', 'Global']);
    assert.equal(all.rows[0]!.sourceLabel, 'Carcass Jack');
    assert.equal(all.rows[0]!.more, undefined);
  }
  const gear = breakdownBlocks(tbl, { gearOnly: true }, items)[0];
  if (gear?.kind === 'table') assert.deepEqual(gear.rows.map((r) => r.source), ['Body Armour']);
});

test('a table cell is grouped when it is a number, a range or has parentheses', () => {
  assert.equal(groupsDigits('1234'), true);
  assert.equal(groupsDigits('53 to 160'), true);
  assert.equal(groupsDigits('Body Armour'), false);
  assert.equal(groupsDigits('x (1.5)'), true);
});

test('search matches labels without colour codes, ignoring case', () => {
  assert.equal(searchMatch('^xE05030Life Regen', 'life'), true);
  assert.equal(searchMatch('Armour', 'xe0'), false);
  assert.equal(searchMatch('Armour', ''), false);
  assert.equal(searchMatch('Life Regeneration', '^life.*ion$'), true);
  assert.equal(searchMatch('Armour', 'a[rx]m'), true);
  assert.equal(searchMatch('Armour', '(bad'), false);
});

const sec = (id: string, group: number): CalcViewSection => ({ id, enabled: true, shown: true, width: 1, group, colour: null, subSections: [] });

test('offence sections are layout group 1 except the wide Damage Taken table', () => {
  assert.equal(sectionKind(sec('Speed', 1)), 'offence');
  assert.equal(sectionKind(sec('DamageTaken', 1)), 'defence');
  assert.equal(sectionKind(sec('Life', 2)), 'defence');
});

const SKILL: CalcSkillView = { showMinion: false, buffMode: 'EFFECTIVE', skillName: 'Arc', flags: ['spell'], playerFlags: ['spell'], haveMinion: false, parts: [], part: 1, partHasStages: false, stageCount: null, stageDefault: 1, mineCount: null, minions: [], minion: null, spectre: false, minionHasItemSet: false, minionItemSet: null, lists: { buff: '', combat: '', curse: '' }, minionLists: null, minionSkills: [], minionSkill: 1 };

test('the skill controls show by the original rules', () => {
  const none = skillControls(SKILL);
  assert.equal(none.part || none.stages || none.mines || none.showMinion || none.minion, false);
  const multi = skillControls({ ...SKILL, parts: ['One', 'Two'], playerFlags: ['multiPart', 'multiStage'], partHasStages: true });
  assert.equal(multi.part, true);
  assert.equal(multi.stages, true);
  const noStages = skillControls({ ...SKILL, parts: ['One', 'Two'], playerFlags: ['multiPart', 'multiStage'], partHasStages: false });
  assert.equal(noStages.stages, false);
  const minion = skillControls({ ...SKILL, haveMinion: true, flags: ['haveMinion', 'minion'], minions: [{ id: 'a', label: 'A' }], minionSkills: ['Melee'] });
  assert.equal(minion.showMinion && minion.minion && minion.minionSkill, true);
  assert.equal(skillControls(null).part, false);
});

test('the Spectre Library is read from and written to the Build element', () => {
  const self = '<PathOfBuilding><Build level="90"/><Skills/></PathOfBuilding>';
  assert.deepEqual(readSpectres(self), []);
  const one = setSpectres(self, ['Metadata/Monster/A', 'Metadata/Monster/B']);
  assert.deepEqual(readSpectres(one), ['Metadata/Monster/A', 'Metadata/Monster/B']);
  assert.ok(one.includes('<Build level="90"><Spectre id="Metadata/Monster/A"/>'));
  const open = '<PathOfBuilding><Build level="90"><PlayerStat stat="Life" value="1"/><Spectre id="Old"/></Build><Skills/></PathOfBuilding>';
  const next = setSpectres(open, ['New']);
  assert.deepEqual(readSpectres(next), ['New']);
  assert.ok(next.includes('<PlayerStat stat="Life" value="1"/>'));
  assert.equal(setSpectres(open, []).includes('Spectre'), false);
});

const row = (label: string | null, cols: number) => ({ label, cells: ['1'], cellDetails: [[]], cellIdx: [0], cols, bgCol: null, color: null, textSize: null });
const subOf = (rows: ReturnType<typeof row>[], columns: string[] | null) => ({ label: 'X', extra: null, collapsed: false, rows, columns });

test('column titles show only for a table whose rows have none of their own', () => {
  assert.deepEqual(columnTitles(subOf([row('Ancestral Cry', 5)], ['Uptime', 'Count'])), ['Uptime', 'Count']);
  assert.equal(columnTitles(subOf([row(null, 5), row('Ancestral Cry', 5)], ['Uptime', 'Count'])), null, 'the engine already sends a header row');
  assert.equal(columnTitles(subOf([row('Life', 1)], ['Uptime', 'Count'])), null, 'single-column rows need none');
  assert.equal(columnTitles(subOf([row('Life', 5)], null)), null);
});

test('a section is drawn only when at least one of its rows passes (CalcSectionControl:UpdateSize)', () => {
  const sec = (id: string, shown: boolean): CalcViewSection => ({ id, enabled: true, shown, width: 1, group: 1, colour: null, subSections: [] });
  assert.deepEqual(shownSections([sec('Pacts', false), sec('Speed', true)]).map((s) => s.id), ['Speed']);
});

test('calcsDiffersFromMain: the Lacerate build opens with Calcs on One slash while the sidebar shows Both slashes', async () => {
  const { calcsDiffersFromMain } = await import('../src/shared/calcsLogic.js');
  assert.equal(calcsDiffersFromMain({ group: 1, active: 1, part: 2 }, { group: 1, active: 1, part: 1 }), true);
  assert.equal(calcsDiffersFromMain({ group: 1, active: 1, part: 2 }, { group: 1, active: 1, part: 2 }), false);
  assert.equal(calcsDiffersFromMain({ group: 1, active: 1, part: 1 }, { group: 2, active: 1, part: 1 }), true);
  assert.equal(calcsDiffersFromMain({ group: 1, active: 1, part: 1 }, { group: 1, active: 2, part: 1 }), true);
});

test('search filter keeps matching rows, whole sections for a title match, and original indexes', async () => {
  const { searchFilter } = await import('../src/shared/calcsLogic.js');
  const row = (label: string) => ({ label, cols: 1, cells: [''], cellDetails: [[]], cellIdx: [0] });
  const sec = (id: string, subs: [string, string[]][]) => ({ id, shown: true, subSections: subs.map(([label, rows]) => ({ label, rows: rows.map(row) })) }) as unknown as CalcViewSection;
  const f = searchFilter([sec('A', [['Defence', ['x', 'y']], ['Regen', ['Life Regen', 'z']]]), sec('B', [['Mana', ['Total']]]), sec('C', [['Armour', ['Total Life']]]), sec('D', [['Life', ['p']]])], 'life');
  assert.deepEqual([...f.keys()], ['A', 'C', 'D']);
  assert.deepEqual(f.get('A')!.get(0), undefined);
  assert.deepEqual(f.get('A')!.get(1), [0]);
  assert.deepEqual(f.get('C')!.get(0), [0]);
  assert.equal(f.get('D')!.get(0), null);
  assert.equal(searchFilter([sec('B', [['Mana', ['Total']]])], 'zzz').size, 0);
});
