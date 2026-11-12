import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ItemInfo } from '@pom/protocol';
import { activeSetOf, addItem, deleteItemSet, deleteItems, newItemSet, readItems, renameItemSet, setActiveSet, setFlaskActive, setItemText, setJewel, setSecondWeaponSet } from '../src/shared/itemsXml.js';
import { addExplicitLines, addImplicit, enchantEntry, poolLines, removeLine, replaceImplicits, setCorruptedRange, setEnchantSlot, setInfluences, setQuality, setRange, setSockets, setVariant, textLines, variantNames } from '../src/renderer/items/itemText.js';
import { compareLines, formatSigned, skillKindOf, type StatRow } from '../src/renderer/items/statCompareCore.js';
import { buildTradeUrl, tradeCategory, tradeMods } from '../src/renderer/items/tradeQuery.js';
import { alternateSlot, itemFitsSlot, listSlots } from '../src/renderer/items/slots.js';

const BUILD = `<?xml version="1.0" encoding="UTF-8"?>
<PathOfBuilding>
\t<Tree activeSpec="1">
\t\t<Spec treeVersion="3_29" classId="1" nodes="1,2">
\t\t\t<Sockets>
\t\t\t\t<Socket nodeId="7960" itemId="0" />
\t\t\t</Sockets>
\t\t</Spec>
\t</Tree>
\t<Items activeItemSet="1" useSecondWeaponSet="nil">
\t\t<Item id="1">
\t\t\tRarity: RARE
Doom Knuckle
Vaal Gauntlets
Quality: 20
Implicits: 0
+84 to maximum Life
\t\t</Item>
\t\t<Item id="2">
\t\t\tRarity: MAGIC
Cobalt Jewel of Archery
Implicits: 0
12% increased Projectile Damage
\t\t</Item>
\t\t<ItemSet useSecondWeaponSet="nil" id="1">
\t\t\t<Slot name="Gloves" itemId="1" />
\t\t\t<Slot name="Flask 1" itemId="0" />
\t\t</ItemSet>
\t</Items>
\t<Config />
</PathOfBuilding>
`;

test('reads items, the active set and jewel sockets', () => {
  const m = readItems(BUILD);
  assert.equal(m.items.length, 2);
  assert.equal(m.items[0]!.text.split('\n')[1], 'Doom Knuckle');
  assert.equal(activeSetOf(m).slots.get('Gloves')!.itemId, 1);
  assert.equal(m.specs[0]!.sockets.get(7960), 0);
});

test('adds an item with the next id and equips jewels in the active spec', () => {
  const a = addItem(BUILD, 'Rarity: NORMAL\nRuby Ring');
  assert.equal(a.id, 3);
  assert.ok(readItems(a.xml).items.some((i) => i.id === 3 && i.text.includes('Ruby Ring')));
  const j = setJewel(a.xml, 7960, 3);
  assert.equal(readItems(j).specs[0]!.sockets.get(7960), 3);
  const added = setJewel(j, 99, 2);
  assert.equal(readItems(added).specs[0]!.sockets.get(99), 2);
});

test('deleting an item empties every slot and socket that held it, and nothing else', () => {
  const j = setJewel(BUILD, 7960, 2);
  const d = deleteItems(j, [1, 2]);
  const m = readItems(d);
  assert.equal(m.items.length, 0);
  assert.equal(activeSetOf(m).slots.get('Gloves')!.itemId, 0);
  assert.equal(m.specs[0]!.sockets.get(7960), 0);
});

