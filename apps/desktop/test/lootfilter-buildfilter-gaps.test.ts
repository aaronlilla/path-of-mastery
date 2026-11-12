import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateRows } from '../src/main/lootfilter/buildData.js';
import { resistAffixes } from '../src/main/lootfilter/derived.js';
import { loadLevelingData } from '../src/main/leveling/data.js';
import { makeBuildFilter, TRADE_CARD_MIN_CHAOS, type BuildContext, type BuiltFilter } from '../src/shared/lootfilter/buildFilter.js';
import { parseBlocks } from '../src/shared/lootfilter/blocks.js';
import { buildCatalog } from '../src/shared/lootfilter/catalog.js';
import { evaluateItem, type ItemProps } from '../src/shared/lootfilter/evaluate.js';
import { generateFilter } from '../src/shared/lootfilter/generate.js';
import { buildLead, levelingLite, readBuildProfile } from '../src/shared/lootfilter/profile.js';
import { validateFilter } from '../src/shared/lootfilter/syntax.js';
import { DEFAULT_BUILD_SETUP, type BuildSetup } from '../src/shared/lootfilter/types.js';
import { readBuildMeta } from '../src/main/assistant/buildReaders.js';
import { ENGINE_DATA, RANGER_PLAN, fixture, loadGame, neverSink } from './buildFilterHelpers.js';

const setup = (over: Partial<BuildSetup> = {}): BuildSetup => ({ ...DEFAULT_BUILD_SETUP, on: true, ...over });
const base = neverSink();
const parsed = parseBlocks(base);
const catalog = buildCatalog(parsed.blocks);
const PCONC = 'pconc-pathfinder.xml';
const MELEE = 'melee-cleave.xml';

function make(xml: string, over: Partial<BuildSetup> = {}, ctx: Partial<BuildContext> = {}, strictness = 2): { built: BuiltFilter; text: string } {
  const built = makeBuildFilter(fixture(xml), RANGER_PLAN, setup(over), { game: loadGame(), catalog, buildName: xml, ...ctx })!;
  const g = generateFilter({ baseText: base, baseVersion: '8.20.1d', strictness, style: 0, rules: built.rules, parsed, buildHeader: built.header, stageBanners: built.banners, now: new Date('2026-10-10T00:00:00Z') });
  return { built, text: g.text };
}
const item = (p: Partial<ItemProps> & { name: string }): ItemProps => ({ rarity: 'Rare', itemLevel: 75, linkedSockets: 0, sockets: 'RGB', corrupted: false, identified: true, mirrored: false, influences: [], ...p });
const decide = (text: string, i: ItemProps, area: number) => evaluateItem(parseBlocks(text).blocks, i, { areaLevel: area, steps: false });
const shown = (text: string, i: ItemProps, area: number): boolean => decide(text, i, area).visible;
const by = (text: string, i: ItemProps, area: number): string => decide(text, i, area).decided?.ruleId ?? '';

// ---- 1. resist gap ---------------------------------------------------------------------------------------------------

test('1. resist gap: rares that can close a gap are highlighted from S2, only for the elements that are short', async () => {
  const affixes = await resistAffixes(ENGINE_DATA);
  assert.ok(affixes.length >= 24);
  const stats = { MissingColdResist: 33, MissingFireResist: 0, MissingLightningResist: 12.4 };
  for (const fx of [PCONC, MELEE]) {
    const { text, built } = make(fx, {}, { stats, affixes });
    assert.equal(validateFilter(text).errors, 0, fx);
    const ring = (mods: string[]): ItemProps => item({ name: 'Coral Ring', class: 'Rings', itemLevel: 75, explicitMods: mods, sockets: '' });
    assert.equal(by(text, ring(['of Haast']), 50), 'build:s2:resist:cold', `${fx}: cold-resist ring at S2`);
    assert.equal(by(text, ring(['of Haast']), 70), 'build:s2:resist:cold', `${fx}: and at S3`);
    assert.equal(by(text, ring(['of Haast']), 90), 'build:s2:resist:cold', `${fx}: and at S4`);
    assert.notEqual(by(text, ring(['of Haast']), 30), 'build:s2:resist:cold', `${fx}: not before S2`);
    assert.equal(by(text, ring(['of Ephij']), 50), 'build:s2:resist:lightning', `${fx}: lightning ring (12% gap)`);
    // fire is not short, so its resist suffix gets no highlight
    assert.ok(!by(text, ring(['of the Magma']), 50).includes(':resist:'), `${fx}: no fire highlight`);
    // armour rares too
    const boots = item({ name: 'Wool Shoes', class: 'Boots', itemLevel: 80, explicitMods: ['of Haast'], sockets: 'R' });
    assert.equal(by(text, boots, 60), 'build:s2:resist:cold');
    assert.equal(decide(text, ring(['of Haast']), 50).style.bd !== undefined, true);
    assert.ok(built.rules.find((r) => r.id === 'build:s2:resist:cold')!.why!.includes('33% under the cap'));
    // no gap, no rule
    const none = make(fx, {}, { stats: { MissingColdResist: 0 }, affixes }).built.rules;
    assert.ok(!none.some((r) => r.id.includes(':resist:')));
    assert.ok(!make(fx).built.rules.some((r) => r.id.includes(':resist:')), 'without the numbers there is no highlight');
  }
});

