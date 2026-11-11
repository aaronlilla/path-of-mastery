import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SolveGoal } from '@pom/protocol';
import { systemPrompt } from '../src/main/assistant/prompts.js';
import { SOLVE_TOOLS, SolveManager } from '../src/main/assistant/solve.js';
import type { AssistantEngine, ToolContext } from '../src/main/assistant/tools.js';

// The AI writes the plan, the solve starts at once, a stall goes back to the AI for new leads,
// and only the AI ends it, with the numbers.

const REQUEST = 'a poisonous concoction build league start with 3m dps and 80k ehp';

type Lead = { name: string; values: Array<{ name: string; value: number; need: number }>; limiting: string; moreTimeHelps: boolean };
const result = (dps: number, ehp: number) => ({
  index: 0, label: 'r', className: 'Ranger', ascendancy: 'Pathfinder', score: 1,
  targets: [
    { name: 'DPS', metric: 'combined', stats: [], value: dps, target: 3_000_000, met: false },
    { name: 'EHP', metric: 'ehp', stats: [], value: ehp, target: 80_000, met: ehp >= 80_000 },
  ],
  limits: [], limitsMet: true, blocking: null, points: 0, ascendancyPointsUsed: 0, gems: { main: [], utility: [] }, items: [], bandit: 'None', start: false,
});

/** A fake engine: each solve runs one step, then ends stalled with per-lead best values (the engine's contract). */
function engine(goals: SolveGoal[], leads: Lead[][]) {
  const steps = new Map<string, number>();
  return {
    async send(cmd: string, params: Record<string, unknown>) {
      if (cmd === 'solveStart') {
        goals.push(params.goal as SolveGoal);
        assert.ok(!(params.options as { timeBudgetMs?: number }).timeBudgetMs, 'no time cap is sent');
        return { solveId: `s${goals.length}` };
      }
      if (cmd === 'solveStep') {
        const id = params.solveId as string;
        const n = (steps.get(id) ?? 0) + 1;
        steps.set(id, n);
        const round = Number(id.slice(1)) - 1;
        const best = leads[round]![0]!.values;
        const snap = { active: n < 2, done: n >= 2, layer: 'leads', evaluations: n * 1000, elapsedMs: n * 1000, results: [result(best[0]!.value, best[1]!.value)], picks: [0] };
        return n >= 2 ? { ...snap, end: { reason: 'stalled', leads: leads[round] } } : snap;
      }
      if (cmd === 'solveCancel') return {};
      throw new Error(cmd);
    },
  } as unknown as AssistantEngine;
}

async function until(f: () => boolean, what: string): Promise<void> {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > 3000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const tool = (name: string) => SOLVE_TOOLS.find((t) => t.name === name)!;

test('pconc request: the plan goes to the solver, it starts at once, a stall re-plans once, then an honest end with numbers', async () => {
  const goals: SolveGoal[] = [];
  const ROUND1: Lead[] = [
    { name: 'Pathfinder flask pconc', values: [{ name: 'DPS', value: 1_200_000, need: 3_000_000 }, { name: 'EHP', value: 62_000, need: 80_000 }], limiting: 'poison duration and chaos multiplier', moreTimeHelps: false },
    { name: 'Occultist pconc', values: [{ name: 'DPS', value: 900_000, need: 3_000_000 }, { name: 'EHP', value: 85_000, need: 80_000 }], limiting: 'flask charges', moreTimeHelps: true },
  ];
  const ROUND2: Lead[] = [
    { name: 'Pathfinder pconc with Vaal Pact', values: [{ name: 'DPS', value: 1_600_000, need: 3_000_000 }, { name: 'EHP', value: 70_000, need: 80_000 }], limiting: 'league start gear', moreTimeHelps: false },
  ];
  const states: string[] = [];
  const m = new SolveManager({ engine: engine(goals, [ROUND1, ROUND2]), open: () => ({ buildId: 'b1', buildKey: 'k1', name: 'Templar build' }), proposals: {} as never, tree: {} as never, push: (s) => void states.push(s.status), pollMs: 5 });
  const ctx = { solve: m, origin: 'panel' } as unknown as ToolContext;

  // The AI's first call, as it once went wrong: className copied from the open Templar build. The player never named a class.
  const plan = { leads: [
    { name: 'Pathfinder flask pconc', className: 'Ranger', ascendancy: 'Pathfinder', uniques: ['Atziri\'s Promise'], supports: ['Unbound Ailments', 'Critical Strike Affliction'], why: 'flask uptime and poison scaling' },
    { name: 'Occultist pconc', className: 'Witch', ascendancy: 'Occultist', supports: ['Unbound Ailments'], why: 'chaos curses and ES' },
  ] };
  const goal = { skill: 'Poisonous Concoction', className: 'Templar', targets: [{ name: 'DPS', value: 3_000_000 }, { name: 'EHP', metric: 'ehp', value: 80_000 }], wealth: 'league-start', plan };
  await tool('startSolve').run({ goal, request: REQUEST }, ctx);
  // playMode was not said: the panel asks, and the solve starts when the player presses Run.
  assert.equal(m.state.status, 'ready');
  await m.setGoal({ ...m.state.goal!, assume: { playMode: 'mapping' } }, {}, 'panel');
  assert.equal(m.state.status, 'ready', 'answering the panel does not start the solve');
  await m.run();
  assert.equal(m.state.status, 'running');
  const sent = goals[0] as SolveGoal & { plan?: typeof plan };
  assert.equal(sent.className, undefined, 'the open build\'s class is not the plan');
  assert.equal(sent.plan?.leads.length, 2);
  assert.ok(!JSON.stringify(sent.plan).includes('Templar'));

  await until(() => m.state.status === 'stalled', 'stall 1');
  const replan = (m.state as { replan?: string }).replan ?? '';
  assert.match(replan, /Pathfinder flask pconc: DPS 1\.2M of 3M, EHP 62k of 80k/);
  assert.match(replan, /limited by poison duration and chaos multiplier/);
  assert.match(replan, /more time would help/);

  // The AI's re-plan round: same goal, new leads; the player presses Run again.
  await tool('startSolve').run({ goal: { ...m.state.goal!, plan: { leads: [{ name: 'Pathfinder pconc with Vaal Pact', ascendancy: 'Pathfinder', keystones: ['Vaal Pact'] }] } }, request: REQUEST }, ctx);
  assert.equal(m.state.status, 'ready');
  await m.run();
  assert.equal(m.state.status, 'running');
  assert.equal((m.state as { round?: number }).round, 2);
  await until(() => m.state.status === 'stalled', 'stall 2');

  // No credible lead left: the AI ends it with its reason; the app adds the numbers.
  const end = (await tool('stopSolve').run({ verdict: 'League start gear cannot carry pconc past about half the DPS ask.' }, ctx)) as { verdict?: { why: string; gaps: string[] } };
  assert.equal(m.state.status, 'done');
  assert.match(end.verdict?.why ?? '', /League start gear/);
  assert.deepEqual(end.verdict?.gaps, ['DPS 1.6M of 3M (47% short)', 'EHP 70k of 80k (13% short)']);
  assert.equal(goals.length, 2, 'one re-plan round');
  assert.ok(!states.includes('error'));
});

test('the solver prompt plans first and never sends the player to Run', () => {
  const p = systemPrompt({ tools: ['startSolve', 'getSolve', 'stopSolve', 'applySolveResult'] });
  assert.match(p, /3 to 5 distinct leads/);
  assert.match(p, /Solve update/);
  assert.doesNotMatch(p, /press Run|Run again|run: true/);
});
