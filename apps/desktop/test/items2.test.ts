import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSharedSet, addShared, parseShared, removeSharedItem, removeSharedSet, renameSharedSet } from '../src/shared/sharedItems.js';
import { addItem, readItems, retargetMainSocketGroup, setSecondWeaponSet, setSlot, weaponSetOfSlot } from '../src/shared/itemsXml.js';
import { toggleDisabled, altVariants, clusterEnchants, setAltVariant, setCatalyst, setClusterSpec, setCrucible, setEnchantBlock, textLines, addImplicitMod } from '../src/renderer/items/itemText.js';
import { BASE_KEY, batchSize, gainText, rankAll, rankValue, sortByValue, type RankBatch } from '../src/renderer/items/rank.js';
import { middleTier, sliderPosition, sliderTier } from '../src/renderer/items/affixMath.js';

// ---- ranking by a stat -------------------------------------------------------------------------------------------------

test('rank values: a missing result is worst, and "taken" stats are negated', () => {
  assert.equal(rankValue(null, false), -Infinity);
  assert.equal(rankValue(undefined, false), -Infinity);
  assert.equal(rankValue(Number.NaN, false), -Infinity);
  assert.equal(rankValue(120, false), 120);
  assert.equal(rankValue(120, true), -120);
});

test('gain text groups thousands and keeps the sign', () => {
  assert.equal(gainText(1234.4), '+1,234');
  assert.equal(gainText(-8527765.3), '-8,527,765');
  assert.equal(gainText(12.5), '+12.5');
  assert.equal(gainText(0.001), '0');
  assert.equal(gainText(0.25), '+0.25');
  assert.equal(gainText(Number.NaN), '');
});

test('sort by value puts the best first and breaks ties by name without "The "', () => {
  const rows = [{ n: 'The Zed', v: 5 }, { n: 'Alpha', v: 5 }, { n: 'Low', v: 1 }, { n: 'High', v: 9 }];
  const out = sortByValue(rows, (r) => r.v, (r) => r.n).map((r) => r.n);
  assert.deepEqual(out, ['High', 'Alpha', 'The Zed', 'Low']);
});

test('rankAll runs batches, reports progress, reuses the cache and stops when asked', async () => {
  const calls: RankBatch[] = [];
  const run = async (_stat: string, batch: RankBatch) => {
    calls.push(batch);
    return batch.map((b) => (b.base ? 100 : b.text.length));
  };
  const cands = [{ key: BASE_KEY, text: '', slots: [], base: true }, ...Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, text: 'x'.repeat(i + 1), slots: ['Ring 1'] }))];
  const cache = new Map<string, number>();
  const seen: number[] = [];
  const out = await rankAll('Life', false, cands, run, cache, (p) => seen.push(p), () => true);
  assert.ok(out);
  assert.equal(out!.get(BASE_KEY), 100);
  assert.equal(out!.get('k4'), 5);
  assert.equal(calls.length, Math.ceil(31 / batchSize('Life')));
  assert.equal(seen[seen.length - 1], 1);
  // The second run asks the engine for nothing.
  const before = calls.length;
  await rankAll('Life', false, cands, run, cache, () => undefined, () => true);
  assert.equal(calls.length, before);
  // A run that is told to stop returns nothing and stops asking.
  let alive = true;
  const stopper = async (_s: string, b: RankBatch) => {
    alive = false;
    return b.map(() => 1);
  };
  const stopped = await rankAll('Mana', false, cands, stopper, new Map(), () => undefined, () => alive);
  assert.equal(stopped, null);
});

test('FullDPS goes in smaller batches than other stats', () => {
  assert.ok(batchSize('FullDPS') < batchSize('Life'));
});

// ---- affix rows ------------------------------------------------------------------------------------------------------------

test('slider position and tier are each other\'s inverse', () => {
  for (const count of [1, 2, 4, 11]) {
    for (let index = 0; index < count; index++) {
      for (const range of [0, 0.25, 0.5, 0.99]) {
        const t = sliderTier(sliderPosition(index, count, range), count);
        assert.equal(t.index, index, `count ${count} index ${index} range ${range}`);
        assert.ok(Math.abs(t.range - range) < 1e-9);
      }
    }
  }
  assert.deepEqual(sliderTier(1, 4), { index: 3, range: 1 });
  assert.deepEqual(sliderTier(0, 4), { index: 0, range: 0 });
});

test('the middle tier of a group is the original\'s pick at roll 0.5', () => {
  assert.equal(middleTier(1), 0);
  assert.equal(middleTier(2), 1);
  assert.equal(middleTier(4), 2);
  assert.equal(middleTier(11), 5);
});

// ---- item text edits ----------------------------------------------------------------------------------------------------------

