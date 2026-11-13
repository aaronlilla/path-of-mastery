import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerQuestion, evidenceFor, solveQuestions, standing, type PackLike } from '../src/shared/assistant/solveQuestions.js';

// The questions read the shipped real-builds pack: ascendancy and gem version come from it, the line "where the ask sits" too.
const pack = JSON.parse(readFileSync('resources/buildpatterns/patterns.json', 'utf8')) as PackLike;
const goal = (skill: string, extra = {}) => ({ skill, level: 95, targets: [], ...extra }) as never;

test('a skill with a real group: the most played ascendancy is suggested, one tap sets class and ascendancy', () => {
  const ev = evidenceFor(pack, 'Righteous Fire')!;
  const q = solveQuestions(goal('Righteous Fire'), ev).find((x) => x.id === 'ascendancy')!;
  assert.equal(q.suggested, 'Chieftain');
  assert.match(q.options[0]!.note ?? '', /^most played, \d+%$/);
  const g = answerQuestion(goal('Righteous Fire'), 'ascendancy', q.suggested!);
  assert.deepEqual([g.ascendancy, g.className], ['Chieftain', 'Marauder']);
  assert.equal(ev.sits!.builds >= 8, true);
});

test('a gem version most players run is one tap, the typed gem stays', () => {
  const ev = evidenceFor(pack, 'Storm Burst of Repulsion')!; // 8 builds of Repulsion, 11 of plain Storm Burst
  const q = solveQuestions(goal('Storm Burst of Repulsion'), ev).find((x) => x.id === 'gem')!;
  assert.equal(q.answer, 'Storm Burst of Repulsion');
  assert.equal(q.suggested, 'Storm Burst');
  assert.equal(answerQuestion(goal('Storm Burst of Repulsion'), 'gem', 'Storm Burst').skill, 'Storm Burst');
  // the typed gem is the most played one: no question
  assert.equal(solveQuestions(goal('Kinetic Blast'), evidenceFor(pack, 'Kinetic Blast')!).some((x) => x.id === 'gem'), false);
});

test('no group for the skill (or too few builds): no evidence, only budget and focus', () => {
  assert.equal(evidenceFor(pack, 'Poisonous Concoction'), null);
  assert.equal(evidenceFor(pack, 'Summon Raging Spirit')?.sits, undefined); // 3 builds: no line
  assert.deepEqual(solveQuestions(goal('Poisonous Concoction')).map((q) => q.id), ['budget', 'focus']);
});

test('where an ask sits: above all, 9 in 10, half, 1 in 10, below nearly all; nothing without a spread or a number', () => {
  const s = { p10: 100, p50: 200, p90: 400, max: 500 };
  assert.deepEqual([600, 450, 300, 150, 50].map((v) => standing(v, s)), ['all', 'p90', 'p50', 'p10', 'low']);
  assert.equal(standing(0, s), null);
  assert.equal(standing(300, undefined), null);
  assert.equal(standing(300, { p10: null, p50: null, p90: null, max: null }), null);
});
