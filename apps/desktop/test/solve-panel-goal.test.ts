import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SolveGoal } from '@pom/protocol';
import { fromGoal, runBlockFor, toGoal } from '../src/renderer/assistant/SolvePanel.js';
import { NEED_MODE, SolveManager } from '../src/main/assistant/solve.js';

const st = { timeBudgetMs: 120_000, cpu: 'normal' } as never;
const goal: SolveGoal = {
  skill: 'Boneshatter',
  targets: [{ name: 'DPS', metric: 'combined', weight: 3 }],
  limits: { extra: [{ stat: 'Speed', min: 1 }] },
  gems: { ban: ['Pulverise'] },
  bandit: 'Oak',
  passivePoints: 120,
  assume: { playMode: 'bossing', flasksAlways: true },
  wealth: 'rich',
};

test('panel round trip keeps what the form has no box for, incl. bossing', () => {
  const base = fromGoal(goal, st, {} as never);
  // the focus is asked every time: a loaded goal's playMode is never carried into the form or back out
  assert.equal(base.playMode, '');
  assert.equal(toGoal(base).assume?.playMode, undefined);
  const out = toGoal({ ...base, playMode: 'bossing' });
  assert.equal(out.assume?.playMode, 'bossing');
  assert.equal(out.assume?.flasksAlways, true);
  assert.deepEqual(out.gems, { ban: ['Pulverise'] });
  assert.equal(out.bandit, 'Oak');
  assert.equal(out.passivePoints, 120);
  assert.equal(out.targets?.[0]?.weight, 3);
  assert.equal(out.limits?.extra?.length, 1);
  assert.equal(toGoal({ ...base, wealth: '' }).wealth, undefined);
  assert.equal(toGoal({ ...base, playMode: 'bossing', assume: false }).assume?.playMode, 'bossing');
});

test('Run stays disabled until a play focus is picked, incl. both', () => {
  const base = fromGoal({ ...goal, assume: { flasksAlways: true } }, st, {} as never);
  assert.equal(base.playMode, '');
  assert.match(runBlockFor(base) ?? '', /Mapping, Bossing or Both/);
  assert.equal(toGoal(base).assume?.playMode, undefined);
  const both = { ...base, playMode: 'both' as const };
  assert.equal(runBlockFor(both), '');
  assert.equal(toGoal(both).assume?.playMode, 'both');
  assert.equal(toGoal(both).assume?.flaskUptime, 'bossing');
});

test('a solve without a play focus is refused, even with wealth set', async () => {
  const m = new SolveManager({ open: () => ({ buildId: 'b', buildKey: 'k', name: 'n' }), push: () => {} } as never);
  const g: SolveGoal = { skill: 'Cleave', wealth: 'rich', assume: { flaskUptime: 'bossing' } };
  await assert.rejects(m.run(g), { message: NEED_MODE });
});

test('a focus the player said in chat is carried in; a loaded goal starts empty; flaskUptime follows the pick', async () => {
  const said = fromGoal(goal, { ...st, modeStated: true } as never, {} as never);
  assert.equal(said.playMode, 'bossing');
  assert.equal(fromGoal(goal, st, {} as never).playMode, '');
  const m = new SolveManager({ open: () => ({ buildId: 'b', buildKey: 'k', name: 'n' }), push: () => {} } as never);
  assert.equal((await m.setGoal(goal, {}, 'assistant')).modeStated, true);
  assert.equal((await m.setGoal({ ...goal, assume: { flasksAlways: true } }, {}, 'assistant')).modeStated, false);
  const stale = { ...fromGoal({ ...goal, assume: { flaskUptime: 'bossing' } }, st, {} as never), playMode: 'mapping' as const };
  assert.equal(toGoal(stale).assume?.flaskUptime, 'mapping');
  assert.equal(toGoal({ ...stale, playMode: 'both' }).assume?.flaskUptime, 'bossing');
});
