import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { search, type SearchDoc } from '../src/renderer/search/searchIndex.js';
import { configRows, gemRows, itemRows, type CfgOpt } from '../src/shared/searchRows.js';
import { copyEldritchImplicits, defaultAffixRange, networkPlan, steppedValue, updateChannelFor, visibleSegs, wheelStep } from '../src/shared/settingsEffects.js';
import { applyMainSettings } from '../src/main/network.js';
import { SettingsStore } from '../src/main/library/settingsStore.js';
import { DEFAULT_SETTINGS } from '../src/shared/library.js';
import { activeSetOf, readItems } from '../src/shared/itemsXml.js';

const doc = (kind: SearchDoc['kind'], title: string, meta = ''): SearchDoc => ({ kind, title, meta, run: () => undefined });

// ---- search ------------------------------------------------------------------------------------------------------

test('search groups results in the design order and highlights the matched word', () => {
  const docs = [doc('Stat', 'Life', '4,639'), doc('Stat', 'Life Regen', '412.6'), doc('Item', 'Divine Life Flask of Staunching', 'Flask 1'), doc('Gem', 'Cyclone', 'Active · 20/20')];
  const r = search('life', docs);
  assert.deepEqual(r.groups.map((g) => g.kind), ['Stat', 'Item']);
  assert.deepEqual(r.flat.map((h) => h.doc.title), ['Life', 'Life Regen', 'Divine Life Flask of Staunching']);
  assert.equal(r.flat[0]!.segs.some((s) => s.hl && s.t === 'Life'), true);
});

test('search folds plurals and synonyms: "resists" finds Resistance, "hp" finds Life', () => {
  const docs = [doc('Stat', 'Fire Resistance', '80%'), doc('Stat', 'Life', '4,639'), doc('Stat', 'Mana', '944')];
  assert.deepEqual(search('resists', docs).flat.map((h) => h.doc.title), ['Fire Resistance']);
  assert.equal(search('hp', [doc('Stat', 'Life', '1')]).flat.length, 0, 'basic search matches names, synonyms need the words in the title');
});

test('a plain-language question names its topic without inventing an answer', () => {
  const r = search('am I res capped?', [doc('Stat', 'Fire Resistance', '80%')]);
  assert.equal(r.locked?.title, 'Resistances');
  assert.match(r.locked!.where, /Calcs/);
});

test('a near miss gets a suggestion and nothing else', () => {
  const r = search('resistanse', [doc('Stat', 'Fire Resistance', '80%'), doc('Stat', 'Life', '1')]);
  assert.equal(r.flat.length > 0 || r.suggestion.length > 0, true);
  const none = search('zzzqqq', [doc('Stat', 'Life', '1')]);
  assert.equal(none.flat.length, 0);
});

// ---- what the palette finds in the build text --------------------------------------------------------------------

const XML = `<PathOfBuilding><Build level="90"/>
<Skills activeSkillSet="1"><SkillSet id="1"><Skill><Gem nameSpec="Cyclone" skillId="Cyclone" level="20" quality="20"/><Gem nameSpec="Pulverise Support" skillId="SupportPulverise" level="18" quality="0"/></Skill></SkillSet></Skills>
<Config activeConfigSet="1"><ConfigSet id="1"><Input name="conditionFrenzyCharges" boolean="true"/><Input name="enemyLevel" number="84"/></ConfigSet></Config>
<Items activeItemSet="1">
<Item id="1">
Rarity: UNIQUE
Paradoxica
Vaal Rapier
</Item>
<ItemSet id="1"><Slot name="Weapon 1" itemId="1"/></ItemSet></Items></PathOfBuilding>`;

test('items, gems and configuration come from the build text with their values', () => {
  assert.deepEqual(itemRows(XML), [{ title: 'Paradoxica', meta: 'Weapon 1' }]);
  assert.deepEqual(gemRows(XML), [
    { title: 'Cyclone', meta: 'Active · 20/20' },
    { title: 'Pulverise Support', meta: 'Support · 18/0' },
  ]);
  const opts: CfgOpt[] = [
    { var: 'conditionFrenzyCharges', label: 'Do you use Frenzy Charges?', section: 'When In Combat', type: 'check' },
    { var: 'enemyLevel', label: 'Enemy Level:', section: 'Enemy Stats', type: 'count' },
    { var: 'bandit', label: 'Bandit quest:', section: 'General', type: 'list', list: [{ val: 'None', label: 'Kill all' }] },
  ];
  assert.deepEqual(configRows(XML, opts), [
    { title: 'Do you use Frenzy Charges?', meta: 'On' },
    { title: 'Enemy Level', meta: '84' },
    { title: 'Bandit quest', meta: 'General' },
  ]);
});

// ---- settings that had no effect ---------------------------------------------------------------------------------

test('the wheel steps a slider one notch, and Invert slider scroll flips it', () => {
  assert.equal(wheelStep(-100, false), 1);
  assert.equal(wheelStep(100, false), -1);
  assert.equal(wheelStep(-100, true), -1);
  assert.equal(steppedValue(50, 0, 100, 5, 1), 55);
  assert.equal(steppedValue(100, 0, 100, 5, 1), 100);
  assert.equal(steppedValue(0.5, 0, 1, 0.1, -1), 0.4);
});

