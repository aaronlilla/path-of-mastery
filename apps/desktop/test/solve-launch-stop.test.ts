import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SolveGoal } from '@pom/protocol';
import { SolveManager } from '../src/main/assistant/solve.js';
import { resultHash } from '../src/main/assistant/assess.js';
import type { AssistantEngine } from '../src/main/assistant/tools.js';

// A Stop while a kept-build Run is still starting is not lost, and the kept build's one-try probe never outlives its row (0.1.21 review findings 1 and 2).

const goal = { skill: 'Poisonous Concoction of Bouncing', wealth: 'mid-league', assume: { playMode: 'bossing' }, targets: [{ name: 'DPS', metric: 'dps', value: 3e6 }] } as SolveGoal;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** `hold` names a call ("loadBuild#2", "solveStart#2") that waits until `release()`; `reached` resolves when it is called. */
function rig(hold?: string) {
  const calls: Array<{ cmd: string; args: any }> = [];
  let loaded = '';
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const at = new Promise<void>((r) => (reached = r));
  const engine = {
    async send(cmd: string, args: any) {
      calls.push({ cmd, args });
      const n = calls.filter((c) => c.cmd === cmd).length;
      if (`${cmd}#${n}` === hold) {
        reached();
        await gate;
      }
      if (cmd === 'loadBuild') {
        loaded = args.buildXml;
        return { buildId: 'scratch' + n };
      }
      if (cmd === 'solveStart') return { solveId: 's' + n };
      if (cmd === 'solveStep') return { active: true, done: false, layer: 'x', evaluations: 1, elapsedMs: 1, results: [{ id: resultHash(loaded), start: true, targets: [], limits: [] }], picks: [] };
      if (cmd === 'solveResult') return { xml: loaded };
      return {};
    },
  } as unknown as AssistantEngine;
  const m = new SolveManager({ engine, open: () => ({ buildId: 'b1', buildKey: 'k1', name: 'x' }), proposals: {} as never, tree: {} as never, push: () => undefined, pollMs: 5 });
  // the row's check opens scratch builds of its own; out of the way so the engine calls counted are the launch's
  (m as any).assess = async () => undefined;
  return { m, calls, release, at };
}

for (const hold of ['loadBuild#2', 'solveStart#2']) {
  test(`Stop while the search's ${hold.split('#')[0]} is pending: stays stopped, no search left running, no polling`, async () => {
    const { m, calls, release, at } = rig(hold);
    const run = m.run(goal);
    await at;
    assert.equal(m.state.status, 'running', 'the kept row is on screen with Stop');
    await m.stop();
    const stoppedAt = calls.length;
    release();
    await run;
    await tick(30);
    assert.equal(m.state.status, 'stopped');
    const after = calls.slice(stoppedAt);
    const started = after.filter((c) => c.cmd === 'solveStart').map((c) => calls.indexOf(c));
    // nothing new is started after Stop; a start already on its way is cancelled at once
    for (const i of started) assert.ok(calls.slice(i).some((c) => c.cmd === 'solveCancel'), 'a start after Stop is cancelled');
    if (hold === 'solveStart#2') assert.ok(after.some((c) => c.cmd === 'solveCancel' && c.args.solveId === 's2'), 'the search the engine started for the stale launch is cancelled');
    assert.equal(after.filter((c) => c.cmd === 'solveStep').length, 0, 'no polling after Stop');
    assert.equal((m as any).timer, null);
    assert.equal(calls.filter((c) => c.cmd === 'loadBuild').length, calls.filter((c) => c.cmd === 'closeBuild').length, 'every scratch build is closed');
  });
}

test("the probe's solve is cancelled before the search starts, and Stop afterwards cancels the search", async () => {
  const { m, calls } = rig();
  await m.run(goal);
  const probeCancel = calls.findIndex((c) => c.cmd === 'solveCancel' && c.args.solveId === 's1');
  const search = calls.findIndex((c) => c.cmd === 'solveStart' && c.args.options.maxEvals !== 1);
  assert.ok(probeCancel >= 0 && probeCancel < search, `probe cancel at ${probeCancel}, search start at ${search}`);
  await m.stop();
  assert.ok(calls.some((c) => c.cmd === 'solveCancel' && c.args.solveId === 's2'));
  assert.equal(m.state.status, 'stopped');
});

// 0.1.22 review finding 2: a new goal while the first loadBuild of a Run is pending makes that Run stale.
test("a new goal while the Run's first loadBuild is pending: the goal stays, no search for the old goal starts", async () => {
  const { m, calls, release, at } = rig('loadBuild#1');
  await m.setGoal(goal);
  const run = m.run();
  await at;
  assert.equal(m.state.status, 'ready', 'the kept row is not on screen yet');
  await m.setGoal({ ...goal, skill: 'Lightning Arrow' } as SolveGoal);
  release();
  await run;
  await tick(30);
  assert.equal(m.state.goal?.skill, 'Lightning Arrow');
  assert.equal(m.state.status, 'ready');
  assert.equal(calls.filter((c) => c.cmd === 'solveStart').length, 0, 'nothing is started for the old goal');
});
