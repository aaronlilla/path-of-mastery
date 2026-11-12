import { test } from 'node:test';
import assert from 'node:assert/strict';
import { equipped, readFacts } from '../src/shared/buildFacts.js';
import { configText, impactOf, itemSlots, normaliseConfig, planPower, POWER_STATS, powerRows, type ConfigSchema, type PowerInputs } from '../src/shared/comparePower.js';

const mk = (o: { spec: string; items: [string, string][]; groups: string; config: string; main?: number }): string => `<PathOfBuilding>
<Build level="90" className="Ranger" mainSocketGroup="${o.main ?? 1}"/>
<Skills activeSkillSet="1"><SkillSet id="1">${o.groups}</SkillSet></Skills>
<Tree activeSpec="1"><Spec treeVersion="3_29" classId="2" nodes="${o.spec}"/></Tree>
<Items activeItemSet="1">${o.items.map(([, text], i) => `<Item id="${i + 1}">\n${text}\n</Item>`).join('')}<ItemSet id="1">${o.items.map(([slot], i) => `<Slot name="${slot}" itemId="${i + 1}"/>`).join('')}</ItemSet></Items>
<Config activeConfigSet="1"><ConfigSet id="1">${o.config}</ConfigSet></Config>
</PathOfBuilding>`;

const gem = (name: string, id: string) => `<Gem nameSpec="${name}" skillId="${id}" level="20" quality="0" enabled="true"/>`;
const A = mk({
  spec: '1,2,3',
  items: [['Helmet', 'Rarity: RARE\nDoom Crown\nIron Hat'], ['Belt', 'Rarity: UNIQUE\nHeadhunter\nLeather Belt']],
  groups: `<Skill label="" slot="Body Armour">${gem('Cyclone', 'Cyclone')}${gem('Fortify', 'SupportFortify')}</Skill>`,
  config: '<Input boolean="true" name="useFrenzyCharges"/><Input string="Pinnacle" name="enemyIsBoss"/>',
});
const B = mk({
  spec: '1,2,3,10,11,12,13,14',
  items: [['Helmet', 'Rarity: RARE\nDoom Crown\nIron Hat'], ['Belt', 'Rarity: UNIQUE\nMageblood\nHeavy Belt'], ['Ring 1', 'Rarity: MAGIC\nRuby Ring of X']],
  groups: `<Skill label="" slot="Body Armour">${gem('Cyclone', 'Cyclone')}${gem('Faster Attacks', 'SupportFasterAttacks')}${gem('Fortify', 'SupportFortify')}</Skill><Skill label="" slot="Boots">${gem('Leap Slam', 'LeapSlam')}</Skill>`,
  config: '<Input boolean="true" name="usePowerCharges"/><Input string="Uber" name="enemyIsBoss"/><Input boolean="true" name="useFrenzyCharges"/>',
});

const schema: ConfigSchema = {
  sections: [],
  options: [
    { var: 'usePowerCharges', type: 'check', label: 'Do you use Power Charges?', section: 'When In Combat', apply: true },
    { var: 'useFrenzyCharges', type: 'check', label: 'Do you use Frenzy Charges?', section: 'When In Combat', apply: true },
    { var: 'enemyIsBoss', type: 'list', label: 'Is the enemy a Boss?', section: 'Enemy Stats', apply: true, list: [{ val: 'Pinnacle', label: 'Guardian/Pinnacle Boss' }, { val: 'Uber', label: 'Uber Pinnacle Boss' }] },
    { var: 'bandit', type: 'list', label: 'Bandit quest:', section: 'General', list: [{ val: 'None', label: 'Kill all' }] },
  ],
};

const inputs = (cats = { Tree: true, Items: true, 'Skill gems': true, 'Support gems': true, Config: true }): PowerInputs => ({
  primary: readFacts(A),
  primaryXml: A,
  primaryNodes: [1, 2, 3],
  compare: readFacts(B),
  nodes: {
    '10': { n: 'Swift Venoms', t: 'Notable', k: 7 },
    '11': { n: 'Toxic Strikes', t: 'Normal', k: 7 },
    '12': { n: 'Ascendancy thing', t: 'Notable', a: 'Deadeye', k: 9 },
    '13': { n: 'Mastery', t: 'Mastery' },
    '14': { n: 'Heart of Darkness', t: 'Keystone', k: 5 },
  },
  schema,
  isSupport: (_n, id) => id.startsWith('Support'),
  categories: cats,
});

