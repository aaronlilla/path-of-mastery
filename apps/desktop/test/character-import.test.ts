import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charactersIn, hasDiscriminator, leaguesOf, normalizeAccountName, pickLeague, startEnabled, standardLeagueFor, TREE_AND_JEWELS, ITEMS_AND_SKILLS, type CharacterRow } from '../src/shared/characterImport.js';
import { buildCounts, readExportParty, setExportParty } from '../src/shared/importXml.js';
import { checkBuildXml, blankBuildXml } from '../src/shared/buildXml.js';
import { readItems } from '../src/shared/itemsXml.js';
import { accountFromProfile, CharacterApi, ImportError } from '../src/main/character/api.js';
import { applyCharacter, appendSpecNodes, estimateAct, resistancePenaltyFor, type ConvertData, type TreeInfo } from '../src/main/character/convert.js';
import { itemToRaw, sanitiseText, type GItem, type ItemData } from '../src/main/character/items.js';
import { CharacterService } from '../src/main/character/service.js';
import { GggError } from '../src/main/wealth/ggg.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---- account names and lists -----------------------------------------------------------------------------------------

test('account names follow the original: PC drops spaces, the last - or # is the discriminator mark', () => {
  assert.equal(normalizeAccountName(' Kaelen - 4821 ', 'pc'), 'Kaelen#4821');
  assert.equal(normalizeAccountName('Kaelen-4821', 'pc'), 'Kaelen#4821');
  assert.equal(normalizeAccountName('A-B-1234', 'pc'), 'A-B#1234');
  assert.equal(normalizeAccountName(' Some Name#1234 ', 'xbox'), 'Some+Name#1234');
  assert.equal(startEnabled('Kaelen#4821'), true);
  assert.equal(startEnabled('Kaelen'), false);
  assert.equal(startEnabled('#4821'), false);
  assert.equal(hasDiscriminator('Kaelen-4821'), true);
});

const rows: CharacterRow[] = [
  { name: 'Zed', league: 'Standard', class: 'Slayer', level: 90, realm: 'pc' },
  { name: 'abe', league: 'Mercenaries', class: 'Pathfinder', level: 97, realm: 'pc' },
  { name: 'Cy', league: 'Mercenaries', class: 'Juggernaut', level: 80, realm: 'pc' },
  { name: 'Xo', league: 'Standard', class: 'Witch', level: 10, realm: 'xbox' },
];

test('leagues and characters are listed per realm, sorted without regard to case', () => {
  assert.deepEqual(leaguesOf(rows, 'pc'), ['Mercenaries', 'Standard']);
  assert.deepEqual(charactersIn(rows, 'pc', 'Mercenaries').map((c) => c.name), ['abe', 'Cy']);
  assert.deepEqual(charactersIn(rows, 'pc', '').map((c) => c.name), ['abe', 'Cy', 'Zed']);
  assert.equal(pickLeague(['Mercenaries', 'Standard'], 'Mercenaries'), 'Mercenaries');
  assert.equal(pickLeague(['Hardcore', 'Standard'], 'Settlers'), 'Standard');
  assert.equal(pickLeague(['Hardcore', 'Standard'], 'Hardcore Settlers'), 'Hardcore');
  assert.equal(standardLeagueFor('SSF Settlers'), 'SSF Standard');
});

// ---- the site: recorded answer shapes ----------------------------------------------------------------------------------

const LIST_BODY = JSON.stringify([
  { name: 'KaelenCyclone', league: 'Mercenaries', classId: 4, class: 'Slayer', level: 97, experience: 1, realm: 'pc' },
  { name: 'KaelenTR', league: 'Standard', classId: 2, class: 'Pathfinder', level: 88 },
]);
const PROFILE_HTML = '<a href="/account/view-profile/Kaelen-4821/characters">Characters</a>';

