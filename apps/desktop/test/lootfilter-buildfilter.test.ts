import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFilterFile } from '../src/main/lootfilter/fileWriter.js';
import { makeBuildFilter, MOVEMENT_PREFIXES, type BuiltFilter } from '../src/shared/lootfilter/buildFilter.js';
import { parseBlocks } from '../src/shared/lootfilter/blocks.js';
import { GEAR_KINDS } from '../src/shared/lootfilter/bases.js';
import { buildCatalog } from '../src/shared/lootfilter/catalog.js';
import { evaluateItem, type ItemProps } from '../src/shared/lootfilter/evaluate.js';
import { generateFilter } from '../src/shared/lootfilter/generate.js';
import { validateFilter } from '../src/shared/lootfilter/syntax.js';
import { DEFAULT_BUILD_SETUP, type BuildSetup } from '../src/shared/lootfilter/types.js';
import { archetypeTag } from '../src/shared/lootfilter/profile.js';
import { RANGER_PLAN, WITCH_PLAN, fixture, levelingGuide, loadGame, neverSink } from './buildFilterHelpers.js';

const setup = (over: Partial<BuildSetup> = {}): BuildSetup => ({ ...DEFAULT_BUILD_SETUP, on: true, ...over });
const base = neverSink();
const parsed = parseBlocks(base);
const catalog = buildCatalog(parsed.blocks);

function make(xml: string, plan: typeof RANGER_PLAN | null = RANGER_PLAN, s = setup()): { built: BuiltFilter; text: string; fileText: string } {
  const built = makeBuildFilter(fixture(xml), plan, s, { game: loadGame(), catalog, buildName: 'PConc test' })!;
  const g = generateFilter({ baseText: base, baseVersion: '8.20.1d', strictness: 2, style: 0, rules: built.rules, parsed, buildHeader: built.header, stageBanners: built.banners, now: new Date('2026-10-10T00:00:00Z') });
  return { built, text: g.text, fileText: g.fileText };
}

const item = (p: Partial<ItemProps> & { name: string }): ItemProps => ({ rarity: 'Rare', itemLevel: 75, linkedSockets: 0, sockets: 'RGB', corrupted: false, identified: true, mirrored: false, influences: [], ...p });
const shown = (text: string, i: ItemProps, area: number): boolean => evaluateItem(parseBlocks(text).blocks, i, { areaLevel: area, steps: false }).visible;

