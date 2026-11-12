import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GemInfo } from '@pom/protocol';
import { defaultGemLevel, gemSlug, groupToText, matchColourOrder, matchSummary, previewPercent, searchGems, textToGroup, type PickerFilter } from '../src/shared/skillsLogic.js';

const gem = (name: string, o: Partial<GemInfo> = {}): GemInfo => ({
  id: 'G/' + name, gameId: 'G/' + name, name, colour: 'str', support: false, exceptional: false, legacy: false, vaal: false, tags: [], naturalMaxLevel: 20, maxLevel: 21,
  levelReq: Array.from({ length: 21 }, (_, i) => 1 + i * 4), reqStr: 0, reqDex: 0, reqInt: 0, plusVersion: false, imbuedOk: true, effectName: name, ...o,
});
const GEMS = [
  gem('Cold to Fire', { support: true, colour: 'int', tags: ['support', 'cold', 'fire'] }),
  gem('Cyclone', { tags: ['attack', 'melee', 'area', 'grants_active_skill'] }),
  gem('Arc', { colour: 'int', tags: ['spell', 'lightning', 'chaining', 'grants_active_skill'] }),
  gem('Awakened Added Fire Damage', { support: true, exceptional: true, tags: ['support', 'fire'] }),
  gem('Added Fire Damage', { support: true, tags: ['support', 'fire'] }),
  gem("Warlord's Mark", { legacy: true, tags: ['curse'] }),
];
const F: PickerFilter = { options: { showSupportGemTypes: 'ALL', showLegacyGems: false, defaultGemLevel: 'normalMaximum' }, characterLevel: 90, kind: null };
const names = (l: GemInfo[]) => l.map((g) => g.name);

test('slugs match the art file names', () => {
  assert.equal(gemSlug('Awakened Elemental Damage with Attacks'), 'awakened-elemental-damage-with-attacks');
  assert.equal(gemSlug("Warlord's Mark"), 'warlords-mark');
  assert.equal(gemSlug('Vaal Molten Shell'), 'vaal-molten-shell');
});

test('search: exact, then abbreviation, then starts with, then contains', () => {
  assert.deepEqual(names(searchGems(GEMS, 'cyclone', F)), ['Cyclone']);
  assert.deepEqual(names(searchGems(GEMS, 'ctf', F)), ['Cold to Fire']);
  assert.deepEqual(names(searchGems(GEMS, 'added', F)), ['Added Fire Damage', 'Awakened Added Fire Damage']);
  assert.deepEqual(names(searchGems(GEMS, 'fire', F)), ['Added Fire Damage', 'Awakened Added Fire Damage', 'Cold to Fire']);
});

test('search: tag filters, aliases and exclusion', () => {
  assert.deepEqual(names(searchGems(GEMS, ':fire', F)), ['Added Fire Damage', 'Awakened Added Fire Damage', 'Cold to Fire']);
  assert.deepEqual(names(searchGems(GEMS, ':fire:-cold', F)), ['Added Fire Damage', 'Awakened Added Fire Damage']);
  assert.deepEqual(names(searchGems(GEMS, ':active:aoe', F)), ['Cyclone']);
  assert.deepEqual(names(searchGems(GEMS, ':int:active', F)), ['Arc']);
});

test('search: options filter legacy, exceptional and kind', () => {
  assert.ok(!names(searchGems(GEMS, '', F)).includes("Warlord's Mark"));
  assert.ok(names(searchGems(GEMS, '', { ...F, options: { ...F.options, showLegacyGems: true } })).includes("Warlord's Mark"));
  const ex = searchGems(GEMS, '', { ...F, options: { ...F.options, showSupportGemTypes: 'EXCEPTIONAL' } });
  assert.ok(ex.every((g) => !g.support || g.exceptional));
  assert.deepEqual(names(searchGems(GEMS, '', { ...F, kind: 'A' })), ['Arc', 'Cyclone']);
  assert.deepEqual(names(searchGems(GEMS, '', { ...F, options: { ...F.options, showSupportGemTypes: 'NORMAL' }, kind: 'S' })), ['Added Fire Damage', 'Cold to Fire']);
});

test('default gem levels follow the five modes', () => {
  const g = gem('X');
  assert.equal(defaultGemLevel(g, 'normalMaximum', 90), 20);
  assert.equal(defaultGemLevel(g, 'corruptedMaximum', 90), 21);
  assert.equal(defaultGemLevel(gem('P', { plusVersion: true }), 'corruptedMaximum', 90), 20);
  assert.equal(defaultGemLevel(g, 'awakenedMaximum', 90), 21);
  assert.equal(defaultGemLevel(g, 'levelOne', 90), 1);
  assert.equal(defaultGemLevel(g, 'characterLevel', 50), 13);
  assert.equal(defaultGemLevel(g, 'normalMaximum', 90, true), 1);
});

