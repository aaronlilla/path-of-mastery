// No raw NeverSink key may reach the screen as a tier name ("Deco mapup t16", "Qualchancing", "Armorsiq1", "Rrihide4").
// Every word of every tier name, in all seven NeverSink files, must be a word a player reads: an ordinary English word
// from the list below, a number, or a word that the tier's own item classes and base types carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseBlocks } from '../src/shared/lootfilter/blocks.js';
import { buildCatalog } from '../src/shared/lootfilter/catalog.js';
import { NEVERSINK_DIR } from './lootfilterHelpers.js';

const ENGLISH = new Set(
  ('tier top high good mid low lowest everything else hidden by neversink supplies portal wisdom scroll fragments any other others stack stacked custom over quality level early base bases rare rares magic normal large medium small tiny mirrored general jewel jewels jewellery abyss corrupted uncorrupted fractured veiled flask flasks utility life mana boots gloves helmet helmets shield shields quiver quivers body armour armours weapon weapons caster attack minion ring rings amulet amulets belt belts exotic delve incursion bestiary warband mercenary essence essences unique uniques special multi hide hideable final rest act link links linked socket sockets map maps scroll physical pure fire cold light lightning chaos focus defence spell core exalter blend bleed double single tincture tinctures perfection overquality anointed crucible talisman heist ritual expedition pearl sacrificial stygian mirage first areas under drop vaal gem gems staves wand wands sling relic relics key keys safe itemized leagues ultimatum sanctum corruption resist resists great greater optimal very the not and non no yes one two three four five six rgb cluster dual hit speed traps elemental glove helm chest random necropolis craft valuable synth imbued void stones trinket fishing rods pieces items totemic noble burial conqueror conqueror\'s idols idol minor enshrouded gear veil duo hybrid movement leveling levels zone selected mod mods enchanted handpicked foulborn invitations silver coin kamasan unknown boss bow vestige binding alchemy chance annul chrom aug divine exalted crusader warlord redeemer hunter shaper elder classes shared influenced exarch eater consumable labyrinth sacrificial standard misc miscellaneous fract based identified projectile suppress suppression generic quicksilver valdo valdo\'s nightmare guardian uber blighted temple lake of kalandra assorted mixed exception decorated damage energy critical transmutation tincture item passives wanted with in up to or less by slots wide tall area from stacks zana memory 6 linked identified normal and for a is on at unique daggers rune daggers sceptres claws swords axes maces bows staves two hand one thin fishing rod flask cards divination card currency orb orbs scarab scarabs fossil fossils resonator oil oils vial vials corpse corpses gold ducat ducats coin coins splinter splinters ancestors tattoo tattoos omen omens delirium sulphur lifeforce harvest simulacrum idol idols quest cursed pantheon souls time socketed').split(' '),
);

const bad = (label: string, own: Set<string>): string[] =>
  label
    .split(/[^A-Za-z0-9']+/)
    .filter(Boolean)
    .filter((w) => !/^\d+\+?$/.test(w) && w.length > 1 && !ENGLISH.has(w.toLowerCase()) && !own.has(w.toLowerCase()));

const files = readdirSync(NEVERSINK_DIR).filter((f) => f.endsWith('.filter'));

test('no tier name in any NeverSink file carries a raw key', () => {
  let tiers = 0;
  const flagged: string[] = [];
  for (const f of files) {
    const blocks = parseBlocks(readFileSync(join(NEVERSINK_DIR, f), 'utf8')).blocks;
    const cat = buildCatalog(blocks);
    for (const ty of cat.types) {
      const names = ty.tiers.map((t) => t.label);
      assert.equal(new Set(names).size, names.length, `${f} ${ty.type}: two tiers share a name`);
      for (const t of ty.tiers) {
        tiers++;
        const own = new Set<string>();
        for (const b of blocks) if (b.tag && b.tag.type === t.type && b.tag.tier === t.tier) for (const c of b.conditions) if (c.key === 'Class' || c.key === 'BaseType') for (const v of c.values) for (const w of v.toLowerCase().split(/[^a-z']+/)) own.add(w);
        const raw = bad(t.label, own);
        if (raw.length) flagged.push(`${f} ${t.type}/${t.tier} -> "${t.label}" (${raw.join(', ')})`);
      }
    }
  }
  assert.ok(tiers > 4000, `${tiers} tiers checked`);
  assert.deepEqual(flagged.slice(0, 60), [], `${flagged.length} of ${tiers} tier names carry raw keys`);
});

test('the names the reviewer found read as what the tier matches', () => {
  const cat = buildCatalog(parseBlocks(readFileSync(join(NEVERSINK_DIR, '2-SEMI-STRICT.filter'), 'utf8')).blocks);
  const label = (type: string, tier: string): string => cat.tierByKey.get(`${type}|${tier}`)!.label;
  assert.equal(label('maps', 'deco_mapup_t16'), 'Maps tier 16+, decorated');
  assert.match(label('crafting->qualityperfection', 'qualchancing'), /^Quality 26\+/);
  assert.match(label('crafting->qualityperfection', 'armors1q1'), /^Quality 28\+/);
  assert.match(label('gems->exceptional', 'highexceptionalbadcorrupt'), /^Corrupted gems/);
  assert.match(label('hidelayer', 'rrihide4'), /^Rare gear/);
  assert.equal(label('uniques', 'exuberimpresence').startsWith('Unique'), true);
});