function fakeWindow(answers: Record<string, string | GggError>) {
  const calls: { path: string; query: Record<string, string>; cookie: boolean }[] = [];
  const fn = async (path: string, query: Record<string, string>, cookie: boolean) => {
    calls.push({ path, query, cookie });
    const a = answers[path] ?? answers[path.split('?')[0]!];
    if (a === undefined) throw new GggError('not-found', 'no such page');
    if (a instanceof GggError) throw a;
    return a;
  };
  return { fn, calls };
}

test('listing a public account asks for the list, then the profile for the right casing, without the cookie', async () => {
  const w = fakeWindow({ '/character-window/get-characters': LIST_BODY, '/account/view-profile/kaelen%234821': PROFILE_HTML });
  const out = await new CharacterApi(w.fn).listCharacters('pc', 'kaelen - 4821', false);
  assert.equal(out.account, 'Kaelen#4821');
  assert.equal(out.characters.length, 2);
  assert.deepEqual(out.characters[0], { name: 'KaelenCyclone', league: 'Mercenaries', class: 'Slayer', classId: 4, level: 97, realm: 'pc' });
  assert.equal(out.characters[1]!.realm, 'pc', 'a row with no realm takes the asked realm');
  assert.equal(w.calls[0]!.query.accountName, 'kaelen%234821');
  assert.equal(w.calls[0]!.query.realm, 'pc');
  assert.ok(w.calls.every((c) => c.cookie === false));
});

test('a profile page the site turns away does not stop the list: the typed name is used', async () => {
  const w = fakeWindow({ '/character-window/get-characters': LIST_BODY, '/account/view-profile/Kaelen%234821': new GggError('private', 'blocked') });
  const out = await new CharacterApi(w.fn).listCharacters('pc', 'Kaelen#4821', false);
  assert.equal(out.account, 'Kaelen#4821');
});

test('listing says what went wrong in the original\'s words', async () => {
  const api = (a: Record<string, string | GggError>) => new CharacterApi(fakeWindow(a).fn);
  await assert.rejects(api({ '/character-window/get-characters': new GggError('private', 'x') }).listCharacters('pc', 'A#1234', false), /Account profile is private or does not exist\./);
  await assert.rejects(api({ '/character-window/get-characters': new GggError('not-found', 'x') }).listCharacters('pc', 'A#1234', false), /Account name is incorrect\./);
  await assert.rejects(api({ '/character-window/get-characters': '[]' }).listCharacters('pc', 'A#1234', false), /no characters to import/);
  await assert.rejects(api({ '/character-window/get-characters': 'oops' }).listCharacters('pc', 'A#1234', false), /Error processing character list/);
  await assert.rejects(api({ '/character-window/get-characters': new GggError('rate-limited', 'x', 42) }).listCharacters('pc', 'A#1234', false), /too fast\. Please wait 42 seconds/);
  await assert.rejects(api({ '/character-window/get-characters': new GggError('expired', 'x') }).listCharacters('pc', 'A#1234', true), /session was refused/);
  await assert.rejects(api({ '/character-window/get-characters': new GggError('down', 'The site answered 500') }).listCharacters('pc', 'A#1234', false), (e: unknown) => e instanceof ImportError && /try again/.test(e.message));
});

test('a character answer of "false" is the site refusing the character', async () => {
  const api = new CharacterApi(fakeWindow({ '/character-window/get-items': 'false', '/character-window/get-passive-skills': '{"hashes":[1]}' }).fn);
  await assert.rejects(api.character('items', 'pc', 'A#1234', 'X', false), /Failed to retrieve character data/);
  const p = await api.character('passives', 'pc', 'A#1234', 'X', false);
  assert.deepEqual(p.hashes, [1]);
});

test('the account name is found in the profile page links', () => {
  assert.equal(accountFromProfile(PROFILE_HTML), 'Kaelen#4821');
  assert.equal(accountFromProfile('<a href="/account/view-profile/K%C3%A4len-0001/characters">'), 'Kälen#0001');
  assert.equal(accountFromProfile('<html></html>'), null);
});

// ---- the service: the session stays in the main process ---------------------------------------------------------

