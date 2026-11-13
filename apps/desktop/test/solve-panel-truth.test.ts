import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flushReplanUpdate, type Replan } from '../src/renderer/assistant/replan.js';
import { askPercent } from '../src/renderer/assistant/SolvePanel.js';

// R8: a Solve update is cleared only after its turn has started; a blocked gate keeps it queued.

test('the Solve update stays queued when the AI gate blocks, and goes out once the turn starts', async () => {
  const waiting: { current: Replan | null } = { current: { key: 'k1', text: 'update' } };
  const sent = { current: '' };
  const started: string[] = [];
  let gateOpen = false;
  const start = async (text: string) => { if (!gateOpen) return false; started.push(text); return true; };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  flushReplanUpdate(waiting, sent, false, start);
  await tick();
  assert.equal(waiting.current?.text, 'update', 'blocked start: the update is not lost');
  assert.equal(sent.current, '', 'blocked start: the key is free to send again');

  gateOpen = true;
  flushReplanUpdate(waiting, sent, true, start); // a turn is live: nothing goes out
  await tick();
  assert.deepEqual(started, []);

  flushReplanUpdate(waiting, sent, false, start);
  flushReplanUpdate(waiting, sent, false, start); // a push while the start is pending must not send twice
  await tick();
  assert.deepEqual(started, ['update']);
  assert.equal(waiting.current, null, 'cleared after the turn started');
  assert.equal(sent.current, 'k1');
});

test('best so far is the weakest target as a percent of the ask', () => {
  const row = (ts: Array<[number, number | null, number?]>) => ({ targets: ts.map(([value, target, shown]) => ({ name: 'x', metric: 'dps', stats: [], value, target, met: false, ...(shown === undefined ? {} : { shown }) })) }) as never;
  assert.equal(askPercent(row([[1_490_000, 3_000_000], [90_000, 80_000]])), 49);
  assert.equal(askPercent(row([[100, 200, 150]])), 75);
  assert.equal(askPercent(row([[5, null]])), null);
  assert.equal(askPercent(undefined), null);
});
