import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateGuide } from '../src/main/leveling/guideFor.js';
import { readLevelingOverride, writeLevelingOverride } from '../src/main/leveling/override.js';
import { LootFilterStore } from '../src/main/lootfilter/store.js';
import { planLeveling } from '../src/shared/leveling/plan.js';
import { makeBuildFilter } from '../src/shared/lootfilter/buildFilter.js';
import { levelingLite, readBuildProfile } from '../src/shared/lootfilter/profile.js';
import { DEFAULT_BUILD_SETUP } from '../src/shared/lootfilter/types.js';
import { parseBlocks } from '../src/shared/lootfilter/blocks.js';
import { buildCatalog } from '../src/shared/lootfilter/catalog.js';
import { generateFilter } from '../src/shared/lootfilter/generate.js';
import { loadGame, neverSink } from './buildFilterHelpers.js';
import { ENGINE_DATA, FIXTURE_XML, loadAll } from './levelingHelpers.js';

async function kit() {
  const { data, idx } = await loadAll();
  return { data, idx, engineDir: ENGINE_DATA, game: async () => loadGame() };
}

test('the guide and the filter read the same main skill: PConc fixture swaps at 12 in both', async () => {
  const k = await kit();
  const xml = FIXTURE_XML();
  const g = await generateGuide(k, xml, undefined, false);
  assert.equal(g.plan.swap?.level, 12);
  assert.equal(g.build.mainSkillId, 'Metadata/Items/Gems/SkillGemPoisonousConcoction');
  const swaps = g.guide.acts.flatMap((a) => a.steps).filter((s) => s.kind === 'swap');
  assert.equal(swaps.length, 1);
  // the filter's own profile and plan
  const profile = readBuildProfile(xml, loadGame())!;
  const filterPlan = planLeveling(levelingLite(profile), k.data);
  assert.equal(filterPlan.swap?.level, g.plan.swap?.level);
  assert.deepEqual(levelingLite(profile).mainSupportIds, g.lite.mainSupportIds);
  const base = neverSink();
  const parsed = parseBlocks(base);
  const built = makeBuildFilter(xml, filterPlan, { ...DEFAULT_BUILD_SETUP, on: true }, { game: loadGame(), catalog: buildCatalog(parsed.blocks), buildName: 'x' })!;
  const text = generateFilter({ baseText: base, baseVersion: '8.20.1d', strictness: 2, style: 0, rules: built.rules, parsed, buildHeader: built.header, stageBanners: built.banners, now: new Date('2026-10-10T00:00:00Z') }).text;
  assert.match(text, /AreaLevel >= 12/);
});

test('one override: writing it through the tab changes the filter plan and the guide, and back', async () => {
  const k = await kit();
  const xml = FIXTURE_XML();
  const dir = mkdtempSync(join(tmpdir(), 'lvl-ovr-'));
  try {
    const store = new LootFilterStore(join(dir, 'filters.json'));
    assert.equal(await readLevelingOverride(store), '');
    const base = await generateGuide(k, xml, await readLevelingOverride(store), false);
    assert.equal(base.plan.skills[0]!.name, 'Caustic Arrow');
    const other = 'Metadata/Items/Gems/SkillGemSplitArrow';
    await writeLevelingOverride(store, other);
    // the filter's doc carries it
    const st = await store.load();
    const doc = st.filters.find((f) => f.id === st.activeId)!;
    assert.equal(doc.setup.build?.levelingSkill, other);
    assert.equal(doc.setup.build?.on, DEFAULT_BUILD_SETUP.on, 'the rest of the build setup is kept');
    // the tab path (guide) and the filter path (planLeveling with the doc's value) agree
    const guide = await generateGuide(k, xml, await readLevelingOverride(store), false);
    const filterPlan = planLeveling(levelingLite(readBuildProfile(xml, loadGame())!), k.data, doc.setup.build?.levelingSkill);
    assert.equal(guide.plan.skills[0]!.gemId, other);
    assert.equal(filterPlan.skills[0]!.gemId, other);
    assert.deepEqual(guide.plan.skills[0]!.weaponClasses, filterPlan.skills[0]!.weaponClasses);
    // and a write from the filter side shows up in the tab's read
    const fresh = new LootFilterStore(join(dir, 'filters.json'));
    await fresh.load();
    await writeLevelingOverride(store, '');
    assert.equal(await readLevelingOverride(store), '');
    assert.equal((await generateGuide(k, xml, await readLevelingOverride(store), false)).plan.skills[0]!.name, 'Caustic Arrow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
