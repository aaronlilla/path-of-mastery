import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archetypeTag, levelingLite, matchCards, readBuildProfile } from '../src/shared/lootfilter/profile.js';
import { parseCardWikitext } from '../src/main/lootfilter/cardRewards.js';
import { fixture, loadGame } from './buildFilterHelpers.js';

test('PConc fixture: no weapons, body armour archetype from the base tag, 4 green sockets, the build uniques', () => {
  const g = loadGame();
  const p = readBuildProfile(fixture('pconc-pathfinder.xml'), g)!;
  assert.equal(p.className, 'Ranger');
  assert.equal(p.mainSkill?.name, 'Poisonous Concoction');
  assert.deepEqual(p.weaponClasses, []);
  assert.match(p.weaponWhy, /unarmed/);
  const body = p.slots.find((s) => s.slot === 'Body Armour')!;
  assert.equal(body.base, 'Sentinel Jacket');
  assert.equal(p.armour['Body Armours']!.tag, archetypeTag(g.bases[body.base]));
  assert.equal(p.armour['Body Armours']!.tag, 'dex_int_armour');
  const main = p.skillGroups.find((s) => s.main)!;
  assert.equal(main.slot, 'Body Armour');
  assert.ok(main.colours.split('').filter((c) => c === 'G').length >= 4, main.colours);
  assert.deepEqual(p.uniques.map((u) => u.name).sort(), ["Coralito's Signature", 'Dendrobate', 'Dusktoe', 'Replica Sorrow of the Divine', "Ungil's Harmony"]);
  assert.ok(p.chromaticNeed, 'four green links on a dex/int jacket ask for off-colour sockets');
  assert.ok(p.skillGroups.every((s) => s.why));
  assert.ok(p.currencyNeeds.some((c) => c.item === "Armourer's Scrap"));
  assert.deepEqual(levelingLite(p).mainSkillId, 'Metadata/Items/Gems/SkillGemPoisonousConcoction');
});

test('melee fixture: weapon classes come from the equipped weapon', () => {
  const p = readBuildProfile(fixture('melee-cleave.xml'), loadGame())!;
  assert.equal(p.mainSkill?.name, 'Cleave');
  assert.deepEqual(p.weaponClasses, ['One Hand Swords']);
  assert.equal(p.armour['Body Armours']!.tag, 'str_armour');
});

test('a file that is not a build gives null', () => {
  assert.equal(readBuildProfile('nope', loadGame()), null);
});

test('cards: the wiki description names the reward, and only build rewards match', () => {
  const doc = '{{Item\n|class_id = DivinationCard\n|stack_size = 8\n|description = {{c|unique|{{iil|Headhunter}}}}\n}}';
  assert.deepEqual(parseCardWikitext('The Doctor', doc), { kind: 'unique', reward: 'Headhunter', stack: 8 });
  assert.equal(parseCardWikitext('Not a card', '{{Item|class_id = Gem}}'), null);
  const cards = matchCards({ 'The Doctor': { kind: 'unique', reward: 'Headhunter', stack: 8 }, 'The Fiend': { kind: 'unique', reward: 'Dendrobate', stack: 11 }, Other: { kind: 'gem', reward: 'Cleave', stack: 2 } }, [{ name: 'Dendrobate', slot: 'Body Armour' }], ['Poisonous Concoction']);
  assert.deepEqual(cards.map((c) => c.card), ['The Fiend']);
  assert.match(cards[0]!.why, /Turn in 11 for Dendrobate, your body armour/);
});