test('planPower lists what the compared build has and this one does not, by category', () => {
  const t = planPower(inputs());
  assert.deepEqual(t.filter((x) => x.category === 'Tree').map((x) => x.name), ['Swift Venoms', 'Toxic Strikes', 'Heart of Darkness']);
  assert.deepEqual(t.filter((x) => x.category === 'Items').map((x) => x.name), ['Ruby Ring of X, Ring 1', 'Mageblood, Belt']);
  assert.equal(t.filter((x) => x.category === 'Items').length, 2, 'the same helmet is skipped; the belt and ring differ');
  assert.deepEqual(t.filter((x) => x.category === 'Skill gems' || x.category === 'Support gems').map((x) => [x.kind, x.name]), [['gem', 'Cyclone'], ['gem', 'Leap Slam'], ['support', 'Faster Attacks']]);
  assert.deepEqual(t.filter((x) => x.category === 'Config').map((x) => x.name), [
    'Do you use Power Charges?  ((not set) -> Yes)',
    'Is the enemy a Boss?  (Guardian/Pinnacle Boss -> Uber Pinnacle Boss)',
  ]);
});

test('planPower builds the edits the engine previews', () => {
  const t = planPower(inputs());
  const tree = t.find((x) => x.id === 'tree:10')!;
  assert.deepEqual(tree.edit, { kind: 'addNodes', nodeIds: [10] });
  assert.equal(tree.cacheKey, t.find((x) => x.id === 'tree:11')!.cacheKey, 'nodes with the same mods share one answer');
  const item = t.find((x) => x.id === 'item:Belt')!;
  assert.equal(item.edit.kind, 'setItem');
  assert.match((item.edit as { itemText: string }).itemText, /^Rarity: UNIQUE\nMageblood/);
  const sup = t.find((x) => x.kind === 'support')!;
  assert.equal(sup.edit.kind, 'setXml');
  assert.match((sup.edit as { xml: string }).xml, /Faster Attacks[\s\S]*<\/Skill>/);
  assert.deepEqual(t.find((x) => x.id === 'cfg:usePowerCharges')!.edit, { kind: 'setConfig', key: 'usePowerCharges', value: true });
});

test('planPower leaves out categories that are switched off and nodes it cannot name', () => {
  const none = planPower(inputs({ Tree: false, Items: false, 'Skill gems': false, 'Support gems': false, Config: false }));
  assert.deepEqual(none, []);
  const noNodes = planPower({ ...inputs(), nodes: null });
  assert.equal(noNodes.filter((x) => x.category === 'Tree').length, 0);
});

test('config values compare the way the original normalises them', () => {
  const check = schema.options[0]!;
  assert.deepEqual(normaliseConfig(check, undefined, false), [false, false]);
  assert.equal(configText(check, true), 'Yes');
  assert.equal(configText(schema.options[2]!, 'Uber'), 'Uber Pinnacle Boss');
  assert.equal(configText(check, undefined), '(not set)');
});

test('impactOf reads the power stat out of the changed stats and powerRows sorts by gain', () => {
  const dps = POWER_STATS.find((s) => s.stat === 'CombinedDPS')!;
  assert.equal(impactOf(dps, [{ statId: 'CombinedDPS', before: 100, after: 130 }, { statId: 'Life', before: 1, after: 2 }]), 30);
  assert.equal(impactOf(dps, [{ statId: 'Life', before: 1, after: 2 }]), 0);
  const taken = POWER_STATS.find((s) => s.stat === 'PhysicalTakenHit')!;
  assert.equal(impactOf(taken, [{ statId: 'PhysicalTakenHit', before: 100, after: 80 }]), 20, 'taking less damage is a gain');
  const tasks = planPower(inputs()).slice(0, 3);
  const rows = powerRows(tasks, [5, 0, -12], 50);
  assert.deepEqual(rows.map((r) => [r.task.id, r.impact, r.percent]), [[tasks[0]!.id, 5, 10], [tasks[2]!.id, -12, -24]]);
  assert.equal(powerRows(tasks, [5, null, 1], 0)[0]!.percent, null);
});