const RING = ['Rarity: RARE', 'Doom Loop', 'Ruby Ring', 'Implicits: 1', '{crafted}{enchant}+10 to Strength', '+40 to maximum Life', 'Corrupted'].join('\n');

test('catalyst lines are written after the header and replaced, never doubled', () => {
  const a = setCatalyst(RING, 'Intrinsic', 20);
  assert.match(a, /Catalyst: Intrinsic\nCatalystQuality: 20/);
  const b = setCatalyst(a, 'Imbued', 15);
  assert.equal((b.match(/^Catalyst:/gm) ?? []).length, 1);
  assert.match(b, /CatalystQuality: 15/);
  assert.doesNotMatch(setCatalyst(b, null, 0), /Catalyst/);
});

test('a cluster jewel\'s skill lines and enchant block are rebuilt together', () => {
  const jewel = ['Rarity: RARE', 'Gloom Gem', 'Large Cluster Jewel', 'Implicits: 2', '{crafted}{enchant}Adds 8 Passive Skills', '{crafted}{enchant}Added Small Passive Skills grant: 10% increased Attack Damage', '+30 to Dexterity'].join('\n');
  const mods = [{ bucket: 'enchant', rawLine: 4 }, { bucket: 'enchant', rawLine: 5 }];
  const block = clusterEnchants('Large', 10, ['Added Small Passive Skills grant: 12% increased Spell Damage']);
  assert.deepEqual(block, ['{crafted}{enchant}Adds 10 Passive Skills', '{crafted}{enchant}2 Added Passive Skills are Jewel Sockets', '{crafted}{enchant}Added Small Passive Skills grant: 12% increased Spell Damage']);
  const out = setClusterSpec(setEnchantBlock(jewel, mods, block), 'affliction_spell_damage', 10);
  const lines = textLines(out);
  assert.ok(lines.includes('Cluster Jewel Skill: affliction_spell_damage'));
  assert.ok(lines.includes('Cluster Jewel Node Count: 10'));
  assert.equal(lines.find((l) => l.startsWith('Implicits:')), 'Implicits: 3');
  assert.equal(lines.filter((l) => l.includes('Adds 8 Passive Skills')).length, 0);
  assert.ok(lines.indexOf('+30 to Dexterity') > lines.indexOf('{crafted}{enchant}Added Small Passive Skills grant: 12% increased Spell Damage'));
  assert.equal(clusterEnchants('Small', 2, []).length, 1);
  assert.equal(clusterEnchants('Medium', 5, []).length, 2);
});

test('crucible lines replace the old ones and sit before the trailing flags', () => {
  const sword = ['Rarity: UNIQUE', 'Starforge', 'Infernal Sword', 'Implicits: 0', '+10 to Strength', '{crucible}10% increased Attack Speed', 'Mirrored'].join('\n');
  const out = textLines(setCrucible(sword, [{ bucket: 'crucible', rawLine: 5 }], ['{crucible}20% increased Area of Effect']));
  assert.deepEqual(out.slice(-3), ['+10 to Strength', '{crucible}20% increased Area of Effect', 'Mirrored']);
  assert.equal(out.filter((l) => l.includes('Attack Speed')).length, 0);
});

test('an Eldritch implicit replaces the item\'s own of that kind and a new one is appended', () => {
  const helm = ['Rarity: RARE', 'Doom Crown', 'Iron Hat', 'Implicits: 2', '{exarch}+5% to Fire Resistance', '+10 to Armour', '+30 to maximum Life'].join('\n');
  const mods = [{ bucket: 'implicit', rawLine: 4 }, { bucket: 'implicit', rawLine: 5 }];
  const replaced = textLines(addImplicitMod(helm, mods, 'exarch', ['{exarch}+8% to Cold Resistance']));
  assert.equal(replaced[4], '{exarch}+8% to Cold Resistance');
  assert.equal(replaced[3], 'Implicits: 2');
  const fresh = textLines(addImplicitMod(helm, mods, 'eater', ['{eater}+3% to Chaos Resistance']));
  assert.equal(fresh[3], 'Implicits: 3');
  assert.equal(fresh[6], '{eater}+3% to Chaos Resistance');
});

test('alternate variant axes are found by their Has lines and stored in their own line', () => {
  const unique = ['Rarity: UNIQUE', 'Ancient Thing', 'Gold Ring', 'Variant: Pre 3.0', 'Variant: Current', 'Selected Variant: 2', 'Has Alt Variant: true', 'Has Alt Variant Two: true', 'Selected Alt Variant: 1', 'Implicits: 0'].join('\n');
  const alts = altVariants(unique);
  assert.deepEqual(alts.map((a) => [a.sel, a.value]), [['Selected Alt Variant', 1], ['Selected Alt Variant Two', 1]]);
  const next = setAltVariant(setAltVariant(unique, 'Selected Alt Variant', 2), 'Selected Alt Variant Two', 2);
  assert.deepEqual(altVariants(next).map((a) => a.value), [2, 2]);
  assert.equal(altVariants(RING).length, 0);
});