test('group text round trips in the original grammar', () => {
  const text = groupToText({ label: 'Mapping', slot: 'Body Armour', gems: [{ nameSpec: 'Cyclone', level: 20, quality: 20, enabled: true, count: 1 }, { nameSpec: 'Added Fire Damage', level: 18, quality: 0, enabled: false, count: 2 }] });
  assert.equal(text, 'Label: Mapping\r\nSlot: Body Armour\r\nCyclone 20/20  1\r\nAdded Fire Damage 18/0 DISABLED 2\r\n');
  const g = textToGroup(text)!;
  assert.equal(g.label, 'Mapping');
  assert.equal(g.slot, 'Body Armour');
  assert.deepEqual(g.gems, [
    { nameSpec: 'Cyclone', level: 20, quality: 20, enabled: true, count: 1 },
    { nameSpec: 'Added Fire Damage', level: 18, quality: 0, enabled: false, count: 2 },
  ]);
  assert.equal(textToGroup('nothing here'), null);
});

test('match colours puts each gem in a socket of its colour, and says nothing when no gain exists', () => {
  const gems = [{ colour: 'int' as const, support: false }, { colour: 'str' as const, support: true }, { colour: 'dex' as const, support: true }];
  assert.deepEqual(matchColourOrder(gems, ['R', 'W', 'B']), [2, 3, 1]);
  assert.equal(matchColourOrder(gems, ['W', 'W', 'W']), null);
  assert.equal(matchColourOrder([gems[1]!, gems[0]!], ['R', 'B']), null);
});

test('match summary counts coloured and matched sockets', () => {
  const gems = [{ colour: 'str' as const }, { colour: 'int' as const }, { colour: 'dex' as const }];
  assert.deepEqual(matchSummary(gems, ['R', 'W', 'B']), { matched: 1, coloured: 2 });
});

test('preview percent reads the chosen stat from an engine diff', () => {
  assert.equal(previewPercent([{ statId: 'FullDPS', before: 100, after: 125 }], 'FullDPS'), 0.25);
  assert.equal(previewPercent([{ statId: 'Life', before: 1, after: 2 }], 'FullDPS'), null);
  assert.equal(previewPercent([{ statId: 'FullDPS', before: 0, after: 5 }], 'FullDPS'), null);
});

test('skill id: the variant id, or the granted effect id for the gems that spell it differently', async () => {
  const { skillIdOf, dpsColour, gemTagLabels, gemWikiUrl, optimisedSockets, optimiseWanted, openingGroup, appendedGroupIndex } = await import('../src/shared/skillsLogic.js');
  assert.equal(skillIdOf({ id: 'Metadata/Items/Gems/SkillGemFireball', variantId: 'Fireball' }), 'Fireball');
  assert.equal(skillIdOf({ id: 'Metadata/Items/Gems/SkillGemStormBind', variantId: 'StormBind' }), 'Stormbind');
  assert.equal(skillIdOf({ id: 'Metadata/Items/Gems/SkillGemSupportCastonMeleeKill', variantId: 'SupportCastonMeleeKill' }), 'SupportCastOnMeleeKill');
  assert.equal(dpsColour(3), '#228866');
  assert.equal(dpsColour(-0.1), '#ff4422');
  assert.equal(dpsColour(0), '#ffff66');
  assert.deepEqual(gemTagLabels(['area', 'grants_active_skill', 'spell', 'strength']), ['AoE', 'Spell']);
  assert.equal(gemWikiUrl('Added Fire Damage', true), 'https://www.poewiki.net/wiki/Added_Fire_Damage_Support');
  assert.equal(gemWikiUrl('Cyclone', false), 'https://www.poewiki.net/wiki/Cyclone');
  // Optimise Sockets: a socket per gem, linked inside a group, cut at the item's limit.
  const g = (c: 'str' | 'dex' | 'int' | 'w') => ({ colour: c });
  assert.deepEqual(optimisedSockets([[g('str'), g('dex')], [g('int')]], 6), [{ c: 'R', link: true }, { c: 'G', link: false }, { c: 'B', link: false }]);
  assert.deepEqual(optimisedSockets([[g('str'), g('dex'), g('int')]], 2), [{ c: 'R', link: true }, { c: 'G', link: false }]);
  assert.deepEqual(optimisedSockets([], 6), []);
  assert.equal(optimiseWanted([{ gems: [{ matchesSocket: true }, { matchesSocket: false }] }], 6), true);
  assert.equal(optimiseWanted([{ gems: [{ matchesSocket: true }, { matchesSocket: false }] }], 1), false);
  assert.equal(optimiseWanted([], 6), false);
  // Opening the tab selects the main skill's group; New and Paste add after the last saved group.
  assert.equal(openingGroup(2, 6), 2);
  assert.equal(openingGroup(9, 6), 1);
  assert.equal(openingGroup(1, 0), null);
  assert.equal(appendedGroupIndex([{}, {}, { source: 'item' }]), 3);
  assert.equal(appendedGroupIndex([]), 1);
});