function service(session: { connected: boolean; account: string }, answers: Record<string, string>) {
  const w = fakeWindow(answers);
  const svc = new CharacterService({ file: join(mkdtempSync(join(tmpdir(), 'ci-')), 'c.json'), window: w.fn, session: () => session, data: async () => data });
  return { svc, calls: w.calls };
}

test('the connected player\'s characters are read with the session, a public name without it', async () => {
  const answers = { '/character-window/get-characters': LIST_BODY, '/account/view-profile/Me%231234': '<a href="/account/view-profile/Me-1234/characters">' };
  const a = service({ connected: true, account: 'Me#1234' }, answers);
  const mine = await a.svc.list('account', 'pc', 'ignored');
  assert.equal(mine.account, 'Me#1234');
  assert.ok(a.calls.every((c) => c.cookie === true));
  assert.ok(a.calls.every((c) => JSON.stringify(c).includes('ignored') === false), 'the typed name is not used for the player\'s own list');
  const b = service({ connected: true, account: 'Me#1234' }, { ...answers, '/account/view-profile/Other%235678': '' });
  await b.svc.list('name', 'pc', 'Other#5678');
  assert.ok(b.calls.every((c) => c.cookie === false));
});

test('after Logout the player\'s own characters are not read until Authorize', async () => {
  const { svc } = service({ connected: true, account: 'Me#1234' }, { '/character-window/get-characters': LIST_BODY });
  assert.equal((await svc.access()).signedOut, false);
  await svc.signOut();
  await assert.rejects(svc.list('account', 'pc', ''), /Not authenticated/);
  assert.equal((await svc.authorize()).signedOut, false);
  await svc.list('account', 'pc', '');
  const none = service({ connected: false, account: '' }, {});
  await assert.rejects(none.svc.authorize(), /Connect your account in Wealth/);
});

test('account history keeps the newest first, without repeats, and can be cleared and restored', async () => {
  const body = { '/character-window/get-characters': LIST_BODY };
  const { svc } = service({ connected: false, account: '' }, { ...body, '/account/view-profile/A%231111': '<a href="/account/view-profile/A-1111/characters">', '/account/view-profile/B%232222': '<a href="/account/view-profile/B-2222/characters">', '/account/view-profile/a%231111': '<a href="/account/view-profile/A-1111/characters">' });
  await svc.list('name', 'pc', 'A#1111');
  await svc.list('name', 'pc', 'B#2222');
  await svc.list('name', 'pc', 'a#1111');
  const h = (await svc.access()).history;
  assert.deepEqual(h, ['A#1111', 'B#2222']);
  assert.deepEqual(await svc.setHistory([]), []);
  assert.deepEqual(await svc.setHistory(h), h);
});

// ---- converting a character into build text ---------------------------------------------------------------------------

const data: ConvertData = makeData();

