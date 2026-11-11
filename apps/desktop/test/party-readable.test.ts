import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeEnemyModLine, describeModLine, parseBuffRows } from '../src/shared/partyXml.js';

test('a mod line reads the way the design words it, and an enemy modifier stays raw', () => {
  const l = (v: string, name: string, type: string, flags = '-') => `${v}|Skill:X|${name}|${type}|${flags}|-|-`;
  assert.equal(describeModLine(l('3210', 'Armour', 'BASE')), '+3210 to Armour');
  assert.equal(describeModLine(l('32', 'Armour', 'MORE')), '32% more Armour');
  assert.equal(describeModLine(l('-10', 'Accuracy', 'INC')), '10% reduced Accuracy');
  assert.equal(describeModLine(l('21', 'MovementSpeed', 'INC')), '21% increased Movement Speed');
  assert.equal(describeModLine(l('17', 'Damage', 'MORE', 'Spell')), '17% more Spell Damage');
  assert.equal(describeModLine(l('-30', 'ElementalResist', 'BASE')), '-30% to Elemental Resistance');
  assert.equal(describeModLine(l('true', 'Condition:Tailwind', 'FLAG')), 'Tailwind');
  assert.equal(describeEnemyModLine(l('39', 'PhysicalDamageTaken', 'INC')), '39|INC|PhysicalDamageTaken');
  const rows = parseBuffRows('Pride\n186\n39|Skill:Pride|PhysicalDamageTaken|INC|-|-|-\n---', 'Aura').rows;
  assert.deepEqual(rows[0]!.lines, ['39% increased Physical Damage Taken']);
  assert.deepEqual(rows[0]!.raw, ['39|Skill:Pride|PhysicalDamageTaken|INC|-|-|-']);
});
