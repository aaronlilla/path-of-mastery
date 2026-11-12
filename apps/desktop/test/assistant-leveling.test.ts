import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOOT_TOOLS, LfProposalStore } from '../src/main/assistant/lootTools.js';
import { LEVELING_TOOLS, makeGuideProvider, type BuildToolsDeps } from '../src/main/assistant/levelingTools.js';
import { loadLevelingData } from '../src/main/leveling/data.js';
import { NeverSinkStore } from '../src/main/lootfilter/neversink.js';
import { LootFilterStore } from '../src/main/lootfilter/store.js';
import { planLeveling } from '../src/shared/leveling/plan.js';
import { makeBuildFilter } from '../src/shared/lootfilter/buildFilter.js';
import { parseBlocks } from '../src/shared/lootfilter/blocks.js';
import { evaluateItem } from '../src/shared/lootfilter/evaluate.js';
import { generateFilter } from '../src/shared/lootfilter/generate.js';
import type { LfProposal } from '../src/shared/lootfilter/ipcTypes.js';
import { levelingLite, readBuildProfile } from '../src/shared/lootfilter/profile.js';
import { DEFAULT_BUILD_SETUP, type FilterSetup } from '../src/shared/lootfilter/types.js';
import { NEVERSINK_DIR } from './lootfilterHelpers.js';
import { ENGINE_DATA, fixture, levelingGuide, loadGame, neverSink } from './buildFilterHelpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const LEVELING_DIR = resolve(here, '..', '..', 'resources', 'leveling');
// The leveling tools stay in levelingTools.ts while the guide is switched off (they are left out of LOOT_TOOLS).
const tool = (n: string) => [...LOOT_TOOLS, ...LEVELING_TOOLS].find((t) => t.name === n)!;

async function setup(withBuildFilter: boolean, leveling = true) {
  const dir = mkdtempSync(join(tmpdir(), 'pom-lvl-'));
  const store = new LootFilterStore(join(dir, 'filters.json'));
  await store.load();
  const proposals = new LfProposalStore();
  const seen: LfProposal[] = [];
  proposals.onCreated((p) => seen.push(p));
  const { data } = await loadLevelingData(LEVELING_DIR);
  const build: BuildToolsDeps = {
    game: async () => loadGame(),
    // Switched off, main has no leveling planner and every plan is null (main/lootfilter/buildData.ts planFor).
    plan: async (lite, override) => ({ plan: leveling ? planLeveling(lite, data, override) : null }),
    guide: makeGuideProvider(LEVELING_DIR, ENGINE_DATA, async () => loadGame()),
    ticked: () => [],
  };
  const xml = fixture('pconc-pathfinder.xml');
  const ctx = {
    origin: 'panel',
    open: () => ({ buildId: 'b1', name: 'PConc Pathfinder', buildKey: 'k' }),
    engine: { send: async () => ({ buildXml: xml }) },
    loot: { store, ns: new NeverSinkStore(join(NEVERSINK_DIR, '..'), join(dir, 'dl')), prices: async () => null, proposals, ...(withBuildFilter ? { build } : {}) },
  } as never;
  return { dir, store, seen, ctx, data, xml };
}

/** What accepting a card does in the app: the change's setup patch lands on the filter's setup. */
const accept = (setupNow: FilterSetup, p: LfProposal): FilterSetup => p.changes.reduce((s, c) => ({ ...s, ...(c.setup ?? {}) }), setupNow);