function makeData(): ConvertData {
  const bases: ItemData['bases'] = {
    'Titan Greaves': { type: 'Boots', armour: {} },
    'Maelstrom Staff': { type: 'Staff', weapon: {} },
    'Gold Amulet': { type: 'Amulet' },
    'Cobalt Jewel': { type: 'Jewel' },
    'Colossal Tower Shield': { type: 'Shield', armour: {} },
    'Two-Toned Boots (Armour/Energy Shield)': { type: 'Boots', armour: {} },
    'Two-Toned Boots (Armour/Evasion)': { type: 'Boots', armour: {} },
    'Two-Toned Boots (Evasion/Energy Shield)': { type: 'Boots', armour: {} },
    'Rusted Sword': { type: 'One Handed Sword', weapon: {} },
  };
  const gems: ItemData['gems'] = {
    'Metadata/Items/Gems/SkillGemCyclone': { id: 'Metadata/Items/Gems/SkillGemCyclone', gameId: 'Metadata/Items/Gems/SkillGemCyclone', variantId: 'Cyclone', grantedEffectId: 'Cyclone', name: 'Cyclone' },
    'Metadata/Items/Gems/SkillGemSupportMelee': { id: 'Metadata/Items/Gems/SkillGemSupportMelee', gameId: 'Metadata/Items/Gems/SupportGemMelee', variantId: 'SupportMelee', grantedEffectId: 'SupportMelee', name: 'Melee Physical Damage' },
  };
  const tree = (): TreeInfo => ({
    classes: [
      { name: 'Scion', ascendancies: ['Ascendant'] },
      { name: 'Marauder', ascendancies: ['Juggernaut', 'Berserker', 'Chieftain'] },
      { name: 'Ranger', ascendancies: ['Raider', 'Deadeye', 'Pathfinder'] },
      { name: 'Witch', ascendancies: [] },
      { name: 'Duelist', ascendancies: ['Slayer', 'Gladiator', 'Champion'] },
    ],
    jewelSlots: [26725, 36634, 33989],
    nodes: { '58833': { type: 'ClassStart' }, '100': {}, '101': {}, '102': { type: 'Mastery' }, '9000': { ascendancyName: 'Slayer' }, '9001': { type: 'AscendClassStart', ascendancyName: 'Slayer' } },
    secondaryAscend: { Abyssal: 16 },
    tattoos: { 'Acrobatics Tattoo': { dn: 'Acrobatics Tattoo', icon: 'a.png', activeEffectImage: 'b.png', sd: ['+10 to Dexterity'] } },
  });
  return {
    items: { bases, gems, gemForBaseName: { cyclone: 'Metadata/Items/Gems/SkillGemCyclone', 'melee physical damage support': 'Metadata/Items/Gems/SkillGemSupportMelee' }, vaalGemFor: {} },
    tree,
    latestTree: '3_29',
    hasTree: (v) => v === '3_29' || v === '3_29_ruthless',
  };
}

const char: CharacterRow = { name: 'KaelenCyclone', league: 'Mercenaries', class: 'Slayer', classId: 4, level: 97, realm: 'pc' };

const BOOTS: GItem = { id: 'boots1', inventoryId: 'Boots', frameType: 2, name: 'Doom Stride', typeLine: 'Titan Greaves', ilvl: 83, properties: [{ name: 'Quality', values: [['+20%', 1]] }, { name: 'Armour', values: [['500', 1]] }], requirements: [{ name: 'Level', values: [['68', 0]] }], sockets: [{ group: 0, sColour: 'R' }, { group: 0, sColour: 'G' }, { group: 1, sColour: 'B' }], explicitMods: ['+80 to maximum Life', '30% increased Movement Speed'], implicitMods: ['10% increased Armour'], corrupted: true, socketedItems: [{ typeLine: 'Cyclone', support: false, socket: 0, properties: [{ name: 'Level', values: [['21 (Max)', 0]] }, { name: 'Quality', values: [['+23%', 0]] }] }, { typeLine: 'Melee Physical Damage Support', support: true, socket: 1, properties: [{ name: 'Level', values: [['20', 0]] }] }] };
const AMULET: GItem = { id: 'amu1', inventoryId: 'Amulet', frameType: 3, name: 'Bisco', typeLine: 'Gold Amulet', ilvl: 65, influences: { shaper: true, warlord: true }, enchantMods: ['Allocates Something'], explicitMods: ['+5 to all Attributes'], craftedMods: ['+1 to Level of all'], properties: [{ name: 'Quality (Life and Mana Modifiers)', values: [['+10%', 1]] }] };
const JEWEL: GItem = { id: 'jew1', inventoryId: 'PassiveJewels', x: 2, frameType: 2, name: 'Grim Gaze', typeLine: 'Cobalt Jewel', ilvl: 80, properties: [{ name: 'Radius', values: [['Large', 0]] }], explicitMods: ['+10 to Intelligence'] };
const SWAP: GItem = { id: 'sw1', inventoryId: 'Weapon2', frameType: 0, name: '', typeLine: 'Rusted Sword', ilvl: 1, properties: [], socketedItems: [] };

