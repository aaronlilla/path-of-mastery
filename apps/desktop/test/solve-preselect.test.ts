import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preselect } from '../src/shared/assistant/solveQuestions.js';
import { blankBuildXml } from '../src/shared/buildXml.js';

// What the form starts with when the goal names no class: the player's words, else the open build's own, else (blank build only) the most played (0.1.21 Claude review OTHER 5).

const ask = { skill: 'Poisonous Concoction', targets: [] } as never;
const blank = { className: 'Templar', ascendClassName: '', xml: blankBuildXml('Templar', 90) };
const mine = { className: 'Templar', ascendClassName: 'Inquisitor', xml: blankBuildXml('Templar', 90).replace('<SkillSet id="1" />', '<SkillSet id="1"><Skill><Gem nameSpec="Righteous Fire"/></Skill></SkillSet>') };

test('named class or ascendancy: nothing is preselected', () => {
  assert.equal(preselect({ ...(ask as object), className: 'Templar' } as never, blank, 'Pathfinder'), null);
  assert.equal(preselect({ ...(ask as object), ascendancy: 'Deadeye' } as never, mine, 'Pathfinder'), null);
});

test("an improve-my-build ask keeps the open build's class and ascendancy", () => {
  assert.deepEqual(preselect(ask, mine, 'Pathfinder'), { className: 'Templar', ascendancy: 'Inquisitor', picked: false });
});

test('only a blank build takes the most played, shown as picked', () => {
  assert.deepEqual(preselect(ask, blank, 'Pathfinder'), { className: 'Ranger', ascendancy: 'Pathfinder', picked: true });
  assert.equal(preselect(ask, blank, undefined), null);
});
