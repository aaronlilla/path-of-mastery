import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SolveGoal } from '@pom/protocol';
import { SOLVE_TOOLS, SolveGoalSchema, SolveManager, finishText } from '../src/main/assistant/solve.js';
import { systemPrompt } from '../src/main/assistant/prompts.js';
import { xmlHash } from '../src/main/assistant/buildReaders.js';
import { resultHash } from '../src/main/assistant/assess.js';
import type { AssistantEngine, ToolContext } from '../src/main/assistant/tools.js';

// No clock and no try cap by default, the run ends on its result, Keep improving from the best build, a closing turn on Stop, "not ready" cannot be applied, the text.

const res = (xmlTag: string) => ({
  index: 0, id: xmlTag, label: 'r', className: 'Ranger', ascendancy: 'Pathfinder', score: 1,
  targets: [{ name: 'DPS', metric: 'dps', stats: [], value: 1_200_000, target: 3_000_000, met: false }],
  limits: [], limitsMet: true, blocking: null, points: 0, ascendancyPointsUsed: 0, gems: { main: [], utility: [] }, items: [], bandit: 'None', start: false,
});

type Call = { cmd: string; params: Record<string, unknown> };
const PLAN = { leads: [{ name: 'Pathfinder flask poison', ascendancy: 'Pathfinder' }, { name: 'Occultist chaos', ascendancy: 'Occultist' }] };
const GOAL = { skill: 'Poisonous Concoction', targets: [{ name: 'DPS', value: 3_000_000 }], wealth: 'mid-league', assume: { playMode: 'bossing' }, plan: PLAN } as SolveGoal;

function rig(done: boolean, idle = false) {
  const calls: Call[] = [];
  const turns: Array<{ text: string; key: string }> = [];
  let n = 0;
  const engine = {
    async send(cmd: string, params: Record<string, unknown>) {
      calls.push({ cmd, params });
      if (cmd === 'solveStart') return { solveId: `s${++n}` };
      if (cmd === 'solveStep') return { active: !done, done, idle, stalls: idle ? [{ id: 0, name: 'Pathfinder flask poison', values: [], limiting: 'DPS 1.2M of 3M', moreTimeHelps: false }] : [], layer: 'x', evaluations: 9, elapsedMs: 9, results: [res(resultHash(`<best block="${n}"/>`))], picks: [0] };
      if (cmd === 'solveResult') return { xml: `<best block="${n}"/>` };
      if (cmd === 'loadBuild') return { buildId: 'scratch1' };
      return {};
    },
  } as unknown as AssistantEngine;
  const m = new SolveManager({
    engine, open: () => ({ buildId: 'b1', buildKey: 'k1', name: 'x' }), proposals: {} as never, tree: {} as never, pollMs: 5,
    push: (s) => { if (s.replan && s.replanKey && !turns.some((t) => t.key === s.replanKey)) turns.push({ text: s.replan, key: s.replanKey }); },
  });
  return { m, calls, turns };
}
const starts = (calls: Call[]) => calls.filter((c) => c.cmd === 'solveStart');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('the default run has no clock and no try cap, and the whole plan', async () => {
  const { m, calls } = rig(false);
  await m.run(GOAL);
  const s = starts(calls)[0]!.params as { goal: SolveGoal & { plan?: typeof PLAN }; options: Record<string, unknown> };
  assert.deepEqual(s.options, {});
  assert.deepEqual(s.goal.plan?.leads.map((l) => l.name), ['Pathfinder flask poison', 'Occultist chaos']);
  assert.equal(m.state.block, 1);
  await m.stop(false);
  await m.run(GOAL, { timeBudgetMs: 300_000 });
  assert.deepEqual(starts(calls)[1]!.params.options, { timeBudgetMs: 300_000 }, 'a timed entry still sends its clock');
  await m.stop(false);
});

test('every lead stalled and the AI\'s answer adds no lead: the run ends with its closing turn', async () => {
  const { m, calls, turns } = rig(false, true);
  await m.run(GOAL);
  await wait(30);
  assert.equal(m.state.status, 'stalled');
  assert.equal(turns.length, 1);
  assert.match(turns[0]!.text, /every lead has stalled/);
  await m.turnEnded('what does this gem do?');
  assert.equal(m.state.status, 'stalled', 'another turn leaves it waiting');
  await m.turnEnded(turns[0]!.text);
  assert.equal(m.state.status, 'done');
  assert.ok(calls.some((c) => c.cmd === 'solveCancel'), 'the engine stops waiting');
  assert.equal(turns.length, 2);
  assert.match(turns[1]!.text, /the solve finished with 1 build[\s\S]*Keep improving/);
  await m.keepImproving();
  assert.equal(m.state.block, 2, 'Keep improving goes on from there');
  await m.stop(false);
});

