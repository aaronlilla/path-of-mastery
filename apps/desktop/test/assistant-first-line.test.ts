import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstLine, fitSwapAlt, swapAsk, swapLine, swapSkip, wantsAdvice, wantsRanking, wantsSupportSwap } from '../src/main/assistant/firstLine.js';

test('the first line names the first hole a player would fix, from facts only', () => {
  assert.equal(firstLine({ warnings: ['Your unreserved Mana is negative'], passivePointsLeft: 3 }), 'Your auras reserve more mana than you have: fixing that first.');
  assert.equal(firstLine({ warnings: [], passivePointsLeft: 2 }), 'You have unspent passive points: finding where they pay most.');
  assert.equal(firstLine({ warnings: [], passivePointsLeft: 0 }), null);
});

test('only an open-ended advice question gets a first line', () => {
  assert.equal(wantsAdvice('What should I upgrade next?'), true);
  assert.equal(wantsAdvice("What's my max hit against chaos damage?"), false);
  assert.equal(wantsAdvice('How does Righteous Fire work?'), false);
  // a direct change (for example "Replace the weakest support ...") is not advice: no upgrade plan, no unspent-points line, no 25 s of plan work beside the swap
  assert.equal(wantsAdvice('Replace the weakest support in my Burning Arrow setup with the best one for damage.'), false);
  assert.equal(wantsAdvice('Swap the weakest support in my Boneshatter link for the one that adds the most damage.'), false);
  assert.equal(wantsAdvice('Which of my supports is the weakest and what should I do about it?'), true);
});

// The selected skill (Fire Trap) is not all the damage (Righteous Fire); a ranking ask hears that first, in the app's own line
test('a ranking ask on a build whose selected skill is not all its damage opens with that, before any other first line', () => {
  const facts = { warnings: ['Your unreserved Mana is negative'], passivePointsLeft: 0, damageSkills: { selected: 'Fire Trap', others: ['Righteous Fire'] } };
  assert.equal(firstLine(facts), 'Your damage numbers count only Fire Trap, the selected skill, but Righteous Fire also deals damage, so I am counting them together.');
  assert.equal(firstLine(facts, true), 'Your damage numbers count only Fire Trap, the selected skill, but Righteous Fire also deals damage, so I am counting them together.');
  assert.equal(firstLine({ warnings: ['Your unreserved Mana is negative'], passivePointsLeft: 0 }, true), null, 'a ranking ask gets only the damage line');
  assert.equal(wantsRanking('Find the unique helmet that gives me the most effective HP and equip it.'), true);
  assert.equal(wantsRanking('What is my fire resistance?'), false);
});

// A direct "replace the weakest support" ask is done by the app itself before the model starts, and its first line says so
test('a direct support swap ask is recognised, and the first line names the swap with placeholders for its numbers', () => {
  assert.equal(wantsSupportSwap('Replace the weakest support in my Burning Arrow setup with the best one for damage.'), true);
  assert.equal(wantsSupportSwap('Swap the weakest support in my Boneshatter link for the one that adds the most damage.'), true);
  assert.equal(wantsSupportSwap('Pick the best support gems for Poisonous Concoction: replace any that are not pulling their weight, for the most Full DPS.'), false);
  assert.equal(wantsSupportSwap('Which support is the weakest in my Burning Arrow setup?'), false);
  assert.equal(
    swapLine('r7', { replace: { name: 'Mirage Archer' }, with: { name: 'Invert the Rules' }, skill: 'Burning Arrow', stat: { label: 'Combined DPS' } }),
    'Swapped Mirage Archer for Invert the Rules on Burning Arrow: Combined DPS {{r7:stat.beforeShown}} -> {{r7:stat.afterShown}} (+{{r7:stat.percent}}%).',
  );
});

// review of 4a73de6a0: the app's own swap fires only when it is safe, otherwise the model gets the ranking
test('the app swap: hedged asks, other skills, non-damage stats and unsafe swaps are not made automatically', () => {
  assert.equal(wantsSupportSwap('Replace the weakest support only if it is worth it.'), false);
  assert.equal(wantsSupportSwap('Swap the weakest support, or tell me why not.'), false);
  assert.deepEqual(swapAsk('Swap the weakest support in my Boneshatter link for the most damage.', ['Boneshatter', 'Fire Trap']), { skill: 'Boneshatter', notDamage: false });
  assert.equal(swapAsk('Replace the weakest support for more survivability.', []).notDamage, true);
  const ok = { stat: { percent: 10 }, with: {}, requirement: 'Fork level 20 needs Dex 10 of 100', side: [{ stat: 'TotalEHP', label: 'Effective HP', percent: 0 }] };
  assert.equal(swapSkip(ok), null);
  assert.match(swapSkip({ ...ok, with: { price: '3 div' } }) ?? '', /costs currency/);
  assert.match(swapSkip({ ...ok, requirement: undefined }) ?? '', /requirement/);
  assert.match(swapSkip({ ...ok, side: [{ stat: 'TotalEHP', label: 'Effective HP', percent: -8 }] }) ?? '', /Effective HP/);
});

test('recolour top pick falls back to the socket-fitting swap, same guards', () => {
  const top: any = { stat: { percent: 56 }, with: { name: 'Invert The Rules' }, requirement: 'x level 1 needs no attributes', socketColours: { bestWithoutRecolour: { replace: 'Mirage Archer', replaceGem: 3, with: 'Pierce', stat: { percent: 27 }, requirement: 'Pierce level 20 needs Dex 10 of 100', side: [], edits: [{}] } }, edits: [{}] };
  assert.match(swapSkip(top) ?? '', /recolour/);
  const alt = fitSwapAlt(top)!;
  assert.equal(swapSkip(alt), null);
  assert.equal(alt.with.name, 'Pierce');
  assert.equal(alt.replace.gem, 3);
  assert.match(swapSkip({ ...alt, with: { price: '3 div' } }) ?? '', /currency/);
});
