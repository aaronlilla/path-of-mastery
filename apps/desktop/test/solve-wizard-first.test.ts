import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SolveGoal } from '@pom/protocol';
import { SOLVE_TOOLS, SolveManager } from '../src/main/assistant/solve.js';
import { goalOfAsk, readBuildAsk } from '../src/main/assistant/solveAsk.js';
import { answerQuestion, canRun, solveQuestions, usualLevel } from '../src/shared/assistant/solveQuestions.js';
import type { AssistantEngine, ToolContext } from '../src/main/assistant/tools.js';

// The form opens from the words at once; the AI's plan that arrives later never undoes the player's answers or a running solve.

const ASK = 'make me a poisonous concoction build, 3M dps and 80k ehp, 10 div bossing';
const startSolve = SOLVE_TOOLS.find((t) => t.name === 'startSolve')!;
const AI_GOAL = { skill: 'Poisonous Concoction', wealth: 'rich', assume: { playMode: 'mapping' }, targets: [{ name: 'DPS', metric: 'dps', value: 9e6 }], plan: { leads: [{ name: 'Pathfinder', ascendancy: 'Pathfinder' }] } };

function rig() {
  const sent: string[] = [];
  const engine = { async send(cmd: string) { sent.push(cmd); if (cmd === 'solveStart') return { solveId: 's1' }; if (cmd === 'solveStep') return { active: true, done: false, layer: 'x', evaluations: 1, elapsedMs: 1, results: [], picks: [] }; return {}; } } as unknown as AssistantEngine;
  const m = new SolveManager({ engine, open: () => ({ buildId: 'b1', buildKey: 'k1', name: 'x' }), proposals: {} as never, tree: {} as never, push: () => undefined, pollMs: 5 });
  const call = (args: Record<string, unknown>) => startSolve.run(args, { solve: m } as unknown as ToolContext);
  return { m, sent, call };
}
const opened = async (m: SolveManager) => m.openFromAsk(ASK, goalOfAsk(readBuildAsk(ASK, ['Poisonous Concoction'])!));

test('the form opens from the ask before any AI turn, filled and not running', async () => {
  const { m, sent } = rig();
  await opened(m);
  assert.equal(m.state.status, 'ready');
  assert.deepEqual([m.state.goal?.skill, m.state.goal?.wealth, m.state.goal?.assume?.playMode, m.state.goal?.targets?.length], ['Poisonous Concoction', 'mid-league', 'bossing', 2]);
  assert.equal(sent.includes('solveStart'), false);
});

test("the AI's late startSolve keeps the player's answers, even with `request` left out", async () => {
  const { m, call } = rig();
  await opened(m);
  const rev = m.state.goalRev;
  await call({ goal: AI_GOAL });
  const g = m.state.goal as SolveGoal;
  assert.deepEqual([g.wealth, g.assume?.playMode, g.targets?.[0]?.value], ['mid-league', 'bossing', 3_000_000]);
  assert.equal(g.plan?.leads[0]?.name, 'Pathfinder');
  assert.equal(m.state.goalRev, rev + 1);
});

test('once the player pressed Run, a late plan restarts nothing and waits for the next block', async () => {
  const { m, sent, call } = rig();
  await opened(m);
  await m.run();
  assert.equal(m.state.status, 'running');
  await call({ goal: AI_GOAL, request: ASK });
  assert.equal(m.state.status, 'running');
  assert.equal(sent.includes('solveCancel'), false);
  assert.equal(sent.filter((c) => c === 'solveStart').length, 1);
  assert.equal(m.state.goal?.plan?.leads.length, 1);
  assert.equal(m.state.goal?.wealth, 'mid-league');
  await m.stop();
});

test('an ask the form was not opened from still replaces it, as before', async () => {
  const { m, call } = rig();
  await opened(m);
  await call({ goal: { skill: 'Flicker Strike' }, request: 'make me a flicker strike build' });
  assert.equal(m.state.goal?.skill, 'Flicker Strike');
});

test('the questions: budget and focus first, ascendancy and gem version only with evidence', () => {
  const g = goalOfAsk(readBuildAsk(ASK, ['Poisonous Concoction'])!);
  const base = solveQuestions(g);
  assert.deepEqual(base.map((q) => q.id), ['budget', 'focus']);
  assert.equal(canRun(solveQuestions({ skill: 'x' } as SolveGoal)), false);
  assert.equal(canRun(base), true);
  const qs = solveQuestions(g, { ascendancies: [{ name: 'Pathfinder', share: 0.6 }, { name: 'Trickster', share: 0.1 }], versions: [{ name: 'Poisonous Concoction', builds: 20 }, { name: 'Poisonous Concoction of Bouncing', builds: 80 }] });
  assert.deepEqual(qs.map((q) => q.id), ['budget', 'focus', 'ascendancy', 'gem']);
  assert.equal(qs[2]!.suggested, 'Pathfinder');
  assert.equal(qs[3]!.answer, 'Poisonous Concoction');
  assert.equal(qs[3]!.suggested, 'Poisonous Concoction of Bouncing');
  assert.equal(answerQuestion(g, 'ascendancy', 'Pathfinder').className, 'Ranger');
  assert.equal(solveQuestions({ ...g, ascendancy: 'Trickster' }, { ascendancies: [{ name: 'Pathfinder', share: 1 }] }).length, 2);
  assert.equal(usualLevel({ skill: 'x', wealth: 'league-start' }), 88);
});
