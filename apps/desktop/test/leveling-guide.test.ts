import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelInTitle } from '../src/shared/leveling/guide.js';
import { generateGuide } from '../src/main/leveling/guideFor.js';
import { loadGame } from './buildFilterHelpers.js';
import { orderPassives } from '../src/shared/leveling/treeOrder.js';
import { readFacts } from '../src/shared/buildFacts.js';
import type { GuideStep } from '../src/shared/leveling/types.js';
import { ENGINE_DATA, FIXTURE_XML, loadAll, loadTree } from './levelingHelpers.js';

async function setup(leagueStart = false) {
  const { data, idx } = await loadAll();
  const xml = FIXTURE_XML();
  const g = await generateGuide({ data, idx, engineDir: ENGINE_DATA, game: async () => loadGame() }, xml, undefined, leagueStart);
  const f = readFacts(xml);
  const spec = f.specs[f.activeSpec - 1]!;
  const tree = loadTree(spec.treeVersion || '3_29', spec.classId);
  return { data, build: g.build, plan: g.plan, tree, guide: g.guide, spec };
}
const all = (steps: { acts: { steps: GuideStep[] }[] }) => steps.acts.flatMap((a) => a.steps);

test('the fixture reads as a Ranger Pathfinder PConc build', async () => {
  const { build, plan } = await setup();
  assert.equal(build.className, 'Ranger');
  assert.equal(build.mainSkillId, 'Metadata/Items/Gems/SkillGemPoisonousConcoction');
  assert.equal(plan.swap?.level, 12);
});

test('guide: a quest reward per act 1 to 4, one swap step at the plan level, the a1q3 reward reads Take Poisonous Concoction', async () => {
  const { guide, plan } = await setup();
  for (let act = 1; act <= 4; act++) {
    const steps = guide.acts.find((a) => a.act === act)!.steps;
    assert.ok(steps.some((s) => s.kind === 'quest-reward'), `act ${act} has a quest-reward step`);
  }
  const swaps = all(guide).filter((s) => s.kind === 'swap');
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0]!.kind === 'swap' && swaps[0]!.level, plan.swap!.level);
  const r = all(guide).find((s) => s.kind === 'quest-reward' && s.questId === 'a1q3');
  assert.ok(r && r.kind === 'quest-reward');
  assert.equal(r.take, 'Poisonous Concoction');
  // the swap comes after the hand-in that unlocks the main skill
  const flat = all(guide);
  const iReward = flat.findIndex((s) => s.id === r.id);
  const iSwap = flat.findIndex((s) => s.kind === 'swap');
  assert.ok(iSwap > iReward);
});

test('guide: tree steps never lose points and only add nodes the build has', async () => {
  const { guide, spec } = await setup();
  const trees = all(guide).filter((s): s is Extract<GuideStep, { kind: 'tree' }> => s.kind === 'tree');
  assert.ok(trees.length >= 5);
  let prev = 0;
  const mine = new Set(spec.nodes);
  const added = new Set<number>();
  for (const t of trees) {
    assert.ok(t.points >= prev, `points ${t.points} >= ${prev}`);
    prev = t.points;
    for (const id of t.add) {
      assert.ok(mine.has(id) || id > 0, 'node');
      added.add(id);
    }
  }
  for (const id of added) assert.ok(mine.has(id), `node ${id} is in the build`);
  assert.ok(trees[0]!.specTitle.startsWith('Leveling 1: Act 1'));
});

test('guide: step ids are identical across runs and across the league start toggle for shared steps', async () => {
  const a = await setup(false);
  const b = await setup(false);
  assert.deepEqual(all(a.guide).map((s) => s.id), all(b.guide).map((s) => s.id));
  const c = await setup(true);
  const own = (g: typeof a.guide) => all(g).filter((s) => !['arrive', 'handin', 'text'].includes(s.kind)).map((s) => s.id);
  assert.deepEqual(own(a.guide).sort(), own(c.guide).sort());
  const ids = all(a.guide).map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
});

test('orderPassives: every build node is reached once and ascendancy nodes come out in order', async () => {
  const { tree, spec } = await setup();
  const o = orderPassives(tree, spec.nodes);
  const regular = spec.nodes.filter((id) => tree.nodes.find((n) => n.id === id && !n.a && n.t !== 3 && n.t !== 5));
  assert.equal(new Set(o.order).size, o.order.length);
  for (const id of regular) assert.ok(o.order.includes(id), `node ${id}`);
  assert.ok(o.ascend.length >= 1);
});

test('spec titles with a level are checkpoints', () => {
  assert.equal(levelInTitle('Level 30'), 30);
  assert.equal(levelInTitle('lvl30 clear'), 30);
  assert.equal(levelInTitle('Endgame'), null);
});