test('the stalled end says it stopped gaining, what it reached and what holds it back', () => {
  const snap = { done: true, layer: 'done', evaluations: 9, elapsedMs: 9, results: [res('r1')], picks: [0], end: { reason: 'stalled', leads: [{ name: 'Solver\'s own leads', values: [], limiting: 'EHP 50k of 80k' }] } };
  const t = finishText(snap as never);
  assert.match(t, /stopped gaining and ended with 1 build/);
  assert.match(t, /DPS 1\.2M of 3M \(60% short\)/);
  assert.match(t, /What holds each lead back: Solver's own leads: EHP 50k of 80k/);
});

test('Keep improving starts the next run from the best build, with the next seed', async () => {
  const { m, calls } = rig(true);
  await m.run(GOAL);
  await wait(60);
  assert.equal(m.state.status, 'done');
  await m.keepImproving();
  const loads = calls.filter((c) => c.cmd === 'loadBuild');
  assert.equal(loads.length, 1);
  assert.equal(loads[0]!.params.buildXml, '<best block="1"/>', 'the best build of block 1 is the start');
  const s2 = starts(calls)[1]!.params as { buildId: string; goal: SolveGoal & { plan?: typeof PLAN }; options: Record<string, unknown> };
  assert.equal(s2.buildId, 'scratch1');
  assert.deepEqual(s2.options, { seed: 1 });
  assert.equal(s2.goal.plan?.leads.length, 2);
  assert.equal(m.state.block, 2);
  assert.ok(calls.some((c) => c.cmd === 'closeBuild' && c.params.buildId === 'scratch1'), 'the scratch copy is closed');
  await wait(60);
  assert.equal(m.state.status, 'done');
  await m.stop(false);
});

test('Keep improving needs a finished solve', async () => {
  const { m } = rig(false);
  await assert.rejects(m.keepImproving(), /finished solve/);
  await m.run(GOAL);
  await assert.rejects(m.keepImproving(), /finished solve/);
  await m.stop(false);
});

test('Stop gives the AI one closing turn; the run\'s own end gives one; the AI\'s own stop gives none', async () => {
  const a = rig(false);
  await a.m.run(GOAL);
  await wait(30);
  await a.m.stop();
  assert.equal(a.m.state.status, 'stopped');
  assert.equal(a.turns.length, 1);
  assert.match(a.turns[0]!.text, /the player stopped the solve with 1 build so far/);
  assert.match(a.turns[0]!.text, /Keep improving/);

  const b = rig(true);
  await b.m.run(GOAL);
  await wait(60);
  assert.equal(b.turns.length, 1);
  assert.match(b.turns[0]!.text, /the solve finished with 1 build/);
  await b.m.stop();
  assert.equal(b.turns.length, 1, 'a solve that already ended has nothing more to close');

  const c = rig(false);
  await c.m.run(GOAL);
  await wait(30);
  await c.m.stop(false);
  assert.equal(c.turns.length, 0);
  assert.equal(c.m.state.replan, undefined);
});

test('propose refuses a "not ready" row and lets a "needs fixes" row through to the card', async () => {
  const live = '<PathOfBuilding/>';
  const engine = { async send(cmd: string) { if (cmd === 'getBuildXml') return { buildXml: live }; return { statDiff: { changed: [] } }; } } as unknown as AssistantEngine;
  const m = new SolveManager({ engine, open: () => ({ buildId: 'b1', buildKey: 'k1', name: 'x' }), proposals: {} as never, tree: { classes: async () => ({ classes: [] }), all: async () => new Map() } as never, push: () => undefined });
  const put = (id: string, verdict: string) => (m as unknown as { records: Map<string, unknown> }).records.set(id, { rec: { id, verdict, why: 'Flask 3 cannot hold its enchant.', sourceRevision: xmlHash(live) }, xml: '<PathOfBuilding/>', title: 'Solver result 1', summary: '', assumptions: [] });
  put('a', 'notReady');
  await assert.rejects(m.propose('a', 'external'), /Solver result 1 is not ready, so it cannot be applied: Flask 3 cannot hold its enchant/);
  put('b', 'fix');
  const made: unknown[] = [];
  await m.propose('b', 'external', { create: (p: unknown) => (made.push(p), p as never) } as never);
  assert.equal(made.length, 1);
});

test('the text: no "no time limit", no "cannot be reached at this wealth", mid league uniques match the data', () => {
  const tool = (n: string) => SOLVE_TOOLS.find((t) => t.name === n)!;
  const p = systemPrompt({ tools: ['startSolve', 'getSolve', 'stopSolve', 'applySolveResult'] });
  const desc = (z: unknown) => (z as { description?: string }).description ?? '';
  for (const text of [p, tool('startSolve').description, desc(tool('stopSolve').shape.verdict), desc(SolveGoalSchema.shape.wealth)]) {
    assert.doesNotMatch(text, /no time limit/i);
    assert.doesNotMatch(text, /at this wealth/);
    assert.doesNotMatch(text, /about 1 divine/);
  }
  assert.match(p, /Keep improving/);
  assert.match(p, /what this search reached and what limits it/);
});
