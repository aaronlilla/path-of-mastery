import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LATEST_TREE_VERSION } from '../src/shared/treeSets.js';
import { estimateLevel, readHeader, setActiveSpec, setBuildAttr, specTreeVersion, withSpecClassNames } from '../src/renderer/buildSkills.js';

const XML = `<PathOfBuilding>
<Build level="98" className="Scion" ascendClassName="Reliquarian" mainSocketGroup="2" characterLevelAutoMode="false">
</Build>
<Skills activeSkillSet="1">
 <Skill slot="Weapon 1" enabled="true" mainActiveSkill="1"><Gem nameSpec="Cyclone" skillId="Cyclone" level="20" quality="0"/><Gem nameSpec="Melee Physical Damage Support" skillId="SupportMeleePhysicalDamage" level="20"/></Skill>
 <Skill slot="Helmet" enabled="true" mainActiveSkill="2"><Gem nameSpec="Frostbolt" skillId="Frostbolt" level="21"/><Gem nameSpec="Arc" skillId="Arc" level="19" quality="20"/><Gem nameSpec="Spell Echo Support" skillId="SupportSpellEcho"/></Skill>
</Skills>
<Tree activeSpec="2">
 <Spec title="One" classId="0" nodes="1,2,3" masteryEffects="{100,200}" treeVersion="3_29"></Spec>
 <Spec title="Two" classId="4" ascendClassId="1" nodes="5,6" treeVersion="3_29"></Spec>
</Tree>
</PathOfBuilding>`;

test('readHeader reads the header, specs and socket groups', () => {
  const h = readHeader(XML)!;
  assert.equal(h.level, 98);
  assert.equal(h.auto, false);
  assert.equal(h.mainSocketGroup, 2);
  assert.equal(h.mainActive, 2);
  assert.equal(h.activeSpec, 2);
  assert.deepEqual(h.specs.map((s) => [s.title, s.nodes.length]), [['One', 3], ['Two', 2]]);
  assert.deepEqual(h.specs[0]!.masteries, [[100, 200]]);
  assert.equal(h.groups.length, 2);
  assert.equal(h.groups[1]!.summary, 'Arc +1 support');
  assert.equal(h.groups[1]!.link, 3);
  assert.equal(h.groups[1]!.actives.length, 2);
});

test('attribute edits touch only their attribute', () => {
  const a = setBuildAttr(XML, 'level', '100');
  assert.ok(a.includes('level="100" className="Scion"'));
  assert.equal(a.replace('level="100"', 'level="98"'), XML);
  const b = setBuildAttr(XML, 'newAttr', 'x');
  assert.ok(b.includes('newAttr="x"'));
  assert.ok(setActiveSpec(XML, 1).includes('<Tree activeSpec="1">'));
});

test('estimateLevel is the original’s EstimatePlayerProgress', () => {
  assert.deepEqual(estimateLevel(0, 0), { level: 1, act: 1, questPoints: 0, extraSkillpoints: 0, lab: '' });
  assert.equal(estimateLevel(12, 0).level, 12);
  assert.equal(estimateLevel(116, 0).level, 94);
  assert.equal(estimateLevel(116, 0).act, 'Endgame');
  assert.equal(estimateLevel(40, 0).act, 4);
});

test('autoLevelStep: only a change in the level the points call for rewrites the level', async () => {
  const { autoLevelStep } = await import('../src/renderer/buildSkills.js');
  const c = { auto: true, stepping: false, edited: true, level: 95 };
  // opening: the first look settles on the estimate and rewrites nothing
  assert.deepEqual(autoLevelStep(null, 89, { ...c, edited: false }), { settled: 89, apply: false });
  // a Config switch or an item edit: the estimate is the same, so the saved level 95 stays
  assert.deepEqual(autoLevelStep(89, 89, c), { settled: 89, apply: false });
  // a point spent: the level follows
  assert.deepEqual(autoLevelStep(89, 90, c), { settled: 90, apply: true });
  // undo, manual level, nothing edited yet, already at that level: no rewrite
  assert.equal(autoLevelStep(89, 90, { ...c, stepping: true }).apply, false);
  assert.equal(autoLevelStep(89, 90, { ...c, auto: false }).apply, false);
  assert.equal(autoLevelStep(89, 90, { ...c, edited: false }).apply, false);
  assert.equal(autoLevelStep(89, 90, { ...c, level: 90 }).apply, false);
});

test('withSpecClassNames writes <Build className ascendClassName> from the active spec, as the original Save does', () => {
  const classes = { 0: { name: 'Scion', asc: [[0, 'None'], [1, 'Ascendant']] as Array<[number, string]> }, 4: { name: 'Duelist', asc: [[0, 'None'], [1, 'Slayer'], [2, 'Gladiator']] as Array<[number, string]> } };
  const out = withSpecClassNames(XML, classes);
  assert.match(out, /<Build level="98" className="Duelist" ascendClassName="Slayer" mainSocketGroup="2"/);
  assert.equal(out.replace(/<Build\b[^>]*>/, ''), XML.replace(/<Build\b[^>]*>/, ''), 'nothing else changes');
  // No ascendancy is written as "None"; a class the tree does not know leaves the text alone.
  const one = setActiveSpec(XML, 1);
  assert.match(withSpecClassNames(one, classes), /className="Scion" ascendClassName="None"/);
  assert.equal(withSpecClassNames(XML, {}), XML);
});

test('export text: a spec with no treeVersion is read as the latest tree, so its class names still get written', () => {
  const old = XML.replace(/ treeVersion="[^"]*"/g, '');
  assert.equal(specTreeVersion(old), LATEST_TREE_VERSION);
  assert.equal(specTreeVersion(XML), '3_29');
});