const SPEC = (nodes: string, sockets: string) => `<Tree activeSpec="1"><Spec treeVersion="3_29" nodes="${nodes}">${sockets}</Spec></Tree>`;
const JBUILD = (nodes: string, sockets: string, helm: string, extra = '') => `<PathOfBuilding><Build level="90" className="Witch"/>${SPEC(nodes, sockets)}<Items activeItemSet="1">
<Item id="1">
${helm}
</Item>
<Item id="2">
Rarity: UNIQUE
Glorious Vanity
Timeless Jewel
</Item>
<Item id="3">
Rarity: RARE
Eye A
Murderous Eye Jewel
</Item>
${extra}<ItemSet id="1"><Slot name="Helmet" itemId="1"/>${extra ? '<Slot name="Helmet Abyssal Socket 1" itemId="3"/>' : ''}</ItemSet></Items></PathOfBuilding>`;

test('planPower tries a jewel in an allocated socket directly and in every socket when its own is not allocated', () => {
  const helm = 'Rarity: RARE\nDoom Crown\nIron Hat';
  const A = JBUILD('1,2', '<Sockets><Socket nodeId="10" itemId="3"/></Sockets>', helm);
  const B = JBUILD('1,2,3', '<Sockets><Socket nodeId="10" itemId="2"/><Socket nodeId="11" itemId="2"/></Sockets>', helm);
  const t = planPower({ primary: readFacts(A), primaryXml: A, primaryNodes: [1, 2, 10], compare: readFacts(B), nodes: null, socketNodes: [10, 20, 30], schema, isSupport: () => false, categories: { Tree: false, Items: true, 'Skill gems': false, 'Support gems': false, Config: false } });
  const direct = t.find((x) => x.id === 'jewel:10')!;
  assert.equal(direct.edit.kind, 'setXml');
  assert.equal(direct.alternatives, undefined);
  assert.match(direct.name, /^Glorious Vanity, Socket #1$/);
  const best = t.find((x) => x.id === 'jewel:11')!;
  assert.equal(best.edit.kind, 'addNodes');
  assert.equal(best.alternatives!.length, 2, 'one try per socket of this tree');
  const nodesOf = (e: unknown) => (e as { nodeIds: number[] }).nodeIds;
  assert.deepEqual([best.edit, ...best.alternatives!].map(nodesOf), [[], [20], [30]], 'allocated sockets need no extra node');
  assert.match(((best.edit as { xml: string }).xml), /<Socket nodeId="10" itemId="4"\/>/);
  assert.equal(best.bestNote, ' (best socket)');
  assert.equal(best.name, 'Glorious Vanity, Socket');
});

test('planPower swaps in an item with its abyssal jewels, and lists shared abyssal sockets', () => {
  const hA = 'Rarity: RARE\nDoom Crown\nIron Hat\nSockets: A A';
  const hB = 'Rarity: RARE\nOther Crown\nIron Hat\nSockets: A A';
  const eyeB = 'Rarity: RARE\nEye B\nMurderous Eye Jewel';
  const A = JBUILD('1', '', hA);
  const B = JBUILD('1', '', hB, `<Item id="4">\n${eyeB}\n</Item>\n`).replace('Eye A', 'Eye A');
  const t = planPower({ primary: readFacts(A), primaryXml: A, primaryNodes: [1], compare: readFacts(B), nodes: null, schema, isSupport: () => false, categories: { Tree: false, Items: true, 'Skill gems': false, 'Support gems': false, Config: false } });
  const helm = t.find((x) => x.id === 'item:Helmet')!;
  assert.equal(helm.edit.kind, 'setXml');
  assert.match(helm.name, /^Other Crown, Helmet, 1 Jewel$/);
  const xml = (helm.edit as { xml: string }).xml;
  const f = readFacts(xml);
  assert.equal(equipped(f).get('Helmet')!.name, 'Other Crown');
  assert.equal(equipped(f).get('Helmet Abyssal Socket 1')!.name, 'Eye A');
  assert.equal(equipped(f).has('Helmet Abyssal Socket 2'), false, 'this build\'s own jewel in a socket B leaves empty is taken out');
});

test('itemSlots lists the second weapon set only when a build has something in it', () => {
  assert.ok(!itemSlots(readFacts(A), readFacts(B)).some((s) => s.includes('Swap')));
  const C = mk({ spec: '1', items: [['Weapon 1 Swap', 'Rarity: RARE\nStorm Edge\nCoral Sword']], groups: '', config: '' });
  const slots = itemSlots(readFacts(A), readFacts(C));
  assert.deepEqual(slots.slice(0, 3), ['Weapon 1', 'Weapon 2', 'Weapon 1 Swap']);
});