test('an item becomes the item text the original writes', () => {
  const r = itemToRaw(BOOTS, data.items)!;
  assert.equal(r.baseName, 'Titan Greaves');
  assert.deepEqual(r.raw.split('\n').slice(0, 8), ['Rarity: RARE', 'Doom Stride', 'Titan Greaves', 'Armour: 500', 'Unique ID: boots1', 'Item Level: 83', 'Quality: 20', 'Sockets: R-G B']);
  assert.match(r.raw, /Implicits: 1\n10% increased Armour\n\+80 to maximum Life\n30% increased Movement Speed\nCorrupted$/);
  assert.equal(r.raw.includes('LevelReq'), false, 'requirements are not trusted when gems are socketed');
  const a = itemToRaw(AMULET, data.items)!.raw.split('\n');
  assert.ok(a.includes('Shaper Item') && a.includes('Warlord Item'));
  assert.ok(a.indexOf('Shaper Item') < a.indexOf('Warlord Item'), 'influences in the original\'s order');
  assert.ok(a.includes('Catalyst: Fertile'));
  assert.ok(a.includes('CatalystQuality: 10'));
  assert.ok(a.includes('{crafted}Allocates Something') && a.includes('{crafted}+1 to Level of all'));
  assert.equal(itemToRaw({ ...BOOTS, typeLine: 'Unknown Boots Of Nothing' }, data.items), null, 'an unknown base is skipped');
  assert.equal(itemToRaw({ ...BOOTS, frameType: 5 }, data.items), null, 'no rarity is skipped');
});

const TREE_JSON = { hashes: [100, 101, 102, 9000, 65537], hashes_ex: [], mastery_effects: { '102': 1234 }, skill_overrides: { '101': { name: 'Acrobatics Tattoo' } }, alternate_ascendancy: 0, items: [JEWEL], bandit_choice: 'Alira', pantheon_major: 'Solaris' };
const ITEMS_JSON = { items: [BOOTS, AMULET, SWAP], character: {} };

test('importing the tree puts class, nodes, masteries, tattoos, level and quest choices in the build and the jewels in their sockets', () => {
  const base = blankBuildXml('Scion', 1);
  const out = applyCharacter(base, { character: char, passives: TREE_JSON }, { ...TREE_AND_JEWELS, deleteJewels: true }, data);
  assert.deepEqual(checkBuildXml(out.xml), { ok: true });
  assert.match(out.xml, /<Spec treeVersion="3_29" clusterHashFormatVersion="2" classId="4" ascendClassId="1" secondaryAscendClassId="0" nodes="100,101,102,9000,65537" masteryEffects="\{102,1234\}">/);
  assert.match(out.xml, /<Override nodeId="101" icon="a.png" activeEffectImage="b.png" dn="Acrobatics Tattoo">\+10 to Dexterity<\/Override>/);
  const build = /<Build\b[^>]*>/.exec(out.xml)![0];
  for (const a of ['level="97"', 'className="Duelist"', 'ascendClassName="Slayer"', 'bandit="Alira"', 'pantheonMajorGod="Solaris"', 'characterLevelAutoMode="false"']) assert.ok(build.includes(a), `${a} in ${build}`);
  assert.match(out.xml, /<Input name="bandit" string="Alira" \/>/);
  const m = readItems(out.xml);
  assert.equal(m.items.length, 1);
  assert.equal(m.specs[0]!.sockets.get(33989), 1, 'a jewel with x = 2 goes to the third jewel socket of the tree');
  assert.ok(out.notes.some((n) => /Passive tree imported: 5 nodes/.test(n)));
  assert.ok(out.notes.some((n) => /Jewels imported: 1/.test(n)));
});

test('the resistance penalty follows the original\'s act estimate', () => {
  assert.equal(estimateAct(0).act, 1);
  assert.equal(resistancePenaltyFor(estimateAct(1).act), 0);
  assert.equal(resistancePenaltyFor(estimateAct(62).act), -30);
  assert.deepEqual(estimateAct(62), { act: 7, level: 51 });
  assert.equal(resistancePenaltyFor(estimateAct(121).act), null);
  assert.equal(estimateAct(121).act, 'Endgame');
});

