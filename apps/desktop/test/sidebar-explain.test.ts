import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CalcViewSection } from '@pom/protocol';
import { mainSkillProbeKey, mainSkillProbeXml } from '../src/shared/mainSkillProbe.js';
import { buildBreakdownIndex, hasBreakdown, statBreakdownKey, statDetails } from '../src/shared/statBreakdown.js';
import { STAT_MEANING } from '../src/shared/statMeaning.js';

test('every stat of the original display list has a meaning for its tooltip', () => {
  const src = readFileSync(join(process.cwd(), 'src/renderer/displayStatsData.ts'), 'utf8');
  const ids = new Set<string>();
  for (const m of src.matchAll(/\{ stat: "([A-Za-z0-9_.]+)"(?:, childStat: "([A-Za-z0-9_]+)")?, label:/g)) ids.add(m[2] ? `${m[1]}.${m[2]}` : m[1]!);
  const missing = [...ids].filter((id) => !STAT_MEANING[id]);
  assert.ok(ids.size > 100);
  assert.deepEqual(missing, []);
});

const BUILD = [
  '<PathOfBuilding><Build mainSocketGroup="2"/><Skills>',
  '<Skill mainActiveSkill="2" mainActiveSkillCalcs="1"><Gem skillId="A" skillPart="2" skillPartCalcs="1" skillStageCount="5" skillMinion="Spectre1" skillMinionSkill="3"/></Skill>',
  '<Skill mainActiveSkill="1"><Gem skillId="B" skillMineCount="4" skillMineCountCalcs="9"/></Skill>',
  '</Skills><Calcs><Input name="skill_number" number="1"/></Calcs></PathOfBuilding>',
].join('');

test('the probe text makes the Calcs tab describe the main skill', () => {
  const out = mainSkillProbeXml(BUILD, 2);
  assert.match(out, /<Input name="skill_number" number="2"\/>/);
  assert.match(out, /mainActiveSkillCalcs="2"/);
  assert.match(out, /skillPartCalcs="2"/);
  assert.match(out, /skillStageCountCalcs="5"/);
  assert.match(out, /skillMinionCalcs="Spectre1"/);
  assert.match(out, /skillMinionSkillCalcs="3"/);
  assert.match(out, /skillMineCountCalcs="4"/);
  assert.doesNotMatch(out, /skillMineCountCalcs="9"/);
  // A choice the main skill does not have is removed from the Calcs copy too.
  assert.doesNotMatch(mainSkillProbeXml('<Skill mainActiveSkill="1"><Gem skillPartCalcs="3"/></Skill>', 1), /skillPartCalcs/);
});

test('the probe key changes with the main skill and not with other edits', () => {
  const a = mainSkillProbeKey(BUILD, 1, 1, '<Skill/>');
  assert.equal(a, mainSkillProbeKey(BUILD.replace('<Build', '<Build level="5"'), 1, 1, '<Skill/>'));
  assert.notEqual(a, mainSkillProbeKey(BUILD, 1, 2, '<Skill/>'));
  assert.notEqual(a, mainSkillProbeKey(BUILD, 1, 1, '<Skill skillPart="2"/>'));
  assert.notEqual(a, mainSkillProbeKey(BUILD + '<Spectre id="X"/>', 1, 1, '<Skill/>'));
});

const row = (cells: Array<Array<Record<string, unknown>>>) => ({ label: null, cells: cells.map(() => ''), cellIdx: cells.map((_, i) => i), cols: cells.length, cellDetails: cells, bgCol: null, color: null, textSize: null });
const SECTIONS = [
  {
    id: 'Life',
    enabled: true,
    width: 1,
    group: 1,
    colour: null,
    shown: true,
    subSections: [
      {
        label: 'Life',
        extra: null,
        collapsed: false,
        columns: null,
        rows: [
          row([[{ label: 'Base from Gear', modName: ['Life'], modType: 'BASE', modSource: 'Item' }, { label: 'Total', breakdown: 'Life' }]]),
          row([[{ label: 'Inc. from Tree', modName: ['Life'], modType: 'INC', modSource: 'Tree' }]]),
        ],
      },
    ],
  },
] as unknown as CalcViewSection[];

test('a sidebar stat finds its breakdown the way the original does', () => {
  const idx = buildBreakdownIndex(SECTIONS);
  const tables = { Life: ['1276 ^8(base)', '= 1786'], Empty: [] as string[] };
  assert.equal(statBreakdownKey({ stat: 'Life' }, tables), 'Life');
  assert.equal(statBreakdownKey({ stat: 'Empty' }, tables), null);
  assert.equal(statBreakdownKey({ stat: 'Nope' }, tables), null);
  assert.equal(statBreakdownKey({ stat: 'Life', breakdown: 'Other', modNames: ['Life'] }, tables), 'Other');
  const d = statDetails({ stat: 'Life', modNames: ['Life'], ignoredSections: ['Total'] }, 'Life', idx);
  // The cell's own entries, then the modifier tables of the named modifier; the ignored section is dropped.
  assert.deepEqual(d.map((x) => x.label), ['Base from Gear', 'Inc. from Tree']);
  assert.deepEqual(statDetails({ stat: 'X', modNames: ['X'] }, 'X', idx), [{ breakdown: 'X' }, { modName: ['X'] }]);
  assert.ok(hasBreakdown({ rowList: [1] }));
  assert.ok(!hasBreakdown({ rowList: [] }));
});
