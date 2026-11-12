import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copySpecXml, setActiveSetXml, activeConfigOf, activeGroupsOf, activeSpecOf, addGemXml, addGroupXml, equipped, loadoutsOf, loadoutXml, readFacts, setConfigInputs, setJewelXml, swapItemsXml } from '../src/shared/buildFacts.js';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<PathOfBuilding>
	<Build level="95" className="Ranger" ascendClassName="Deadeye" mainSocketGroup="2" />
	<Skills activeSkillSet="2">
		<SkillSet id="1" title="Mapping">
			<Skill enabled="true" label="" slot="Weapon 1">
				<Gem nameSpec="Tornado Shot" skillId="TornadoShot" level="20" quality="20" enabled="true"/>
			</Skill>
		</SkillSet>
		<SkillSet id="2" title="Bossing">
			<Skill enabled="true" label="Main" slot="Body Armour">
				<Gem nameSpec="Lightning Arrow" skillId="LightningArrow" level="21" quality="0" enabled="true"/>
				<Gem nameSpec="Faster Attacks" skillId="SupportFasterAttacks" level="20" quality="20" enabled="false"/>
			</Skill>
			<Skill enabled="true" label="" slot="Helmet">
				<Gem nameSpec="Hatred" skillId="Hatred" level="20" quality="0" enabled="true"/>
			</Skill>
		</SkillSet>
	</Skills>
	<Tree activeSpec="2">
		<Spec title="Mapping" treeVersion="3_29" classId="2" ascendClassId="2" nodes="1,2,3" />
		<Spec title="Bossing" treeVersion="3_29" classId="2" ascendClassId="2" nodes="1,2,3,4,5"><URL>x</URL></Spec>
		<Spec title="Leveling" treeVersion="3_29" classId="2" ascendClassId="0" nodes="1" />
	</Tree>
	<Items activeItemSet="2">
		<Item id="1">
			Rarity: UNIQUE
Death&apos;s Opus
Imperial Bow
Implicits: 0
+10 to Dexterity
		</Item>
		<Item id="2">
			Rarity: RARE
Doom Veil
Carnal Armour
		</Item>
		<ItemSet id="1" title="Mapping"><Slot name="Body Armour" itemId="2"/></ItemSet>
		<ItemSet id="2" title="Bossing"><Slot name="Weapon 1" itemId="1"/><Slot name="Body Armour" itemId="0"/></ItemSet>
	</Items>
	<Config activeConfigSet="2">
		<ConfigSet id="1" title="Mapping"><Input boolean="true" name="useFrenzyCharges"/></ConfigSet>
		<ConfigSet id="2" title="Bossing"><Input boolean="true" name="usePowerCharges"/><Input number="30" name="multiplierRage"/><Input string="Uber" name="enemyIsBoss"/></ConfigSet>
	</Config>