test('importing items and skills fills the slots, and replaces what was there when asked', () => {
  const first = applyCharacter(blankBuildXml('Duelist', 1), { character: char, items: ITEMS_JSON }, ITEMS_AND_SKILLS, data);
  const m = readItems(first.xml);
  assert.equal(m.items.length, 3);
  const slots = m.sets[0]!.slots;
  assert.ok(slots.get('Boots')!.itemId > 0 && slots.get('Amulet')!.itemId > 0 && slots.get('Weapon 1 Swap')!.itemId > 0);
  assert.match(first.xml, /<Skill enabled="true" includeInFullDPS="false" label="" slot="Boots" mainActiveSkill="1" mainActiveSkillCalcs="1">/);
  assert.match(first.xml, /<Gem nameSpec="Cyclone" skillId="Cyclone" gemId="Metadata\/Items\/Gems\/SkillGemCyclone" variantId="Cyclone" level="21" quality="23"/);
  assert.match(first.xml, /<Gem nameSpec="Melee Physical Damage" skillId="SupportMelee" gemId="Metadata\/Items\/Gems\/SupportGemMelee"/);
  assert.match(first.xml, /<Build level="97" [^>]*characterLevelAutoMode="false"/);

  // Importing again does not duplicate the items or the group (same ids, same gems).
  const again = applyCharacter(first.xml, { character: char, items: ITEMS_JSON }, ITEMS_AND_SKILLS, data);
  assert.equal(readItems(again.xml).items.length, 3);
  assert.equal((again.xml.match(/<Skill /g) ?? []).length, 1);

  // Ignore weapon swap leaves the swap items out.
  const ign = applyCharacter(blankBuildXml('Duelist', 1), { character: char, items: ITEMS_JSON }, { ...ITEMS_AND_SKILLS, ignoreWeaponSwap: true }, data);
  assert.equal(readItems(ign.xml).items.length, 2);

  // Delete first: the old equipment and skill groups go before the new ones come in.
  const other = { ...ITEMS_JSON, items: [{ ...AMULET, id: 'amu2', name: 'Other' }] };
  const del = applyCharacter(first.xml, { character: char, items: other }, { ...ITEMS_AND_SKILLS, deleteItems: true, deleteSkills: true }, data);
  const dm = readItems(del.xml);
  assert.equal(dm.items.length, 1);
  assert.match(dm.items[0]!.text, /Other/);
  assert.equal((del.xml.match(/<Skill /g) ?? []).length, 0);
  const keep = applyCharacter(first.xml, { character: char, items: other }, ITEMS_AND_SKILLS, data);
  assert.equal(readItems(keep.xml).items.length, 4, 'without delete the new item is added next to the old ones');
});

test('buildCounts and Export Support read and write the build text', () => {
  const imported = applyCharacter(blankBuildXml('Duelist', 1), { character: char, items: ITEMS_JSON, passives: TREE_JSON }, { ...TREE_AND_JEWELS, items: true, skills: true, deleteItems: false, deleteJewels: false, deleteSkills: false, ignoreWeaponSwap: false }, data).xml;
  const c = buildCounts(imported);
  assert.deepEqual(c, { jewels: 1, items: 3, skillGroups: 1, nodes: 5 });
  assert.deepEqual(buildCounts(''), { jewels: 0, items: 0, skillGroups: 0, nodes: 0 });
  const blank = blankBuildXml('Scion', 1);
  assert.equal(readExportParty(blank), false);
  const on = setExportParty(blank, true);
  assert.equal(readExportParty(on), true);
  assert.match(on, /<Import exportParty="true" \/>/);
  assert.equal(readExportParty(setExportParty(on, false)), false);
  assert.equal(setExportParty('<PathOfBuilding><Build level="1"></Build></PathOfBuilding>', true).includes('<Import exportParty="true" />'), true);
});

// ---- cluster jewel passives of an imported character -----------------------------------------------------------------

