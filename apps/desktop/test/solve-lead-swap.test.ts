import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SolveGoal } from '@pom/protocol';
import { SOLVE_TOOLS, SolveManager } from '../src/main/assistant/solve.js';
import type { AssistantEngine, ToolContext } from '../src/main/assistant/tools.js';

// A lead that stalls goes to the AI at once while the others keep running;
// the AI swaps in a lead, the engine takes it into the running solve; once every lead has stalled the engine waits and
// only the AI ends it, with the numbers.

const result = (dps: number) => ({
  index: 0, label: 'r', className: 'Ranger', ascendancy: 'Pathfinder', score: 1,
  targets: [{ name: 'DPS', metric: 'combined', stats: [], value: dps, target: 3_000_000, met: false }],
  limits: [], limitsMet: true, blocking: null, points: 0, ascendancyPointsUsed: 0, gems: { main: [], utility: [] }, items: [], bandit: 'None', start: false,
});
const stall = (id: number, name: string, dps: number, limiting: string) => ({ id, name, values: [{ name: 'DPS', value: dps, need: 3_000_000 }], limiting, moreTimeHelps: false });

/** A fake engine: A stalls on step 2 while B runs; after C arrives, every lead stalls and the engine idles. */
function engine(log: Array<[string, Record<string, unknown>]>) {
  let step = 0;
  let added = -1;
  return {
    async send(cmd: string, params: Record<string, unknown>) {
      log.push([cmd, params]);
      if (cmd === 'solveStart') return { solveId: 's1' };
      if (cmd === 'solveAddLeads') {
        added = step;
        return { queued: (params.leads as unknown[]).length, running: true };
      }
      if (cmd === 'solveStep') {
        step++;
        const a = stall(0, 'Juggernaut armour poison', 900_000, 'DPS 900k of 3M; tree and gems alone give 300k of it');
        const stalls = added < 0 ? (step >= 2 ? [a] : []) : step - added >= 3 ? [a, stall(1, "Solver's own leads", 1_400_000, 'gear budget used up at league-start'), stall(2, 'Pathfinder flask poison', 1_600_000, 'gear budget used up at league-start')] : [a];
        const idle = stalls.length === 3;
        return { active: true, done: false, idle, layer: idle ? 'waiting for new leads' : 'plan', evaluations: step * 1000, elapsedMs: step * 1000, results: [result(idle ? 1_600_000 : 900_000)], picks: [0], stalls };
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

test('a lead that stalls goes to the AI at once, its swap joins the running solve, all stalled waits for the AI, which ends it honestly', { timeout: 10_000 }, async (t) => {
  const log: Array<[string, Record<string, unknown>]> = [];
  const turns: string[] = [];
  const keys = new Set<string>();
  const m = new SolveManager({
    engine: engine(log),
    open: () => ({ buildId: 'b1', buildKey: 'k1', name: 'pconc' }),
    proposals: {} as never,
    tree: {} as never,
    // (the panel's auto-send: one AI turn per new replanKey)
    push: (s) => {
      const k = (s as { replanKey?: string }).replanKey;
      if (s.replan && k && !keys.has(k)) {
        keys.add(k);
        turns.push(s.replan);
      }
    },
    pollMs: 5,
  });
  const ctx = { solve: m, origin: 'panel' } as unknown as ToolContext;
  t.after(() => void m.stop());
  const plan = { leads: [{ name: 'Juggernaut armour poison', ascendancy: 'Juggernaut' }, { name: 'Assassin crit poison', ascendancy: 'Assassin' }] };
  const goal = { skill: 'Poisonous Concoction', targets: [{ name: 'DPS', value: 3_000_000 }], wealth: 'league-start', assume: { playMode: 'mapping' }, plan } as SolveGoal;
  await tool('startSolve').run({ goal }, ctx);
  assert.equal(m.state.status, 'ready', 'startSolve only fills the form');
  await m.run();
  assert.equal(m.state.status, 'running');

  // A stalls while B runs: one turn for A, the solve keeps running.
  await until(() => turns.length === 1, 'the stall turn');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(turns.length, 1, 'one turn for the one stall, not one per poll');
  assert.match(turns[0]!, /Juggernaut armour poison: DPS 900k of 3M; limited by DPS 900k of 3M; tree and gems alone give 300k of it/);
  assert.match(turns[0]!, /others keep running/);
  assert.equal(m.state.status, 'running');

  // The AI swaps in C for A: the engine gets C in the same solve.
  await tool('addLeads').run({ leads: [{ name: 'Pathfinder flask poison', ascendancy: 'Pathfinder', replaces: 'Juggernaut armour poison' }] }, ctx);
  const add = log.find(([c]) => c === 'solveAddLeads');
  assert.equal(add?.[1].solveId, 's1');
  assert.deepEqual((add?.[1].leads as Array<{ name: string; replaces?: string }>).map((l) => [l.name, l.replaces]), [['Pathfinder flask poison', 'Juggernaut armour poison']]);
  assert.equal(log.filter(([c]) => c === 'solveStart').length, 1, 'no new solve');

  // Every lead stalls: the engine idles, the AI gets one turn saying the solver waits.
  await until(() => m.state.status === 'stalled', 'idle');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(turns.length, 2);
  assert.match(turns[1]!, /waiting for you/);
  assert.match(turns[1]!, /Pathfinder flask poison: DPS 1\.6M of 3M/);
  assert.doesNotMatch(turns[1]!, /Juggernaut/, 'A was already told');

  // No credible lead left: the AI ends it; the engine is stopped and the panel shows the numbers.
  const end = (await tool('stopSolve').run({ verdict: 'League start gear cannot carry pconc past about half the DPS ask.' }, ctx)) as { verdict?: { why: string; gaps: string[] } };
  assert.equal(m.state.status, 'done');
  assert.ok(log.some(([c]) => c === 'solveCancel'), 'the idle engine is stopped');
  assert.deepEqual(end.verdict?.gaps, ['DPS 1.6M of 3M (47% short)']);
});