</PathOfBuilding>
`;

test('readFacts reads specs, sets, items, groups and config of the active sets', () => {
  const f = readFacts(XML);
  assert.equal(f.className, 'Ranger');
  assert.equal(f.ascendClassName, 'Deadeye');
  assert.equal(f.mainSocketGroup, 2);
  assert.deepEqual(activeSpecOf(f)?.nodes, [1, 2, 3, 4, 5]);
  assert.deepEqual([...equipped(f)].map(([s, i]) => [s, i.name, i.base, i.rarity]), [['Weapon 1', "Death's Opus", 'Imperial Bow', 'UNIQUE']]);
  assert.deepEqual(activeGroupsOf(f).map((g) => [g.label, g.slot, g.gems.map((x) => x.name)]), [['Main', 'Body Armour', ['Lightning Arrow', 'Faster Attacks']], ['', 'Helmet', ['Hatred']]]);
  assert.equal(activeGroupsOf(f)[0]!.gems[1]!.enabled, false);
  assert.deepEqual([...activeConfigOf(f)], [['usePowerCharges', true], ['multiplierRage', 30], ['enemyIsBoss', 'Uber']]);
  assert.match(f.items.get(1)!.raw, /^Rarity: UNIQUE\nDeath's Opus/);
});

test('a build with no sections reads as empty', () => {
  const f = readFacts('<PathOfBuilding><Build level="1" className="Witch"/></PathOfBuilding>');
  assert.deepEqual([f.specs, activeGroupsOf(f), [...activeConfigOf(f)], [...equipped(f)]], [[], [], [], []]);
});

test('loadouts pair a spec with the sets of the same title, and loadoutXml makes them active', () => {
  const f = readFacts(XML);
  const lo = loadoutsOf(f);
  assert.deepEqual(lo.map((l) => [l.name, l.spec, l.itemSet, l.skillSet, l.configSet]), [['Mapping', 1, 1, 1, 1], ['Bossing', 2, 2, 2, 2]]);
  const out = loadoutXml(XML, lo[0]!);
  const g = readFacts(out);
  assert.equal(g.activeSpec, 1);
  assert.equal(g.activeItemSet, 1);
  assert.equal(g.activeSkillSet, 1);
  assert.equal(g.activeConfigSet, 1);
  assert.equal(out.length - XML.length, 0, 'only attribute values changed');
  assert.deepEqual([...activeConfigOf(g)], [['useFrenzyCharges', true]]);
});

test('addGroupXml and addGemXml add to the active skill set only', () => {
  const f = readFacts(XML);
  const group = activeGroupsOf(readFacts(XML.replace('activeSkillSet="2"', 'activeSkillSet="1"')))[0]!;
  const withGroup = addGroupXml(XML, group.xml);
  const g = readFacts(withGroup);
  assert.equal(activeGroupsOf(g).length, 3);
  assert.deepEqual(g.skillSets[0]!.groups.length, 1);
  const withGem = addGemXml(XML, 1, '<Gem nameSpec="Vitality" skillId="Vitality" level="1" quality="0" enabled="true"/>');
  assert.deepEqual(activeGroupsOf(readFacts(withGem))[0]!.gems.map((x) => x.name), ['Lightning Arrow', 'Faster Attacks', 'Vitality']);
  assert.deepEqual(activeGroupsOf(f)[1]!.gems.length, 1, 'other groups are untouched');
});

test('setConfigInputs replaces, adds and removes inputs in the active set only', () => {
  const out = setConfigInputs(XML, { usePowerCharges: false, multiplierRage: null, useOnslaught: true, enemyIsBoss: 'Pinnacle' });
  const f = readFacts(out);
  assert.deepEqual([...activeConfigOf(f)].sort(), [['enemyIsBoss', 'Pinnacle'], ['usePowerCharges', false], ['useOnslaught', true]].sort());
  assert.deepEqual([...f.configSets[0]!.input], [['useFrenzyCharges', true]]);
  const bare = setConfigInputs('<PathOfBuilding>\n</PathOfBuilding>\n', { a: 1 });
  assert.deepEqual([...activeConfigOf(readFacts(bare))], [['a', 1]]);
  const selfClosing = setConfigInputs('<PathOfBuilding><Config /></PathOfBuilding>', { a: true });
  assert.deepEqual([...activeConfigOf(readFacts(selfClosing))], [['a', true]]);
});

const JW = `<PathOfBuilding>
<Build level="90" className="Witch"/>
<Tree activeSpec="2">
<Spec treeVersion="3_29" nodes="1"/>
<Spec treeVersion="3_29" nodes="1,2"><Sockets><Socket nodeId="26725" itemId="3"/><Socket nodeId="0" itemId="0"/></Sockets></Spec>
</Tree>
<Items activeItemSet="1">
<Item id="1">
Rarity: RARE
Doom Crown
Iron Hat
Sockets: A A R
</Item>
<Item id="3">
Rarity: UNIQUE
Glorious Vanity
Timeless Jewel
</Item>
<ItemSet id="1"><Slot name="Helmet" itemId="1"/></ItemSet>
</Items>
</PathOfBuilding>`;

test('readFacts reads the active spec jewels and an item\'s abyssal sockets', () => {
  const f = readFacts(JW);
  assert.deepEqual([...activeSpecOf(f)!.jewels], [[26725, 3]]);
  assert.equal(f.items.get(1)!.abyssal, 2);
  assert.equal(f.items.get(3)!.abyssal, 0);
});

test('setJewelXml adds the jewel to the item list and sockets it, replacing what was there', () => {
  const out = setJewelXml(JW, 26725, 'Rarity: RARE\nHorror Jewel\nCrimson Jewel');
  const f = readFacts(out);
  const id = activeSpecOf(f)!.jewels.get(26725)!;
  assert.equal(id, 4);
  assert.equal(f.items.get(id)!.name, 'Horror Jewel');
  const fresh = readFacts(setJewelXml(JW, 40000, 'Rarity: RARE\nA\nB'));
  assert.deepEqual([...activeSpecOf(fresh)!.jewels.keys()].sort(), [26725, 40000]);
  assert.deepEqual([...activeSpecOf(readFacts(JW.replace(/<Sockets>.*<\/Sockets>/, '')))!.jewels], []);
  const none = readFacts(setJewelXml(JW.replace(/<Sockets>.*<\/Sockets>/, ''), 5, 'Rarity: RARE\nA\nB'));
  assert.deepEqual([...activeSpecOf(none)!.jewels.keys()], [5]);
});

test('swapItemsXml equips the item and sets or empties the abyssal sockets in the active item set', () => {
  const out = swapItemsXml(JW, 'Helmet', 'Rarity: RARE\nNew Hat\nIron Hat\nSockets: A', [['Helmet Abyssal Socket 1', 'Rarity: RARE\nStygian Jewel\nMurderous Eye Jewel'], ['Helmet Abyssal Socket 2', null]]);
  const f = readFacts(out);
  const eq = equipped(f);
  assert.equal(eq.get('Helmet')!.name, 'New Hat');
  assert.equal(eq.get('Helmet Abyssal Socket 1')!.name, 'Stygian Jewel');
  assert.equal(eq.has('Helmet Abyssal Socket 2'), false);
});

test('setActiveSetXml switches the active tree, item, skill and config set', () => {
  assert.equal(readFacts(setActiveSetXml(XML, 'spec', 1)).activeSpec, 1);
  assert.equal(readFacts(setActiveSetXml(XML, 'itemSet', 1)).activeItemSet, 1);
  assert.equal(readFacts(setActiveSetXml(XML, 'skillSet', 1)).activeSkillSet, 1);
  assert.equal(readFacts(setActiveSetXml(XML, 'skillSet', 1)).activeSpec, 2, 'the other kinds stay as they were');
});

test('copySpecXml adds the active tree under a new title, without jewels, and can switch to it', () => {
  const from = XML.replace('nodes="1,2,3,4,5"><URL>x</URL></Spec>', 'nodes="7,8,9"><Sockets><Socket nodeId="5" itemId="1"/></Sockets></Spec>');
  const into = XML.replace(/title="Leveling"/, 'title="Other"');
  const out = copySpecXml(into, from, 'Friend (Compared)', false);
  const f = readFacts(out);
  assert.equal(f.specs.length, 4);
  assert.equal(f.specs[3]!.title, 'Friend (Compared)');
  assert.deepEqual(f.specs[3]!.nodes, [7, 8, 9]);
  assert.equal(f.specs[3]!.jewels.size, 0, 'no jewels travel with the copy');
  assert.equal(f.activeSpec, 2);
  assert.equal(readFacts(copySpecXml(into, from, 'Friend (Compared)', true)).activeSpec, 4);
});
