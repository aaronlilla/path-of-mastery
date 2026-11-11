import { test } from 'node:test';
import assert from 'node:assert/strict';
import { craftGroups } from '../src/renderer/items/craftGroups.js';

const types = ['Amulet', 'Amulet: Talisman', 'Belt', 'Body Armour: Armour', 'Boots', 'Bow', 'Dagger: Rune Dagger', 'Flask: Life', 'Gloves: Ward', 'Graft', 'Helmet', 'Jewel', 'Jewel: Cluster', 'One Handed Sword: Thrusting', 'Quiver', 'Ring', 'Shield: Evasion', 'Tincture', 'Two Handed Axe', 'Wand'];

test('the types sit under the prototype\'s five headings, in order', () => {
  const g = craftGroups(types);
  assert.deepEqual(g.map((x) => x.name), ['Weapons', 'Armour', 'Jewellery', 'Jewels', 'Flasks']);
  assert.deepEqual(g[0]!.types, ['Bow', 'Dagger: Rune Dagger', 'One Handed Sword: Thrusting', 'Quiver', 'Shield: Evasion', 'Two Handed Axe', 'Wand']);
  assert.deepEqual(g[1]!.types, ['Body Armour: Armour', 'Boots', 'Gloves: Ward', 'Helmet']);
  assert.deepEqual(g[2]!.types, ['Amulet', 'Amulet: Talisman', 'Belt', 'Graft', 'Ring']);
  assert.deepEqual(g[3]!.types, ['Jewel', 'Jewel: Cluster']);
  assert.deepEqual(g[4]!.types, ['Flask: Life', 'Tincture']);
});

test('a heading with no type is left out, and a type that fits none is kept under Other', () => {
  assert.deepEqual(craftGroups(['Ring', 'Belt']).map((x) => x.name), ['Jewellery']);
  assert.deepEqual(craftGroups(['Ring', 'Mystery Thing']).map((x) => x.name), ['Jewellery', 'Other']);
  assert.deepEqual(craftGroups([]), []);
});