test('item sets: new, copy, rename, switch, delete (never the last)', () => {
  const n = newItemSet(BUILD, 'Budget');
  assert.equal(n.id, 2);
  let m = readItems(n.xml);
  assert.deepEqual(m.sets.map((s) => s.title), ['', 'Budget']);
  const c = newItemSet(n.xml, 'Copy', 1);
  m = readItems(c.xml);
  assert.equal(m.sets[2]!.slots.get('Gloves')!.itemId, 1);
  m = readItems(renameItemSet(c.xml, 2, 'Mirror'));
  assert.equal(m.sets[1]!.title, 'Mirror');
  m = readItems(setActiveSet(c.xml, 2));
  assert.equal(m.activeSet, 2);
  const del = readItems(deleteItemSet(setActiveSet(c.xml, 2), 2));
  assert.equal(del.sets.length, 2);
  assert.equal(del.activeSet, 1);
  assert.equal(readItems(deleteItemSet(BUILD, 1)).sets.length, 1);
});

test('weapon set and flask switches rewrite only the item set', () => {
  assert.ok(readItems(setSecondWeaponSet(BUILD, true)).sets[0]!.useSecond);
  assert.ok(readItems(setFlaskActive(BUILD, 'Flask 1', true)).sets[0]!.slots.get('Flask 1')!.active);
  assert.ok(!readItems(setFlaskActive(setFlaskActive(BUILD, 'Flask 1', true), 'Flask 1', false)).sets[0]!.slots.get('Flask 1')!.active);
  assert.equal(setItemText(BUILD, 2, 'Rarity: MAGIC\nOther').includes('<Notes'), false);
  assert.ok(readItems(setItemText(BUILD, 2, 'Rarity: MAGIC\nOther')).items[1]!.text.includes('Other'));
});

const RING = `Rarity: RARE
Doom Whorl
Two-Stone Ring
Quality: +20%
Sockets: R-G B
Implicits: 1
{enchant}+5 to Strength
{range:0.5}+(10-20) to Life
{fractured}+30% to Fire Resistance
Corrupted`;

test('text edits change one line and keep the rest', () => {
  assert.ok(setQuality(RING, 12).includes('Quality: +12%'));
  assert.ok(!setQuality(RING, null).includes('Quality:'));
  assert.ok(setSockets(RING, [{ c: 'W', link: false }, { c: 'W', link: true }, { c: 'R', link: false }]).includes('Sockets: W W-R'));
  assert.equal(textLines(setSockets(RING, [{ c: 'R', link: true }, { c: 'G', link: false }, { c: 'B', link: false }])).find((l) => l.startsWith('Sockets:')), 'Sockets: R-G B');
  assert.ok(setInfluences(RING, ['shaper', 'elder']).split('\n').slice(0, 6).join('|').includes('Shaper Item|Elder Item'));
  assert.ok(setRange(RING, 7, 0.25).includes('{range:0.25}{range') === false);
  assert.ok(textLines(setRange(RING, 7, 0.25))[7]!.startsWith('{range:0.25}'));
  assert.equal(removeLine(RING, 6, true).includes('+5 to Strength'), false);
  assert.ok(removeLine(RING, 6, true).includes('Implicits: 0'));
});

test('variants: names and selection', () => {
  const t = 'Rarity: UNIQUE\nX\nBow\nVariant: Pre 1.0\nVariant: Current\nImplicits: 0\n{variant:1}a';
  assert.deepEqual(variantNames(t), ['Pre 1.0', 'Current']);
  assert.ok(setVariant(t, 2).includes('Selected Variant: 2'));
  assert.equal(setVariant(setVariant(t, 2), 1).match(/Selected Variant/g)!.length, 1);
});

