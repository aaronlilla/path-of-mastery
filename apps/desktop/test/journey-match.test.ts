import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCharacter, socketedGems, type MatchBuild } from '../src/shared/journey/match.js';
import type { CharacterRow } from '../src/shared/characterImport.js';

const build: MatchBuild = { className: 'Ranger', ascendancy: 'Pathfinder', level: 90, league: 'Mirage', mainSkill: 'Poisonous Concoction', levelingSkill: 'Frost Blades' };
const row = (name: string, cls: string, level: number, league = 'Mirage'): CharacterRow => ({ name, class: cls, level, league, realm: 'pc' });
const itemsWith = (...gems: string[]) => ({
  items: [
    { inventoryId: 'BodyArmour', socketedItems: gems.map((g) => ({ typeLine: g, baseType: g })) },
    { inventoryId: 'MainInventory', socketedItems: [{ typeLine: 'Hidden Gem' }] },
  ],
});

test('a Pathfinder with Poisonous Concoction socketed is a Match', () => {
  const m = matchCharacter(build, row('A', 'Pathfinder', 80), { gems: socketedGems(itemsWith('Poisonous Concoction', 'Greater Fork Support')) });
  assert.equal(m.state, 'match');
  assert.ok(m.reasons.some((r) => /socketed/.test(r)));
});
test('a Ranger at level 8 is Likely', () => {
  assert.equal(matchCharacter(build, row('B', 'Ranger', 8)).state, 'likely');
});
test('a Pathfinder whose gems were not read yet is Likely, not Match', () => {
  assert.equal(matchCharacter(build, row('A', 'Pathfinder', 80)).state, 'likely');
});
test('a Ranger levelling with the plan skill before the swap stays Likely', () => {
  const m = matchCharacter(build, row('B', 'Ranger', 30), { gems: ['Frost Blades'] });
  assert.equal(m.state, 'likely');
  assert.ok(m.reasons.some((r) => /before the swap/.test(r)));
});
test('a Witch, another league, or a level past the build is Different', () => {
  assert.equal(matchCharacter(build, row('C', 'Witch', 20)).state, 'different');
  assert.equal(matchCharacter(build, row('D', 'Pathfinder', 80, 'Standard')).state, 'different');
  assert.equal(matchCharacter(build, row('E', 'Pathfinder', 95)).state, 'different');
});
test('the main gem is found through support prefixes and case', () => {
  assert.equal(matchCharacter(build, row('A', 'Pathfinder', 80), { gems: ['poisonous concoction'] }).state, 'match');
  assert.equal(matchCharacter(build, row('A', 'Pathfinder', 80), { gems: ['Cyclone'] }).state, 'likely');
});
