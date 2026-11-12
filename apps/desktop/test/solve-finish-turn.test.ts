import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SolveGoal } from '@pom/protocol';
import { SolveManager, finishText } from '../src/main/assistant/solve.js';
import { afterRetry } from '../src/shared/assistant/retry.js';
import { systemPrompt, lootSystemPrompt } from '../src/main/assistant/prompts.js';
import type { AssistantEngine } from '../src/main/assistant/tools.js';
import type { ThreadMessage } from '../src/shared/assistant/types.js';

// A solve that ends gives the AI exactly one finish turn; a miss gets the frontier answer; retry keeps landed cards; the prompt matches the tools.

const res = (dps: number, met: boolean) => ({
  index: 0, label: 'r', className: 'Ranger', ascendancy: 'Pathfinder', score: 1,
  targets: [{ name: 'DPS', metric: 'dps', stats: [], value: dps, target: 3_000_000, met }],
  limits: [], limitsMet: true, blocking: null, points: 0, ascendancyPointsUsed: 0, gems: { main: [], utility: [] }, items: [], bandit: 'None', start: false,
});

function run(dps: number, met: boolean) {
  const turns: Array<{ text: string; key: string }> = [];
  const engine = {
    async send(cmd: string) {
      if (cmd === 'solveStart') return { solveId: 's1' };
      if (cmd === 'solveStep') return { active: false, done: true, layer: 'done', evaluations: 9, elapsedMs: 9, results: [res(dps, met)], picks: [0] };
      if (cmd === 'solveCancel') return {};
      throw new Error(cmd);
    },
  } as unknown as AssistantEngine;
  const m = new SolveManager({
    engine, open: () => ({ buildId: 'b1', buildKey: 'k1', name: 'x' }), proposals: {} as never, tree: {} as never, pollMs: 5,
    // the panel's auto-send: one AI turn per new replanKey
    push: (s) => { if (s.replan && s.replanKey && !turns.some((t) => t.key === s.replanKey)) turns.push({ text: s.replan, key: s.replanKey }); },
  });
  const goal = { skill: 'Lightning Arrow', targets: [{ name: 'DPS', value: 3_000_000 }], wealth: 'league-start', assume: { playMode: 'mapping' } } as SolveGoal;
  return { m, turns, start: () => m.run(goal) };
}

test('a solve that reaches done without a stall sends exactly one finish turn', { timeout: 10_000 }, async () => {
  const { m, turns, start } = run(3_400_000, true);
  await start();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(m.state.status, 'done');
  assert.equal(turns.length, 1);
  assert.match(turns[0]!.text, /finished with 1 build/);
  assert.match(turns[0]!.text, /Every target is met/);
  assert.doesNotMatch(turns[0]!.text, /planBudget/);
});

test('a target miss gets the frontier answer: best, what is short, what to buy', () => {
  const t = finishText({ done: true, results: [res(1_200_000, false)], picks: [0] } as never);
  assert.match(t, /DPS 1\.2M of 3M \(60% short\)/);
  assert.match(t, /planBudget and upgradeCandidates/);
  assert.match(t, /buy these first/);
});

test('retry keeps a landed card and drops the failed attempt', () => {
  const card = (status: 'applied' | 'failed') => ({ id: status, role: 'proposal', createdAt: 1, proposal: { status } }) as unknown as ThreadMessage;
  const m = (id: string, role: 'user' | 'assistant'): ThreadMessage => ({ id, role, createdAt: 1, text: id });
  const out = afterRetry([m('old', 'assistant'), m('q', 'user'), card('applied'), m('half', 'assistant'), { id: 'rc', role: 'receipt', createdAt: 1 } as ThreadMessage, card('failed')], 1);
  assert.deepEqual(out.map((x) => x.id), ['old', 'q', 'applied', 'rc']);
});

test('the prompt denies web access only when the web tools are off', () => {
  for (const f of [systemPrompt, lootSystemPrompt]) {
    assert.match(f({ tools: ['getBuildSummary'], web: false }), /and no web access,/);
    const on = f({ tools: ['getBuildSummary'], web: true });
    assert.match(on, /WebSearch and WebFetch/);
    assert.doesNotMatch(on, /and no web access,/);
  }
});