test('enchants, anoints and implicits go in the implicit block and keep the count right', () => {
  const t = 'Rarity: RARE\nA\nAmulet\nImplicits: 1\n{enchant}old\nimplicit line\n+10 life';
  const mods = [{ bucket: 'enchant', rawLine: 4 }, { bucket: 'implicit', rawLine: 5 }, { bucket: 'explicit', rawLine: 6 }];
  const swapped = setEnchantSlot(t, mods, 1, [enchantEntry('Allocates Acrimony')]);
  assert.ok(swapped.includes('{crafted}{enchant}Allocates Acrimony'));
  assert.ok(!swapped.includes('old'));
  assert.ok(swapped.includes('Implicits: 1'));
  const removed = setEnchantSlot(t, mods, 1, null);
  assert.ok(removed.includes('Implicits: 0'));
  assert.ok(!removed.includes('{enchant}'));
  const added = setEnchantSlot('Rarity: RARE\nA\nAmulet\nImplicits: 0\n+10 life', [{ bucket: 'explicit', rawLine: 4 }], 1, ['{crafted}{enchant}x']);
  assert.deepEqual(textLines(added).slice(3, 6), ['Implicits: 1', '{crafted}{enchant}x', '+10 life']);
  const corrupted = replaceImplicits(t, mods, 'implicit', poolLines(['attack'], 'implicit', ['+1 to Level of Socketed Gems']));
  assert.ok(corrupted.includes('{tags:attack}+1 to Level of Socketed Gems'));
  assert.ok(!corrupted.includes('implicit line'));
  assert.ok(addImplicit('Rarity: RARE\nA\nRing\n+1 life', 'x').includes('Implicits: 1'));
  assert.ok(addExplicitLines('Rarity: RARE\nA\nRing\nImplicits: 0\n+1 life\nCorrupted', ['{custom}z']).endsWith('{custom}z\nCorrupted'));
  assert.ok(setCorruptedRange('Rarity: UNIQUE\nA\nB\n+(10-20) life', 3, 1.1).includes('{corruptedRange:1.1}'));
  assert.ok(!setCorruptedRange('Rarity: UNIQUE\nA\nB\n{corruptedRange:1.1}+(10-20) life', 3, 1).includes('corruptedRange'));
});

test('stat comparison formats like the original and picks the right direction', () => {
  assert.equal(formatSigned('d', 12.9), '+12');
  assert.equal(formatSigned('d', -1234567), '-1,234,567');
  assert.equal(formatSigned('.1f', 3), '+3');
  assert.equal(formatSigned('.2f%%', 2.5), '+2.5%');
  assert.equal(formatSigned('.2fs', -0.25), '-0.25s');
  const rows: StatRow[] = [
    { stat: 'Life', label: 'Total Life', fmt: 'd', compPercent: true },
    { stat: 'ManaCost', label: 'Mana Cost', fmt: 'd', lowerIsBetter: true },
    { stat: 'Speed', label: 'Attack Rate', fmt: '.2f', flag: 'attack' },
    { stat: 'Speed', label: 'Cast Rate', fmt: '.2f', flag: 'spell' },
  ];
  const lines = compareLines(rows, [
    { statId: 'Life', before: 1000, after: 1100 },
    { statId: 'ManaCost', before: 30, after: 20 },
    { statId: 'Speed', before: 2, after: 2.5 },
    { statId: 'Other', before: 1, after: 2 },
  ], skillKindOf({ Speed: 2 }));
  assert.deepEqual(lines.map((l) => l.text), ['+100 Total Life (+10.0%)', '-10 Mana Cost', '+0.5 Attack Rate']);
  assert.deepEqual(lines.map((l) => l.good), [true, true, true]);
  assert.equal(compareLines(rows, [{ statId: 'Life', before: 5, after: 5.0001 }], skillKindOf({})).length, 0);
});

const info = (o: Partial<ItemInfo>): ItemInfo => ({ valid: true, name: 'X', lines: [], ...o });