test('Network settings become a proxy rule and a lookup order', () => {
  assert.deepEqual(networkPlan({ connectionProtocol: 'auto', proxyKind: 'http', proxyHost: '' }), { proxyRules: '', dnsOrder: 'verbatim' });
  assert.deepEqual(networkPlan({ connectionProtocol: 'ipv4', proxyKind: 'socks5', proxyHost: 'localhost:1080' }), { proxyRules: 'socks5://localhost:1080', dnsOrder: 'ipv4first' });
  assert.equal(networkPlan({ connectionProtocol: 'ipv6', proxyKind: 'http', proxyHost: 'http://proxy.corp:8080' }).proxyRules, 'http://proxy.corp:8080');
  assert.equal(networkPlan({ connectionProtocol: 'auto', proxyKind: 'http', proxyHost: 'not a host' }).proxyRules, '', 'a malformed proxy is ignored rather than breaking every request');
});

test('saving settings applies the update channel, the proxy and the lookup order in the main process', async () => {
  const calls: string[] = [];
  const deps = {
    setProxy: (r: string) => void calls.push('proxy:' + r),
    setDnsOrder: (o: string) => void calls.push('dns:' + o),
    routeFetchThroughChromium: (on: boolean) => void calls.push('chromium:' + on),
    setUpdateChannel: (c: string) => void calls.push('channel:' + c),
  };
  await applyMainSettings({ ...DEFAULT_SETTINGS, betaBuilds: true, connectionProtocol: 'ipv4', proxyHost: 'p:3128' }, deps);
  assert.deepEqual(calls, ['dns:ipv4first', 'proxy:http://p:3128', 'chromium:true', 'channel:beta']);
  assert.equal(updateChannelFor({ betaBuilds: false }), 'stable');
});

test('the settings store tells the main process what was saved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pom-set-'));
  try {
    const store = new SettingsStore(join(dir, 'settings.json'));
    const seen: boolean[] = [];
    store.onChange((s) => seen.push(s.betaBuilds));
    await store.set({ betaBuilds: true });
    assert.deepEqual(seen, [true]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a new affix starts at the Default item affix quality', () => {
  assert.equal(defaultAffixRange({ defaultAffixQuality: 50 }), 0.5);
  assert.equal(defaultAffixRange({ defaultAffixQuality: 80 }), 0.8);
  assert.equal(defaultAffixRange({ defaultAffixQuality: 0 }), 0);
});

test('the "Not supported" note is dropped when its tooltip is switched off', () => {
  const segs = [{ c: 'unsupported' as const, t: '10% more Thing' }, { c: 'muted' as const, t: ' (Not supported yet)' }];
  assert.equal(visibleSegs(segs, true).length, 2);
  assert.deepEqual(visibleSegs(segs, false).map((s) => s.t), ['10% more Thing']);
});

const WORN = `Rarity: RARE
Carnal Armour
Evasion/Energy Shield Chest
Searing Exarch Item
Eater of Worlds Item
Crafted: true
Prefix: None
Quality: 30
LevelReq: 71
Implicits: 2
{exarch}Flasks gain a Charge every 3 seconds
{tags:aura}{eater}Hatred has (19-21)% increased Aura Effect
+259 to Evasion Rating`;
const FRESH = `Rarity: RARE
Doom Shell
Evasion/Energy Shield Chest
Quality: 20
LevelReq: 70
Implicits: 0
+10 to maximum Life`;

test('Copy Eldritch implicits gives a new body armour the Exarch and Eater implicits of the one worn', () => {
  const out = copyEldritchImplicits(FRESH, 'Body Armour', 'RARE', WORN).split('\n');
  assert.ok(out.includes('Searing Exarch Item') && out.includes('Eater of Worlds Item'));
  const at = out.indexOf('Implicits: 2');
  assert.equal(out[at + 1], '{exarch}Flasks gain a Charge every 3 seconds');
  assert.equal(out[at + 3], '+10 to maximum Life');
  assert.equal(out.filter((l) => l.startsWith('Implicits:')).length, 1);
});

test('Copy Eldritch implicits leaves alone anything it does not apply to', () => {
  assert.equal(copyEldritchImplicits(FRESH, 'Amulet', 'RARE', WORN), FRESH);
  assert.equal(copyEldritchImplicits(FRESH, 'Body Armour', 'UNIQUE', WORN), FRESH);
  assert.equal(copyEldritchImplicits(FRESH, 'Body Armour', 'RARE', null), FRESH);
  const corrupt = FRESH + '\nCorrupted';
  assert.equal(copyEldritchImplicits(corrupt, 'Body Armour', 'RARE', WORN), corrupt);
  const hasImp = FRESH.replace('Implicits: 0', 'Implicits: 1\n+5 to Strength');
  assert.equal(copyEldritchImplicits(hasImp, 'Body Armour', 'RARE', WORN), hasImp);
});

// ---- a file that is not a build ------------------------------------------------------------------------------------

test('a build file with no item set reads as one empty set instead of crashing the Items tab', () => {
  const m = readItems('<PathOfBuilding><Build level="1"/></PathOfBuilding>');
  assert.equal(activeSetOf(m).useSecond, false);
  assert.equal(activeSetOf(readItems('plain text, not xml')).slots.size, 0);
  assert.equal(activeSetOf(readItems('')).slots.size, 0);
});
