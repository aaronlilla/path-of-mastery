import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_PARTY, importParty, parseBuffRows, parseEnemyModRows, partyFromEngine, partyToEngine, readExportedBuffs, readParty, removeRow, withExportedBuffs, writeParty, type PartyData } from '../src/shared/partyXml.js';

const BUILD = `<?xml version="1.0" encoding="UTF-8"?>
<PathOfBuilding>
	<Build level="90" className="Witch" />
	<Party destination="All" ShowAdvanceTools="true" append="false">
		<ImportedBuffs name="PartyMemberStats">
			MovementSpeedMod|percent|max=103
		</ImportedBuffs>
		<ImportedBuffs name="Aura">
			Zealotry
130
17|Skill:Zealotry|Damage|MORE|Spell|-|type=GlobalEffect/effectType=Aura
45|Skill:Zealotry|CritChance|INC|Spell|-|type=GlobalEffect/effectType=Aura
---
Pride
186
-5|Skill:Pride|Damage|INC|-|-|-
---
		</ImportedBuffs>
		<ImportedBuffs name="Curse">
			--- Curse Limit ---
3
Enfeeble
100
false
-10|Skill:Enfeeble|Accuracy|INC|-|-|type=GlobalEffect/effectType=Curse
---
		</ImportedBuffs>
		<ImportedBuffs name="EnemyMods">
			PhysicalDamageConvertToFire
25|Item:12:Kaom&apos;s Binding, Heavy Belt|PhysicalDamageConvertToFire|BASE|-|-|-
		</ImportedBuffs>
		<ExportedBuffs name="Aura">
			Hatred
100
---
		</ExportedBuffs>
	</Party>
	<Tree activeSpec="1" />
</PathOfBuilding>
`;

test('readParty reads the text fields and the attributes', () => {
  const p = readParty(BUILD);
  assert.equal(p.destination, 'All');
  assert.equal(p.showAdvanced, true);
  assert.equal(p.append, false);
  assert.equal(p.disabled, false);
  assert.equal(p.stats, 'MovementSpeedMod|percent|max=103');
  assert.ok(p.auras.startsWith('Zealotry\n130\n17|Skill:Zealotry'));
  assert.ok(p.enemyMods.includes("Kaom's Binding"));
  assert.equal(p.warcries, '');
});

test('readParty of a build without a party is empty', () => {
  assert.deepEqual(readParty('<PathOfBuilding><Build /></PathOfBuilding>'), EMPTY_PARTY);
});

test('writeParty then readParty gives the same data, and keeps the exported blocks', () => {
  const p = readParty(BUILD);
  const out = writeParty(BUILD, p);
  assert.deepEqual(readParty(out), p);
  assert.deepEqual(readExportedBuffs(out), { auras: 'Hatred\n100\n---' });
  // Only the party element changed.
  assert.equal(out.slice(0, out.indexOf('<Party')), BUILD.slice(0, BUILD.indexOf('<Party')));
  assert.equal(out.slice(out.indexOf('</Party>')), BUILD.slice(BUILD.indexOf('</Party>')));
});

test('writeParty inserts a party before the tree and leaves an empty party alone', () => {
  const bare = '<PathOfBuilding>\n\t<Build />\n\t<Tree activeSpec="1" />\n</PathOfBuilding>\n';
  assert.equal(writeParty(bare, EMPTY_PARTY), bare);
  const out = writeParty(bare, { ...EMPTY_PARTY, auras: 'Pride\n100\n---' });
  assert.ok(out.indexOf('<Party') > out.indexOf('<Build') && out.indexOf('<Party') < out.indexOf('<Tree'));
  assert.equal(readParty(out).auras, 'Pride\n100\n---');
});

test('disabled parties are written as DisabledBuffs for the engine and saved as ImportedBuffs with a flag', () => {
  const p = { ...readParty(BUILD), disabled: true };
  const forEngine = writeParty(BUILD, p);
  assert.ok(!forEngine.includes('<ImportedBuffs'), 'the engine does not read these');
  assert.ok(forEngine.includes('<DisabledBuffs name="Aura">'));
  const file = partyFromEngine(forEngine);
  assert.ok(file.includes('<ImportedBuffs name="Aura">') && !file.includes('DisabledBuffs'), 'upstream reads ImportedBuffs');
  assert.ok(file.includes('DisableEffects="true"'));
  const back = readParty(file);
  assert.equal(back.disabled, true);
  assert.equal(back.auras, p.auras);
  assert.equal(partyToEngine(file), forEngine, 'opening the saved file gives the engine the same text again');
  const on = writeParty(forEngine, { ...back, disabled: false });
  assert.ok(on.includes('<ImportedBuffs name="Aura">') && !on.includes('DisabledBuffs') && !on.includes('DisableEffects'));
  assert.equal(partyFromEngine(on), on, 'a party that is on is left as it is');
  assert.equal(partyToEngine(BUILD), BUILD, 'a party that is on is left as it is');
});