test('explainLootItem: a rare sword at area 70 is hidden by the weapons rule, and the reason names the skill', async (t) => {
  levelingGuide(t, true); // the leveling stage and leveling skill are the leveling guide's (switched off by default)
  const { dir, ctx } = await setup(true);
  try {
    const r = (await tool('explainLootItem').run({ name: 'Rusted Sword', class: 'One Hand Swords', rarity: 'Rare', itemLevel: 70, linkedSockets: 2, sockets: 'RG', areaLevel: 70 }, ctx)) as { visible: boolean; stage: { id: string } | null; decidedBy: { source: string; ruleId: string; reason: string } };
    assert.equal(r.visible, false);
    assert.equal(r.stage?.id, 'S3');
    assert.equal(r.decidedBy.source, 'build filter');
    assert.match(r.decidedBy.ruleId, /^build:s\d:hide:weapons$/);
    assert.match(r.decidedBy.reason, /Poisonous Concoction/);
    const six = (await tool('explainLootItem').run({ name: 'Rusted Sword', class: 'One Hand Swords', rarity: 'Rare', linkedSockets: 6, areaLevel: 70 }, ctx)) as { visible: boolean; decidedBy: { ruleId: string } };
    assert.equal(six.visible, true);
    assert.equal(six.decidedBy.ruleId, 'build:safety:6l');
    const bow = (await tool('explainLootItem').run({ name: 'Short Bow', rarity: 'Normal', areaLevel: 5 }, ctx)) as { visible: boolean; decidedBy: { ruleId: string } };
    assert.equal(bow.visible, true, 'the bow is shown while Caustic Arrow is the leveling skill');
    assert.equal(bow.decidedBy.ruleId, 'build:s0:levweap');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getLootBuild and getBuildFilterStages carry the profile with reasons and the stages', async (t) => {
  levelingGuide(t, true); // the leveling stage and leveling skill are the leveling guide's (switched off by default)
  const { dir, ctx } = await setup(true);
  try {
    const b = (await tool('getLootBuild').run({}, ctx)) as { buildFilter: { weapons: { classes: string[]; why: string }; stages: { id: string; areaLevels: (number | null)[] }[]; uniques: { name: string }[] } };
    assert.deepEqual(b.buildFilter.weapons.classes, []);
    assert.match(b.buildFilter.weapons.why, /unarmed/);
    assert.deepEqual(b.buildFilter.stages.map((s) => [s.id, s.areaLevels[0]]), [['S0', 1], ['S1', 12], ['S2', 45], ['S3', 68], ['S4', 78]]);
    assert.equal(b.buildFilter.uniques.length, 5);
    const st = (await tool('getBuildFilterStages').run({ stage: 'S3' }, ctx)) as { levelingSkill: string; stages: { id: string; hides: { group: string; reason: string }[] }[] };
    assert.equal(st.levelingSkill, 'Caustic Arrow');
    assert.equal(st.stages.length, 1);
    assert.ok(st.stages[0]!.hides.some((h) => h.group === 'weapons' && /unarmed/.test(h.reason)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('leveling guide switched off: getLootBuild and getBuildFilterStages have no S0 stage and no leveling skill', async (t) => {
  levelingGuide(t, false);
  const { dir, ctx } = await setup(true, false);
  try {
    const b = (await tool('getLootBuild').run({}, ctx)) as { buildFilter: { stages: { id: string; areaLevels: (number | null)[] }[] } };
    assert.deepEqual(b.buildFilter.stages.map((s) => [s.id, s.areaLevels[0]]), [['S1', 1], ['S2', 45], ['S3', 68], ['S4', 78]]);
    const st = (await tool('getBuildFilterStages').run({}, ctx)) as { levelingSkill: string | null; stages: { id: string }[] };
    assert.equal(st.levelingSkill, null);
    assert.ok(!st.stages.some((s) => s.id === 'S0'));
    const bow = (await tool('explainLootItem').run({ name: 'Short Bow', rarity: 'Normal', areaLevel: 5 }, ctx)) as { decidedBy: { ruleId: string } | null };
    assert.notEqual(bow.decidedBy?.ruleId, 'build:s0:levweap');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('proposeBuildFilterChange makes a card and leaves the rules alone; accepting it changes the stage', async () => {
  const { dir, store, seen, ctx, xml, data } = await setup(true);
  try {
    const before = (await store.load()).filters[0]!;
    const rulesBefore = JSON.stringify(before.rules);
    const r = (await tool('proposeBuildFilterChange').run({ stage: 'S3', action: 'show', classes: ['Daggers'], reason: 'You want a dagger to craft with at map level.' }, ctx)) as { proposalId: string };
    assert.ok(r.proposalId);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.changes[0]!.rule, undefined, 'a setting change carries no rule');
    assert.equal(JSON.stringify((await store.load()).filters[0]!.rules), rulesBefore, 'the rules are unchanged until the card is accepted');
    // accepting
    const setupAfter = accept({ ...before.setup, build: { ...DEFAULT_BUILD_SETUP, on: true } }, seen[0]!);
    assert.equal(setupAfter.build?.overrides?.length, 1);
    const game = loadGame();
    const lite = levelingLite(readBuildProfile(xml, game)!);
    const plan = planLeveling(lite, data);
    const base = neverSink();
    const text = (setup: FilterSetup['build']) => {
      const built = makeBuildFilter(xml, plan, setup!, { game })!;
      return generateFilter({ baseText: base, baseVersion: '8.20.1d', strictness: 2, style: 0, rules: built.rules, buildHeader: built.header, stageBanners: built.banners }).text;
    };
    const dagger = (t: string, area: number) => evaluateItem(parseBlocks(t).blocks, { name: 'Glass Shank', class: 'Daggers', rarity: 'Rare', itemLevel: 70, linkedSockets: 1, sockets: 'G', influences: [], corrupted: false, mirrored: false }, { areaLevel: area, steps: false }).visible;
    const t0 = text({ ...DEFAULT_BUILD_SETUP, on: true });
    const t1 = text({ ...setupAfter.build!, on: true });
    assert.equal(dagger(t0, 70), false);
    assert.equal(dagger(t1, 70), true, 'shown at S3 after the card');
    assert.equal(dagger(t1, 80), false, 'still hidden at S4');
    // a class that is not in the game data is refused
    await assert.rejects(tool('proposeBuildFilterChange').run({ stage: 'S3', action: 'hide', classes: ['Spoons'], reason: 'x' }, ctx), /not in the game data/);
    await assert.rejects(tool('proposeBuildFilterChange').run({ stage: 'S2', action: 'reset', reason: 'x' }, ctx), /no changes to reset/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getLevelingGuide: the steps and ids are the ones the guide generator makes', async () => {
  const { dir, ctx, xml } = await setup(true);
  try {
    const own = await makeGuideProvider(LEVELING_DIR, ENGINE_DATA, async () => loadGame())(xml);
    const a1 = (await tool('getLevelingGuide').run({ act: 1 }, ctx)) as { steps: { id: string; kind: string; text: string; done: boolean }[]; mainSkillReady: { level: number } };
    assert.deepEqual(a1.steps.map((s) => s.id), own.guide.acts.find((a) => a.act === 1)!.steps.map((s) => s.id));
    assert.ok(a1.steps.length > 3);
    assert.ok(a1.steps.some((s) => s.kind === 'quest-reward'));
    assert.equal(a1.mainSkillReady.level, 12);
    assert.ok(a1.steps.every((s) => s.text && s.done === false));
    const all = (await tool('getLevelingGuide').run({}, ctx)) as { acts: { act: number; steps: number }[] };
    assert.equal(all.acts.length, 10);
    const reward = a1.steps.find((s) => s.kind === 'quest-reward')!;
    const e = (await tool('explainGuideStep').run({ stepId: reward.id }, ctx)) as { kind: string; sources: { gem: string; fromYourClass: { kind: string }[] }[] };
    assert.equal(e.kind, 'quest-reward');
    assert.ok(e.sources[0]!.fromYourClass.length > 0);
    await assert.rejects(tool('explainGuideStep').run({ stepId: 'nope' }, ctx), /No step has the id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('proposeLevelingSkill: a card that, accepted, changes the leveling skill and the first stage', async (t) => {
  levelingGuide(t, true); // the leveling stage and leveling skill are the leveling guide's (switched off by default)
  const { dir, store, seen, ctx, xml, data } = await setup(true);
  try {
    const before = (await store.load()).filters[0]!;
    const r = (await tool('proposeLevelingSkill').run({ gem: 'Freezing Pulse', reason: 'You level with spells.' }, ctx)) as { proposalId: string };
    assert.ok(r.proposalId);
    assert.deepEqual((await store.load()).filters[0]!.setup, before.setup, 'nothing changes until it is accepted');
    const setupAfter = accept(before.setup, seen[0]!);
    const fp = Object.entries(data.gems).find(([, m]) => m.name === 'Freezing Pulse')![0];
    assert.equal(setupAfter.build?.levelingSkill, fp);
    const game = loadGame();
    const lite = levelingLite(readBuildProfile(xml, game)!);
    const s0Weapons = (levelingSetup: string | undefined): string[] => {
      const plan = planLeveling(lite, data, levelingSetup);
      const built = makeBuildFilter(xml, plan, { ...DEFAULT_BUILD_SETUP, on: true, ...(levelingSetup ? { levelingSkill: levelingSetup } : {}) }, { game })!;
      const rule = built.rules.find((x) => x.id === 'build:s0:levweap');
      return rule ? rule.targets[0]!.conditions!.find((x) => x.key === 'Class')!.values : [];
    };
    assert.deepEqual(s0Weapons(undefined), ['Bows']);
    assert.deepEqual(s0Weapons(setupAfter.build?.levelingSkill), [], 'a spell needs no weapon, so the S0 weapon show goes');
    await assert.rejects(tool('proposeLevelingSkill').run({ gem: 'Not A Gem' }, ctx), /No skill gem is called/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