// ---- shared items ---------------------------------------------------------------------------------------------------------------

test('shared lists read back what was stored and drop anything that is not an item or a set', () => {
  assert.deepEqual(parseShared('not json'), { items: [], sets: [] });
  const stored = JSON.stringify({ items: ['Rarity: RARE\nA', 7, '  ', 'Rarity: MAGIC\nB'], sets: [{ title: 'Boss', slots: { Helmet: 'Rarity: RARE\nH', Gloves: 5 } }, 'x', { slots: null }] });
  const got = parseShared(stored);
  assert.deepEqual(got.items, ['Rarity: RARE\nA', 'Rarity: MAGIC\nB']);
  assert.equal(got.sets.length, 2);
  assert.deepEqual(got.sets[0], { title: 'Boss', slots: { Helmet: 'Rarity: RARE\nH' } });
  assert.deepEqual(got.sets[1], { title: '', slots: {} });
});

test('shared list edits add at a position, remove and rename without touching the other list', () => {
  let l = parseShared('{}');
  l = addShared(l, 'one');
  l = addShared(l, 'three');
  l = addShared(l, 'two', 1);
  assert.deepEqual(l.items, ['one', 'two', 'three']);
  l = removeSharedItem(l, 0);
  assert.deepEqual(l.items, ['two', 'three']);
  l = addSharedSet(l, { title: 'A', slots: {} });
  l = addSharedSet(l, { title: 'B', slots: {} }, 0);
  l = renameSharedSet(l, 1, 'A2');
  assert.deepEqual(l.sets.map((s) => s.title), ['B', 'A2']);
  l = removeSharedSet(l, 0);
  assert.deepEqual(l.sets.map((s) => s.title), ['A2']);
  assert.deepEqual(l.items, ['two', 'three']);
});

test('setSlot puts an item in a slot of the active set, adding the slot when it is missing', () => {
  const xml = '<PathOfBuilding><Items activeItemSet="1"><ItemSet id="1"><Slot name="Helmet" itemId="0" /></ItemSet></Items></PathOfBuilding>';
  const a = addItem(xml, 'Rarity: RARE\nX\nIron Hat');
  const helm = readItems(setSlot(a.xml, 'Helmet', a.id));
  assert.equal(helm.sets[0]!.slots.get('Helmet')?.itemId, a.id);
  const ring = readItems(setSlot(a.xml, 'Ring 1', a.id));
  assert.equal(ring.sets[0]!.slots.get('Ring 1')?.itemId, a.id);
});

test('switching weapon sets moves the main skill to a group of the new set', () => {
  const xml = '<PathOfBuilding><Build level="90" mainSocketGroup="2"/><Skills activeSkillSet="1"><SkillSet id="1"><Skill slot="Weapon 1 Swap" enabled="true"/><Skill slot="Weapon 1" enabled="true"/><Skill slot="Helmet" enabled="true"/></SkillSet></Skills><Items activeItemSet="1"><ItemSet id="1"/></Items></PathOfBuilding>';
  assert.equal(weaponSetOfSlot('Weapon 2 Abyssal Socket 1'), 1);
  assert.equal(weaponSetOfSlot('Weapon 2 Swap Abyssal Socket 1'), 2);
  assert.equal(weaponSetOfSlot('Helmet'), 0);
  // The main group is in set 1, so entering set 2 picks the swap group; leaving it again picks the first set-1 group.
  const second = setSecondWeaponSet(xml, true);
  assert.match(second, /mainSocketGroup="1"/);
  assert.match(setSecondWeaponSet(second, false), /mainSocketGroup="2"/);
  // A main group outside both sets stays.
  assert.equal(retargetMainSocketGroup(xml.replace('mainSocketGroup="2"', 'mainSocketGroup="3"'), true).includes('mainSocketGroup="3"'), true);
});

test('a modifier line is turned off and on again with {disabled}', () => {
  const t = ['Rarity: RARE', 'Gloom Ring', 'Ruby Ring', 'Implicits: 0', '{range:0.4}+(10-20) to Strength', '+8 to Dexterity'].join('\n');
  const off = toggleDisabled(t, 4);
  assert.equal(textLines(off)[4], '{disabled}{range:0.4}+(10-20) to Strength');
  assert.equal(textLines(off)[5], '+8 to Dexterity');
  assert.equal(toggleDisabled(off, 4), t);
  assert.equal(toggleDisabled(t, 99), t);
});