test('special characters and CRLF survive a round trip', () => {
  const crlf = BUILD.replace(/\n/g, '\r\n');
  const p = { ...readParty(crlf), enemyCond: "Condition:Foo<&>\"'" };
  const out = writeParty(crlf, p);
  assert.equal(readParty(out).enemyCond, "Condition:Foo<&>\"'");
  assert.ok(!/[^\r]\n/.test(out.slice(out.indexOf('<Party'), out.indexOf('</Party>'))), 'line endings stay CRLF inside the party');
});

test('importParty without Append replaces the destination, with Append adds after it', () => {
  const cur: PartyData = { ...EMPTY_PARTY, auras: 'Old\n100\n---', curses: '--- Curse Limit ---\n2\nDespair\n100\nfalse\n---', links: 'Flame Link\n100\n---', stats: 'Life=10' };
  const ex = { auras: 'New\n150\n---', curses: '--- Curse Limit ---\n1', links: '', stats: 'Mana=5' };
  const rep = importParty(cur, ex, 'All', false);
  assert.equal(rep.auras, 'New\n150\n---');
  assert.equal(rep.stats, 'Mana=5');
  assert.equal(rep.links, '');
  const app = importParty(cur, ex, 'All', true);
  assert.equal(app.auras, 'Old\n100\n---\nNew\n150\n---');
  assert.equal(app.stats, 'Life=10\nMana=5');
  assert.equal(app.curses, cur.curses, 'an import with no curses of its own keeps the current ones');
  assert.equal(app.links, cur.links, 'an empty link import keeps the current link');
  const only = importParty(cur, ex, 'Aura', false);
  assert.equal(only.auras, 'New\n150\n---');
  assert.equal(only.stats, 'Life=10');
});

test('buff rows list name, effect and mods, and removing a row removes only its lines', () => {
  const p = readParty(BUILD);
  const { rows } = parseBuffRows(p.auras, 'Aura');
  assert.deepEqual(rows.map((r) => [r.name, r.effect, r.lines.length]), [['Zealotry', 130, 2], ['Pride', 186, 1]]);
  assert.equal(removeRow(p.auras, rows[0]!), 'Pride\n186\n-5|Skill:Pride|Damage|INC|-|-|-\n---');
  const curses = parseBuffRows(p.curses, 'Curse');
  assert.equal(curses.curseLimit, 3);
  assert.deepEqual(curses.rows.map((r) => [r.name, r.effect, r.mark]), [['Enfeeble', 100, false]]);
  const em = parseEnemyModRows(p.enemyMods);
  assert.deepEqual(em.map((r) => [r.name, r.lines.length]), [['PhysicalDamageConvertToFire', 1]]);
  assert.equal(removeRow(p.enemyMods, em[0]!), '');
});

test('withExportedBuffs puts the engine blocks in the party and drops them when there are none', () => {
  const blocks: [string, string][] = [['Aura', 'Haste\n100\n20|Skill:Haste|Speed|INC|-|-|-\n---'], ['EnemyConditions', 'Condition:Burning']];
  const on = withExportedBuffs(BUILD, blocks);
  assert.deepEqual(readExportedBuffs(on), { auras: 'Haste\n100\n20|Skill:Haste|Speed|INC|-|-|-\n---', enemyCond: 'Condition:Burning' });
  assert.equal(readParty(on).auras, readParty(BUILD).auras, 'the imported text is untouched');
  const again = withExportedBuffs(on, [['Aura', 'Other']]);
  assert.deepEqual(readExportedBuffs(again), { auras: 'Other' }, 'the old blocks are replaced, not added to');
  assert.deepEqual(readExportedBuffs(withExportedBuffs(on, [])), {}, 'with the switch off the file carries none');
});