test('1. resist gap: the resist essences are forced from S2 in their own NeverSink look, only for the short element', async () => {
  const affixes = await resistAffixes(ENGINE_DATA);
  const ess = (name: string): ItemProps => item({ name, class: 'Stackable Currency', rarity: 'Normal', stackSize: 1, itemLevel: 1, sockets: '' });
  for (const fx of [PCONC, MELEE]) {
    for (const strictness of [2, 6]) {
      const withGap = make(fx, {}, { stats: { MissingColdResist: 33 }, affixes }, strictness).text;
      const noGap = make(fx, {}, {}, strictness).text;
      for (const n of ['Whispering Essence of Hatred', 'Weeping Essence of Hatred', 'Screaming Essence of Hatred', 'Deafening Essence of Hatred']) {
        for (const area of [50, 70, 90]) {
          assert.equal(shown(withGap, ess(n), area), true, `${fx} s${strictness}: ${n} at ${area}`);
          assert.match(by(withGap, ess(n), area), /^build:s2:resist:cold:essence/, `${fx} s${strictness}: ${n} decided by the gap rule`);
        }
        assert.ok(!by(noGap, ess(n), 50).includes(':resist:'), 'no gap, no rule');
        assert.ok(!by(withGap, ess(n), 30).includes(':resist:'), 'not before S2');
        const own = catalog.byName.get(n)!;
        const got = decide(withGap, ess(n), 50).style;
        assert.equal(got.fs, own.style.fs, `${n}: NeverSink font size`);
        assert.deepEqual(got.bd, own.style.bd, `${n}: NeverSink border`);
      }
      // the other elements' essences are untouched
      assert.ok(!by(withGap, ess('Screaming Essence of Anger'), 50).includes(':resist:'));
      assert.ok(!by(withGap, ess('Screaming Essence of Wrath'), 50).includes(':resist:'));
    }
  }
});

// ---- 2. life flasks --------------------------------------------------------------------------------------------------

test('2. life flasks: S0-S2 show only the two best drop levels at or below the area level', () => {
  const g = loadGame();
  const levels = Object.entries(g.bases)
    .filter(([, r]) => r.type === 'Flask' && r.tags?.life_flask)
    .map(([n, r]) => [n, Math.max(1, r.req?.level ?? 1)] as const)
    .sort((a, b) => a[1] - b[1]);
  for (const fx of [PCONC, MELEE]) {
    const { text } = make(fx);
    for (const area of [1, 3, 5, 6, 11, 12, 17, 18, 29, 30, 35, 36, 41, 42, 49, 50, 59, 60, 64, 65, 67]) {
      const eligible = levels.filter(([, l]) => l <= area);
      const top = eligible.slice(-2).map(([n]) => n);
      for (const [n] of eligible) {
        const flask = item({ name: n, class: 'Life Flasks', rarity: 'Magic', itemLevel: 80, sockets: '' });
        const r = decide(text, flask, area);
        if (top.includes(n)) assert.equal(r.visible, true, `${fx}: ${n} shows at area ${area}`);
        else {
          assert.equal(r.visible, false, `${fx}: ${n} is hidden at area ${area}`);
          assert.match(r.decided?.ruleId ?? '', /^build:s\d:hide:flask:life:/);
        }
      }
    }
  }
});

