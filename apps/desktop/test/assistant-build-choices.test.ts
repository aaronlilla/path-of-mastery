import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortReservationWays } from '../src/main/assistant/audit.js';
import { refundNodes } from '../src/main/assistant/playerSense.js';
import { masteryEffectId, setAutoSpend, spendFresh } from '../src/main/assistant/rankTools.js';

// Smaller assistant bugs, one test each.

test('an aura that costs nothing to turn off beats lowering a gem that costs 30%', () => {
  const ways = [{ name: 'Lower Determination from level 20 to 3', loss: 0.3 }, { name: 'Turn off Clarity', loss: 0 }];
  assert.equal(sortReservationWays(ways)[0]!.name, 'Turn off Clarity');
});

test('no refund when the tree has fewer spendable end nodes than the points owed', () => {
  assert.equal(refundNodes([1, 2], 2, (id) => id === 1), null, 'only one non-attribute node for two owed points');
  assert.deepEqual(refundNodes([1, 2, 3], 2, (id) => id === 1), [2, 3]);
});

// previewEdit gives effect 9 more damage than the others
const fakeCtx = () => ({
  engine: {
    async send(cmd: string, p: { edit?: { effectId: number } }) {
      if (cmd === 'getStats') return { stats: [{ id: 'CombinedDPS', value: 100 }, { id: 'TotalEHP', value: 1000 }] };
      if (cmd === 'previewEdit') return { statDiff: { changed: [{ statId: 'CombinedDPS', after: p.edit!.effectId === 9 ? 150 : 100 }] } };
      throw new Error(`unexpected ${cmd}`);
    },
  },
}) as never;

test('a mastery takes the asked effect, else the one the engine finds best, not the first', async () => {
  const effects = [{ id: 4 }, { id: 9 }, { id: 7 }];
  assert.equal(await masteryEffectId(fakeCtx(), 's', 1, effects, 7), 7);
  assert.equal(await masteryEffectId(fakeCtx(), 's', 1, effects), 9);
});

test('spendFresh never hands back the result the app made earlier in the turn', async () => {
  const cached = { alreadyApplied: true, edits: [{ kind: 'clickNode', nodeId: 1 }] };
  setAutoSpend('k', Promise.resolve(cached));
  const ctx = { open: () => ({ buildId: 'b', name: 'n', buildKey: 'k' }), engine: { async send() { throw new Error('fake engine'); } } } as never;
  const r = await spendFresh(ctx, 'Life').catch(() => null);
  assert.notEqual(r, cached);
});
