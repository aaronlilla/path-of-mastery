import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DelayedFlag } from '../src/renderer/delayedFlag.js';

/** Node's mock clock jumps Date to the end of a tick before firing timers, so time is walked 1 ms at a time. */
const tick = (ms: number) => { for (let i = 0; i < ms; i++) mock.timers.tick(1); };

/** Runs work that takes `workMs`, then 2 s more, and returns every span (start, end in ms) the feedback was on. */
function spans(workMs: number, delayMs = 200, minShownMs = 400): [number, number][] {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  try {
    const out: [number, number][] = [];
    const flag = new DelayedFlag((on) => (on ? out.push([Date.now(), Infinity]) : (out[out.length - 1]![1] = Date.now())), delayMs, minShownMs);
    flag.set(true);
    tick(workMs);
    flag.set(false);
    tick(2000);
    flag.dispose();
    return out;
  } finally {
    mock.timers.reset();
  }
}

test('fast data: the feedback is never shown', () => {
  assert.deepEqual(spans(0), []);
  assert.deepEqual(spans(16), []);
  assert.deepEqual(spans(150), []);
});

test('slow data: the feedback shows after the delay and stays until the data lands', () => {
  assert.deepEqual(spans(2000), [[200, 2000]]);
});

test('slow data that lands soon after the delay still keeps the feedback up for the minimum time', () => {
  assert.deepEqual(spans(250), [[200, 600]]);
});

test('data landing right at the delay boundary never gives a 1-3 frame show', () => {
  for (let ms = 180; ms <= 260; ms++) {
    for (const [a, b] of spans(ms)) assert.ok(b - a >= 400, `work of ${ms} ms showed feedback for only ${b - a} ms`);
  }
});

test('turning back on during the minimum hold keeps it on without a gap', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  try {
    const seen: boolean[] = [];
    const flag = new DelayedFlag((on) => seen.push(on), 200);
    flag.set(true);
    tick(250);
    flag.set(false);
    tick(100);
    flag.set(true);
    tick(1000);
    assert.deepEqual(seen, [true]);
    assert.equal(flag.shown, true);
    flag.dispose();
  } finally {
    mock.timers.reset();
  }
});