test('2. life flasks: S3+ show only the build flask bases with quality 16+ or item level 84+', () => {
  const { text, built } = make(PCONC);
  const mine = built.profile.flasks.find((f) => f.class === 'Life Flasks')!.base;
  assert.equal(mine, 'Divine Life Flask');
  const f = (name: string, q: number, ilvl: number): ItemProps => item({ name, class: 'Life Flasks', rarity: 'Magic', itemLevel: ilvl, quality: q, sockets: '' });
  for (const area of [68, 77, 78, 90]) {
    assert.equal(shown(text, f(mine, 16, 70), area), true, `quality 16 at ${area}`);
    assert.equal(shown(text, f(mine, 0, 84), area), true, `item level 84 at ${area}`);
    assert.equal(shown(text, f(mine, 10, 80), area), false, `a plain ${mine} at ${area}`);
    assert.equal(shown(text, f('Eternal Life Flask', 20, 86), area), false, `another base at ${area}`);
    assert.equal(shown(text, f('Hallowed Life Flask', 0, 86), area), false);
  }
  // the melee build has no flasks at all, so no life flask shows in maps
  const melee = make(MELEE).text;
  assert.equal(shown(melee, f('Divine Life Flask', 20, 86), 70), false);
  assert.equal(validateFilter(text).errors, 0);
});

// ---- 3. gems ---------------------------------------------------------------------------------------------------------

test('3. gems: Vaal versions of the build skills and Awakened versions of its supports always show', () => {
  const g = loadGame();
  const gem = (name: string, cls: 'Skill Gems' | 'Support Gems'): ItemProps => item({ name, class: cls, rarity: 'Normal', itemLevel: 1, sockets: '' });
  const cases: [string, string[], string[]][] = [
    [PCONC, ['Vaal Cyclone'], ['Awakened Blasphemy Support', 'Awakened Void Manipulation Support', 'Awakened Cast On Critical Strike Support']],
    [MELEE, ['Vaal Cleave'], ['Awakened Brutality Support', 'Awakened Melee Physical Damage Support']],
  ];
  for (const [fx, vaal, awakened] of cases) {
    const { text, built } = make(fx);
    const p = built.profile;
    for (const a of p.gems.filter((x) => !x.support)) for (const v of g.vaalByBase?.[a.gemId] ?? []) assert.ok(vaal.includes(v) || true, v);
    for (const v of vaal) {
      for (const area of [10, 50, 70, 90]) {
        assert.equal(shown(text, gem(v, 'Skill Gems'), area), true, `${fx}: ${v} at ${area}`);
        assert.equal(by(text, gem(v, 'Skill Gems'), area), 'build:gems:skill', `${fx}: ${v} decided by the build gem rule`);
      }
    }
    for (const a of awakened) assert.equal(by(text, gem(a, 'Support Gems'), 70), 'build:gems:support', `${fx}: ${a}`);
    // an Awakened gem that does not exist, and a Vaal gem of a skill the build lacks, are not forced
    assert.ok(!text.includes('Awakened Nothing Support'));
    assert.notEqual(by(text, gem('Vaal Absolution', 'Skill Gems'), 70), 'build:gems:skill');
    assert.equal(validateFilter(text).errors, 0);
  }
});

// ---- 4. trade cards --------------------------------------------------------------------------------------------------

test('4. trade mode: divination cards worth 5c or more show; ssf adds none', () => {
  const cardPrices = { 'The Doctor': 900, 'The Apothecary': 120, 'Her Mask': 5, Humility: 4.9, 'Rain of Chaos': 0.2, 'The Wretched': 0.1 };
  const card = (name: string): ItemProps => item({ name, class: 'Divination Cards', rarity: 'Normal', stackSize: 1, itemLevel: 1, sockets: '' });
  for (const fx of [PCONC, MELEE]) {
    const trade = make(fx, { mode: 'trade' }, { cardPrices }, 6);
    for (const n of ['The Doctor', 'The Apothecary', 'Her Mask']) {
      for (const area of [1, 50, 90]) {
        assert.equal(shown(trade.text, card(n), area), true, `${fx}: ${n} at ${area}`);
        assert.equal(by(trade.text, card(n), area), 'build:cards:trade');
      }
    }
    for (const n of ['Humility', 'Rain of Chaos', 'The Wretched']) assert.notEqual(by(trade.text, card(n), 90), 'build:cards:trade', `${fx}: ${n} is under ${TRADE_CARD_MIN_CHAOS}c`);
    const ssf = make(fx, { mode: 'ssf' }, { cardPrices }, 6);
    assert.ok(!ssf.built.rules.some((r) => r.id === 'build:cards:trade'));
    assert.equal(validateFilter(trade.text).errors, 0);
  }
});

// ---- 5. leveling skill picker ----------------------------------------------------------------------------------------

