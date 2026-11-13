import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceFor, solveQuestions } from '../src/shared/assistant/solveQuestions.js';
import { loadPatterns } from '../src/main/assistant/buildPatterns.js';

// "Make me a Templar Lightning Arrow build": the class the player named wins over the most played ascendancy (0.1.21 review finding 3).

test('a named class: only its ascendancies are offered, none is picked, the most played elsewhere is information', () => {
  const ev = evidenceFor(loadPatterns(), 'Lightning Arrow')!;
  assert.equal([...(ev.ascendancies ?? [])].sort((a, b) => b.share - a.share)[0]?.name, 'Deadeye', 'the shipped evidence says Deadeye');
  const q = solveQuestions({ skill: 'Lightning Arrow', className: 'Templar', level: 95, targets: [] } as never, ev).find((x) => x.id === 'ascendancy')!;
  assert.deepEqual(q.options.map((o) => o.value).sort(), ['Guardian', 'Hierophant', 'Inquisitor']);
  assert.equal(q.suggested, undefined, 'nothing is filled in against the words');
  assert.equal(q.elsewhere?.name, 'Deadeye');
  // nothing named: the most played is still the suggestion
  assert.equal(solveQuestions({ skill: 'Lightning Arrow', level: 95, targets: [] } as never, ev).find((x) => x.id === 'ascendancy')?.suggested, 'Deadeye');
});
