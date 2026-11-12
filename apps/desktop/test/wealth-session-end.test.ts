import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker, emptyTracker, type Run } from '../src/main/wealth/sessions.js';

const MIN = 60_000;
const running = (start: number, lastActivity: number, manual: boolean): Run => ({ id: 'r', name: 'Strand', custom: false, manual, start, lastActivity, end: null, gained: {}, spent: {}, bars: [], flags: [], snapshots: 3, maps: 2 });

test('ending an automatic session keeps the duration the player was looking at', () => {
  // Showing 68 minutes (start to now) while the last loot arrived at minute 60.
  const t = new SessionTracker({ ...emptyTracker(), run: running(0, 60 * MIN, false) }, () => 370);
  assert.ok(t.end(68 * MIN));
  const closed = t.state.closed[0]!;
  assert.equal((closed.end! - closed.start) / MIN, 68);
});

test('ending a manual session also ends it now', () => {
  const t = new SessionTracker({ ...emptyTracker(), run: running(0, 10 * MIN, true) }, () => 370);
  t.end(45 * MIN);
  assert.equal(t.state.closed[0]!.end, 45 * MIN);
});

test('a session that goes quiet on its own still ends at its last loot', () => {
  const t = new SessionTracker({ ...emptyTracker(), run: running(0, 60 * MIN, false) }, () => 370);
  t.tick(60 * MIN + 3 * 3600_000);
  assert.equal(t.state.closed[0]!.end, 60 * MIN);
});