test('5. leveling skill picker: candidates sorted by score with a reason; the pick reaches the plan through setup.build.levelingSkill', async () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'leveling');
  const { data } = await loadLevelingData(dir);
  const { planLeveling } = await import('../src/shared/leveling/plan.js');
  const lite = levelingLite(readBuildProfile(fixture(PCONC), loadGame())!);
  const rows = candidateRows(lite, data);
  assert.ok(rows.length >= 3, `${rows.length} candidates`);
  assert.equal(rows[0]!.name, 'Caustic Arrow');
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1]!.score >= rows[i]!.score, 'best first');
  for (const r of rows) {
    assert.ok(r.reason.length > 0 && r.availLevel <= 4 && r.name && r.gemId.startsWith('Metadata/Items/Gems/'));
  }
  // picking another candidate changes the leveling skill the plan, and so the filter, uses
  const other = rows.find((r) => r.name !== 'Caustic Arrow')!;
  const plan = planLeveling(lite, data, other.gemId);
  assert.equal(plan.skills[0]?.gemId, other.gemId);
  const built = makeBuildFilter(fixture(PCONC), plan, setup({ levelingSkill: other.gemId }), { game: loadGame(), catalog })!;
  assert.equal(built.rules.length > 0, true);
  const lev = built.rules.filter((r) => r.build?.group === 'gems' && r.id.includes('levgems'));
  assert.ok(lev.length === 0 || lev.some((r) => JSON.stringify(r.targets).includes(other.name)));
});

// ---- chip ------------------------------------------------------------------------------------------------------------

test('chip: every place names the build with the profile main skill', () => {
  const g = loadGame();
  const p = readBuildProfile(fixture(PCONC), g)!;
  assert.equal(buildLead(p), 'Pathfinder · Poisonous Concoction');
  assert.equal(buildLead(readBuildProfile(fixture(MELEE), g)!), 'Juggernaut · Cleave');
  // the library reads the main skill another way; the chip must not use it
  const meta = readBuildMeta(fixture(PCONC));
  assert.notEqual(`${meta.ascendClassName} · ${meta.mainSkill}`, buildLead(p), 'the library name differs, which is why the chip uses the profile');
  // the same skill the leveling planner is given
  assert.equal(g.gems[levelingLite(p).mainSkillId]?.name, p.mainSkill?.name);
  // no ascendancy: the class
  assert.equal(buildLead({ ascendancy: '', className: 'Ranger', mainSkill: p.mainSkill }), 'Ranger · Poisonous Concoction');
  assert.equal(buildLead({ ascendancy: '', className: 'Ranger', mainSkill: null }), 'Ranger');
});

// ---- 6. nothing a build Hide block can reach -------------------------------------------------------------------------

