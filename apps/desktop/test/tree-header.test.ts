import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateFor } from '../src/shared/buildGates.js';
import { experienceMultipliers } from '../src/shared/experience.js';
import { addLoadoutTreeAndItems, loadoutRows, openLoadoutNamed } from '../src/shared/loadouts.js';
import { readSpecSummaries } from '../src/shared/treeSets.js';
import { estimateLevel } from '../src/renderer/buildSkills.js';

const XML = `<PathOfBuilding>
	<Build level="90" className="Witch" targetVersion="3_0"></Build>
	<Skills activeSkillSet="1"><SkillSet id="1" title="Default"/></Skills>
	<Tree activeSpec="1">
		<Spec title="Default" classId="3" ascendClassId="2" nodes="5,6" treeVersion="3_29"></Spec>
	</Tree>
	<Config activeConfigSet="1"><ConfigSet id="1" title="Default"/></Config>
	<Items activeItemSet="1"><ItemSet id="1" title="Default" useSecondWeaponSet="nil"/></Items>
</PathOfBuilding>`;

test('opening a build asks about an unknown tree version first, then about the game version', () => {
  const known = ['3_28', '3_29'];
  assert.equal(gateFor(XML, known), null);
  assert.equal(gateFor(XML.replace('3_29', '9_99'), known), 'unknown-tree');
  assert.equal(gateFor(XML.replace('targetVersion="3_0"', 'targetVersion="0_1"'), known), 'game-version');
  assert.equal(gateFor(XML.replace(' targetVersion="3_0"', ''), known), 'game-version', 'no target version means an old 2.6 build');
  assert.equal(gateFor(XML.replace('3_29', '9_99').replace('3_0', '0_1'), known), 'unknown-tree');
});

test('a new loadout adds a tree and an item set with its name; the other sets come from the engine', () => {
  const x = addLoadoutTreeAndItems(XML, 'Boss fight');
  const s = readSpecSummaries(x);
  assert.deepEqual(s.specs.map((a) => a.title), ['Default', 'Boss fight']);
  assert.equal(s.specs[1]!.classId, 3);
  assert.equal(s.specs[1]!.ascendClassId, 2);
  assert.match(x, /<ItemSet[^>]*title="Boss fight"/);
  // The skill set and the config set are added by the engine's own edits: add them here the way those edits write them.
  const full = x.replace('<SkillSet id="1" title="Default"/>', '<SkillSet id="1" title="Default"/><SkillSet id="2" title="Boss fight"/>').replace('<ConfigSet id="1" title="Default"/>', '<ConfigSet id="1" title="Default"/><ConfigSet id="2" title="Boss fight"/>');
  const rows = loadoutRows(full);
  assert.deepEqual(rows.map((r) => [r.name, r.active]), [['Default', true], ['Boss fight', false]]);
  const opened = openLoadoutNamed(full, 'Boss fight');
  assert.match(opened, /<Tree activeSpec="2">/);
  assert.match(opened, /activeItemSet="2"/);
  assert.match(opened, /activeSkillSet="2"/);
  assert.match(opened, /activeConfigSet="2"/);
  assert.deepEqual(loadoutRows(opened).map((r) => r.active), [false, true]);
});

test('the experience multiplier is full inside the safe zone and falls off outside it', () => {
  const l = experienceMultipliers(80);
  assert.equal(l.find((x) => x.area === '80 (Tier 13)')!.percent, '100.0');
  assert.equal(l.find((x) => x.area === '1'), undefined, 'level 1 areas give a level 80 character under 1%');
  assert.equal(l[0]!.area, '53');
  assert.ok(l.some((x) => x.area === '68 (Tier 1)'));
  // from level 95 the late-level penalty applies; a level 100 character earns nothing
  const late = experienceMultipliers(99);
  assert.ok(late.length > 0 && late.every((x) => Number(x.percent) <= 60));
  assert.deepEqual(experienceMultipliers(100), []);
});

test('the points tooltip: quest points, extra skillpoints and the lab for the level', () => {
  const e = estimateLevel(60, 2);
  assert.equal(e.level, 50);
  assert.equal(e.act, 6);
  assert.equal(e.questPoints, 9);
  assert.equal(e.extraSkillpoints, 2);
  assert.equal(e.lab, 'Normal Lab');
  assert.equal(estimateLevel(110, 0).lab, 'Uber Lab');
  assert.equal(estimateLevel(5, 0).lab, '');
  assert.equal(estimateLevel(130, 0).lab, '');
});