test('slots: what fits where follows the original rules', () => {
  const one = { weapon1Type: 'None', weapon1OneHand: null } as const;
  assert.ok(itemFitsSlot(info({ type: 'One Handed Sword', isWeapon: true, oneHand: true }), 'Weapon 1', one));
  assert.ok(itemFitsSlot(info({ type: 'Shield' }), 'Weapon 2', one));
  assert.ok(!itemFitsSlot(info({ type: 'Two Handed Sword', isWeapon: true, oneHand: false }), 'Weapon 2', one));
  assert.ok(itemFitsSlot(info({ type: 'Quiver' }), 'Weapon 2', { weapon1Type: 'Bow', weapon1OneHand: false }));
  assert.ok(!itemFitsSlot(info({ type: 'Shield' }), 'Weapon 2', { weapon1Type: 'Bow', weapon1OneHand: false }));
  assert.ok(!itemFitsSlot(info({ type: 'Wand', isWeapon: true, oneHand: true }), 'Weapon 2', { weapon1Type: 'Sceptre', weapon1OneHand: true }));
  assert.ok(itemFitsSlot(info({ type: 'Wand', isWeapon: true, oneHand: true }), 'Weapon 2', { weapon1Type: 'Wand', weapon1OneHand: true }));
  assert.ok(itemFitsSlot(info({ type: 'Ring' }), 'Ring 2', one));
  assert.ok(itemFitsSlot(info({ type: 'Tincture' }), 'Flask 3', one));
  assert.ok(!itemFitsSlot(info({ type: 'Helmet' }), 'Gloves', one));
  const cluster = info({ type: 'Jewel', cluster: { size: 'Large Cluster Jewel', sizeIndex: 2 } });
  assert.ok(itemFitsSlot(cluster, 'Jewel 1', { ...one, node: { size: 2 } }));
  assert.ok(!itemFitsSlot(cluster, 'Jewel 1', { ...one, node: { size: 1 } }));
  assert.ok(!itemFitsSlot(cluster, 'Jewel 1', { ...one, node: { size: null } }));
  assert.ok(itemFitsSlot(info({ type: 'Jewel' }), 'Jewel 1', { ...one, node: { size: null } }));
  assert.ok(itemFitsSlot(info({ type: 'Jewel', abyssJewel: true }), 'Helmet Abyssal Socket 1', one));
  assert.equal(alternateSlot('Ring 1'), 'Ring 2');
  const s = listSlots({ second: true, abyssal: { 'Helmet': 2 }, filled: new Set(), ring3: false, grafts: false, sockets: [{ id: 5, size: 2 }] });
  assert.ok(s.some((x) => x.name === 'Weapon 1 Swap'));
  assert.ok(!s.some((x) => x.name === 'Ring 3' || x.name.startsWith('Graft')));
  assert.equal(s.filter((x) => x.kind === 'abyssal').length, 2);
  assert.equal(s.at(-1)!.name, 'Jewel 5');
});

