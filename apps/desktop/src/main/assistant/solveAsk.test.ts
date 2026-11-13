import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SolveGoal } from '@pom/protocol';
import { askWords, goalOfAsk, keepAnswers, opensWizard, prefillFromAsk, readBuildAsk, sameAsk, skillIn } from './solveAsk.js';

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

const GEMS = ['Poisonous Concoction', 'Poisonous Concoction of Bouncing', 'Righteous Fire', 'Lightning Arrow'];
const PCONC = 'make me a poisonous concoction build, 3M dps and 80k ehp, level 90, 10 div bossing';

test('the pconc ask is read whole: skill, both targets, level, budget, focus', () => {
  const a = readBuildAsk(PCONC, GEMS)!;
  assert.equal(a.skill, 'Poisonous Concoction');
  assert.deepEqual(a.targets, [{ name: 'DPS', metric: 'dps', value: 3_000_000 }, { name: 'EHP', metric: 'ehp', value: 80_000 }]);
  assert.equal(a.level, 90);
  assert.equal(a.wealth, 'mid-league');
  assert.equal(a.playMode, 'bossing');
  assert.deepEqual(goalOfAsk(a).targets, a.targets);
});

test('"of Bouncing" is the longest match, so the typed gem is kept', () => {
  assert.equal(readBuildAsk('build me a poisonous concoction of bouncing for 2 million dps', GEMS)!.skill, 'Poisonous Concoction of Bouncing');
  assert.equal(skillIn('poisonous concoction', GEMS), 'Poisonous Concoction');
});

test('no skill, no number or no build word: no early open', () => {
  assert.equal(readBuildAsk('make me a build with 3M dps', GEMS), null);
  assert.equal(readBuildAsk('make me a poisonous concoction build', GEMS), null);
  assert.equal(readBuildAsk('is 3M dps good for poisonous concoction', GEMS), null);
});

test('a class or ascendancy the words name is read, so the form holds it', () => {
  const a = readBuildAsk('new Lightning Arrow Deadeye build 4M dps', GEMS)!;
  assert.deepEqual([a.className, a.ascendancy], ['Ranger', 'Deadeye']);
  assert.equal(readBuildAsk(PCONC, GEMS)!.className, undefined);
});

test("the AI's late goal keeps every answer the form holds and adds the rest", () => {
  const open = goalOfAsk(readBuildAsk(PCONC, GEMS)!);
  const late = { skill: 'Poisonous Concoction of Bouncing', level: 95, wealth: 'rich', targets: [{ name: 'DPS', metric: 'dps', value: 5e6 }], assume: { playMode: 'mapping', flasks: true }, limits: { resists: 75 }, plan: { leads: [{ name: 'a' }] } } as SolveGoal;
  const g = keepAnswers(open, late);
  assert.deepEqual([g.skill, g.level, g.wealth, g.assume?.playMode, g.assume?.flasks], ['Poisonous Concoction', 90, 'mid-league', 'bossing', true]);
  assert.deepEqual(g.targets, open.targets);
  assert.equal(g.plan?.leads.length, 1);
  assert.equal(g.limits?.resists, 75);
  assert.equal(sameAsk('Make me a build!', 'make me a build'), true);
});
