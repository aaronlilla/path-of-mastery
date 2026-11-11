import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setGroupVariant, setVersion, variantModel } from '../src/renderer/items/variantGroups.js';
import { wikiUrl } from '../src/renderer/items/wiki.js';
import { applyMutation } from '../src/renderer/items/itemText.js';

const RING = [
  'Rarity: UNIQUE',
  'Test Ring',
  'Ruby Ring',
  'Variant: Life',
  'Variant: Mana',
  'Variant: Reflect',
  'Variant: Steal',
  '{variant:1}{group:1}10% increased maximum Life',
  '{variant:2}{group:1}20% increased maximum Mana',
  '{variant:3}{group:2}Damage cannot be Reflected',
  '{variant:4}{group:2}Monsters cannot steal your charges',
  '{variant:1,3}{group:3}Something shared',
].join('\n');

test('an item with no groups or versions has no variant model', () => {
  assert.equal(variantModel('Rarity: UNIQUE\nX\nRuby Ring\nVariant: A\nVariant: B\n{variant:1}foo'), null);
});

test('groups default to the first eligible variant not taken by another group', () => {
  const m = variantModel(RING)!;
  assert.deepEqual(m.groups.map((g) => g.selected), [1, 3, null]);
  // group 3 offers variants 1 and 3, both already used by groups 1 and 2, so it has no free option
  assert.equal(m.groups[2]!.options.length, 0);
  assert.equal(m.groups[0]!.options.map((o) => o.variantId).join(), '1,2');
});

test('picking a variant in a group writes the selection and moves the rest', () => {
  const t = setGroupVariant(RING, 1, 2);
  assert.match(t, /Selected Variant Group: 1=2/);
  const m = variantModel(t)!;
  assert.equal(m.groups[0]!.selected, 2);
  assert.equal(m.groups[1]!.options.some((o) => o.variantId === 2), false);
});

test('versions limit which variants a group offers', () => {
  const text = ['Rarity: UNIQUE', 'V Ring', 'Ruby Ring', 'Version: Old', 'Version: New', 'Variant: A', 'Variant: B', '{variant:1}{group:1}{version:1}old a', '{variant:2}{group:1}{version:2}new b'].join('\n');
  assert.equal(variantModel(text)!.selectedVersion, 2);
  assert.deepEqual(variantModel(text)!.groups[0]!.options.map((o) => o.variantId), [2]);
  const old = setVersion(text, 1);
  assert.match(old, /Selected Version: 1/);
  assert.deepEqual(variantModel(old)!.groups[0]!.options.map((o) => o.variantId), [1]);
  assert.equal(variantModel(old)!.groups[0]!.selected, 1);
});

test('the wiki page of a unique is its title, of anything else its base type', () => {
  assert.equal(wikiUrl({ rarity: 'UNIQUE', title: 'Tabula Rasa', baseKey: 'Simple Robe' }), 'https://www.poewiki.net/wiki/Tabula_Rasa');
  assert.equal(wikiUrl({ rarity: 'RARE', title: 'Doom Cry', baseKey: 'Vaal Regalia' }), 'https://www.poewiki.net/wiki/Vaal_Regalia');
});

test('a mutation swaps its lines in place and drops the other lines it covered', () => {
  const text = ['Rarity: UNIQUE', 'X', 'Ruby Ring', 'Implicits: 0', 'line a', 'line b', 'line c'].join('\n');
  const out = applyMutation(text, { rawLines: [4, 5], modId: 'A', newModId: 'B', mutated: false, replace: ['{mutated}new one'] });
  assert.equal(out, ['Rarity: UNIQUE', 'X', 'Ruby Ring', 'Implicits: 0', '{mutated}new one', 'line c'].join('\n'));
});
