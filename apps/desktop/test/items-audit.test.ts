import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeSetOf, readItems } from '../src/shared/itemsXml.js';
import { eldritchInfluenceAllowed, extraAffixLine } from '../src/renderer/items/itemText.js';
import { equippedWhere } from '../src/renderer/items/deleteInfo.js';
import { windowRange } from '../src/renderer/items/virtual.js';

for (const [name, text] of [['plain text', 'this is not a build file'], ['empty', ''], ['random bytes', '\u0000\u0001��abc<<<'], ['wrong root', '<Foo/>']] as const) {
  test(`a file that is not a build still has one item set (${name})`, () => {
    const m = readItems(text);
    assert.equal(m.sets.length, 1);
    const set = activeSetOf(m);
    assert.equal(set.useSecond, false);
    assert.equal(set.slots.size, 0);
  });
}

test('activeSetOf never returns undefined, even for a model with no sets', () => {
  const set = activeSetOf({ activeSet: 3, items: [], sets: [], specs: [], activeSpec: 1 });
  assert.equal(set.useSecond, false);
});

test('with affix rows showing, only crafted and custom lines are listed again', () => {
  const m = { prefix: false, suffix: false, custom: false, crafted: false };
  assert.equal(extraAffixLine(m), false, 'a plain line that arrives with Prefix and Suffix entries is the same modifier');
  assert.equal(extraAffixLine({ ...m, prefix: true }), false);
  assert.equal(extraAffixLine({ ...m, suffix: true, crafted: true }), false);
  assert.equal(extraAffixLine({ ...m, crafted: true }), true);
  assert.equal(extraAffixLine({ ...m, custom: true }), true);
});

test('eldritch influences are only offered on armour', () => {
  assert.equal(eldritchInfluenceAllowed('Ring', 'Rarity: RARE'), false);
  assert.equal(eldritchInfluenceAllowed('Amulet', 'x'), false);
  assert.equal(eldritchInfluenceAllowed('Body Armour', 'x'), true);
  assert.equal(eldritchInfluenceAllowed('Helmet', 'x'), true);
  assert.equal(eldritchInfluenceAllowed('Belt', 'If the Eater of Worlds is dominant'), true);
});

test('the delete confirmation says where the item is equipped', () => {
  const model = {
    activeSet: 1,
    items: [],
    sets: [
      { id: 1, title: 'Main', useSecond: false, slots: new Map([['Ring 1', { name: 'Ring 1', itemId: 5, active: false }]]) },
      { id: 2, title: '', useSecond: false, slots: new Map([['Boots', { name: 'Boots', itemId: 6, active: false }], ['Weapon 1 Abyssal Socket 1', { name: 'Weapon 1 Abyssal Socket 1', itemId: 8, active: false }]]) },
    ],
    specs: [{ index: 1, title: 'Early', sockets: new Map([[100, 7]]) }],
    activeSpec: 1,
  };
  assert.equal(equippedWhere(model, 5), 'Ring 1');
  assert.equal(equippedWhere(model, 6), 'Boots in set ‘Default’');
  assert.equal(equippedWhere(model, 8), 'an Abyssal Socket in set ‘Default’');
  assert.equal(equippedWhere(model, 7), 'passive tree ‘Early’');
  assert.equal(equippedWhere(model, 99), null);
});

test('a long list draws only the rows in view', () => {
  const r = windowRange(1137, 29, 0, 580, 10);
  assert.equal(r.start, 0);
  assert.equal(r.end, 20 + 10);
  assert.equal(r.padTop, 0);
  assert.equal(r.padBottom, (1137 - r.end) * 29);
  const bottom = windowRange(1137, 29, 1137 * 29 - 580, 580, 10);
  assert.equal(bottom.end, 1137, 'the last row is reachable');
  assert.ok(bottom.start > 1000);
  const mid = windowRange(1137, 29, 29 * 500, 580, 10);
  assert.equal(mid.padTop + (mid.end - mid.start) * 29 + mid.padBottom, 1137 * 29, 'the scroll height stays the full list');
  assert.deepEqual(windowRange(0, 29, 0, 500), { start: 0, end: 0, padTop: 0, padBottom: 0 });
});