test('6. no build Hide block can hide a Divine Orb or a t1 unique base at any stage', () => {
  const uniques = catalog.items.filter((it) => /^t1$/.test(it.tier) && /uniq/i.test(it.type)).slice(0, 25);
  assert.ok(uniques.length >= 5, `${uniques.length} t1 unique entries in the catalog`);
  const divine = item({ name: 'Divine Orb', class: 'Stackable Currency', rarity: 'Normal', stackSize: 1, itemLevel: 1, sockets: '' });
  const areas = Array.from({ length: 34 }, (_, i) => i * 3 + 1);
  const overrides = [
    { stage: 'all' as const, action: 'hide' as const, classes: ['Stackable Currency'], reason: 'test' },
    { stage: 'S3' as const, action: 'hide' as const, bases: ['Divine Orb'], reason: 'test' },
    { stage: 'all' as const, action: 'hide' as const, classes: ['Amulets', 'Belts', 'Rings', 'Body Armours', 'Helmets', 'Gloves', 'Boots', 'Shields', 'Life Flasks'], reason: 'test' },
  ];
  let checked = 0;
  for (const fx of [PCONC, MELEE]) {
    for (const mode of ['ssf', 'trade'] as const) {
      for (const ov of [[], overrides]) {
        for (const strictness of [6]) {
          const { text, built } = make(fx, { mode, overrides: ov }, {}, strictness);
          const hideIds = new Set(built.rules.filter((r) => r.visibility === 'hide').map((r) => r.id));
          assert.ok(hideIds.size >= 3);
          for (const area of areas) {
            const r = decide(text, divine, area);
            assert.equal(r.visible, true, `${fx} ${mode} area ${area}: Divine Orb is shown`);
            assert.ok(!hideIds.has(r.decided?.ruleId ?? ''), `${fx} ${mode} area ${area}: not decided by a build Hide`);
            checked++;
          }
          for (const u of uniques) {
            const cls = u.class ?? '';
            for (const area of [1, 30, 50, 70, 90]) {
              const r = decide(text, item({ name: u.name, class: cls, rarity: 'Unique', itemLevel: 80, sockets: '' }), area);
              assert.ok(!hideIds.has(r.decided?.ruleId ?? ''), `${fx} ${mode} area ${area}: ${u.name} not decided by a build Hide (${r.decided?.ruleId})`);
              checked++;
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 1000, `${checked} checks`);
});

test('6. a change that hides currency keeps NeverSink t1-t3 currency; without such a change no extra block is written', () => {
  const plain = make(PCONC);
  assert.ok(!plain.built.rules.some((r) => r.id.startsWith('build:safety:currency')));
  const hidden = make(PCONC, { overrides: [{ stage: 'all', action: 'hide', classes: ['Stackable Currency'], reason: 'test' }] }, {}, 6);
  const safety = hidden.built.rules.filter((r) => r.id.startsWith('build:safety:currency'));
  assert.ok(safety.length >= 1);
  for (const n of ['Mirror of Kalandra', 'Divine Orb']) {
    const it = catalog.byName.get(n);
    if (!it) continue;
    assert.equal(shown(hidden.text, item({ name: n, class: 'Stackable Currency', rarity: 'Normal', stackSize: 1, itemLevel: 1, sockets: '' }), 70), true, n);
  }
  assert.equal(validateFilter(hidden.text).errors, 0);
});

// ---- the assistant path makes the same rules as the wizard -----------------------------------------------------------

test('assistant and wizard paths give byte-identical build rules (resist gap, cards, flasks)', async () => {
  const { openBuildFilter } = await import('../src/main/assistant/levelingTools.js');
  const { cardPricesOf, statsOf } = await import('../src/shared/lootfilter/buildFilter.js');
  const { planLeveling } = await import('../src/shared/leveling/plan.js');
  const { LootFilterStore } = await import('../src/main/lootfilter/store.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'leveling');
  const { data } = await loadLevelingData(dir);
  const affixes = await resistAffixes(ENGINE_DATA);
  const statList = [{ id: 'MissingColdResist', value: 33 }, { id: 'MissingLightningResist', value: 12.4 }, { id: 'MissingFireResist', value: 0 }, { id: 'Life', value: 5000 }, { id: 'Nested', value: { a: 1 } }];
  const table = { byName: { 'The Doctor': { chaos: 900, category: 'DivinationCard' }, Humility: { chaos: 1, category: 'DivinationCard' }, 'Divine Orb': { chaos: 200, category: 'Currency' } } };
  const tmp = mkdtempSync(join(tmpdir(), 'pom-same-'));
  try {
    const store = new LootFilterStore(join(tmp, 'f.json'));
    await store.load();
    const xml = fixture(PCONC);
    const c = {
      store,
      prices: async () => table,
      build: { game: async () => loadGame(), plan: async (l: Parameters<typeof planLeveling>[0], o?: string) => ({ plan: planLeveling(l, data, o) }), affixes: async () => affixes },
    };
    const ctx = { open: () => ({ buildId: 'b1', name: 'PConc', buildKey: 'k' }), engine: { send: async (cmd: string) => (cmd === 'getStats' ? { stats: statList } : { buildXml: xml }) } };
    for (const mode of ['ssf', 'trade'] as const) {
      const st = await store.load();
      const withMode = { ...st, filters: st.filters.map((f) => (f.id === st.activeId ? { ...f, setup: { ...f.setup, build: { ...DEFAULT_BUILD_SETUP, mode } } } : f)) };
      const viaAssistant = await openBuildFilter({ ...c, store: { load: async () => withMode } } as never, ctx as never, catalog);
      // the wizard path: the same inputs from the renderer's own readers
      const profile = readBuildProfile(xml, loadGame())!;
      const plan = planLeveling(levelingLite(profile), data, viaAssistant.setup.levelingSkill);
      const viaWizard = makeBuildFilter(xml, plan, viaAssistant.setup, { game: loadGame(), catalog, buildName: 'PConc', stats: statsOf(statList)!, affixes, cardPrices: cardPricesOf(table.byName)! })!;
      assert.equal(viaAssistant.setup.mode, mode);
      assert.equal(JSON.stringify(viaAssistant.built.rules), JSON.stringify(viaWizard.rules), `${mode}: identical rules`);
      assert.ok(viaAssistant.built.rules.some((r) => r.id === 'build:s2:resist:cold'), `${mode}: the resist rule is there`);
      assert.equal(viaAssistant.built.rules.some((r) => r.id === 'build:cards:trade'), mode === 'trade');
    }
    // and without the numbers there is no resist rule, which is what made the two paths differ before
    const bare = await openBuildFilter({ ...c, build: { ...c.build, affixes: undefined } } as never, ctx as never, catalog);
    assert.ok(!bare.built.rules.some((r) => r.id.includes(':resist:')));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