test('PConc build filter on disk: header, hide blocks, safety net first, no syntax errors', async (t) => {
  levelingGuide(t, true); // the leveling stage and leveling skill are the leveling guide's (switched off by default)
  const { built, fileText, text } = make('pconc-pathfinder.xml');
  const dir = await mkdtemp(join(tmpdir(), 'pom-bf-'));
  try {
    const r = await writeFilterFile({ folder: dir, fileName: 'Path of Mastery.filter', fileText }, { dir: join(dir, 'bak'), keep: 2 });
    assert.equal(r.kind, 'written');
    const disk = (await readFile(join(dir, 'Path of Mastery.filter'), 'utf8')).replace(/\r\n/g, '\n');
    assert.match(disk, /^# build: PConc test \(Ranger Poisonous Concoction\)$/m);
    assert.match(disk, /^# build-mode: ssf$/m);
    assert.match(disk, /^# stages: S0 1-11, S1 12-44, S2 45-67, S3 68-77, S4 78\+$/m);
    assert.match(disk, /^# STAGE S1 Transition \(area 12-44\)$/m);
    const blocks = parseBlocks(disk).blocks;
    const hide = blocks.find((b) => b.kind === 'Hide' && b.ruleId?.startsWith('build:s1:hide:weapons'))!;
    assert.ok(hide, 'a weapons Hide block exists');
    const cls = hide.conditions.find((c) => c.key === 'Class')!;
    for (const w of GEAR_KINDS.find((k) => k.id === 'weapon')!.classes) assert.ok(cls.values.includes(w), `${w} is hidden from S1`);
    assert.ok(cls.values.includes('One Hand Swords'));
    assert.deepEqual(hide.conditions.find((c) => c.key === 'AreaLevel'), { key: 'AreaLevel', op: '>=', values: ['12'] });
    const firstSix = blocks.findIndex((b) => b.kind === 'Show' && b.conditions.some((c) => c.key === 'LinkedSockets' && c.values[0] === '6' && c.op === ''));
    const buildHides = blocks.map((b, i) => [b, i] as const).filter(([b]) => b.kind === 'Hide' && b.ruleId?.startsWith('build:'));
    assert.ok(buildHides.length >= 3);
    for (const [, i] of buildHides) assert.ok(firstSix >= 0 && firstSix < i, 'LinkedSockets 6 Show sits above every build Hide');
    assert.equal(validateFilter(disk).errors, 0);
    assert.equal(disk, text, 'disk text is the generated text');
    assert.ok(built.rules.every((r) => r.source === 'build' && r.build && r.why));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('evaluateItem on the generated filter', (t) => {
  levelingGuide(t, true); // the leveling stage and leveling skill are the leveling guide's (switched off by default)
  const { text, built } = make('pconc-pathfinder.xml');
  const g = loadGame();
  const body = built.profile.armour['Body Armours']!;
  const sameArch = Object.entries(g.bases).filter(([, r]) => r.type === 'Body Armour' && archetypeTag(r) === body.tag && (r.req?.level ?? 0) >= 50).map(([n]) => n)[0]!;
  const otherArch = Object.entries(g.bases).filter(([, r]) => r.type === 'Body Armour' && archetypeTag(r) !== body.tag).map(([n]) => n)[0]!;
  assert.equal(shown(text, item({ name: 'Rusted Sword', class: 'One Hand Swords', linkedSockets: 2, sockets: 'RG' }), 70), false, 'rare sword at 70 is hidden');
  assert.equal(shown(text, item({ name: 'Rusted Sword', class: 'One Hand Swords', linkedSockets: 6, sockets: 'RGBRGB' }), 70), true, '6-link sword is shown');
  assert.equal(shown(text, item({ name: sameArch, class: 'Body Armours', itemLevel: 75, linkedSockets: 2, sockets: 'RG' }), 70), true, 'build archetype body shown');
  assert.equal(shown(text, item({ name: otherArch, class: 'Body Armours', itemLevel: 75, linkedSockets: 2, sockets: 'RG' }), 70), false, 'other archetype body hidden');
  assert.equal(shown(text, item({ name: 'Divine Orb', class: 'Stackable Currency', rarity: 'Normal', stackSize: 1 }), 83), true);
  const boots = evaluateItem(parseBlocks(text).blocks, item({ name: 'Wool Shoes', class: 'Boots', rarity: 'Magic', explicitMods: ["Cheetah's"], linkedSockets: 0, sockets: 'R' }), { areaLevel: 30 });
  assert.equal(boots.visible, true);
  assert.deepEqual(boots.style.sound, { kind: 'builtin', id: 2, vol: 200 }, 'with the build sound');
  assert.ok(MOVEMENT_PREFIXES.includes("Cheetah's"));
  const bow = (area: number): boolean => shown(text, item({ name: 'Short Bow', class: 'Bows', rarity: 'Normal', itemLevel: 3, linkedSockets: 0, sockets: 'R' }), area);
  assert.equal(bow(5), true, 'a bow at area 5 is shown: Caustic Arrow needs one');
  assert.equal(shown(text, item({ name: 'Short Bow', class: 'Bows', rarity: 'Rare', itemLevel: 40, linkedSockets: 1, sockets: 'RG' }), 20), false, 'the same bow is hidden from area 12');
});

test('Witch plan: the bow stays until area 30', (t) => {
  levelingGuide(t, true); // the leveling stage and leveling skill are the leveling guide's (switched off by default)
  const { text } = make('pconc-pathfinder.xml', WITCH_PLAN);
  const rareBow = (area: number): boolean => shown(text, item({ name: 'Short Bow', class: 'Bows', rarity: 'Rare', itemLevel: 40, linkedSockets: 1, sockets: 'RG' }), area);
  assert.equal(rareBow(20), true);
  assert.equal(rareBow(31), false);
  assert.match(text, /^# stages: S0 1-30, S1 31-44/m);
});

test('leveling guide switched off: no plan (main has none), no S0 stage, S1 from area 1, no leveling weapons, still a valid filter', (t) => {
  levelingGuide(t, false);
  const { built, text } = make('pconc-pathfinder.xml', null, setup({ bounds: [12, 45, 68, 78] }));
  assert.match(text, /^# stages: S1 1-44, S2 45-67, S3 68-77, S4 78\+$/m);
  assert.ok(!built.rules.some((r) => r.build?.stage === 'S0' || /levweap|levgems/.test(r.id)), 'no leveling-stage rules');
  assert.equal(shown(text, item({ name: 'Short Bow', class: 'Bows', rarity: 'Rare', itemLevel: 3, linkedSockets: 0, sockets: 'R' }), 5), false, 'no leveling skill keeps a bow');
  assert.equal(validateFilter(text).errors, 0);
});

test('melee fixture: its own weapon class is never hidden', () => {
  const { text } = make('melee-cleave.xml');
  const hides = parseBlocks(text).blocks.filter((b) => b.kind === 'Hide' && b.ruleId?.includes(':hide:weapons'));
  assert.ok(hides.length > 0);
  for (const h of hides) assert.ok(!h.conditions.find((c) => c.key === 'Class')!.values.includes('One Hand Swords'));
  assert.ok(hides.some((h) => h.conditions.find((c) => c.key === 'Class')!.values.includes('Bows')));
});

test('trade mode adds Rarity Normal Magic to every build Hide block; ssf-only currency is not forced', () => {
  const { text, built } = make('pconc-pathfinder.xml', RANGER_PLAN, setup({ mode: 'trade' }));
  const hides = parseBlocks(text).blocks.filter((b) => b.kind === 'Hide' && b.ruleId?.startsWith('build:'));
  assert.ok(hides.length >= 3);
  for (const h of hides) {
    assert.ok(h.conditions.some((c) => c.key === 'Rarity' && c.op === '' && c.values.join() === 'Normal,Magic'), h.ruleId);
    assert.ok(h.conditions.some((c) => c.key === 'ItemLevel' && c.op === '<' && c.values[0] === '82'));
  }
  assert.ok(!built.rules.some((r) => /Fossil|Resonator/.test(r.id)));
  assert.match(text, /^# build-mode: trade$/m);
});

test('chips: a disabled group writes no blocks; safety net off writes no safety blocks', () => {
  const on = make('pconc-pathfinder.xml').text;
  const off = make('pconc-pathfinder.xml', RANGER_PLAN, setup({ disabled: ['weapons'], safetyNet: false })).text;
  assert.match(on, /pom:rule=build:s1:hide:weapons/);
  assert.doesNotMatch(off, /pom:rule=build:s1:hide:weapons/);
  assert.doesNotMatch(off, /pom:rule=build:safety/);
  assert.equal(validateFilter(off).errors, 0);
});

test('build off writes nothing', () => {
  assert.deepEqual(makeBuildFilter(fixture('pconc-pathfinder.xml'), RANGER_PLAN, setup({ on: false }), { game: loadGame() })!.rules, []);
});

test('the real leveling planner feeds the filter: Ranger PConc swaps at 12 and levels on Caustic Arrow with a bow', async (t) => {
  levelingGuide(t, true); // the leveling stage and leveling skill are the leveling guide's (switched off by default)
  const { loadLevelingData } = await import('../src/main/leveling/data.js');
  const { planLeveling } = await import('../src/shared/leveling/plan.js');
  const { readBuildProfile, levelingLite } = await import('../src/shared/lootfilter/profile.js');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'leveling');
  const { data } = await loadLevelingData(dir);
  const profile = readBuildProfile(fixture('pconc-pathfinder.xml'), loadGame())!;
  const plan = planLeveling(levelingLite(profile), data);
  assert.equal(plan.swap?.level, 12);
  assert.equal(plan.skills[0]?.name, 'Caustic Arrow');
  assert.deepEqual(plan.skills[0]?.weaponClasses, ['Bows']);
  const { text } = make('pconc-pathfinder.xml', plan);
  assert.match(text, /^# stages: S0 1-11, S1 12-44/m);
  assert.equal(shown(text, item({ name: 'Short Bow', class: 'Bows', rarity: 'Normal', itemLevel: 3, linkedSockets: 0, sockets: 'R' }), 5), true);
  assert.equal(validateFilter(text).errors, 0);
});
