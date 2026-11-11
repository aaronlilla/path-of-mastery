import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs, displayState, INITIAL, reduce, type MachineState, type SyncEvent } from '../src/main/accounts/syncMachine.js';

const run = (events: SyncEvent[], from: MachineState = INITIAL): MachineState => events.reduce(reduce, from);

test('signed out is "local", and a sign-in makes it idle and synced', () => {
  assert.equal(displayState(INITIAL), 'local');
  const s = run([{ t: 'signedIn' }]);
  assert.equal(s.phase, 'idle');
  assert.equal(displayState(s), 'synced');
});

test('a pass shows syncing, then synced with the time of the last one', () => {
  const s = run([{ t: 'signedIn' }, { t: 'start' }]);
  assert.equal(displayState(s), 'syncing');
  const done = reduce(s, { t: 'ok', at: 1234, pending: 0, conflicts: 0 });
  assert.equal(displayState(done), 'synced');
  assert.equal(done.lastOkAt, 1234);
});

test('offline: retries back off 5, 15, 30, 60, 120, 300 s and stay at 300', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs), [5000, 15000, 30000, 60000, 120000, 300000, 300000, 300000]);
  let s = run([{ t: 'signedIn' }, { t: 'start' }, { t: 'network', at: 1000, pending: 2 }]);
  assert.equal(displayState(s), 'offline');
  assert.equal(s.retryAt, 6000);
  assert.equal(s.pending, 2);
  s = run([{ t: 'start' }, { t: 'network', at: 6000, pending: 2 }], s);
  assert.equal(s.retryAt, 21000);
  assert.equal(s.failures, 2);
});

test('a good pass after failures clears them and the retry', () => {
  let s = run([{ t: 'signedIn' }, { t: 'start' }, { t: 'network', at: 0, pending: 1 }, { t: 'start' }, { t: 'network', at: 0, pending: 1 }]);
  assert.equal(s.failures, 2);
  s = run([{ t: 'start' }, { t: 'ok', at: 99, pending: 0, conflicts: 0 }], s);
  assert.equal(s.failures, 0);
  assert.equal(s.retryAt, null);
  assert.equal(displayState(s), 'synced');
});

test('conflicts show as a conflict once the pass ends and outrank waiting changes', () => {
  let s = run([{ t: 'signedIn' }, { t: 'start' }]);
  assert.equal(displayState(reduce(s, { t: 'ok', at: 1, pending: 3, conflicts: 1 })), 'conflict');
  s = reduce(s, { t: 'ok', at: 1, pending: 0, conflicts: 0 });
  assert.equal(displayState(s), 'synced');
  assert.equal(displayState(reduce(s, { t: 'scanned', pending: 2, conflicts: 0 })), 'syncing', 'waiting changes show as syncing');
});

test('an error is kept with its message and retried like offline', () => {
  const s = run([{ t: 'signedIn' }, { t: 'start' }, { t: 'fail', at: 0, pending: 1, error: 'boom' }]);
  assert.equal(displayState(s), 'error');
  assert.equal(s.error, 'boom');
  assert.equal(s.retryAt, 5000);
});

test('signing out resets everything, and events after it change nothing', () => {
  const s = run([{ t: 'signedIn' }, { t: 'start' }, { t: 'network', at: 0, pending: 2 }, { t: 'signedOut' }]);
  assert.deepEqual(s, INITIAL);
  assert.deepEqual(reduce(s, { t: 'start' }), INITIAL);
  assert.deepEqual(reduce(s, { t: 'scanned', pending: 4, conflicts: 1 }), INITIAL);
});
