import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SolveGoal } from '@pom/protocol';
import { SolveManager } from '../src/main/assistant/solve.js';
import { keptFor, keptEvidence } from '../src/main/assistant/skeletons.js';
import { resultHash } from '../src/main/assistant/assess.js';
import type { AssistantEngine } from '../src/main/assistant/tools.js';

// A goal that matches a kept build starts the solve from it, so the first row is a whole build (PLAN.md slice 3).

const goal = (over: Partial<SolveGoal>): SolveGoal => ({ skill: 'Poisonous Concoction of Bouncing', wealth: 'mid-league', assume: { playMode: 'bossing' }, targets: [{ name: 'DPS', metric: 'dps', value: 3e6 }, { name: 'EHP', metric: 'ehp', value: 8e4 }], ...over }) as SolveGoal;

function rig() {
  const calls: Array<{ cmd: string; args: any }> = [];
  let loaded = '';
  const engine = {
    async send(cmd: string, args: any) {
      calls.push({ cmd, args });
      if (cmd === 'loadBuild') {
        loaded = args.buildXml;
        return { buildId: 'kept1' };
      }
      if (cmd === 'solveStart') return { solveId: 's' + calls.filter((c) => c.cmd === 'solveStart').length };
      // the start row of the build the solve was given (a real row carries the engine's text of it: same here)
      if (cmd === 'solveStep') return { active: true, done: false, layer: 'x', evaluations: 1, elapsedMs: 1, results: loaded ? [{ id: resultHash(loaded), start: true, targets: [], limits: [] }] : [], picks: [] };
      if (cmd === 'solveResult') return { xml: loaded };
      return {};
    },
  } as unknown as AssistantEngine;
  const m = new SolveManager({ engine, open: () => ({ buildId: 'b1', buildKey: 'k1', name: 'x' }), proposals: {} as never, tree: {} as never, push: () => undefined, pollMs: 5, timeless: async () => void (await new Promise((r) => setTimeout(r, 20)), calls.push({ cmd: 'tables', args: {} })) });
  return { m, calls };
}

test('the Bouncing mid league ask starts from the kept build: loaded, used as the start, class and level set', async () => {
  const { m, calls } = rig();
  await m.run(goal({}));
  const load = calls.find((c) => c.cmd === 'loadBuild')!;
  assert.match(load.args.buildXml, /ascendClassName="Pathfinder"/);
  assert.match(load.args.buildXml, /Poisonous Concoction of Bouncing/);
  const starts = calls.filter((c) => c.cmd === 'solveStart');
  // first the kept row alone (one try, checked while the CPU is free), then the block of search started from that row's text
  assert.deepEqual([starts.length, starts[0]!.args.options.maxEvals, starts[1]!.args.options.maxEvals !== 1, starts[1]!.args.buildId], [2, 1, true, 'kept1']);
  assert.equal(calls.some((c) => c.cmd === 'closeBuild' && c.args.buildId === 'kept1'), true);
  assert.deepEqual([m.state.goal?.ascendancy, m.state.goal?.className, m.state.goal?.level], ['Pathfinder', 'Ranger', 95]);
  assert.equal(m.state.startFrom!.label, 'Kept build, mid league');
  await m.stop();
});

test("the kept row stays on screen while the search's own solve has not listed it yet", async () => {
  const { m, calls } = rig();
  const send = (m as any).deps.engine.send;
  let searching = false;
  (m as any).deps.engine.send = async (cmd: string, args: any) => {
    if (cmd === 'solveStart' && args.options.maxEvals !== 1) searching = true;
    const r = await send(cmd, args);
    return cmd === 'solveStep' && searching ? { ...r, results: [], picks: [] } : r;
  };
  await m.run(goal({}));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.filter((c) => c.cmd === 'solveStep').length > 2, true);
  assert.equal(m.state.snapshot?.results.length, 1);
  assert.equal(m.state.snapshot?.results[0]?.start, true);
  assert.match(await m.resultXml(0), /Poisonous Concoction of Bouncing/);
  await m.stop();
});

test('the level the player asked for wins over the kept build\'s own: level 100 still starts from the level 95 build', async () => {
  const { m, calls } = rig();
  await m.run(goal({ level: 100 }));
  assert.deepEqual(calls.filter((c) => c.cmd === 'solveStart').map((c) => c.args.goal.level), [100, 100]);
  assert.equal(m.state.goal?.level, 100);
  assert.equal(m.state.startFrom?.level, 95);
  await m.stop();
});

test('league start takes the league start build; a level 88 box is fine, level 90 at mid league is not', () => {
  assert.equal(keptFor(goal({ wealth: 'league-start', level: 88 }))?.level, 85);
  assert.equal(keptFor(goal({ level: 95 }))?.tier, 'mid-league');
  assert.equal(keptFor(goal({ level: 90 })), null);
});

test('no kept build for the plain gem, another ascendancy, or a rich budget: the solve starts from the open build', async () => {
  assert.equal(keptFor(goal({ skill: 'Poisonous Concoction' })), null);
  assert.equal(keptFor(goal({ ascendancy: 'Trickster' })), null);
  assert.equal(keptFor(goal({ wealth: 'rich' })), null);
  const { m, calls } = rig();
  await m.run(goal({ skill: 'Poisonous Concoction' }));
  assert.equal(calls.some((c) => c.cmd === 'loadBuild'), false);
  assert.equal(calls.find((c) => c.cmd === 'solveStart')!.args.buildId, 'b1');
  assert.equal(m.state.startFrom, undefined);
  await m.stop();
});

test('the wizard evidence has both gem versions for the skill', () => {
  const v = keptEvidence();
  assert.ok(v['Poisonous Concoction of Bouncing']!.builds > v['Poisonous Concoction']!.builds);
});

test('a kept build is loaded only after the timeless jewel tables are in place', async () => {
  const { m, calls } = rig();
  await m.run(goal({}));
  const at = (cmd: string) => calls.findIndex((c) => c.cmd === cmd);
  assert.deepEqual([at('tables') >= 0, at('tables') < at('loadBuild')], [true, true]);
  await m.stop();
});