test('imported cluster jewel passives are asked of the engine and added to the node list, unmatched ones are named', async () => {
  const asked: { hashesEx: number[]; jewelData: Record<string, unknown> }[] = [];
  const mk = (clusters?: ConstructorParameters<typeof CharacterService>[0]['clusters']) =>
    new CharacterService({ file: join(mkdtempSync(join(tmpdir(), 'ci-')), 'c.json'), window: fakeWindow({}).fn, session: () => ({ connected: false, account: '' }), data: async () => data, ...(clusters ? { clusters } : {}) });
  const bundle = { character: char, passives: { ...TREE_JSON, hashes_ex: [2, 5, 27], jewel_data: { '1': { subgraph: { groups: {} } } } } };
  const svc = mk(async (_xml, hashesEx, jewelData) => {
    asked.push({ hashesEx, jewelData });
    return { allocated: [65552, 65561, 13170], unmatched: [27] };
  });
  const r = await svc.apply(blankBuildXml('Scion', 1), bundle, TREE_AND_JEWELS);
  assert.deepEqual(asked, [{ hashesEx: [2, 5, 27], jewelData: { '1': { subgraph: { groups: {} } } } }]);
  assert.match(r.xml, /nodes="100,101,102,9000,65537,65552,65561,13170"/);
  assert.ok(r.notes.includes('Cluster jewel passives allocated: 2.'));
  assert.ok(r.notes.some((n) => /1 cluster jewel passive of the character did not match.*: 27\./.test(n)));

  // Nothing named: the engine is not asked. A failing engine leaves the tree as imported and says so.
  const none = await svc.apply(blankBuildXml('Scion', 1), { character: char, passives: TREE_JSON }, TREE_AND_JEWELS);
  assert.equal(asked.length, 1);
  assert.ok(!none.notes.some((n) => /Cluster/.test(n)));
  const bad = await mk(async () => {
    throw new Error('engine gone');
  }).apply(blankBuildXml('Scion', 1), bundle, TREE_AND_JEWELS);
  assert.match(bad.xml, /nodes="100,101,102,9000,65537"/);
  assert.ok(bad.notes.some((n) => /not allocated: engine gone/.test(n)));
  assert.ok((await mk().apply(blankBuildXml('Scion', 1), bundle, TREE_AND_JEWELS)).notes.some((n) => /engine is not available/.test(n)));
  // The tree part not imported: cluster passives are left alone.
  await svc.apply(blankBuildXml('Scion', 1), bundle, { ...TREE_AND_JEWELS, tree: false });
  assert.equal(asked.length, 1);
});

test('appendSpecNodes adds ids to the active spec only, once', () => {
  const xml = '<Tree activeSpec="2"><Spec nodes="1,2"></Spec><Spec title="b" nodes="5"></Spec></Tree>';
  assert.equal(appendSpecNodes(xml, [7, 5, 8]), '<Tree activeSpec="2"><Spec nodes="1,2"></Spec><Spec title="b" nodes="5,7,8"></Spec></Tree>');
  assert.equal(appendSpecNodes(xml, [5]), xml);
  assert.equal(appendSpecNodes(xml, []), xml);
});

test('names the way the original reads them: umlauts to plain letters, dashes to "-", other characters to "?" per byte', () => {
  assert.equal(sanitiseText('Maelstr\u00f6m Staff'), 'Maelstrom Staff');
  assert.equal(sanitiseText('Mj\u00f6lner'), 'Mjolner');
  assert.equal(sanitiseText('Kaom\u2019s'), 'Kaom???s');
  assert.equal(sanitiseText('a\u2013b\u2014c'), 'a-b-c');
  assert.equal(sanitiseText('<default>{Plain} text<x<y>z>'), '{Plain} text');
  assert.equal(sanitiseText('Plain'), 'Plain');
  assert.equal(sanitiseText('caf\u00e9'), 'caf??');
  // A staff with an umlaut in its base is an item of the known base, not a skipped one.
  const staff = itemToRaw({ id: 's1', inventoryId: 'Weapon', frameType: 3, name: 'Doom Staff', typeLine: 'Maelstr\u00f6m Staff', ilvl: 80, properties: [], explicitMods: ['+1 to Level of all Spell Skill Gems'] } as GItem, data.items);
  assert.equal(staff?.baseName, 'Maelstrom Staff');
});
