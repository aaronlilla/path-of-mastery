import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SolveGoal } from '@pom/protocol';
import { askWords, opensWizard, prefillFromAsk } from './solveAsk.js';

test('"a 4 div Flicker bosser" fills tier and mode', () => {
  assert.deepEqual(askWords('a 4 div Flicker bosser'), { wealth: 'league-start', playMode: 'bossing' });
  const g = prefillFromAsk('a 4 div Flicker bosser', { skill: 'Flicker Strike' } as SolveGoal);
  assert.equal(g.wealth, 'league-start');
  assert.equal(g.assume?.playMode, 'bossing');
  assert.deepEqual(askWords('T17s mid league'), { wealth: 'mid-league', playMode: 'mapping' });
  assert.equal(askWords('12 div mapper and bosser').wealth, 'mid-league');
});

test('"make me a flicker build" leaves both blank, and drops a guess the model made', () => {
  assert.deepEqual(askWords('make me a flicker build'), {});
  const g = prefillFromAsk('make me a flicker build', { skill: 'Flicker Strike', wealth: 'rich', assume: { flasks: true, playMode: 'both' } } as SolveGoal);
  assert.equal(g.wealth, undefined);
  assert.equal(g.assume?.playMode, undefined);
  assert.equal(g.assume?.flasks, true);
  assert.equal(askWords('a mirror arrow build').wealth, undefined);
});

test('a mode the ask rules out is not asked for', () => {
  assert.deepEqual(askWords('a flicker build for maps, not bosses'), { playMode: 'mapping' });
  assert.deepEqual(askWords('a bosser, no mapping'), { playMode: 'bossing' });
  assert.deepEqual(askWords('maps and bosses'), { playMode: 'both' });
});

test('one-item and fix asks never open the wizard', () => {
  assert.equal(opensWizard('is this ring an upgrade'), false);
  assert.equal(opensWizard('fix my resists'), false);
  assert.equal(opensWizard('a 4 div Flicker bosser'), true);
  assert.equal(opensWizard('make me a flicker build with a better ring'), true);
});
