import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAppMessage, isSupportSwap, isUpgradeShape, planApply, pointsShape } from './askShape.js';
import { budgetChaos } from './profile.js';

const SKILLS = ['Boneshatter', 'Burning Arrow', 'Fire Trap'];

/** None of the three shapes the app acts on before the model has read the message. */
const actsFirst = (text: string) => !!pointsShape(text) || isSupportSwap(text, SKILLS) || isUpgradeShape(text);

test('asks that read like a closed shape but say more do not act first', () => {
  for (const text of [
    'Spend my 5 points on damage, but do not lose any life',
    'swap my boots, keep my spell suppression',
    'What should I do about my flasks?',
    'What should I buy to get tankier?',
    'Which is my weakest resistance?',
    'What kills me in hardcore?',
    "I'm level 92, what should I buy with 5 div",
    'Replace the weakest support in my Burning Arrow setup with the best one for damage and keep my mana',
    'Replace the weakest support with the best one for damage',
    'Spend 50 points on life',
    'Spend my points on life and damage',
    'Spend my 5 points on life, not damage',
    'What should I upgrade next in my gloves?',
  ]) assert.equal(actsFirst(text), false, text);
});

test('the plan puts everything in only for the bare upgrade ask', () => {
  assert.equal(planApply('What should I upgrade next?'), 'all');
  assert.equal(planApply('what should i do'), 'all');
  assert.equal(planApply('What should I do about my flasks?'), 'fixes');
  assert.equal(planApply('What should I buy to get tankier?'), 'fixes');
  assert.equal(planApply("I'm level 92, what should I buy with 5 div"), 'fixes');
  assert.equal(planApply('Which is my weakest resistance?'), false);
  assert.equal(planApply('How does Righteous Fire work, what should I do next?'), false);
});

test('a budget is the number beside the currency unit', () => {
  assert.equal(budgetChaos("I'm level 92, what should I buy with 5 div", 150), 750);
});

test('plain asks still act first', () => {
  assert.deepEqual(pointsShape('I have 5 unspent passive points. Spend them where they add the most Full DPS.'), { stat: 'FullDPS' });
  assert.deepEqual(pointsShape('Spend my 5 free passive points to get as much effective HP as possible.'), { stat: 'TotalEHP' });
  assert.deepEqual(pointsShape('Put my 5 unspent points into the most life you can get.'), { stat: 'Life' });
  assert.equal(isSupportSwap('Swap the weakest support in my Boneshatter link for the one that adds the most damage.', SKILLS), true);
  assert.equal(isSupportSwap('Replace the weakest support in my Burning Arrow setup with the best one for damage.', SKILLS), true);
  assert.equal(isUpgradeShape('What should I upgrade next?'), true);
});

test('only the app writes "Solve update"', () => {
  assert.equal(isAppMessage('Solve update, round 2: the solver stalled.'), true);
  assert.equal(isAppMessage('What is a Solve update?'), false);
});