test('trade search: category, stat filters and the link', () => {
  const stats = { explicit: { '+# to maximum Life': 'explicit.stat_3299347043', '#% increased Attack Speed': 'explicit.stat_681332047' }, implicit: {} };
  const item = info({
    type: 'Gloves', baseName: 'Vaal Gauntlets', rarity: 'RARE', name: 'Doom Knuckle',
    mods: [
      { bucket: 'explicit', text: '+84 to maximum Life', c: 'magic', rawLine: 5, range: 0.5, scalable: false, crafted: false, fractured: false, custom: false, mutated: false, prefix: false, suffix: false, unsupported: false },
      { bucket: 'explicit', text: '7% increased Attack Speed', c: 'magic', rawLine: 6, range: 0.5, scalable: false, crafted: false, fractured: false, custom: false, mutated: false, prefix: false, suffix: false, unsupported: false },
      { bucket: 'explicit', text: 'Something the trade site lacks', c: 'magic', rawLine: 7, range: null, scalable: false, crafted: false, fractured: false, custom: false, mutated: false, prefix: false, suffix: false, unsupported: false },
    ],
  });
  assert.equal(tradeCategory('Gloves', item), 'armour.gloves');
  assert.equal(tradeCategory('Weapon 1', info({ type: 'Two Handed Sword' })), 'weapon.twosword');
  assert.equal(tradeCategory('Ring 2', item), 'accessory.ring');
  const mods = tradeMods(item, stats);
  assert.deepEqual(mods.map((m) => [m.id, m.value]), [['explicit.stat_3299347043', 84], ['explicit.stat_681332047', 7], [undefined, undefined]]);
  const url = buildTradeUrl(item, mods, [], { realm: 'pc', league: 'Settlers of Kalguur', listed: 'securable', category: 'armour.gloves', baseType: true, ilvlMin: 80, defences: {}, mods: { [mods[0]!.key]: { on: true, min: 80 }, [mods[1]!.key]: { on: false }, [mods[2]!.key]: { on: true } } });
  assert.match(url, /^https:\/\/www\.pathofexile\.com\/trade\/search\/Settlers\+of\+Kalguur\?q=/);
  const q = JSON.parse(decodeURIComponent(url.split('?q=')[1]!)) as { query: { type: string; stats: Array<{ filters: Array<{ id: string; value: { min: number } }> }>; filters: Record<string, unknown> } };
  assert.equal(q.query.type, 'Vaal Gauntlets');
  assert.deepEqual(q.query.stats[0]!.filters, [{ id: 'explicit.stat_3299347043', value: { min: 80 } }]);
  assert.deepEqual(q.query.filters, { type_filters: { filters: { category: { option: 'armour.gloves' } } }, misc_filters: { filters: { ilvl: { min: 80 } } } });
  assert.match(buildTradeUrl(item, [], [], { realm: 'xbox', league: 'Standard', listed: 'any', category: null, baseType: false, defences: {}, mods: {} }), /\/trade\/search\/xbox\/Standard\?q=/);
  const unique = info({ rarity: 'UNIQUE', title: 'Foulborn Doom Knuckle 12', name: 'x', baseName: 'Vaal Gauntlets' });
  const uq = JSON.parse(decodeURIComponent(buildTradeUrl(unique, [], [], { realm: 'pc', league: 'Standard', listed: 'online', category: 'armour.gloves', baseType: false, defences: {}, mods: {} }).split('?q=')[1]!)) as { query: { name: string; type: string } };
  assert.equal(uq.query.name, 'Doom Knuckle');
  assert.equal(uq.query.type, 'Vaal Gauntlets');
});

test('trade search: weapon and armour local modifiers use the (Local) stat', () => {
  const stats = { explicit: { 'Adds # to # Physical Damage': 'explicit.stat_960081730', 'Adds # to # Physical Damage (Local)': 'explicit.stat_1940865751', '#% increased Attack Speed': 'explicit.stat_681332047', '#% increased Attack Speed (Local)': 'explicit.stat_210067635' }, implicit: { '#% of Physical Attack Damage Leeched as Life': 'implicit.stat_3593843976', '#% of Physical Attack Damage Leeched as Life (Local)': 'implicit.stat_55876295' } };
  const m = (bucket: NonNullable<ItemInfo['mods']>[number]['bucket'], text: string) => ({ bucket, text, c: 'magic' as const, rawLine: 5, range: 0.5, scalable: false, crafted: false, fractured: false, custom: false, mutated: false, prefix: false, suffix: false, unsupported: false });
  const claw = info({ type: 'Claw', baseName: 'Terror Claw', rarity: 'UNIQUE', name: 'The Scourge', mods: [m('implicit', '1.2% of Physical Attack Damage Leeched as Life'), m('explicit', 'Adds 40 to 70 Physical Damage'), m('explicit', '12% increased Attack Speed')] });
  assert.deepEqual(tradeMods(claw, stats).map((x) => x.id), ['implicit.stat_55876295', 'explicit.stat_1940865751', 'explicit.stat_210067635']);
  const gloves = info({ type: 'Gloves', baseName: 'Vaal Gauntlets', rarity: 'RARE', name: 'x', mods: [m('explicit', '7% increased Attack Speed')] });
  assert.deepEqual(tradeMods(gloves, stats).map((x) => x.id), ['explicit.stat_681332047']);
});
