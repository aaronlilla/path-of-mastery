import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readExportedBuffs, skippedFields } from '../src/shared/partyXml.js';

const xml = `<PathOfBuilding><Party destination="All" ShowAdvanceTools="false" append="false">
<ExportedBuffs name="PartyMemberStats">MovementSpeedMod|percent|max=201</ExportedBuffs>
<ExportedBuffs name="Aura">Precision
138
---</ExportedBuffs>
<ExportedBuffs name="Curse">--- Curse Limit ---
1</ExportedBuffs>
</Party></PathOfBuilding>`;

test('a destination of Party Member Stats leaves the auras and curses of the code unimported', () => {
  const ex = readExportedBuffs(xml);
  assert.deepEqual(skippedFields(ex, 'Party Member Stats'), ['auras', 'curses']);
});

test('the destination All skips nothing', () => {
  assert.deepEqual(skippedFields(readExportedBuffs(xml), 'All'), []);
});

test('a code exported without Export Support has no exported blocks', () => {
  assert.deepEqual(skippedFields(readExportedBuffs('<PathOfBuilding><Party destination="All"/></PathOfBuilding>'), 'All'), []);
  assert.deepEqual(Object.keys(readExportedBuffs('<PathOfBuilding></PathOfBuilding>')), []);
});
