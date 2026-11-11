import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RETRY_FIRST_MS, RETRY_MAX_MS, WindowFit, retryDelay } from '../src/renderer/run/fit.js';

test('long text asks for the needed height once, then goes quiet after the acknowledgement', () => {
  const fit = new WindowFit();
  assert.equal(fit.plan({ needed: 190, current: 144, ready: true }), 190);
  assert.equal(fit.plan({ needed: 190, current: 144, ready: true }), null, 'one request at a time while waiting for the reply');
  fit.acked(190);
  assert.equal(fit.plan({ needed: 190, current: 190, ready: true }), null);
});

test('nothing is sent before the real window settings arrived (placeholder settings are rejected by main)', () => {
  const fit = new WindowFit();
  assert.equal(fit.plan({ needed: 190, current: 144, ready: false }), null);
  assert.equal(fit.plan({ needed: 190, current: 144, ready: true }), 190, 'asked as soon as they arrive');
});

test('a lost or refused request is asked again, not remembered as done', () => {
  const fit = new WindowFit();
  assert.equal(fit.plan({ needed: 190, current: 144, ready: true }), 190);
  assert.equal(fit.failed(), RETRY_FIRST_MS);
  assert.equal(fit.plan({ needed: 190, current: 144, ready: true }), 190, 'same height asked again');
  assert.equal(fit.failed(), RETRY_FIRST_MS * 2);
  assert.equal(fit.plan({ needed: 190, current: 144, ready: true }), 190);
  fit.acked(190);
  assert.equal(fit.plan({ needed: 190, current: 190, ready: true }), null);
});

test('a stale confirmation (window still at the old height) is asked again', () => {
  const fit = new WindowFit();
  assert.equal(fit.plan({ needed: 190, current: 144, ready: true }), 190);
  fit.acked(190);
  // a late windowSettings reply still says 144: the content still needs 190
  assert.equal(fit.plan({ needed: 190, current: 144, ready: true }), 190);
});

test('the window goes back to its reference height when the text is short again', () => {
  const fit = new WindowFit();
  assert.equal(fit.plan({ needed: 190, current: 144, ready: true }), 190);
  fit.acked(190);
  assert.equal(fit.plan({ needed: 150, current: 190, ready: true }), null, 'still above the reference: stays');
  assert.equal(fit.plan({ needed: 120, current: 190, ready: true }), 144);
  fit.acked(144);
  assert.equal(fit.plan({ needed: 120, current: 144, ready: true }), null);
  assert.equal(fit.plan({ needed: 200, current: 144, ready: true }), 200, 'and can grow again');
});

test('a height the screen will not allow is not asked again until the content changes', () => {
  const fit = new WindowFit();
  assert.equal(fit.plan({ needed: 900, current: 144, ready: true }), 900);
  fit.acked(700); // clamped to the work area
  assert.equal(fit.plan({ needed: 900, current: 700, ready: true }), null);
  fit.contentChanged();
  assert.equal(fit.plan({ needed: 900, current: 700, ready: true }), 900);
});

test('retry waits back off from 50 ms, double, and stay at 5 s', () => {
  assert.deepEqual([1, 2, 3, 4, 7, 8, 9, 10, 100, 1000].map(retryDelay), [50, 100, 200, 400, 3200, 5000, 5000, 5000, 5000, 5000]);
  assert.equal(RETRY_MAX_MS, 5000);
});

test('60+ consecutive failures never give up: the very next request after recovery goes through and is acknowledged', () => {
  const fit = new WindowFit();
  let waited = 0, last = 0;
  for (let i = 0; i < 75; i++) {
    assert.equal(fit.plan({ needed: 190, current: 144, ready: true }), 190, `request ${i + 1} is still sent`);
    last = fit.failed(); waited += last;
  }
  assert.equal(last, RETRY_MAX_MS);
  assert.ok(waited > 60_000, 'it keeps asking over a long time');
  assert.equal(fit.plan({ needed: 190, current: 144, ready: true }), 190);
  fit.acked(190); // saving works again
  assert.equal(fit.plan({ needed: 190, current: 190, ready: true }), null);
});

test('a content change or window focus restarts the backoff', () => {
  const fit = new WindowFit();
  for (let i = 0; i < 8; i++) { fit.plan({ needed: 190, current: 144, ready: true }); fit.failed(); }
  fit.contentChanged();
  assert.equal(fit.plan({ needed: 190, current: 144, ready: true }), 190);
  assert.equal(fit.failed(), RETRY_FIRST_MS);
});
